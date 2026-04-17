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
import { PowerSyncDatabase, WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web';
import type { SyncStatus } from '@powersync/web';

import { SessionService } from '@mm-services/session.service';
import { LocationService } from '@mm-services/location.service';
import { DeviceTierService } from './device-tier.service';
import { StorageHealthService } from './storage-health.service';
import { ChtPowerSyncSchema } from './powersync-schema';
import { ChtPowerSyncConnector } from './powersync-connector';
import type { ContactRow, ReportRow, TaskRow, TargetRow, SettingsRow } from './powersync-schema';
import type { DeviceTier } from './device-tier.service';

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
    canViewUnallocated?: boolean;
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
    private deviceTierService: DeviceTierService,
    private storageHealthService: StorageHealthService,
    private ngZone: NgZone,
  ) {}

  /**
   * Initialize the PowerSync database and start syncing.
   * Safe to call multiple times - will no-op if already initialized.
   *
   * Call this during app bootstrap after authentication is confirmed.
   *
   * Adaptive behavior:
   * - Detects device tier (go/budget/standard/high) via DeviceTierService
   * - Selects VFS: OPFSCoopSyncVFS if available, IDBBatchAtomicVFS fallback
   * - Sets cacheSizeKb per device tier
   * - Requests persistent storage via navigator.storage.persist()
   * - Starts StorageHealthMonitor for resource-constrained devices
   *
   * @param config - Optional configuration. In dev mode, provide devUser
   *   to enable client-side JWT generation.
   */
  async initialize(config?: PowerSyncConfig): Promise<void> {
    if (this.initialized || this.sessionService.isOnlineOnly()) {
      return;
    }

    // Detect device capabilities
    const deviceTier = await this.deviceTierService.detect();
    const tierConfig = this.deviceTierService.getConfig(deviceTier.tier);

    // Request persistent storage to prevent OPFS/IndexedDB eviction
    this.requestPersistentStorage();

    // Select VFS: AccessHandlePoolVFS for single-tab (best perf, lowest memory),
    // OPFSCoopSyncVFS if multi-tab needed, IDBBatchAtomicVFS as fallback.
    // Allow benchmark override via window.__CHT_FORCE_VFS for testing.
    const forceVfs = (window as any).__CHT_FORCE_VFS;
    const vfs = forceVfs === 'idb'
      ? WASQLiteVFS.IDBBatchAtomicVFS
      : deviceTier.opfsAvailable
        ? WASQLiteVFS.AccessHandlePoolVFS
        : WASQLiteVFS.IDBBatchAtomicVFS;

    console.info(
      `PowerSync: Device tier=${deviceTier.tier}, VFS=${vfs}, ` +
      `cacheSizeKb=${tierConfig.cacheSizeKb}, OPFS=${deviceTier.opfsAvailable}, ` +
      `storage=${deviceTier.storageFreeGB.toFixed(1)}GB free / ${deviceTier.storageTotalGB.toFixed(1)}GB total, ` +
      `WebView=${deviceTier.webviewMajor}`
    );

    this.ngZone.runOutsideAngular(() => {
      this.db = new PowerSyncDatabase({
        schema: ChtPowerSyncSchema,
        database: new WASQLiteOpenFactory({
          dbFilename: DB_FILENAME,
          vfs,
          cacheSizeKb: tierConfig.cacheSizeKb,
          // Use pre-bundled UMD worker copied to build output by angular.json assets.
          // Without this, the SDK uses `new URL('./WASQLiteDB.worker.js', import.meta.url)`
          // which resolves to a file:// path in node_modules, blocked by origin security policy.
          worker: '/powersync/worker/WASQLiteDB.umd.js',
        }),
        flags: {
          useWebWorker: true,
          enableMultiTabs: false, // Android WebView does not support multi-tab
        },
      });
    });

    // Expose DB globally for benchmarking (dev mode only)
    (window as any).__ps_db = this.db;

    // Derive the PowerSync service URL — do this before the PRAGMA so connect() isn't blocked
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

    // connect() is fire-and-forget; sync happens in the background.
    // IMPORTANT: connect() must run before any db.execute() calls.
    // The WASM worker may not be ready until connect() initializes it,
    // so any execute() before connect() can deadlock the worker channel.
    this.db!.connect(this.connector);
    this.initialized = true;

    // Reduce SQLite cache for Go edition memory constraint (negative = KiB).
    // Runs after connect() to avoid blocking on an uninitialized worker.
    this.db!.execute(`PRAGMA cache_size = -${tierConfig.cacheSizeKb}`).catch((err: any) => {
      console.warn('PowerSync: PRAGMA cache_size failed (non-fatal):', err?.message || err);
    });

    // Start storage monitoring for resource-constrained devices
    this.storageHealthService.startMonitoring();

    // Record device tier and VFS selection to telemetry (fire-and-forget)
    this.recordInitTelemetry(deviceTier, vfs);
  }

  /**
   * Record PowerSync initialization telemetry to the local-only telemetry table.
   * Logs device tier, VFS selection, and storage metrics on every app start.
   * Fire-and-forget — failure is non-fatal.
   */
  private recordInitTelemetry(deviceTier: DeviceTier, vfs: string): void {
    if (!this.db) {
      return;
    }
    const metrics = {
      powersync_vfs: vfs,
      powersync_device_tier: deviceTier.tier,
      powersync_opfs_available: deviceTier.opfsAvailable,
      powersync_storage_free_gb: Math.round(deviceTier.storageFreeGB * 10) / 10,
      powersync_storage_total_gb: Math.round(deviceTier.storageTotalGB * 10) / 10,
      powersync_webview_major: deviceTier.webviewMajor,
    };
    this.db.execute(
      `INSERT INTO telemetry (id, type, metrics, reported_date) VALUES (uuid(), ?, ?, ?)`,
      ['powersync_init', JSON.stringify(metrics), new Date().toISOString()]
    ).catch(() => {
      // Non-fatal: telemetry recording failure should never break init
    });
  }

  /**
   * Wait for the first sync to complete up to the given priority level.
   *
   * Uses Prioritized Sync so contacts (priority 1) appear before the full
   * dataset finishes syncing — critical for Go edition devices where full
   * sync can take 10-16 seconds on cold start.
   *
   * @param priority - Sync priority level to wait for (default: 1 = contacts).
   *   Lower numbers = higher priority. Omit to wait for all priorities.
   * @param timeoutMs - Optional timeout in milliseconds (default: 30s)
   */
  async waitForFirstSync(priority = 1, timeoutMs = 30_000): Promise<boolean> {
    if (!this.db) {
      return false;
    }

    if (this.db.currentStatus?.hasSynced) {
      return true;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      await this.db.waitForFirstSync({ signal: controller.signal, priority });
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
    this.storageHealthService.stopMonitoring();
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
   * Request persistent storage so the browser does not evict OPFS/IndexedDB data.
   * Fire-and-forget — failure is non-fatal (some browsers/contexts deny this).
   */
  private requestPersistentStorage(): void {
    try {
      if (navigator?.storage?.persist) {
        navigator.storage.persist().then(granted => {
          console.info(`PowerSync: Persistent storage ${granted ? 'granted' : 'denied'}`);
        }).catch(() => {
          // Non-fatal
        });
      }
    } catch {
      // navigator.storage not available
    }
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
    this.storageHealthService.stopMonitoring();
    this.disconnectAndClear();
  }
}
