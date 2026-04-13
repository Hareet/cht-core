# Agent 5: Device-Adaptive PowerSync Web SDK

## Iteration 2 — Device-Ready Implementation

### Objective
Harden the PowerSync Web SDK integration for the MoH Côte d'Ivoire device fleet. The existing PowerSync client (from Iteration 1) uses hardcoded defaults. This iteration makes it **device-aware** — adapting cache size, VFS selection, and storage monitoring to the actual hardware it's running on.

> **READ FIRST**: `context/BENCHMARK_DEVICE_GAP_ANALYSIS.md` — Contains critical corrections from MCP validation. Key findings:
> - `IDBBatchAtomicVFS` is the default VFS (not OPFS) — explicit `OPFSCoopSyncVFS` config is the #1 priority
> - `fetchStrategy` and `cacheSizeKb` may NOT exist in the Web SDK API — verify against actual TypeScript types before using
> - Use `PRAGMA cache_size` as fallback for cache tuning
> - Use Prioritized Sync (`waitForFirstSync({ priority: 1 })`) instead of `fetchStrategy: 'sequential'`
> - Benchmark numbers from `tests/scalability/` are NOT transferable — they used `@powersync/node` + `better-sqlite3` + Rust sync client

**Why this matters**: 56.3% of the fleet is Android 10 Go edition with ~11GB storage and pinned WebView 122. These devices have aggressive process killing, limited RAM (2GB), and constrained OPFS quotas. The PowerSync client must be tuned per device or Go edition users will hit storage exhaustion, slow WASM startup, and degraded sync performance.

## Scope
- **Primary directory**: `webapp/src/ts/services/powersync/`
- **Also modify**: `webapp/src/sw.js` (service worker WASM caching)
- **May read**: `shared-libs/cht-datasource/`, `context/powersync-hardware-analysis.md`, `devices.json`, `.agents/skills/powersync/`
- **Do NOT modify**: `api/`, `sentinel/`, `shared-libs/cht-datasource/`, `shared-libs/rules-engine/`

## Phase Dependency
Phase 3 (PowerSync running). Device detection and adaptive config code can start at Phase 0.

## Iteration 1 Completed Work
Review what already exists before writing anything:
- `powersync.service.ts` — Main PowerSync client service
- `powersync-schema.ts` — SQLite table schema
- `powersync-connector.ts` — Backend connector (JWT auth, uploadData)
- `powersync-contacts.service.ts` — Contact query layer
- `powersync-init.ts` — Initialization orchestration
- `dev-token-provider.ts` — Dev mode token generation
- Unit tests in `webapp/tests/karma/ts/services/powersync/`

**First action**: Read ALL existing PowerSync files before creating anything new.

## Tasks — Ordered by Priority

### Phase 0: Audit (do first)
1. **Audit existing config**: Read `powersync.service.ts` and `powersync-init.ts`. Document what's hardcoded (cacheSizeKb, fetchStrategy, VFS selection). Check if `navigator.storage.persist()` is called anywhere.
2. **Audit VFS fallback**: Check if `IDBBatchAtomicVFS` fallback is explicitly configured or relies on PowerSync SDK auto-detection. Determine if VFS selection is logged.
3. **Audit upload queue**: Read `powersync-connector.ts` — does `uploadData()` handle storage-critical scenarios? What happens on 5xx retry loops when device is at <50MB free?

### Phase 1: Device Adaptive Layer
4. **Create DeviceTierService**: NEW file `device-tier.service.ts`
   ```typescript
   interface DeviceTier {
     tier: 'go' | 'budget' | 'standard' | 'high';
     opfsAvailable: boolean;
     storageFreeGB: number;
     storageTotalGB: number;
     webviewMajor: number;
   }
   ```
   - Detection: `navigator.storage.estimate()` for storage, `navigator.storage.getDirectory()` for OPFS feature detection (don't rely on UA parsing)
   - Thresholds from real telemetry: `<16GB` → go (56.3%), `16-32GB` → budget (19.0%), `32-128GB` → standard (14.1%), `128GB+` → high (6.4%)
   - Expose as injectable Angular service

5. **Wire adaptive config into PowerSync init**: MODIFY `powersync.service.ts` and `powersync-init.ts`
   
   **CRITICAL — VFS Configuration**: The PowerSync Web SDK defaults to `IDBBatchAtomicVFS` (IndexedDB). You MUST explicitly set `OPFSCoopSyncVFS`:
   ```typescript
   import { PowerSyncDatabase, WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web';
   const db = new PowerSyncDatabase({
     schema: CHTSchema,
     database: new WASQLiteOpenFactory({
       dbFilename: 'cht-powersync.db',
       vfs: WASQLiteVFS.OPFSCoopSyncVFS,
     }),
     flags: { enableMultiTabs: false } // Android doesn't support multi-tab
   });
   ```
   
   **Cache tuning** — verify `cacheSizeKb` exists in `WASQLiteOpenFactory` types. If not, use raw SQL after DB init:
   ```typescript
   await db.execute('PRAGMA cache_size = ?', [isGoEdition ? -10240 : -51200]); // negative = KiB
   ```
   
   - Config matrix:

     | Tier | PRAGMA cache_size | DB size budget |
     |------|------------------|----------------|
     | go | -10240 (10MB) | 200MB |
     | budget | -25600 (25MB) | 500MB |
     | standard | -51200 (50MB) | 1GB |
     | high | -51200 (50MB) | 2GB |

   - Call `navigator.storage.persist()` on init for all tiers
   - Log device tier + selected VFS to CHT telemetry on every app start
   - Use `waitForFirstSync({ priority: 1 })` instead of plain `waitForFirstSync()` — contacts appear before full sync

6. **Create StorageHealthMonitor**: NEW file `storage-health.service.ts`
   - Check `navigator.storage.estimate()` every 5 minutes during active sync
   - Thresholds: `warning` at <100MB free or >60% quota, `critical` at <50MB free or >80% quota
   - On warning: show notification via CHT's existing snackbar/notification service
   - On critical: pause non-essential sync, show persistent alert
   - Log all storage metrics to CHT telemetry

### Phase 2: WASM Startup Optimization
7. **Service worker WASM caching**: MODIFY service worker config
   - Ensure `wa-sqlite` `.wasm` binary is in the precache manifest
   - Verify compiled WASM module is cached (not just the binary)
   - Add `Cache-Control: immutable` for `.wasm` assets in build config

8. **Non-blocking PowerSync init**: MODIFY `powersync-init.ts`
   - Current: app blocks on WASM compilation + DB open
   - Target: app loads → shows CHT loading UI → WASM compiles in background Web Worker → PowerSync ready → transition to live sync
   - Must not break dual-mode (PouchDB/PowerSync) init path
   - On Go edition: show "Preparing offline database..." message during compile

### Phase 4: VFS Fallback & Telemetry
9. **Explicit VFS selection with telemetry**: MODIFY `powersync-init.ts`
   - Feature-detect OPFS: `navigator.storage.getDirectory()` in a try/catch
   - On OPFS failure: explicitly configure `IDBBatchAtomicVFS`, log VFS selection
   - On OPFS success: use `OPFSCoopSyncVFS`, log VFS selection
   - Log which VFS was selected to CHT telemetry (field: `powersync_vfs`)
   - For desktop browser users (no APK): verify cross-browser VFS works (Chrome/Firefox/Safari)

10. **Desktop browser compatibility**: Verify PowerSync Web SDK works for the 112 supervisor/admin users accessing via desktop browsers (no APK, 4.3% of fleet). Document any polyfills or adapter code needed.

### Phase 7: Feature Flag Client-Side
11. **Client-side feature flag consumer**: Check `app_settings.powersync.enabled` on init
    - If disabled for user's facility: instantiate PouchDB (existing path)
    - If enabled: instantiate PowerSync (new path)
    - Support mid-session disable: if admin disables PowerSync for a facility, next sync cycle falls back to PouchDB
    - Must coordinate with Agent 1's server-side feature flag API

### Testing
12. **Unit tests** for all new services:
    - `device-tier.service.spec.ts` — mock `navigator.storage`, test all tier thresholds
    - `storage-health.service.spec.ts` — mock quota, test warning/critical thresholds
    - Updated `powersync-init.spec.ts` — VFS selection, non-blocking init
    - Updated `powersync.service.spec.ts` — adaptive config application
13. Run `npm run unit-webapp` after each change. Do not batch.

## Key Context — Device Fleet

**Read `context/powersync-hardware-analysis.md` before starting.** Key numbers:

- 56.3% of devices are Go edition: ~11GB total, ~10GB free on fresh install, Android 10, WebView 122 pinned
- OPFS quota is ~60% of disk on Chrome/WebView — Go edition gets ~6GB OPFS max
- WASM compilation takes 3-8 seconds on Go edition MediaTek processors (Helio A22)
- 66 telemetry entries show <1GB free — across ALL tiers, not just Go
- 22 non-OPFS users: 14 are desktop browsers (Firefox/Safari), 6 are old-WebView Android
- Android Go has aggressive process killing — upload queue must survive app force-close

**PowerSync SDK reference**: `.agents/skills/powersync/references/sdks/powersync-js.md`

**Known gotchas** (from Iteration 1):
- `connect()` is fire-and-forget; use `waitForFirstSync()` for readiness
- `transaction.complete()` is mandatory or upload queue stalls permanently
- Never define `id` column in PowerSync table schema
- `@powersync/web` has CJS compatibility issues — ensure `"type": "module"` or use dynamic import

## Success Criteria
- DeviceTierService correctly classifies all 4 tiers using `navigator.storage.estimate()`
- PowerSync config adapts to device tier (cacheSizeKb, fetchStrategy verified in tests)
- StorageHealthMonitor fires warning at <100MB, critical at <50MB
- WASM `.wasm` binary is in service worker precache manifest
- PowerSync init is non-blocking (app interactive before WASM compile finishes)
- VFS selection logged to telemetry (OPFS vs IndexedDB)
- IndexedDB fallback works for non-OPFS devices (verified by Agent 7's tests)
- `npm run unit-webapp` passes with all new tests
- Feature flag client-side: PouchDB/PowerSync path selected by `app_settings` flag
