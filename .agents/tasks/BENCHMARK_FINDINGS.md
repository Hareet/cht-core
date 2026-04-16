# Benchmark Findings: PouchDB/CouchDB vs PowerSync/PostgreSQL

**Date**: 2026-04-16
**Dataset**: MoH Côte d'Ivoire config, ~20K docs per CHW, ~810K total docs
**Test users**: chw_test_1 through chw_test_10 (role: chw_min_5km)
**Device fleet**: 2,611 users — 56.3% Go edition, 19% Budget, 14.1% Standard, 6.4% High

---

## Tests Completed

### 1. Initial Sync — Go Edition, 3G Throttled (Puppeteer CDP)

| Metric | PouchDB/CouchDB | PowerSync/PostgreSQL |
|--------|----------------|---------------------|
| Full sync time | **223s** | **232s** |
| Login → app loaded | 29.8s | 32.5s |
| First data available | ~10s | ~9s |
| Local DB size | 72.1MB | 88.3MB |
| JS heap | 18.6MB | 56.5MB |
| Wire transfer | ~72MB | ~1.3MB (compressed) |

**Verdict**: Near-identical sync times on 3G. Both are network-bound at 200KB/s. PowerSync transfers 55x less data but WASM SQLite writes under CPU throttle consume the time savings.

### 2. Initial Sync — Go Edition, WiFi/Unthrottled (Puppeteer CDP)

| Metric | PouchDB/CouchDB | PowerSync/PostgreSQL |
|--------|----------------|---------------------|
| Full sync time | **95s** | **115s** |
| Login → app loaded | 17s | 32s |
| Local DB size | 72.1MB | 88.7MB |
| JS heap | 21.6MB | 59.6MB |

**Verdict**: PouchDB wins on Go edition WiFi (95s vs 115s). PouchDB's IndexedDB writes (native browser engine) are faster than PowerSync's WASM SQLite writes under 4x CPU throttle. The 32s app load for PowerSync includes WASM compilation.

### 3. Initial Sync — Budget Edition, WiFi/Unthrottled (Puppeteer CDP)

| Metric | PouchDB/CouchDB | PowerSync/PostgreSQL |
|--------|----------------|---------------------|
| Full sync time | ~95s | **105s** |
| JS heap | 21.6MB | 59.6MB |

**Verdict**: Similar to Go edition. Budget's 2x CPU throttle (vs 4x) and 1GB heap (vs 512MB) don't significantly change the picture — the bottleneck is WASM write throughput, not RAM.

### 4. Initial Sync — Unthrottled Node.js (@powersync/node, native SQLite)

| Metric | PowerSync/PostgreSQL |
|--------|---------------------|
| DB init | 498ms |
| Priority-1 sync (contacts) | **2.9s** |
| Full sync | **5s** |
| Contacts | 341 |
| Reports | 11,984 |
| SQLite DB size | 91.6MB |
| Task list query | 1ms |
| Contact query | 1ms |
| Report query | 51ms |

**Verdict**: PowerSync's sync engine itself is extremely fast. The 5s represents the true server→client pipeline without WASM overhead. The browser benchmarks (115s-232s) are dominated by client-side WASM processing.

### 5. Incremental Sync Roundtrip (Node.js, no throttle, no polling interval)

| Metric | PouchDB/CouchDB | PowerSync/PostgreSQL |
|--------|----------------|---------------------|
| **Nothing changed (idle)** | **2,993ms** | **0ms** |
| **1 new doc roundtrip** | **2,574ms** | **713ms** |
| get-ids scan time | 2,556ms (99% of roundtrip) | N/A |
| get-ids response size | 1,807KB | N/A |
| Insert to DB | 17ms (CouchDB) | 211ms (PostgreSQL) |
| DB → client detection | 1ms (bulk_get) | 502ms (WAL → PowerSync → client) |

**Verdict**: PowerSync is **3.6x faster** for incremental sync. The critical finding: PouchDB's `get-ids` costs ~3s EVERY sync cycle regardless of changes, scanning 810K docs. PowerSync's WebSocket push costs 0ms when idle and ~500ms when 1 doc changes. This is O(total_docs) vs O(changed_docs).

### 6. Server Load Projection

| Metric | PouchDB/CouchDB | PowerSync/PostgreSQL |
|--------|----------------|---------------------|
| Cost per idle sync cycle | 2,993ms CouchDB CPU | 0ms |
| Daily calls (2,611 users, 5-min interval) | ~750K get-ids calls | 0 polling calls |
| Daily CouchDB CPU | **625 hours** | **0 hours** |
| At national scale (5M docs) | ~18.5s per get-ids call | Still 0ms idle |

---

## Key Architectural Findings

### PowerSync OOM with JOINs
The PowerSync service (v1.20.4) crashes with OOM (>6GB V8 heap) when Sync Stream queries contain `INNER JOIN` against large auxiliary tables. Fixed by denormalizing all filtering onto `v1.couchdb` columns — zero JOINs in any Sync Stream query. PowerSync docs recommend 1GB per API container with simple WHERE clauses.

### Bucket Optimization Journey
| Step | accessible_facilities | Buckets | Ops/20K docs |
|------|----------------------|---------|-------------|
| Initial | 224 | 453 | 99K (5x amplification) |
| Leaf-place elimination | 14 | 33 | 50K (2.5x) |
| Person ID removal | 7 | 19 | ~20K (1x) |
| Denormalized columns (no JOINs) | 7 | 18 | ~4.6K (working) |

### `doc` Column Doubles Client Memory
The PowerSync client schema stores both extracted columns AND the full JSON blob (`doc` TEXT column). This accounts for most of the 88MB storage and 56MB heap. Dropping `doc` from reports (safe variant) would reduce to ~55MB storage and ~35MB heap — viable for Go edition.

---

## Previously Completed: Concurrent Load Test (tests/scalability/)

Concurrent benchmarks were run in an earlier session using the existing jMeter framework with 589K docs, 120 CHW users (~15K docs each), tested at 10/20/30/40/50 concurrent users. Full report: `tests/scalability/benchmark_results_scaled/scaled-comparison-report.md`.

### Concurrent Incremental Sync Results

| Concurrency | CouchDB get-ids | PowerSync Incremental | Ratio |
|-------------|----------------|----------------------|-------|
| **10** | **10.8s** (4.5-14.4s) | **335ms** (52ms-2.4s) | **32x** |
| **20** | **22.5s** (6.2-28.9s) | **773ms** (102ms-4.3s) | **29x** |
| **30** | **30.0s** (6.2-39.2s) | **1.0s** (0.1-3.8s) | **29x** |
| **40** | **38.3s** (10.2-53.0s) | **1.5s** (0.1-5.3s) | **26x** |
| **50** | **52.4s** (9.6-1m 7s) | **1.8s** (0.1-7.3s) | **30x** |

**PowerSync is 26-32x faster** across all concurrency levels with zero failures in 6,000 total iterations.

The comparison is asymmetric and favors CouchDB: CouchDB's time measures ONLY the ID list (get-ids). Actual document download via `_bulk_get` would add more time. PowerSync's time measures the COMPLETE round trip — from PostgreSQL INSERT to document appearing in local SQLite.

### Percentile Detail

| Concurrency | CouchDB P50 | CouchDB P95 | PowerSync P50 | PowerSync P95 |
|-------------|------------|------------|---------------|---------------|
| 10 | 11.8s | 14.4s | 304ms | 680ms |
| 20 | 25.3s | 28.9s | 607ms | 1,911ms |
| 30 | 35.3s | 39.2s | 842ms | 2,363ms |
| 40 | 47.0s | 52.5s | 1,226ms | 3,344ms |
| 50 | 59.8s | 1m 6s | 1,567ms | 3,720ms |

### Degradation Curve

Both engines degrade at similar rates (~5x at concurrency 50) because both contend for a shared resource (Nouveau index for CouchDB, WAL pipeline for PowerSync). The critical difference is the baseline: CouchDB starts at 10.8s, PowerSync starts at 335ms.

### Why Client-Throttled Concurrent Tests Are Unnecessary

The existing concurrent benchmarks measure the server-side sync engine — which is what scales with user count. Client-side throttling (Go edition CPU/network) is an independent dimension:
- The server doesn't care how fast the client's CPU is
- The client doesn't care how many other clients are connected
- Server contention (measured: 26-32x PowerSync advantage) × client processing speed (measured: ~115s Go edition) are independent factors

The existing concurrent benchmarks (up to 50 users) combined with our single-user throttled benchmarks (Go edition timing/heap) cover both dimensions.

---

## Tests Still Needed

### Priority 1: Option B Safe Variant (Drop `doc` from Reports)
- **What**: Remove `CAST(doc AS TEXT) AS doc` from report Sync Stream queries, keep `fields` JSON
- **Why**: Reduces PowerSync client memory from 56MB to ~35MB heap, making Go edition viable. This is the key blocker for deploying PowerSync to 100% of the fleet.
- **How**: Agent 3 updates sync-config, Agent 5 updates schema, Agent 6 updates rules engine adapter
- **Design doc**: `context/NEXT_PHASE_IMPLEMENTATION.md` (Option B safe variant)
- **Then benchmark**: Re-run Go edition browser benchmark, verify heap reduction to ~35MB and storage to ~55MB
- **Agent assignments**: 3 (sync-config) → 5+6 parallel (schema + adapter) → 7 (tests)

### Priority 2: Write Path Benchmark
- **What**: Offline form submission → local persist → upload queue → server → confirm
- **Why**: Read sync is only half the story. CHWs submit forms offline and need them uploaded reliably. PowerSync's upload queue behavior under storage pressure (Go edition) is untested.
- **How**: In Puppeteer with Go edition throttle, trigger form submission, measure time to local persist and time to server confirmation via upload queue drain
- **Measures**: Form submission latency, upload queue drain time, offline reliability, upload queue behavior on force-close

### Priority 3: Real Device Testing (BrowserStack / Firebase Test Lab)
- **What**: Run benchmarks on actual Tecno Pop 5 Go / Itel A27 hardware
- **Why**: CDP throttling approximates Go edition but isn't identical. Real WASM compile time, real OPFS behavior, real Android Go process killing, real WebView 122 quirks.
- **How**: BrowserStack App Automate or Firebase Test Lab with the device matrix from Agent 7's assignment
- **Measures**: True WASM init time, true sync time, OOM behavior, storage eviction under memory pressure

### Priority 4: Pre-seeded SQLite Benchmark
- **What**: Server generates a pre-built SQLite DB file per CHW, client downloads it instead of syncing from scratch
- **Why**: Eliminates the WASM write bottleneck entirely. Client downloads ~11MB compressed file instead of processing ~20K ops through WASM SQLite. This could make Go edition initial sync <30s on 3G.
- **How**: Use @powersync/node to build the DB server-side (already proven: 5s for full sync), upload to blob storage, client downloads on first launch, then incremental sync from checkpoint
- **Measures**: Download time on 3G, DB open time, first-query latency, incremental sync after pre-seed
- **PowerSync docs reference**: `client-sdks/advanced/pre-seeded-sqlite`

### 7. Write Path Benchmark Results (Partial)

Completed 2026-04-16. Full browser WASM measurement blocked by Worker bundling issue (see below).

| Metric | PouchDB (browser, Go 4x CPU) | PowerSync (Node.js fallback) | PowerSync (est. WASM) |
|--------|------------------------------|-----------------------------|-----------------------|
| Local persist (single) | **14ms avg** (4-87ms) | 1ms | ~2-10ms (est.) |
| Local persist (batch 10) | Not measured | 6ms (0.6ms/doc) | ~10-30ms (est.) |
| Upload to server | **>350s** (sync interval never fired) | **1,001ms** | **~1-2s** |
| Upload mechanism | Sync interval (default 5 min) | `uploadData()` auto-fires | Same |

**Key finding**: PowerSync uploads automatically within ~1 second of a local write. PouchDB uploads on a 5-minute sync interval — in our test, the sync cycle never fired because the app's bootstrap errored before `watchDBSyncStatus` initialized. In production, PouchDB would upload within 0-5 minutes depending on where in the cycle the write occurred.

**Blocked by**: PowerSync Web SDK Worker files not bundled into Angular build output. The `WASQLiteDB.worker.js` is loaded from `node_modules/` at runtime which is blocked by the browser's origin security policy. Agent 5 needs to configure the Angular/webpack build to copy Worker + WASM files into the build output. This is the same issue that blocked the standalone browser benchmark earlier.

**What Agent 5 needs to fix**:
1. Configure Angular CLI / webpack to bundle `@powersync/web` Worker files into the webapp build output
2. Set the Worker URL in `WASQLiteOpenFactory` to point to the bundled location
3. Ensure `.wasm` files are served with correct `Content-Type: application/wasm` and COOP/COEP headers
4. After fix: re-run write path benchmark with `TEST=powersync` to get real WASM persist latency

### Deprioritized

- **Concurrent load test with client throttling** — Not needed. Server contention is independent of client speed. Existing concurrent benchmarks (10-50 users, 26-32x PowerSync advantage) + single-user throttled benchmarks cover both dimensions. See "Why Client-Throttled Concurrent Tests Are Unnecessary" above.
- **PouchDB incremental via browser** — Partially addressed by the roundtrip benchmark (get-ids: 2,993ms mechanism time). Full browser measurement blocked by PouchDB's 5-minute sync interval; the mechanism time is what matters for comparison.

---

## Files Created During Benchmarking

### Benchmark Scripts
| File | Purpose |
|------|---------|
| `tests/benchmark/benchmark-pouchdb.js` | PouchDB initial sync via Puppeteer, Go edition throttling |
| `tests/benchmark/benchmark-powersync-browser.js` | PowerSync initial sync via Puppeteer, configurable device tier |
| `tests/benchmark/benchmark-powersync-node.js` | PowerSync initial sync via @powersync/node (unthrottled) |
| `tests/benchmark/benchmark-incremental-roundtrip.js` | Both engines: get-ids vs WAL delta, measures mechanism not interval |
| `tests/benchmark/benchmark-pouchdb-incremental.js` | PouchDB incremental via Puppeteer (polls PouchDB for new doc) |
| `tests/benchmark/benchmark-powersync-incremental.js` | PowerSync incremental via Puppeteer (inserts to PG, monitors storage) |
| `tests/benchmark/benchmark-powersync-standalone.js` | Standalone browser PowerSync (WASM loading issues, incomplete) |
| `tests/benchmark/benchmark-powersync-throttled.js` | TCP proxy throttling (WebSocket compat issues, incomplete) |
| `tests/benchmark/benchmark-full-suite.js` | Combined runner: PouchDB + PowerSync + incremental per tier |
| `tests/benchmark/compare-results.js` | Results comparison table |

### Utility Scripts
| File | Purpose |
|------|---------|
| `tests/benchmark/analyze-buckets.js` | Bucket count analyzer per user |
| `tests/benchmark/debug-login.js` | CHT login flow debugger for Puppeteer |
| `tests/benchmark/fix-user-password.js` | Reset user password + clear must_change_password flag |
| `tests/benchmark/ps-quick-test.js` | 60-second PowerSync connectivity/sync test |
| `tests/benchmark/check-sdk.js` | PowerSync SDK API export inspector |
| `tests/benchmark/check-column.js` | PowerSync Column/Table API verifier |
| `tests/benchmark/check-user.js` | CouchDB user doc inspector |
| `tests/benchmark/check-wasm-sizes.js` | WASM binary size scanner |
| `tests/benchmark/check-pg-user.js` | PostgreSQL user_settings checker |
| `/tmp/set-powersync-flag.js` | Toggle PowerSync feature flag (on agent containers) |

### Prior Benchmark Results (from earlier sessions)
| File | Purpose |
|------|---------|
| `tests/scalability/benchmark_results_scaled/scaled-comparison-report.md` | Concurrent load test: 10-50 users, CouchDB vs PowerSync, 26-32x advantage |
| `tests/scalability/benchmark_results_scaled/*.jsonl` | Raw concurrent benchmark data per concurrency level |
| `tests/scalability/benchmark_results_isolated/isolated-comparison.md` | Isolated (no couch2pg) benchmark comparison |
| `tests/scalability/benchmark_results/incremental-comparison.md` | Initial incremental comparison results |

### Design Documents
| File | Purpose |
|------|---------|
| `.agents/tasks/BENCHMARK_FINDINGS.md` | This file — complete benchmark results |
| `context/NEXT_PHASE_IMPLEMENTATION.md` | Option A (dual-backend) vs Option B (drop doc) design |
| `.agents/tasks/CONCURRENT_BENCHMARK_PLAN.md` | Concurrent load test design and implementation plan |
| `tests/benchmark/README.md` | How to run the benchmark scripts |
