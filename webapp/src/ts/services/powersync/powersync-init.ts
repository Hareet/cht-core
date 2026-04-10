/**
 * PowerSync initialization for the CHT Angular webapp.
 *
 * Call initializePowerSync() during app bootstrap, after the user session
 * is confirmed. This connects to the PowerSync service and begins syncing
 * data from PostgreSQL to the local wa-sqlite database.
 *
 * Integration point: app.component.ts ngOnInit() → setupPromise chain,
 * after chtDatasourceService.isInitialized() and initUser().
 *
 * Example usage in app.component.ts:
 *
 *   import { PowerSyncService } from '@mm-services/powersync/powersync.service';
 *
 *   constructor(private powerSyncService: PowerSyncService, ...) {}
 *
 *   // In the initialization chain:
 *   .then(() => this.initPowerSync())
 *
 *   private async initPowerSync() {
 *     await initializePowerSync(
 *       this.powerSyncService,
 *       this.sessionService,
 *       { devMode: true }  // for development
 *     );
 *   }
 */
import type { PowerSyncService, PowerSyncConfig } from './powersync.service';

interface SessionServiceLike {
  userCtx(): { name?: string; roles?: string[] } | null;
  isOnlineOnly(userCtx?: any): boolean;
}

/**
 * Initialize PowerSync for the current user session.
 *
 * In dev mode, generates JWT tokens client-side using the dev RSA key.
 * In production, the connector fetches tokens from the CHT API.
 *
 * @param powerSyncService - The Angular PowerSyncService instance
 * @param sessionService - The session service for user context
 * @param options - Configuration overrides
 */
export async function initializePowerSync(
  powerSyncService: PowerSyncService,
  sessionService: SessionServiceLike,
  options: {
    devMode?: boolean;
    powerSyncUrl?: string;
  } = {}
): Promise<void> {
  const userCtx = sessionService.userCtx();
  if (!userCtx?.name || sessionService.isOnlineOnly()) {
    console.info('PowerSync: Skipping initialization (online-only user or no session)');
    return;
  }

  const config: PowerSyncConfig = {
    powerSyncUrl: options.powerSyncUrl,
  };

  if (options.devMode) {
    config.devMode = true;
    config.devUser = {
      userId: `org.couchdb.user:${userCtx.name}`,
      roles: userCtx.roles || [],
      reportDepth: 1,
    };
    console.info(`PowerSync: Dev mode initialization for user '${userCtx.name}'`);
  }

  try {
    await powerSyncService.initialize(config);
    console.info('PowerSync: Initialized successfully, syncing in background');
  } catch (err) {
    console.error('PowerSync: Initialization failed (falling back to PouchDB)', err);
    // Non-fatal: the app continues with PouchDB as the data layer
  }
}
