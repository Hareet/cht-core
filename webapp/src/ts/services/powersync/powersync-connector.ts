/**
 * PowerSync backend connector for CHT.
 *
 * Handles two concerns:
 * 1. fetchCredentials() - Gets JWT tokens from CHT API for PowerSync authentication
 * 2. uploadData() - Sends local writes to CHT API (PowerSync is read+sync only;
 *    client writes go through CHT API, not directly to PostgreSQL)
 *
 * HTTP status code handling per PowerSync requirements:
 * - 2xx from backend even for validation errors (4xx blocks upload queue permanently)
 * - 5xx triggers automatic retry with backoff
 * - Validation errors are written to a local-only table for UI display
 */
import { UpdateType } from '@powersync/web';
import type {
  AbstractPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from '@powersync/web';

export interface ChtConnectorConfig {
  /** Base URL of the CHT API (e.g. '/medic' or full URL) */
  apiBaseUrl: string;
  /** PowerSync service endpoint URL */
  powerSyncUrl: string;
}

/**
 * Maps PowerSync table names to CHT API endpoints for write operations.
 */
const TABLE_API_MAP: Record<string, string> = {
  contacts: '/api/v1/people',
  reports: '/api/v1/records',
  feedback: '/api/v1/feedback',
  telemetry: '/api/v2/monitoring',
  read_status: '/api/v1/read-status',
};

export class ChtPowerSyncConnector implements PowerSyncBackendConnector {
  private config: ChtConnectorConfig;

  constructor(config: ChtConnectorConfig) {
    this.config = config;
  }

  /**
   * Fetch JWT credentials for PowerSync service authentication.
   * Called automatically every few minutes when the sync stream reconnects.
   * Must always return fresh credentials.
   */
  async fetchCredentials(): Promise<PowerSyncCredentials> {
    const response = await fetch(`${this.config.apiBaseUrl}/api/v1/powersync-token`, {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch PowerSync credentials: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    return {
      endpoint: this.config.powerSyncUrl,
      token: data.token,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
    };
  }

  /**
   * Upload local writes to CHT API.
   *
   * Called automatically whenever local writes are pending.
   * Must be synchronous with the actual backend write.
   * If it throws, PowerSync backs off and retries automatically.
   *
   * CRITICAL: transaction.complete() must be called or the upload queue stalls permanently.
   */
  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) {
      return;
    }

    try {
      for (const op of transaction.crud) {
        const endpoint = TABLE_API_MAP[op.table];
        if (!endpoint) {
          console.warn(`PowerSync: No API endpoint mapped for table '${op.table}', skipping`);
          continue;
        }

        const url = `${this.config.apiBaseUrl}${endpoint}`;

        switch (op.op) {
          case UpdateType.PUT: {
            // New document creation
            const body = this.transformForApi(op.table, { id: op.id, ...op.opData });
            const response = await fetch(url, {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              body: JSON.stringify(body),
            });
            await this.handleResponse(response, database, op);
            break;
          }

          case UpdateType.PATCH: {
            // Partial update
            const body = this.transformForApi(op.table, { id: op.id, ...op.opData });
            const response = await fetch(`${url}/${op.id}`, {
              method: 'PUT',
              credentials: 'same-origin',
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
              },
              body: JSON.stringify(body),
            });
            await this.handleResponse(response, database, op);
            break;
          }

          case UpdateType.DELETE: {
            const response = await fetch(`${url}/${op.id}`, {
              method: 'DELETE',
              credentials: 'same-origin',
              headers: { 'Accept': 'application/json' },
            });
            await this.handleResponse(response, database, op);
            break;
          }
        }
      }

      // MUST call complete() to advance the queue
      await transaction.complete();
    } catch (ex) {
      // Throw to trigger PowerSync retry with backoff
      console.error('PowerSync upload error:', ex);
      throw ex;
    }
  }

  /**
   * Handle API response. Per PowerSync guidance:
   * - 5xx: throw to retry
   * - 4xx validation errors: log to local-only table, don't block queue
   */
  private async handleResponse(
    response: Response,
    database: AbstractPowerSyncDatabase,
    op: { table: string; id: string; op: UpdateType }
  ): Promise<void> {
    if (response.ok) {
      return;
    }

    if (response.status >= 500) {
      const text = await response.text().catch(() => 'Unknown server error');
      throw new Error(`Server error ${response.status}: ${text}`);
    }

    // 4xx: validation error - log it but don't block the queue
    const errorText = await response.text().catch(() => 'Unknown validation error');
    console.warn(`PowerSync upload validation error for ${op.table}/${op.id}:`, errorText);

    // Write validation error to local-only feedback table for UI display
    try {
      await database.execute(
        `INSERT INTO feedback (id, type, message, info, reported_date) VALUES (uuid(), ?, ?, ?, ?)`,
        [
          'upload_error',
          `Failed to save ${op.table}: ${response.status}`,
          JSON.stringify({ table: op.table, id: op.id, op: op.op, error: errorText }),
          new Date().toISOString(),
        ]
      );
    } catch (e) {
      console.error('Failed to log upload error to local feedback table:', e);
    }
  }

  /**
   * Transform PowerSync row data into CHT API format.
   * PowerSync stores booleans as 0/1; CHT API expects true/false.
   * JSON text fields need to be parsed back to objects.
   */
  private transformForApi(table: string, data: Record<string, any>): Record<string, any> {
    const result = { ...data };

    // Parse JSON text fields back to objects
    const jsonFields: Record<string, string[]> = {
      contacts: ['parent', 'geolocation'],
      reports: ['fields', 'geolocation'],
      tasks: ['state_history', 'emission'],
      targets: ['targets'],
      settings: ['doc'],
      feedback: ['info'],
      telemetry: ['metrics', 'device'],
    };

    const fieldsToParseForTable = jsonFields[table] || [];
    for (const field of fieldsToParseForTable) {
      if (typeof result[field] === 'string') {
        try {
          result[field] = JSON.parse(result[field]);
        } catch {
          // Keep as string if not valid JSON
        }
      }
    }

    // Convert integer booleans back to actual booleans
    const booleanFields: Record<string, string[]> = {
      reports: ['verified', 'is_private', 'needs_signoff'],
    };

    const boolFieldsForTable = booleanFields[table] || [];
    for (const field of boolFieldsForTable) {
      if (field in result) {
        result[field] = result[field] === 1;
      }
    }

    return result;
  }
}
