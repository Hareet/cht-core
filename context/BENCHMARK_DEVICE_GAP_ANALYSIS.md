# Benchmark vs Device Reality: Gap Analysis

**Date:** 2026-04-12
**Branch:** `playtime`
**Purpose:** Validate whether `tests/scalability/` benchmark results are transferable to the MoH Côte d'Ivoire Go edition device fleet, and identify corrections to the device-ready implementation plan.

---

## 1. Critical Mismatch: Benchmarks Run a Different SDK

Our benchmarks use **`@powersync/node`** with **`better-sqlite3`**. The actual devices will run **`@powersync/web`** with **`wa-sqlite`** (WASM). These are fundamentally different runtimes.

| Factor | Benchmark (`tests/scalability/`) | Android Go Device (WebView) |
|--------|----------------------------------|----------------------------|
| **SDK** | `@powersync/node@^0.12.0` | `@powersync/web@^1.37.1` |
| **SQLite engine** | `better-sqlite3` (native C, WAL mode) | `wa-sqlite` (WASM, single connection) |
| **Sync client** | `SyncClientImplementation.RUST` (native compiled) | JavaScript sync client (WASM boundary) |
| **Concurrency** | WAL mode + concurrent readers | Single connection, serialized reads/writes |
| **Storage** | `/dev/shm` (RAM-backed tmpdir) | OPFS (~6GB quota on 11GB device) |
| **Heap** | `--max-old-space-size=28672` (28GB) | ~256-512MB WebView process limit |
| **Network** | Localhost WebSocket | TLS over internet |
| **Startup** | Milliseconds (native module load) | 3-8 seconds (WASM compilation on MediaTek) |

### What DOES transfer from benchmarks

- **Architectural validation**: PowerSync Sync Streams design works; bucket consolidation (16K→59) is correct
- **Server-side performance**: PostgreSQL + PowerSync Service throughput numbers are real
- **Relative comparison**: PowerSync >> CouchDB at concurrency — this ratio holds regardless of client SDK
- **Schema design**: Column definitions, indexes, sync stream YAML — device-agnostic
- **Authorization model**: JWT claims, facility hierarchy filtering — device-agnostic

### What DOES NOT transfer

- **Absolute latency numbers**: Benchmark shows 561ms median @ concurrency=1. On Go edition, expect **800ms-1.5s** due to WASM overhead + OPFS I/O + single connection serialization
- **Concurrency scaling**: Benchmark tests 10-200 concurrent users with separate native SQLite databases. On device, it's a single WebView with one SQLite connection. Concurrency benchmarks are irrelevant to client-side performance.
- **Startup time**: Benchmark measures zero startup overhead. On Go edition, add **3-8 seconds** for WASM compilation (cold start) + ~500ms for DB open on OPFS
- **Storage metrics**: Benchmark uses unlimited RAM-backed storage. On Go edition, OPFS quota is ~6GB and 66 devices already have <1GB free.
- **Memory pressure**: Benchmark runs with 28GB heap. On Go edition, the entire WebView process gets ~256-512MB. 60 sync buckets at once may cause memory pressure.

---

## 2. API Corrections: `fetchStrategy` and `cacheSizeKb`

### `fetchStrategy: 'sequential' | 'buffered'` — NOT IN CURRENT WEB SDK DOCS

**Finding**: The PowerSync Web SDK docs do not document a `fetchStrategy` option on `connect()` or `PowerSyncDatabase`. This option appears in the hardware analysis document citing PowerSync blog posts, but is **not confirmed as a current Web SDK API**.

**Impact**: Agent 5's task to configure `fetchStrategy` per device tier may reference a non-existent API.

**Action required**: 
- Agent 5 MUST check the actual `@powersync/web@1.37.1` TypeScript types for `connect()` options before implementing
- If `fetchStrategy` doesn't exist, the equivalent for Go edition is **Prioritized Sync** (see §5 below) — sync critical streams first, defer large datasets

### `cacheSizeKb` — NOT IN CURRENT WEB SDK DOCS

**Finding**: No `cacheSizeKb` option documented for `PowerSyncDatabase` or `WASQLiteOpenFactory` in the Web SDK. The hardware analysis references this from PowerSync blog posts about wa-sqlite internals.

**Impact**: Agent 5 cannot tune SQLite cache size through the documented PowerSync API.

**Action required**:
- Check if `cacheSizeKb` is a `WASQLiteOpenFactory` constructor option (undocumented but possibly present in types)
- If not available via PowerSync API, can be set via raw SQL: `PRAGMA cache_size = -10240;` (negative = KiB) after DB init
- Document whichever approach works

### `SyncClientImplementation.RUST` — NODE SDK ONLY

**Finding**: The benchmark uses `SyncClientImplementation.RUST` in `initial-sync.js`. This is a Node.js SDK feature — the Rust sync client is compiled as a native module. The Web SDK uses a JavaScript sync client that runs in a Web Worker.

**Impact**: Benchmark sync throughput numbers are inflated relative to what the Web SDK achieves. The Web SDK's JavaScript sync client is slower than the native Rust client.

---

## 3. VFS Configuration: Default is IDBBatchAtomicVFS, NOT OPFS

**Finding from PowerSync docs**: The default VFS for `@powersync/web` is **`IDBBatchAtomicVFS`** (IndexedDB-backed), not OPFS. OPFS requires explicit configuration via `WASQLiteOpenFactory` with `vfs: WASQLiteVFS.OPFSCoopSyncVFS`.

**Impact**: If the current `powersync.service.ts` instantiates `PowerSyncDatabase` with default options, **99.1% of our fleet is running on IndexedDB, not OPFS** — even though they support OPFS.

**Action required for Agent 5**:
- **Audit immediately**: Check if `powersync.service.ts` explicitly sets `OPFSCoopSyncVFS`
- If not set: this is the single biggest performance fix. IndexedDB degrades beyond 100MB. OPFS maintains performance at 1GB+.
- Correct configuration:
  ```typescript
  import { PowerSyncDatabase, WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web';
  
  const db = new PowerSyncDatabase({
    schema: CHTSchema,
    database: new WASQLiteOpenFactory({
      dbFilename: 'cht-powersync.db',
      vfs: WASQLiteVFS.OPFSCoopSyncVFS,
    }),
    flags: {
      enableMultiTabs: false, // Single WebView, no multi-tab needed
    }
  });
  ```
- For the 22 non-OPFS users: the default IDBBatchAtomicVFS fallback handles them automatically if OPFS feature detection fails

---

## 4. Multi-Tab: Confirmed Not Available on Android

**From PowerSync docs**: "Multiple tab support is not currently available on Android."

This confirms the hardware analysis. Since CHT runs in a single WebView inside `cht-android`, this is a non-issue. Agent 5 should set `enableMultiTabs: false` explicitly to avoid spawning unnecessary SharedWorker attempts.

---

## 5. NEW Finding: Prioritized Sync — Critical for Go Edition

**From PowerSync docs** (available since JS Web SDK v1.14.2, we use v1.37.1):

Sync Streams support `priority: 1-3` per stream. Higher priority (lower number) syncs first. This is the correct replacement for the non-existent `fetchStrategy: 'sequential'`.

**Recommended configuration for Agent 3**:

```yaml
streams:
  global_config:
    priority: 0     # Sync FIRST — app_settings, forms, translations needed for UI
    auto_subscribe: true
    query: SELECT * FROM global_config

  all_data:
    priority: 1     # Sync SECOND — contacts needed for navigation
    auto_subscribe: true
    queries:
      - SELECT * FROM contacts WHERE ...
      - SELECT * FROM reports WHERE ...

  tasks:
    priority: 2     # Sync THIRD — tasks can load after contacts visible
    auto_subscribe: true
    query: SELECT * FROM tasks WHERE ...

  user_meta:
    priority: 3     # Sync LAST — telemetry/feedback is lowest priority
    auto_subscribe: true
    query: SELECT * FROM user_meta WHERE ...
```

**Why this matters for Go edition**: 
- User opens app → `global_config` syncs first (priority 0, small dataset, <1s)
- Contacts appear next (priority 1, ~50-100 contacts for a CHW)
- Tasks load in background (priority 2)
- App is usable before full sync completes
- `waitForFirstSync(priority: 1)` makes UI appear after contacts sync, not after everything

**Client-side (Agent 5)**:
```typescript
// Wait for contacts to be available, not full sync
await db.waitForFirstSync({ priority: 1 });
// Now render contacts list — tasks still syncing in background
```

**Action required**: 
- Agent 3: Add `priority` to all Sync Streams
- Agent 5: Use `waitForFirstSync({ priority: 1 })` instead of `waitForFirstSync()`

---

## 6. Performance Expectations: What to Actually Expect on Go Edition

Based on PowerSync docs ("2,000-20,000 ops/sec per client") and the WASM overhead factor:

### Initial Sync (5,000 contacts + 10,000 reports = ~15,000 rows)
- **PowerSync docs rate**: 2,000-20,000 ops/sec per client
- **Conservative for WASM on Go edition**: ~2,000-5,000 ops/sec
- **Estimated time**: 3-8 seconds for data transfer + DB writes
- **Plus WASM compilation**: 3-8 seconds (cold start only)
- **Total initial sync (cold)**: ~10-16 seconds
- **Total initial sync (warm, WASM cached)**: ~3-8 seconds
- **With prioritized sync**: Contacts usable in ~2-4 seconds, full sync completes in background

### Incremental Sync (steady state)
- Typically <100 rows changed since last sync
- **Expected**: <1 second per sync cycle
- This is where PowerSync shines vs CouchDB — no full-database scan

### Form Submission (offline)
- Local SQLite write via WASM: ~5-50ms
- Upload queue persistence: included in above
- **Expected**: <100ms total (well within 500ms target)

### Task List Load During Sync
- SQLite query through WASM: ~10-100ms for SELECT with index
- Single-connection contention: may add 50-200ms if sync write is in progress
- **Expected**: <500ms (within 2-second target, but monitor contention)

---

## 7. Storage Footprint Estimate

### SQLite vs PouchDB/IndexedDB
- PouchDB stores full JSON documents with revision trees (~2x-3x overhead)
- PowerSync SQLite stores normalized columns (no revision overhead)
- **Expected**: 40-60% smaller than current PouchDB footprint for same dataset

### Size estimate for typical CHW
- 50 contacts × ~2KB avg = 100KB
- 200 reports × ~5KB avg = 1MB  
- 30 tasks × ~1KB avg = 30KB
- SQLite overhead (indexes, WAL, etc.) ≈ 2x data size
- **Estimated DB size**: ~2-3MB for typical CHW
- **Estimated DB size for heavy user** (500 contacts, 2,000 reports): ~20-30MB
- **Well within 200MB Go edition budget**

### Risk: OPFS quota
- Go edition gets ~6GB OPFS quota (60% of 10GB)
- CHT SQLite DB: <30MB typical
- Risk is NOT PowerSync — it's WhatsApp, photos, and other apps consuming disk
- StorageHealthMonitor (Agent 5) is the mitigation

---

## 8. Corrections to Agent Assignments

### Agent 5 (PRIORITY — highest impact corrections)
1. **CRITICAL**: Verify OPFS is explicitly configured. If IDBBatchAtomicVFS is the current default, switching to `OPFSCoopSyncVFS` is the single biggest perf win.
2. **REMOVE**: References to `fetchStrategy: 'sequential'` — likely not a Web SDK option. Replace with prioritized sync client-side handling.
3. **REMOVE**: References to `cacheSizeKb` as a constructor option. Use `PRAGMA cache_size` after DB init if needed.
4. **ADD**: `waitForFirstSync({ priority: 1 })` pattern for faster perceived startup on Go edition.
5. **ADD**: Explicitly set `enableMultiTabs: false` (Android doesn't support it anyway).
6. **VERIFY**: Whether the Rust sync client is used in Web SDK v1.37.1 (it was added for Node, may have been ported to web via WASM).

### Agent 3 (Sync Streams)
1. **ADD**: `priority` levels to all Sync Streams:
   - `global_config`: priority 0
   - `all_data` (contacts + reports): priority 1
   - `tasks`: priority 2
   - `user_meta`: priority 3
2. This replaces the `fetchStrategy: 'sequential'` approach with a properly documented, supported mechanism.

### Agent 7 (Testing)
1. **ADD**: Benchmark that uses `@powersync/web` (not `@powersync/node`) to get realistic numbers
2. **ADD**: Test both OPFS and IndexedDB VFS paths explicitly
3. **ADD**: Measure WASM compilation time separately from sync time
4. **REVISE**: Success criteria — initial sync target should be ~10-16 seconds cold, ~3-8 seconds warm (not the benchmark's sub-second numbers)

---

## 9. New Risks Identified

### Risk: Rust Sync Client Status in Web SDK
The benchmark uses `SyncClientImplementation.RUST` (Node SDK). The PowerSync JS SDK v1.34+ changelog mentions a Rust-based sync client. **Unknown**: Is this available in the Web SDK, or only Node? If available in web (compiled to WASM), sync throughput is better than assumed. If not, the JavaScript sync client is the bottleneck.

**Mitigation**: Agent 5 checks `@powersync/web` exports for `SyncClientImplementation`.

### Risk: WebView WASM Cache Eviction
Android Go aggressively clears app caches. If the compiled WASM module is evicted, every app open incurs the 3-8 second compilation penalty.

**Mitigation**: 
- Service worker WASM caching (Agent 5, Phase 2)
- `navigator.storage.persist()` to request durable storage
- If eviction is frequent, Path B (Capacitor native SQLite) eliminates WASM entirely

### Risk: `NOT EXISTS` Subquery Performance in Sync Streams
The purge exclusion pattern `WHERE NOT EXISTS (SELECT 1 FROM purge_status ...)` is applied per-row in the Sync Stream. PowerSync Sync Streams have JOIN limitations (only INNER JOIN with simple equality). The NOT EXISTS subquery may or may not be supported.

**Mitigation**: Agent 3 must test this against the PowerSync Service before committing to this pattern. Alternative: pre-filter using a materialized view or add a `purged` boolean column to the source tables.

### Risk: 60 Buckets × WASM Memory on 2GB RAM
Each bucket maintains state in the sync client. With 60 buckets, the PowerSync SDK allocates memory for each bucket's checkpoint, operations queue, and sync state. On a 2GB RAM device, this could approach the WebView process memory limit.

**Mitigation**: Agent 7's Go edition memory profiling (Phase 5, Task 9).

---

## 10. Summary: Plan Viability Assessment

| Plan Element | Viability | Notes |
|-------------|-----------|-------|
| Path A (WebView + wa-sqlite + OPFS) | **VIABLE** | 99.1% OPFS support confirmed. Must explicitly configure OPFS (not default). |
| Device tier detection | **VIABLE** | `navigator.storage.estimate()` is available on WebView 122+ |
| Adaptive cache tuning | **NEEDS REVISION** | `cacheSizeKb` not in documented API. Use `PRAGMA cache_size` instead. |
| Sequential fetch strategy | **NEEDS REVISION** | `fetchStrategy` not in documented API. Use Prioritized Sync (stream priority) instead. |
| StorageHealthMonitor | **VIABLE** | `navigator.storage.estimate()` works. `navigator.storage.persist()` available. |
| WASM caching via service worker | **VIABLE** | Standard service worker precaching pattern. |
| Non-blocking init | **VIABLE** | Web Worker isolation is already the default for PowerSync Web SDK. |
| Purge via NOT EXISTS | **NEEDS TESTING** | Sync Streams may not support NOT EXISTS subquery. Test on PowerSync Service. |
| Prioritized sync | **VIABLE, RECOMMENDED** | Supported since Web SDK v1.14.2. Major UX win for Go edition. |
| Feature flags | **VIABLE** | Standard app_settings pattern. |
| IndexedDB fallback | **VIABLE** | IDBBatchAtomicVFS is the default. Works for 22 non-OPFS users. |
| Benchmark transferability | **PARTIAL** | Architecture validated. Absolute numbers not transferable. |

**Overall**: The plan is viable with the corrections in §8. The most important immediate action is verifying that OPFS is explicitly configured (§3) — this alone could be the difference between acceptable and unacceptable performance on Go edition.
