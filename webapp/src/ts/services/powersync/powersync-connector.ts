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
 *
 * CHT API endpoints:
 * - POST /api/v1/people - Create person contacts
 * - POST /api/v1/places - Create place contacts (clinic, health_center, district_hospital)
 * - POST /api/v1/records - Create reports/data records
 * - POST /api/v1/feedback - Submit user feedback (from meta DB)
 * Note: tasks and targets are generated client-side by the rules engine and synced
 * via PowerSync — they do not have dedicated write endpoints.
 */
import { UpdateType } from '@powersync/web';
import type {
  AbstractPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
  CrudEntry,
} from '@powersync/web';

export interface ChtConnectorConfig {
  /** Base URL of the CHT API (e.g. '/medic' or full URL) */
  apiBaseUrl: string;
  /** PowerSync service endpoint URL */
  powerSyncUrl: string;
  /** Dev mode: generate tokens client-side instead of fetching from API */
  devMode?: boolean;
  /** Dev mode user config for token generation */
  devUser?: {
    userId: string;
    contactId?: string;
    roles?: string[];
    reportDepth?: number;
  };
  /** Timeout for HTTP requests in milliseconds (default: 30000) */
  fetchTimeoutMs?: number;
}

/**
 * CHT person contact types — these use /api/v1/people.
 * All other contact types (clinic, health_center, district_hospital, custom places)
 * use /api/v1/places.
 */
const PERSON_TYPES = new Set(['person']);

/**
 * Default timeout for HTTP requests (30 seconds).
 * Prevents hung requests from stalling the upload queue indefinitely.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export class ChtPowerSyncConnector implements PowerSyncBackendConnector {
  private config: ChtConnectorConfig;

  constructor(config: ChtConnectorConfig) {
    this.config = config;
  }

  /**
   * Fetch with a per-request timeout. Prevents hung requests from
   * stalling the upload queue or credential refresh indefinitely.
   * On timeout, throws a TimeoutError which triggers PowerSync retry.
   */
  private fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      signal: AbortSignal.timeout(this.config.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
    });
  }

  /**
   * Fetch JWT credentials for PowerSync service authentication.
   * Called automatically every few minutes when the sync stream reconnects.
   * Must always return fresh credentials.
   *
   * In dev mode: generates tokens client-side using Web Crypto API.
   * In production: fetches tokens from CHT API /api/v1/powersync-token endpoint.
   */
  async fetchCredentials(): Promise<PowerSyncCredentials> {
    if (this.config.devMode && this.config.devUser) {
      // Dev mode: generate token client-side
      const { generateDevToken } = await import('./dev-token-provider');
      const { token, expiresAt } = await generateDevToken({
        userId: this.config.devUser.userId,
        contactId: this.config.devUser.contactId,
        roles: this.config.devUser.roles,
        reportDepth: this.config.devUser.reportDepth,
      });
      return {
        endpoint: this.config.powerSyncUrl,
        token,
        expiresAt,
      };
    }

    // Production mode: fetch from CHT API
    const response = await this.fetchWithTimeout(`${this.config.apiBaseUrl}/api/v1/powersync-token`, {
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
        const endpoint = this.resolveEndpoint(op);
        if (!endpoint) {
          console.warn(`PowerSync: No API endpoint for table '${op.table}', skipping`);
          continue;
        }

        const url = `${this.config.apiBaseUrl}${endpoint}`;

        switch (op.op) {
          case UpdateType.PUT: {
            const body = this.transformForApi(op.table, { id: op.id, ...op.opData });
            const response = await this.fetchWithTimeout(url, {
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
            const body = this.transformForApi(op.table, { id: op.id, ...op.opData });
            const response = await this.fetchWithTimeout(`${url}/${op.id}`, {
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
            const response = await this.fetchWithTimeout(`${url}/${op.id}`, {
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
   * Resolve the CHT API endpoint for a given CRUD operation.
   *
   * Contacts require special handling: persons use /api/v1/people,
   * places (clinic, health_center, district_hospital) use /api/v1/places.
   * The contact_type field in opData determines which endpoint to use.
   *
   * Tasks and targets are generated locally by the rules engine and synced
   * through PowerSync — they don't have dedicated upload endpoints.
   * Read status is local-only and doesn't get uploaded.
   */
  private resolveEndpoint(op: CrudEntry): string | null {
    switch (op.table) {
      case 'contacts': {
        // Determine if person or place based on contact_type/type in opData
        const contactType = op.opData?.contact_type || op.opData?.type;
        if (PERSON_TYPES.has(contactType)) {
          return '/api/v1/people';
        }
        return '/api/v1/places';
      }
      case 'reports':
        return '/api/v1/records';
      case 'feedback':
        return '/api/v1/feedback';
      // Tasks and targets are client-generated by rules engine.
      // They sync via PowerSync but don't have dedicated CHT API write endpoints.
      // The server receives them through the PostgreSQL sync path.
      case 'tasks':
      case 'targets':
        return null;
      // Settings are read-only on client (admin-only writes on server)
      case 'settings':
        return null;
      // Local-only tables don't need upload endpoints
      case 'telemetry':
      case 'read_status':
        return null;
      default:
        return null;
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
    op: CrudEntry
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
