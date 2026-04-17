/**
 * PowerSync backend connector for CHT.
 *
 * Handles two concerns:
 * 1. fetchCredentials() - Gets JWT tokens from CHT API for PowerSync authentication
 * 2. uploadData() - Batches CRUD operations and POSTs them to the CHT API's dedicated
 *    PowerSync upload endpoint (/api/v1/powersync/upload). That endpoint routes writes
 *    through cht-datasource and is offline-user safe (isOnline: false).
 *
 * Both endpoints are absolute same-origin paths. Building URLs from `apiBaseUrl`
 * (LocationService.url = "https://host/medic") would prefix /medic/ and cause the
 * request to be caught by the CouchDB proxy / db-doc middleware on the API.
 *
 * Response handling (matches CHT server contract at powersync-upload.js):
 * - 5xx → throw to trigger PowerSync retry with backoff
 * - 4xx → log to local feedback table and advance. Throwing would block the queue
 *   indefinitely on auth/feature-flag errors the client can't self-correct.
 * - 200 with { results: [{ok, error}] } → log per-item failures, advance
 */
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
  /** Dev mode: generate tokens client-side instead of fetching from API */
  devMode?: boolean;
  /** Dev mode user config for token generation */
  devUser?: {
    userId: string;
    contactId?: string;
    roles?: string[];
    reportDepth?: number;
    canViewUnallocated?: boolean;
  };
  /** Timeout for HTTP requests in milliseconds (default: 30000) */
  fetchTimeoutMs?: number;
}

/** CHT PowerSync upload endpoint — receives batches of PowerSync CrudEntry. */
const UPLOAD_ENDPOINT = '/api/v1/powersync/upload';

/** CHT PowerSync token endpoint — returns a signed JWT for the sync service. */
const TOKEN_ENDPOINT = '/api/v1/powersync-token';

/** Max entries per upload POST. Must match MAX_BATCH_SIZE in api/src/controllers/powersync-upload.js. */
const MAX_UPLOAD_BATCH = 100;

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
        canViewUnallocated: this.config.devUser.canViewUnallocated,
      });
      return {
        endpoint: this.config.powerSyncUrl,
        token,
        expiresAt,
      };
    }

    // Production mode: fetch from CHT API. Absolute same-origin path — building
    // from apiBaseUrl would prefix /medic/ and route through the CouchDB proxy.
    const response = await this.fetchWithTimeout(TOKEN_ENDPOINT, {
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
   * Upload local writes to the CHT PowerSync batch endpoint.
   *
   * Called automatically by the SDK whenever local writes are pending.
   * CRITICAL: transaction.complete() must be called or the upload queue stalls permanently.
   */
  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) {
      return;
    }

    try {
      const ops = transaction.crud.map(op => ({
        op: op.op,
        table: op.table,
        id: op.id,
        opData: op.opData,
      }));

      for (let i = 0; i < ops.length; i += MAX_UPLOAD_BATCH) {
        const chunk = ops.slice(i, i + MAX_UPLOAD_BATCH);
        const response = await this.fetchWithTimeout(UPLOAD_ENDPOINT, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({ crud: chunk }),
        });

        if (response.status >= 500) {
          const text = await response.text().catch(() => 'Unknown server error');
          throw new Error(`Server error ${response.status}: ${text}`);
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          console.warn(`PowerSync upload rejected (${response.status}):`, errorText);
          await this.logBatchError(database, response.status, errorText, chunk);
          continue;
        }

        const body = await response.json().catch(() => null);
        const results: Array<{ id: string; ok: boolean; error?: string }> = body?.results ?? [];
        for (const r of results) {
          if (!r.ok) {
            console.warn(`PowerSync upload item error for ${r.id}:`, r.error);
            await this.logItemError(database, r);
          }
        }
      }

      // MUST call complete() to advance the queue
      await transaction.complete();
    } catch (ex) {
      // Throw to trigger PowerSync retry with backoff (5xx path)
      console.error('PowerSync upload error:', ex);
      throw ex;
    }
  }

  /**
   * Record a batch-level failure in the local-only feedback table.
   * PowerSync advances past 4xx errors — logging here is the only user-visible signal.
   */
  private async logBatchError(
    database: AbstractPowerSyncDatabase,
    status: number,
    errorText: string,
    chunk: Array<{ op: string; table: string; id: string; opData?: Record<string, any> }>
  ): Promise<void> {
    try {
      await database.execute(
        `INSERT INTO feedback (id, type, message, info, reported_date) VALUES (uuid(), ?, ?, ?, ?)`,
        [
          'upload_error',
          `Upload batch rejected (${status})`,
          JSON.stringify({ status, error: errorText, ids: chunk.map(o => o.id) }),
          new Date().toISOString(),
        ]
      );
    } catch (e) {
      console.error('Failed to log upload batch error to feedback table:', e);
    }
  }

  private async logItemError(
    database: AbstractPowerSyncDatabase,
    result: { id: string; ok: boolean; error?: string }
  ): Promise<void> {
    try {
      await database.execute(
        `INSERT INTO feedback (id, type, message, info, reported_date) VALUES (uuid(), ?, ?, ?, ?)`,
        [
          'upload_error',
          `Upload item failed: ${result.id}`,
          JSON.stringify({ id: result.id, error: result.error }),
          new Date().toISOString(),
        ]
      );
    } catch (e) {
      console.error('Failed to log upload item error to feedback table:', e);
    }
  }
}
