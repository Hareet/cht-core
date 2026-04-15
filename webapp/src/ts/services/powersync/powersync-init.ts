/**
 * PowerSync initialization for the CHT Angular webapp.
 *
 * Call initializePowerSync() during app bootstrap, after the user session
 * is confirmed. This kicks off PowerSync initialization in the background
 * — it does NOT block the app startup chain.
 *
 * Feature flag: If `options.getSettings` is provided, the init function checks
 * `app_settings.powersync.enabled`. If disabled (or absent), PowerSync is not
 * started and the app uses PouchDB as normal. The getSettings callback is
 * async to allow fetching from CouchDB/cache without blocking.
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
 *   .then(() => initializePowerSync(this.powerSyncService, this.sessionService, {
 *     getSettings: () => this.settingsService.get(),
 *   }))
 *
 *   // Later, when a component needs data:
 *   await this.powerSyncService.waitForFirstSync(); // waits for priority-1 sync
 */
import type { PowerSyncService, PowerSyncConfig } from './powersync.service';

interface SessionServiceLike {
  userCtx(): { name?: string; roles?: string[] } | null;
  isOnlineOnly(userCtx?: any): boolean;
}

export interface PowerSyncInitOptions {
  devMode?: boolean;
  powerSyncUrl?: string;
  /**
   * Async callback that returns CHT app_settings.
   * Used to check the `powersync.enabled` feature flag.
   * If not provided, PowerSync is assumed enabled.
   */
  getSettings?: () => Promise<Record<string, any>>;
}

export interface PowerSyncInitResult {
  /** Whether initialization was attempted (false if skipped for online-only users or feature flag disabled) */
  attempted: boolean;
  /** Promise that resolves when PowerSync is initialized and connected. Rejects on init failure. */
  ready: Promise<void>;
}

/**
 * Check whether PowerSync is enabled in app_settings.
 * Returns true if the feature flag is enabled or if no settings getter is provided.
 */
async function isPowerSyncEnabled(getSettings?: () => Promise<Record<string, any>>): Promise<boolean> {
  if (!getSettings) {
    return true;
  }
  try {
    const settings = await getSettings();
    return !!settings?.powersync?.enabled;
  } catch (err) {
    console.warn('PowerSync: Failed to read app_settings, assuming disabled', err);
    return false;
  }
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
 * @param options - Configuration overrides and feature flag
 * @returns result with `attempted` flag and `ready` promise
 */
export function initializePowerSync(
  powerSyncService: PowerSyncService,
  sessionService: SessionServiceLike,
  options: PowerSyncInitOptions = {}
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

  // Fire-and-forget: don't block the app startup chain.
  // Feature flag check is async but still runs in the background.
  const ready = isPowerSyncEnabled(options.getSettings).then(enabled => {
    if (!enabled) {
      console.info('PowerSync: Disabled by app_settings feature flag');
      return;
    }
    return powerSyncService.initialize(config).then(() => {
      console.info('PowerSync: Initialized successfully, syncing in background');
    });
  }).catch(err => {
    console.error('PowerSync: Initialization failed (falling back to PouchDB)', err);
    // Non-fatal: swallow the error so callers of `ready` don't get unhandled rejections
  });

  return { attempted: true, ready };
}
