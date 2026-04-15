# Agent 7: Integration Tests + Device Fleet Validation

## Iteration 2 — Device-Ready Testing

### Objective
Expand the integration test suite to validate PowerSync works on the actual MoH Côte d'Ivoire device fleet. This includes IndexedDB fallback tests, device farm automation, Go edition memory profiling, and end-to-end feature flag validation.

**Why this matters**: Server-side sync works. The question is whether it works on a Tecno Go edition phone with 11GB storage, 2GB RAM, WebView 122, and <1GB free space. Agent 7 proves (or disproves) that.

## Scope
- **Primary directory**: `tests/` (integration, device-farm, performance)
- **May read**: Everything in the repository
- **Do NOT modify**: Any source code outside `tests/`

## Phase Dependency
Phase 2 (PostgreSQL) for server-side tests. Phase 3 (PowerSync) for sync/device tests.

## Iteration 1 Completed Work
Review what already exists:
- `tests/utils/agent-harness.js` — Container-compatible test wrapper
- `tests/scalability/` — Benchmark infrastructure (JMeter + Node.js)
- `tests/scalability/powersync-benchmark/` — Isolated and scaled comparison results
- `webapp/tests/integration/powersync/verify-sync.js` — Basic sync verification
- `webapp/tests/karma/ts/services/powersync/` — 5 unit test suites

**First action**: Read ALL existing test files before creating new ones.

## Tasks — Ordered by Priority

### Continuing: Server-Side Integration Tests (from Iteration 1)
1. **cht-datasource PG adapter tests**: CRUD, query by type/facility, changes feed
2. **Sentinel PG transition tests**: Document state transitions, LISTEN/NOTIFY
3. **Purge preprocessing tests**: purge_status correctness, incremental processing
4. **cht-sync bridge tests**: CouchDB → PostgreSQL data flow integrity

### NEW: IndexedDB Fallback Tests (Phase 4)
5. **IndexedDB fallback integration tests**: NEW `webapp/tests/integration/powersync/indexeddb-fallback.spec.ts`
   - Force `IDBBatchAtomicVFS` path (mock OPFS unavailability)
   - Test: initial sync completes on IndexedDB
   - Test: form submission works (uploadData queue drains)
   - Test: upload queue persists across simulated app restart
   - Test: graceful degradation at >100MB DB size (performance degrades, doesn't crash)
   - Covers: 22 non-OPFS users (6 old-WebView Android + 14 desktop browsers)

### NEW: Device Farm Test Suite (Phase 5)
6. **Create device test matrix**: NEW `tests/device-farm/README.md`
   - Define test device profiles from actual telemetry:

     | Priority | Device Profile | Fleet % | Test Focus |
     |----------|---------------|---------|------------|
     | P0 | Tecno/Itel Go, Android 10, WV 122, 11GB | 56.3% | WASM startup, storage pressure, sync perf |
     | P0 | Budget Android 10-11, WV 122-130, 26GB | 19.0% | Baseline perf |
     | P1 | Mid-range Android 14, WV 136+, 52GB+ | 7.7% | OPFS strict origin policy |
     | P1 | Android 11-13, WV 125-143, 26-58GB | 15.8% | General compat |
     | P2 | Legacy WV <109 (6 devices) | 0.2% | IndexedDB fallback |
     | P2 | Desktop browsers (no APK) | 4.3% | Cross-browser VFS |

7. **Automated device farm tests**: NEW `tests/device-farm/` suite
   - Platform: BrowserStack App Automate or Firebase Test Lab
   - Test scenarios:
     - **Initial sync**: Time from app load to usable state with 5,000 contacts + 10,000 reports
     - **WASM startup**: Isolate WASM compilation time vs DB open time vs first sync frame
     - **Form submission latency**: Offline form → local persist → measure time
     - **Storage footprint**: After sync, measure total OPFS usage via `navigator.storage.estimate()`
     - **Storage growth**: Simulate 100 CHP work sessions, measure cumulative storage
     - **Offline resilience**: Airplane mode → collect forms 24hr → reconnect → verify queue drain
     - **Force-close resilience**: Submit form → force kill app → reopen → verify data not lost

8. **Success criteria validation** (REVISED from MCP gap analysis — benchmark numbers are NOT transferable):

   | Metric | Target | Rationale | How to Measure |
   |--------|--------|-----------|----------------|
   | WASM compilation (cold) | <8s on Go edition | PowerSync blog estimate, must verify | `performance.now()` around WASM init |
   | Initial sync (5K contacts, warm) | <10s on Go edition | 2K-5K ops/sec WASM estimate from PS docs | BrowserStack timer |
   | Contacts usable (priority 1) | <5s after WASM ready | Prioritized sync — contacts only | `waitForFirstSync({priority:1})` timer |
   | Task list load during sync | <2s | SQLite query + single-connection contention | `performance.now()` in test |
   | Form submission (offline) | <100ms to local persist | SQLite write through WASM | PowerSync SDK timing |
   | Storage footprint | ≤ PouchDB footprint, <30MB typical CHW | Normalized SQL < JSON revision trees | `navigator.storage.estimate()` |
   | Upload queue reliability | 0 data loss / 100 offline cycles | Must survive force-close | Count assertions |
   | OPFS availability | ≥95% of test devices | 99.1% in telemetry | Feature detection report |
   | VFS selection | OPFS on 99%+, IDB fallback works | Must explicitly configure OPFS | Telemetry field check |

   > **NOTE**: `tests/scalability/` benchmark results used `@powersync/node` + `better-sqlite3` (native SQLite, Rust sync client, 28GB heap, RAM storage). These numbers are ~1.5-2x faster than what `@powersync/web` + `wa-sqlite` achieves on Go edition. Do NOT use benchmark numbers as targets. See `context/BENCHMARK_DEVICE_GAP_ANALYSIS.md`.

### NEW: Go Edition Memory Profiling (Phase 5)
9. **Memory profiling on 2GB RAM**: NEW `tests/performance/go-edition-memory-profile.js`
   - Measure during active sync with 60 buckets (the current consolidated bucket count):
     - JS heap size (`performance.memory.usedJSHeapSize`)
     - WASM linear memory (`WebAssembly.Memory.buffer.byteLength`)
     - Web Worker count and overhead
   - Determine if 60 buckets cause OOM on 2GB RAM devices
   - Test with `fetchStrategy: 'sequential'` vs `'buffered'`
   - If OOM: recommend further bucket consolidation or `sequential` as mandatory for Go

### NEW: Feature Flag E2E Validation (Phase 7)
10. **End-to-end feature flag test**: NEW `tests/integration/powersync/feature-flag-e2e.spec.ts`
    - Enable PowerSync for test facility → verify sync works
    - Disable PowerSync for test facility → verify PouchDB fallback activates
    - Re-enable → verify PowerSync resumes without data loss
    - Test with Go edition device profile (simulated via throttling)

### NEW: Production Monitoring Validation
11. **Monitoring metrics test**: Verify that Agent 5's telemetry (device tier, VFS selection, storage usage, sync latency) is correctly reported and can be consumed by Grafana/Prometheus.

## Key Context — Device Fleet

**Read `context/powersync-hardware-analysis.md` for full analysis.** Critical test targets:

- **P0 constraint**: Tecno/Itel Go edition — Android 10, WebView 122.0.6261.90, ~11GB storage, 2GB RAM, MediaTek Helio A22
- **Storage pressure is real**: 66 telemetry entries with <1GB free, across ALL tiers (not just Go)
- **Non-OPFS devices**: 14 desktop browsers (Firefox WV 18-28) + 6 old-WebView Android (WV 87-103) + 2 stale WV Android (94)
- **WebView 122 is pinned**: It doesn't update on Go edition. Any API that works on WV 122 will always work. Any that doesn't, never will.
- **CHT versions in production**: 4.10.0, 4.21.1, 4.9.0 — tests should work on all

## Success Criteria
- IndexedDB fallback tests pass: sync, form submission, upload queue on IDB path
- Device test matrix documented with BrowserStack/Firebase device IDs
- Automated device farm tests: P0 devices pass all success criteria metrics
- Go edition memory profile: no OOM during 60-bucket sync on 2GB RAM
- Feature flag e2e: PouchDB ↔ PowerSync switch works without data loss
- All tests in `tests/` are self-contained, can run independently
- Test results clearly indicate which device profile failed and why
