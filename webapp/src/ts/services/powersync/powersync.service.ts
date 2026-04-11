/**
 * Angular service wrapping PowerSync Web SDK for CHT.
 *
 * Provides:
 * - Database initialization with WASM SQLite
 * - Sync connection lifecycle (connect, disconnect, clear on logout)
 * - Reactive query watching via RxJS Observables
 * - Sync status as an Observable
 * - Offline write queue (writes go to local SQLite, uploaded via connector)
 *
 * This service is designed to run alongside the existing PouchDB-based DbService
 * during the migration period. Components can progressively switch to PowerSync queries.
 */
import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { Observable, BehaviorSubject, Subject } from 'rxjs';
import { PowerSyncDatabase } from '@powersync/web';
import type { SyncStatus } from '@powersync/web';

import { SessionService } from '@mm-services/session.service';
import { LocationService } from '@mm-services/location.service';
import { ChtPowerSyncSchema } from './powersync-schema';
import { ChtPowerSyncConnector } from './powersync-connector';
import type { ContactRow, ReportRow, TaskRow, TargetRow, SettingsRow } from './powersync-schema';

export { ContactRow, ReportRow, TaskRow, TargetRow, SettingsRow };

/** Simplified sync status for UI consumption */
export interface PowerSyncStatus {
  connected: boolean;
  connecting: boolean;
  hasSynced: boolean;
  lastSyncedAt: Date | null;
  uploading: boolean;
  downloading: boolean;
  uploadError: Error | undefined;
  downloadError: Error | undefined;
}

/** Configuration for PowerSync initialization */
export interface PowerSyncConfig {
  /** PowerSync service URL. If not set, derived from browser location. */
  powerSyncUrl?: string;
  /** Enable dev mode (client-side JWT generation) */
  devMode?: boolean;
  /** Dev user config. Required if devMode is true. */
  devUser?: {
    userId: string;
    contactId?: string;
    roles?: string[];
    reportDepth?: number;
  };
}

const DEFAULT_POWERSYNC_SERVICE_URL = '/powersync';
const DB_FILENAME = 'cht-powersync.db';

@Injectable({
  providedIn: 'root'
})
export class PowerSyncService implements OnDestroy {
  private db: PowerSyncDatabase | null = null;
  private connector: ChtPowerSyncConnector | null = null;
  private initialized = false;
  private reconnecting = false;
  private destroyed$ = new Subject<void>();

  private statusSubject = new BehaviorSubject<PowerSyncStatus>({
    connected: false,
    connecting: false,
    hasSynced: false,
    lastSyncedAt: null,
    uploading: false,
    downloading: false,
    uploadError: undefined,
    downloadError: undefined,
  });

  /** Observable sync status for UI components */
  readonly status$ = this.statusSubject.asObservable();

  constructor(
    private sessionService: SessionService,
    private locationService: LocationService,
    private ngZone: NgZone,
  ) {}

  /**
   * Initialize the PowerSync database and start syncing.
   * Safe to call multiple times - will no-op if already initialized.
   *
   * Call this during app bootstrap after authentication is confirmed.
   *
   * @param config - Optional configuration. In dev mode, provide devUser
   *   to enable client-side JWT generation.
   */
  async initialize(config?: PowerSyncConfig): Promise<void> {
    if (this.initialized || this.sessionService.isOnlineOnly()) {
      return;
    }

    this.ngZone.runOutsideAngular(() => {
      this.db = new PowerSyncDatabase({
        schema: ChtPowerSyncSchema,
        database: { dbFilename: DB_FILENAME },
        flags: {
          useWebWorker: true,
          enableMultiTabs: true,
        },
      });
    });

    // Derive the PowerSync service URL
    const powerSyncUrl = config?.powerSyncUrl || this.derivePowerSyncUrl();

    this.connector = new ChtPowerSyncConnector({
      apiBaseUrl: this.locationService.url,
      powerSyncUrl,
      devMode: config?.devMode,
      devUser: config?.devUser,
    });

    // Register status listener before connecting
    this.db!.registerListener({
      statusChanged: (status: SyncStatus) => {
        this.ngZone.run(() => {
          this.statusSubject.next({
            connected: status.connected,
            connecting: status.connecting,
            hasSynced: status.hasSynced ?? false,
            lastSyncedAt: status.lastSyncedAt ?? null,
            uploading: status.dataFlowStatus?.uploading ?? false,
            downloading: status.dataFlowStatus?.downloading ?? false,
            uploadError: status.dataFlowStatus?.uploadError,
            downloadError: status.dataFlowStatus?.downloadError,
          });
        });
      },
    });

    // connect() is fire-and-forget; sync happens in the background
    this.db!.connect(this.connector);
    this.initialized = true;
  }

  /**
   * Wait for the first full sync to complete.
   * Use this to gate rendering of data-dependent screens.
   *
   * @param timeoutMs - Optional timeout in milliseconds (default: 30s)
   */
  async waitForFirstSync(timeoutMs = 30_000): Promise<boolean> {
    if (!this.db) {
      return false;
    }

    if (this.db.currentStatus?.hasSynced) {
      return true;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      await this.db.waitForFirstSync({ signal: controller.signal });
      return true;
    } catch {
      console.warn('PowerSync: First sync timed out or was aborted');
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get the underlying PowerSync database instance.
   * Use for advanced queries not covered by the convenience methods.
   */
  getDatabase(): PowerSyncDatabase {
    if (!this.db) {
      throw new Error('PowerSync not initialized. Call initialize() first.');
    }
    return this.db;
  }

  // ---------------------------------------------------------------------------
  // Query methods
  // ---------------------------------------------------------------------------

  /**
   * Execute a one-time SQL query and return all matching rows.
   */
  async getAll<T = Record<string, any>>(sql: string, params: any[] = []): Promise<T[]> {
    return this.getDatabase().getAll<T>(sql, params);
  }

  /**
   * Get a single row by SQL query. Returns null if not found.
   */
  async getOptional<T = Record<string, any>>(sql: string, params: any[] = []): Promise<T | null> {
    return this.getDatabase().getOptional<T>(sql, params);
  }

  /**
   * Get a single row by SQL query. Throws if not found.
   */
  async get<T = Record<string, any>>(sql: string, params: any[] = []): Promise<T> {
    return this.getDatabase().get<T>(sql, params);
  }

  /**
   * Watch a SQL query reactively. Returns an Observable that emits
   * whenever the underlying data changes.
   *
   * Uses the WatchedQuery API (db.query().watch()) which is the preferred approach
   * in PowerSync JS SDK. Runs outside Angular zone for performance, re-enters
   * zone on emission so change detection fires.
   */
  watch<T = Record<string, any>>(sql: string, params: any[] = []): Observable<T[]> {
    return new Observable<T[]>(subscriber => {
      if (!this.db) {
        subscriber.error(new Error('PowerSync not initialized'));
        return;
      }

      // Use the WatchedQuery API with registerListener.
      // The SDK types the data as ReadonlyArray<Readonly<unknown>> since db.query()
      // doesn't carry our generic T. We cast in the callback.
      const watchedQuery = this.db!.query({ sql, parameters: params }).watch();

      const dispose = watchedQuery.registerListener({
        onData: (data) => {
          this.ngZone.run(() => {
            subscriber.next(data as unknown as T[]);
          });
        },
        onError: (error) => {
          this.ngZone.run(() => {
            subscriber.error(error);
          });
        },
      });

      return () => {
        dispose();
        watchedQuery.close();
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Write methods (local writes that get uploaded via connector)
  // ---------------------------------------------------------------------------

  /**
   * Execute a write SQL statement.
   * The write is recorded locally and uploaded to the CHT API via the connector.
   */
  async execute(sql: string, params: any[] = []): Promise<void> {
    await this.getDatabase().execute(sql, params);
  }

  /**
   * Execute multiple write operations atomically.
   * Auto-commits on success, auto-rollbacks on exception.
   */
  async writeTransaction(fn: (tx: any) => Promise<void>): Promise<void> {
    await this.getDatabase().writeTransaction(fn);
  }

  // ---------------------------------------------------------------------------
  // CHT-specific convenience queries
  // ---------------------------------------------------------------------------

  /**
   * Get all contacts of the given types.
   * Replacement for PouchDB query('medic-client/contacts_by_type').
   *
   * Queries on `contact_type` which holds the resolved type via
   * COALESCE(contact_type, type), matching CHT v3.7+ and older patterns.
   */
  async getContactsByType(types: string[]): Promise<ContactRow[]> {
    if (!types.length) {
      return [];
    }
    const placeholders = types.map(() => '?').join(', ');
    return this.getAll<ContactRow>(
      `SELECT * FROM contacts WHERE contact_type IN (${placeholders}) ORDER BY name`,
      types
    );
  }

  /**
   * Watch contacts of the given types reactively.
   */
  watchContactsByType(types: string[]): Observable<ContactRow[]> {
    if (!types.length) {
      return new Observable(sub => { sub.next([]); sub.complete(); });
    }
    const placeholders = types.map(() => '?').join(', ');
    return this.watch<ContactRow>(
      `SELECT * FROM contacts WHERE contact_type IN (${placeholders}) ORDER BY name`,
      types
    );
  }

  /**
   * Get contacts by parent ID and optional type filter.
   * Replacement for PouchDB query('medic-client/contacts_by_parent').
   */
  async getContactsByParent(parentId: string, type?: string): Promise<ContactRow[]> {
    if (type) {
      return this.getAll<ContactRow>(
        'SELECT * FROM contacts WHERE parent_id = ? AND contact_type = ? ORDER BY name',
        [parentId, type]
      );
    }
    return this.getAll<ContactRow>(
      'SELECT * FROM contacts WHERE parent_id = ? ORDER BY name',
      [parentId]
    );
  }

  /**
   * Get a single document by ID from any synced table.
   */
  async getDoc(id: string): Promise<Record<string, any> | null> {
    // Search across all synced tables - contacts first as most common lookup
    const tables = ['contacts', 'reports', 'tasks', 'targets', 'settings'];
    for (const table of tables) {
      const row = await this.getOptional(`SELECT * FROM ${table} WHERE id = ?`, [id]);
      if (row) {
        return { ...row, _table: table };
      }
    }
    return null;
  }

  /**
   * Get multiple documents by IDs.
   * Replacement for PouchDB allDocs({ keys: [...], include_docs: true }).
   */
  async getDocsByIds(ids: string[]): Promise<Record<string, any>[]> {
    if (!ids.length) {
      return [];
    }
    const results: Record<string, any>[] = [];
    const tables = ['contacts', 'reports', 'tasks', 'targets', 'settings'];

    for (const table of tables) {
      const placeholders = ids.map(() => '?').join(', ');
      const rows = await this.getAll(
        `SELECT * FROM ${table} WHERE id IN (${placeholders})`,
        ids
      );
      for (const row of rows) {
        results.push({ ...row, _table: table });
      }
    }
    return results;
  }

  /**
   * Get reports for a specific patient.
   */
  async getReportsForPatient(patientUuid: string): Promise<ReportRow[]> {
    return this.getAll<ReportRow>(
      'SELECT * FROM reports WHERE patient_uuid = ? ORDER BY reported_date DESC',
      [patientUuid]
    );
  }

  /**
   * Watch reports for a specific patient reactively.
   */
  watchReportsForPatient(patientUuid: string): Observable<ReportRow[]> {
    return this.watch<ReportRow>(
      'SELECT * FROM reports WHERE patient_uuid = ? ORDER BY reported_date DESC',
      [patientUuid]
    );
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Disconnect from sync and clear all local data.
   * Call on user logout to ensure no data persists.
   */
  async disconnectAndClear(): Promise<void> {
    if (this.db) {
      try {
        await this.db.disconnectAndClear();
      } catch (err) {
        console.error('PowerSync: Error during disconnect and clear:', err);
      }
      this.db = null;
      this.connector = null;
      this.initialized = false;
      this.statusSubject.next({
        connected: false,
        connecting: false,
        hasSynced: false,
        lastSyncedAt: null,
        uploading: false,
        downloading: false,
        uploadError: undefined,
        downloadError: undefined,
      });
    }
  }

  /**
   * Get the current sync status snapshot (non-reactive).
   */
  getCurrentStatus(): PowerSyncStatus {
    return this.statusSubject.value;
  }

  /**
   * Check if PowerSync is initialized and connected.
   */
  isReady(): boolean {
    return this.initialized && (this.statusSubject.value.hasSynced || false);
  }

  // ---------------------------------------------------------------------------
  // Error recovery & queue visibility
  // ---------------------------------------------------------------------------

  /**
   * Reconnect to the PowerSync service.
   * Use when sync appears stuck or after recovering from a network outage.
   * Tears down the current sync stream and re-establishes it with fresh credentials.
   *
   * Guarded against concurrent calls — if a reconnect is already in progress,
   * subsequent calls are no-ops to prevent overlapping disconnect/connect sequences
   * that could corrupt sync state or create duplicate streams.
   *
   * If disconnect() fails (e.g. DB locked), connect() is still attempted to avoid
   * leaving the service stuck in a disconnected state with no recovery path.
   */
  async reconnect(): Promise<void> {
    if (!this.db || !this.connector || this.reconnecting) {
      return;
    }
    this.reconnecting = true;
    try {
      try {
        await this.db.disconnect();
      } catch (err) {
        console.warn('PowerSync: disconnect failed during reconnect, attempting connect anyway:', err);
      }
      // Re-check after async yield: disconnectAndClear() may have run during
      // the await above, nullifying db/connector. Without this guard, calling
      // connect() on a null reference throws a TypeError.
      if (!this.db || !this.connector) {
        return;
      }
      // connect() is fire-and-forget; sync resumes in the background
      this.db.connect(this.connector);
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Get the number of pending upload operations in the offline queue.
   * Returns 0 if not initialized.
   */
  async getPendingUploadCount(): Promise<number> {
    if (!this.db) {
      return 0;
    }
    const stats = await this.db.getUploadQueueStats();
    return stats.count;
  }

  /**
   * Check if there are any pending writes waiting to be uploaded.
   */
  async hasPendingWrites(): Promise<boolean> {
    return (await this.getPendingUploadCount()) > 0;
  }

  /**
   * Derive the PowerSync service URL from the current browser location.
   * In the dev container, PowerSync is proxied at /powersync.
   * In production, this would be configured via environment.
   */
  private derivePowerSyncUrl(): string {
    const doc = (globalThis as any).document;
    if (!doc?.location) {
      return `http://localhost:8080`;
    }
    const { protocol, hostname, port } = doc.location;
    return `${protocol}//${hostname}${port ? ':' + port : ''}${DEFAULT_POWERSYNC_SERVICE_URL}`;
  }

  ngOnDestroy(): void {
    this.destroyed$.next();
    this.destroyed$.complete();
    this.disconnectAndClear();
  }
}
