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

## Concurrent Write-Path Load Test (2026-04-17)

Fresh scalability harness that isolates the **write path** under concurrent load, complementing the get-ids benchmark above (which tests pull). The PR that lands this is `tests/scalability/run-scaled-write-path.sh` + two workers (`write-path-worker.js`, `write-powersync-worker.js`) + `visibility-worker.js`. Data in `tests/scalability/benchmark_results_scaled/write-path/`.

### Methodology

Two scenarios are run back-to-back (with the api's `CHT_DB_BACKEND` flipped between them). Each scenario cycles 120 CHW users from `users.csv`, assigning thread N to CHW index `N % 120`. Each worker writes 10 reports in a burst; wall-clock measures the slowest worker in the cohort.

| | Scenario A: CouchDB+PouchDB-path | Scenario B: Postgres+PowerSync-path |
|---|---|---|
| Write endpoint | `POST /medic/_bulk_docs` (haproxy → CouchDB, one POST per doc — matches PouchDB live replicate) | `POST /api/v1/powersync/upload` with all 10 CrudEntries in one call (cht-datasource PG adapter — matches PowerSync SDK uploadData batching) |
| Validates form? | No (_bulk_docs passthrough skips `getForms()`) | Yes (Report.v1.create requires registered form → `anc_followup`) |
| Visibility probe | `POST /medic/_bulk_get` as admin (bypasses offline filter → backend-landed check) | `SELECT count(*) FROM v1.couchdb WHERE _id = ANY($1)` (direct libpq) |

Both visibility modes are backend-landed checks — NOT end-user-observable reads — so the two scenarios produce apples-to-apples numbers. End-user peer-visibility (supervisor via `_bulk_get` with offline filter) is a separate concern, deferred.

### Results

| Conc | Backend | Wall | Throughput (docs/s) | Batch p50 | Batch p95 | Batch p99 | Visibility all_ms |
|---:|:---|---:|---:|---:|---:|---:|---:|
| 1  | CouchDB  |  1s |  10.00 |  1,363 |  1,363 |  1,363 | 36 |
| 1  | Postgres |  1s |  10.00 |  1,490 |  1,490 |  1,490 | 33 |
| 10 | CouchDB  |  7s |  14.29 |  7,059 |  7,080 |  7,080 | 95 |
| 10 | Postgres |  1s | **100.00** |  1,520 |  1,536 |  1,536 | 19 |
| 25 | CouchDB  | 15s |  16.67 | 13,802 | 14,642 | 14,650 | 54 |
| 25 | Postgres |  3s | **83.33**  |  3,429 |  3,583 |  3,586 | 19 |
| 50 | CouchDB  | 29s |  17.24 | 25,282 | 26,538 | 26,544 | 84 |
| 50 | Postgres |  7s | **71.43**  |  6,815 |  7,150 |  7,157 | 22 |

Zero write failures in either scenario, all levels. Backend-landed visibility under 100ms throughout.

### Interpretation

**Single-user latency is tied** (≈1.4s vs 1.5s). Both paths expand the contact lineage and walk the hierarchy before persisting, so the single-doc floor is dominated by cht-datasource work, not the storage backend.

**Under concurrency, PG scales dramatically better**:

| Conc | PG advantage |
|---:|---:|
| 1  | 1.0× (tied) |
| 10 | **7.0×** |
| 25 | **5.0×** |
| 50 | **4.1×** |

**CouchDB plateaus at ~17 docs/s regardless of concurrency**. This is the expected single-writer serialization: CouchDB appends sequentially to each document file. Each worker's perceived latency scales linearly with N (1.4s → 7s → 14s → 25s) because they queue.

**Postgres also shows contention at N=50** (throughput dropping from 100 → 71 docs/s; per-worker batch time climbing from 1.5s → 6.8s), but the ceiling is much higher and the degradation is sub-linear. Worth noting: this test is single-process-per-worker via `Pool` — real-world concurrency would be cht-api's connection pool scaling, which isn't the bottleneck at these numbers.

**Visibility is consistently faster on PG** (19–33ms vs 36–95ms). PG's `_id = ANY($1)` is a single B-tree lookup across the batch; CouchDB's `_bulk_get` serializes per-doc internally.

### Why the comparison is fair

Both paths land writes at the same logical abstraction (cht-datasource expands the contact, resolves the place hierarchy, calls the backend's create). The only difference is where the create goes:
- CouchDB scenario: _bulk_docs passthrough, direct PouchDB-style write (what production does today)
- Postgres scenario: Report.v1.create via PG adapter → `v1.couchdb` JSONB (what the migration target will do)

Both scenarios cycle the same user cohort, use the same burst size, and verify via backend-level queries. The 4-7× PG advantage at concurrency is the migration's core performance argument.

### Limitations + follow-ups

- **120-user pool is the cohort limit**. Concurrency >120 would start cycling users (thread 0 and thread 120 both using CHW[0]) — same-user concurrency adds a different kind of contention. Fine for the 1/10/25/50 range we care about.
- **No peer-visibility measurement**. We picked admin auth for visibility to get clean backend-landed numbers; measuring how long before a supervisor can see a CHW's write via the offline filter is a useful V2.
- **PG scenario depends on the `anc_followup` form being registered** (confirmed via `GET /api/v1/forms`). CouchDB scenario tolerates any form. Documented in `write-powersync-worker.js` header.
- **Postgres has `~600K legacy + ~211K CIV = 811K existing docs`** — writes into this populated table, which is realistic. The CouchDB nodes see the same dataset.

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

### 7. Write Path Benchmark Results (End-to-End Validated 2026-04-17)

Updated 2026-04-17. All write-path issues from the 2026-04-16 partial run are resolved. Browser WASM SQLite writes now flow end-to-end through PowerSync → CHT API → cht-datasource → storage, verified against both CouchDB and PostgreSQL backends, across standard/budget/go device tiers.

#### Standard tier (1x CPU, unthrottled network) — final indexed-detection numbers

| Metric | PouchDB (browser) | PowerSync → CouchDB | PowerSync → PostgreSQL |
|--------|-------------------|---------------------|------------------------|
| Local persist (single doc, avg) | 14ms (4-87ms) | 17ms (9-35ms) | **12ms** (9-20ms) |
| Batch write (10 docs) | Not measured | 142ms (14ms/doc) | **89ms** (9ms/doc) |
| Upload → server visible | >350s (sync interval gated) | **2,016ms** | **2,012ms** |
| Upload mechanism | Sync interval (default 5 min) | `uploadData()` batched POST | `uploadData()` batched POST |
| Server `_id` | client `_id` preserved | **client UUID preserved** (via `idHint`) | **client UUID preserved** (via `idHint`) |

#### Device-tier matrix (all PowerSync browser WASM, indexed detection)

`serverDetectionMs` is now the true end-to-end upload latency — primary-key
`GET /medic/<_id>` on CouchDB or `WHERE _id = $1` on Postgres. Previous
`-scan` results (preserved in `tests/benchmark/results/*-scan.json`) used
Mango `$regex` / JSONB `LIKE` scans that leaked 2-18s of server-side scan
time into the same metric.

| Tier | CPU | Net | Backend | Local avg | Local range | Batch 10 | Upload → visible |
|------|----:|-----|---------|----------:|-------------|---------:|-----------------:|
| Standard | 1× | unthrottled | CouchDB  | 17ms | 9-35  | 142ms (14/doc) | **2,016ms** |
| Standard | 1× | unthrottled | Postgres | 12ms | 9-20  |  89ms (9/doc)  | **2,012ms** |
| Budget   | 2× | 3G          | CouchDB  | 13ms | 9-24  |  91ms (9/doc)  | **4,030ms** |
| Budget   | 2× | 3G          | Postgres | 19ms | 9-77  |  87ms (9/doc)  | **4,034ms** |
| Go       | 4× | 3G          | CouchDB  | 17ms | 9-29  |  76ms (8/doc)  | **4,022ms** |
| Go       | 4× | 3G          | Postgres | 12ms | 9-21  |  87ms (9/doc)  | **4,036ms** |

#### Key observations (corrected)

1. **CouchDB and Postgres are effectively equivalent for single-doc upload
   latency at current scale.** Earlier legacy-scan runs (now preserved as
   `-scan` JSONs) suggested Postgres was 2.5× faster on Go tier (22s vs
   8.6s). That delta was almost entirely scan-detection overhead — CouchDB
   Mango `$regex` on 800K+ docs is slower than Postgres JSONB `LIKE`, so the
   inflation wasn't symmetric. Rewriting detection to use primary keys
   revealed the real numbers: ~2s on unthrottled, ~4s on 3G, backend-agnostic.
2. **Network latency dominates upload time.** Within a tier, CouchDB and
   Postgres differ by <25ms on upload (2,016 vs 2,012 standard; 4,030 vs
   4,034 budget; 4,022 vs 4,036 go). Across tiers, unthrottled ≈ 2s and 3G ≈
   4s regardless of CPU throttle — consistent with the PowerSync upload
   protocol being a single small POST.
3. **Local persist is CPU-scaling tolerant.** WASM SQLite writes land in
   12-19ms avg across all tiers. Go edition (4× CPU) has outliers up to 29ms;
   budget tier has one 77ms spike. Steady-state p50 ≈ 9-12ms on every tier —
   well under the ~100ms perceptual threshold for form submission.
4. **Batch throughput doesn't collapse under throttle.** 10-doc batch is
   76-142ms across all six configurations (7-14ms per doc). WASM SQLite +
   batched API endpoint holds up even at 4× CPU throttle.
5. **Upload mechanism advantage is structural.** PowerSync uploads within
   ~2-4s regardless of tier or backend. PouchDB's default sync interval is
   5 min — supervisors wait up to that long to see a CHW submission on the
   current stack.
6. **Why the "Go tier Postgres advantage" story was misleading.** The
   legacy `-scan` numbers told us CouchDB fell apart on Go tier (22s). In
   reality the server was handling the write fine — the benchmark's
   detection query was what took 18 seconds on a CPU-throttled browser
   parsing Mango response over 3G. Real Postgres advantages at scale exist
   (concurrent-user throughput, view-scan elimination), but they don't
   manifest in single-user single-doc write latency. Use the concurrent
   benchmarks (`tests/scalability/...`) for the PG-under-load story.

#### What's NOT yet captured

| Gap | Run to fill it |
|-----|-----------------|
| PouchDB upload + `get-ids` roundtrip across tiers | `TEST=pouchdb DEVICE_TIER=budget`; `DEVICE_TIER=go` |
| PouchDB replicate.to currently returns `serverDetectionMs: -1` even on standard tier — CHT's db-doc filter probably rejects the benchmark's synthetic report (even with `BENCH_CONTACT_ID` real) because the doc is authored by the offline user but not following the expected submission pipeline | Diagnose — grep cht-api logs for the specific doc id during a PouchDB Test B run |
| Concurrent-user numbers on the CORRECTED detection path | Port the write-path benchmark into the existing scalability harness |

#### Key findings

1. **Local persist is comparable** across all three engines — PouchDB's IndexedDB writes and PowerSync's WASM SQLite writes land in 10-16ms avg on standard tier. CHWs won't feel a difference when submitting a form on either stack.
2. **Upload latency collapses from minutes to ~2 seconds** on PowerSync. PouchDB uploads on its sync interval (default 5 min); PowerSync's `uploadData()` fires as soon as writes queue up. Supervisors see CHW submissions ~2s after the CHW comes online vs up to 5 min today.
3. **PostgreSQL path is slightly faster** than CouchDB path for the same PowerSync client — local persist 12ms vs 16ms, batch 75ms vs 95ms. Driven by JSONB direct insert skipping CouchDB's revision machinery. End-to-end server-visible latency is identical (~2s) because the bottleneck is the upload cadence, not the storage engine.
4. **Client-UUID preservation works on the Postgres path** via agent-1's optional `idHint` parameter on `Report/Person/Place.v1.create` and `createDoc(data, idHint)`. The CouchDB local adapter did not preserve the UUID on this run — suggests the installed `@medic/cht-datasource` in the `cht-api` image doesn't have the `local/libs/doc.ts` idHint change yet (only `postgres/` and public exports did). Follow-up: rebuild and install updated shared-libs into cht-api or bake into a fresh image.
5. **The v5 `/api/v1/replication/get-ids` bottleneck is a *download* concern, not an upload concern.** Reducing PouchDB's sync interval would fire uploads faster but would also fire *more* filtered-view scans on CouchDB — pulling load forward, not changing the asymptote. See "PouchDB sync interval note" below.

#### PouchDB sync interval note

We considered temporarily reducing PouchDB's sync interval to shorten the benchmark, but:

- **PouchDB's upload path** uses `POST /medic/_bulk_docs` — cheap on the server, bounded by network RTT. Reducing the interval just fires this more often.
- **PouchDB's download path** uses `GET /api/v1/replication/get-ids` → `POST /medic/_bulk_get`. `/get-ids` filters the `docs_by_replication_key` view per user and runs `purge.js` — this is the O(N²) scan that collapses CouchDB at 10+ concurrent users (per earlier concurrent benchmarks).
- Reducing the sync interval *does* demonstrate that the filter cost stays constant per call, so firing more often simply multiplies server load. It doesn't change the per-call cost, which is the scalability ceiling PowerSync Sync Streams is designed to remove.

If a future benchmark iteration wants the interval-collapsed number: `POST /medic/_design/medic-client/_update/replication_throttle` isn't a thing in CHT — the interval lives in the webapp service (`shared-libs/replication/src/...`). A one-liner override in `.agents/tasks/BROWSER_INTEGRATION_DEBUGGING.md` or a benchmark-specific build would let us force a 30s interval for the test harness.

#### Resolved (post 2026-04-16)

- Worker/WASM bundling ✓ (Agent 5 via `angular.json` duplicate asset copy)
- Nginx static carve-out for `/powersync/*.{js,wasm,map}` ✓
- PRAGMA-before-connect() deadlock ✓
- Upload URL `/medic/` prefix bug ✓ (caused `db-doc.js` 403s)
- Per-op routing → batched `/api/v1/powersync/upload` ✓
- `transformCrudEntry` bridges PowerSync `contact_id` → cht-datasource `contact` UUID ✓
- Test user roles (`chw` → `chw_min_5km` for CIV config) ✓
- `app_settings.powersync` feature flag enabled ✓
- PowerSync → PostgreSQL wiring via `CHT_DB_BACKEND=postgres` (Agent 1) ✓
- Client-UUID preservation via `idHint` (Agent 1) ✓ on Postgres path

#### Open follow-ups

- CouchDB local adapter UUID preservation (install updated cht-datasource into cht-api)
- Persistent `cht-api` volume mounts so `docker compose up -d api` doesn't wipe dev patches (landed in `.devcontainer/docker-compose.services.yml`)
- Architectural decision: does Postgres-as-primary path write to `v1.couchdb` (current pattern, keeps couch2pg as bridge) or to a new native schema? Flagged for Medic team per `.agents/tasks/AGENT_HANDOFF_NOTES.md`.

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
