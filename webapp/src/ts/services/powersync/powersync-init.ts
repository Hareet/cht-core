/**
 * PowerSync initialization for the CHT Angular webapp.
 *
 * Call initializePowerSync() during app bootstrap, after the user session
 * is confirmed. This kicks off PowerSync initialization in the background
 * — it does NOT block the app startup chain.
 *
 * WASM compilation on Go edition devices takes 3-8 seconds. By making init
 * non-blocking, the app renders its loading UI immediately while PowerSync
 * initializes in a Web Worker.
 *
 * Integration point: app.component.ts ngOnInit() → setupPromise chain,
 * after chtDatasourceService.isInitialized() and initUser().
 *
 * Example usage in app.component.ts:
 *
 *   import { PowerSyncService } from '@mm-services/powersync/powersync.service';
 *   import { initializePowerSync } from '@mm-services/powersync/powersync-init';
 *
 *   // In the initialization chain (does NOT block):
 *   .then(() => initializePowerSync(this.powerSyncService, this.sessionService))
 *
 *   // Later, when a component needs data:
 *   await this.powerSyncService.waitForFirstSync(); // waits for priority-1 sync
 */
import type { PowerSyncService, PowerSyncConfig } from './powersync.service';

interface SessionServiceLike {
  userCtx(): { name?: string; roles?: string[] } | null;
  isOnlineOnly(userCtx?: any): boolean;
}

export interface PowerSyncInitResult {
  /** Whether initialization was attempted (false if skipped for online-only users) */
  attempted: boolean;
  /** Promise that resolves when PowerSync is initialized and connected. Rejects on init failure. */
  ready: Promise<void>;
}

/**
 * Initialize PowerSync for the current user session.
 *
 * Non-blocking: returns immediately after kicking off background initialization.
 * The returned `ready` promise resolves when PowerSync DB is open and sync has started.
 * Init failure is non-fatal — the app continues with PouchDB.
 *
 * @param powerSyncService - The Angular PowerSyncService instance
 * @param sessionService - The session service for user context
 * @param options - Configuration overrides
 * @returns result with `attempted` flag and `ready` promise
 */
export function initializePowerSync(
  powerSyncService: PowerSyncService,
  sessionService: SessionServiceLike,
  options: {
    devMode?: boolean;
    powerSyncUrl?: string;
  } = {}
): PowerSyncInitResult {
  const userCtx = sessionService.userCtx();
  if (!userCtx?.name || sessionService.isOnlineOnly()) {
    console.info('PowerSync: Skipping initialization (online-only user or no session)');
    return { attempted: false, ready: Promise.resolve() };
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

  // Fire-and-forget: don't block the app startup chain
  const ready = powerSyncService.initialize(config).then(() => {
    console.info('PowerSync: Initialized successfully, syncing in background');
  }).catch(err => {
    console.error('PowerSync: Initialization failed (falling back to PouchDB)', err);
    // Non-fatal: swallow the error so callers of `ready` don't get unhandled rejections
  });

  return { attempted: true, ready };
}
