# Browser Integration Debugging: PowerSync WebSocket Connection

**Status**: RESOLVED (2026-04-16) — PowerSync SDK fully operational in headless Chromium. WASM SQLite writes confirmed at 34ms avg.

**Impact**: Browser-based write path benchmarks now measure real WASM SQLite performance instead of falling back to Node.js.

---

## Root Causes Found (3 separate issues)

### 1. PRAGMA before connect() — deadlocked worker init
`powersync.service.ts` called `await this.db.execute('PRAGMA cache_size ...')` before `db.connect()`. With `useWebWorker: true`, the WASM worker hasn't initialized until `connect()` starts it. The `execute()` sent a message to an uninitialized worker and awaited a response that never came, deadlocking the entire init chain. `connect()` on the next line never ran.

**Fix**: Moved PRAGMA to fire-and-forget `.catch()` after `connect()`. connect() initializes the worker, so execute calls after it succeed.

**File**: `webapp/src/ts/services/powersync/powersync.service.ts`

### 2. Worker JS file 404 — nginx proxy intercepted static assets
The worker file at `/powersync/worker/WASQLiteDB.umd.js` was caught by the nginx `location /powersync/` block, which proxied it to the PowerSync sync service (port 8080). The sync service doesn't serve static files, so it returned 404.

**Fix**: Added a regex nginx location block that matches `.js`, `.wasm`, and `.map` files under `/powersync/` and serves them from the API instead of proxying to the sync service. Regex locations take priority over prefix locations in nginx.

**File**: `.devcontainer/powersync-config/nginx-powersync.conf`
```nginx
location ~ ^/powersync/.*\.(js|wasm|map)$ {
    proxy_pass http://api:5988$request_uri;
}
```

### 3. WASM files in wrong directory — webpack publicPath mismatch
The Angular build placed `.wasm` files in `powersync/worker/` but webpack's auto-detected `publicPath` in the worker resolved to `/powersync/` (one level up). The worker tried to load `https://nginx/powersync/ca59e...wasm` but the file was at `powersync/worker/ca59e...wasm`.

**Fix**: Added duplicate `.wasm` asset copy in `angular.json` — files now exist at both `powersync/worker/` (for direct references) and `powersync/` (for webpack chunk loading).

**File**: `webapp/angular.json`

## What Works Now

- PowerSync Web SDK initializes in headless Chromium
- WASM worker loads from same-origin HTTPS (`/powersync/worker/WASQLiteDB.umd.js`)
- wa-sqlite WASM binary compiles successfully
- `db.execute()` works — SELECT and INSERT both succeed
- `connected: true, hasSynced: true` — full sync stream operational
- All 6 sync streams active (all_data, unassigned_reports, tasks, global_config, user_settings_doc, user_meta)
- Initial sync: 116.3MB in ~90s
- WASM SQLite write: **34ms avg** (23-47ms range) on standard tier, unthrottled

## VFS Notes

- **IDBBatchAtomicVFS**: Confirmed working in headless Chromium. Uses IndexedDB as backend.
- **AccessHandlePoolVFS (OPFS)**: Untested with the fixed worker path. The standalone Blob-URL OPFS test failed because Blob URL workers can't access OPFS — but the real PowerSync worker loads from a same-origin HTTPS URL, which may work. Use `FORCE_VFS=idb` env var to force IDB, omit to test OPFS.
- The `__CHT_FORCE_VFS` window override is supported in `powersync.service.ts` for benchmark testing.

## Remaining Issues

### Upload 403 (non-blocking)
The PowerSync upload handler returns `{"error":"forbidden","reason":"Insufficient privileges"}` for benchmark writes. The `chw_test_1` user's permissions don't allow writing `reports` via the PowerSync upload endpoint. This is an auth/permission configuration issue, not a sync issue.

### Deploy Workflow
Building the webapp requires copying the output to the API container:
```bash
# Rebuild
docker exec cht-agent-7 bash -c 'cd /workspace/cht-core/webapp && npx ng build --configuration development'
# Copy to API (note trailing dots for content-only copy)
rm -rf /tmp/cht-webapp-build && \
docker cp cht-agent-7:/workspace/cht-core/api/build/static/webapp/. /tmp/cht-webapp-build/ && \
docker cp /tmp/cht-webapp-build/. cht-api:/service/api/build/static/webapp/
```

## Benchmark Usage

```bash
# Default: OPFS VFS (AccessHandlePoolVFS)
CHT_ROLE=chw_min_5km DEVICE_TIER=standard SKIP_NETWORK_THROTTLE=1 TEST=powersync \
  node benchmark-write-path.js chw_test_1 'Secret1!pass'

# Force IDB VFS
FORCE_VFS=idb CHT_ROLE=chw_min_5km DEVICE_TIER=standard SKIP_NETWORK_THROTTLE=1 TEST=powersync \
  node benchmark-write-path.js chw_test_1 'Secret1!pass'

# Go edition (4x CPU throttle, 3G network)
CHT_ROLE=chw_min_5km DEVICE_TIER=go TEST=powersync \
  node benchmark-write-path.js chw_test_1 'Secret1!pass'
```

## Files Modified

| File | Change |
|------|--------|
| `webapp/src/ts/services/powersync/powersync.service.ts` | PRAGMA after connect(), `__CHT_FORCE_VFS` override |
| `webapp/angular.json` | Duplicate .wasm asset copy to `powersync/` |
| `.devcontainer/powersync-config/nginx-powersync.conf` | Regex location for static assets |
| `tests/benchmark/benchmark-write-path.js` | Noise filter, browser batch/upload tests, FORCE_VFS env var |
