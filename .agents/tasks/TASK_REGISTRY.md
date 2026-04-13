# Task Registry — CHT PostgreSQL Migration

## Iteration 2: Device-Ready PowerSync Implementation

**Context**: Server-side PowerSync integration (Sync Streams, cht-datasource adapter, rules engine adapter, upload handler) is substantially complete from Iteration 1. Iteration 2 hardens the implementation for the **actual MoH Côte d'Ivoire device fleet** — 2,611 users, 56% Go edition (<16GB storage, Android 10, WebView 122 pinned), 99.1% OPFS-capable.

**Device fleet reference**: `context/powersync-hardware-analysis.md` + `devices.json` (6,662 telemetry entries)

## Active Assignments

| Agent | Branch | Task | Phase Dep | Status | Merge Order |
|-------|--------|------|-----------|--------|-------------|
| 1 | playtime-agent-1-cht-datasource | PG adapter hardening + feature flag server-side | Phase 2 | CONTINUING | 1st |
| 2 | playtime-agent-2-sentinel | Sentinel PG transition (LISTEN/NOTIFY, changes feed) | Phase 2 | CONTINUING | 3rd |
| 3 | playtime-agent-3-sync-streams | Sync Streams purge validation + performance at scale | Phase 3 | CONTINUING | 5th |
| 4 | playtime-agent-4-purge-preproc | Purge preprocessor + storage budget API endpoint | Phase 2 | CONTINUING | 2nd |
| 5 | playtime-agent-5-powersync-sdk | **Device adaptive layer, WASM optimization, VFS fallback** | Phase 3 | PRIORITY | 6th |
| 6 | playtime-agent-6-rules-engine | Rules engine adapter continuation | Phase 3 | CONTINUING | 7th |
| 7 | playtime-agent-7-integration | **Device farm tests, fallback tests, e2e validation** | Phase 2 | PRIORITY | 4th |

## Iteration 2 Focus Areas

### PRIORITY agents (new work)
- **Agent 5**: Device-adaptive PowerSync client. DeviceTierService, adaptive `cacheSizeKb`/`fetchStrategy`, StorageHealthMonitor, WASM service worker caching, non-blocking init, VFS fallback with telemetry. Heaviest new scope.
- **Agent 7**: Device fleet testing. IndexedDB fallback integration tests, device farm test suite (BrowserStack/Firebase Test Lab), Go edition memory profiling, e2e feature flag validation.

### CONTINUING agents (extending Iteration 1 work)
- **Agent 1**: Harden PG adapter, add `app_settings.powersync.enabled` feature flag + per-facility rollout endpoint.
- **Agent 2**: Complete Sentinel LISTEN/NOTIFY changes feed, fix reconnection reliability (from Iteration 1 logs).
- **Agent 3**: Validate Sync Streams with `purge_status` JOIN at 100K doc scale, EXPLAIN ANALYZE, tune recursive CTE.
- **Agent 4**: Complete purge preprocessor, add `/api/v1/purge/request` endpoint for client-side storage budget enforcement.
- **Agent 6**: Complete rules engine adapter, ensure performance on PowerSync SQLite within timeout thresholds.

## Dependency Graph

```
Agent 1 (cht-datasource + feature flag) ──┬──> Agent 2 (sentinel) ──> Agent 7 (integration + device tests)
                                           │
Agent 4 (purge + storage budget API) ──────┤──> Agent 3 (sync streams + purge validation)
                                           │
Agent 5 (device adaptive SDK) ─────────────┤──> Agent 6 (rules engine)
                                           │
                                           └──> Agent 7 (device farm tests)
```

## Device-Ready Phase Mapping

| Plan Phase | Agent(s) | Tasks |
|------------|----------|-------|
| Phase 0: Audit | Agent 5 | Audit existing adaptive config, VFS fallback, upload resilience |
| Phase 1: Adaptive Layer | Agent 5 | DeviceTierService, adaptive PowerSync config, StorageHealthMonitor |
| Phase 2: WASM Optimization | Agent 5 | Service worker caching, non-blocking init, startup benchmark |
| Phase 3: Purge & Storage | Agent 4 + Agent 3 | purge_status table, storage budget API, sync stream purge JOIN |
| Phase 4: Fallback | Agent 5 + Agent 7 | VFS selection telemetry, IndexedDB fallback tests, desktop compat |
| Phase 5: Device Testing | Agent 7 | Device test matrix, automated farm tests, Go edition profiling |
| Phase 6: Sentinel PG | Agent 2 | LISTEN/NOTIFY, changes feed, transition tests |
| Phase 7: Prod Ready | Agent 1 + Agent 5 + Agent 7 | Feature flags, monitoring, security audit, e2e validation |

## Merge Queue

| Branch | Merged To | Date | Notes |
|--------|-----------|------|-------|
| playtime-agent-3-sync-streams | playtime | 2026-04-10 | Iteration 1: bucket consolidation, 16K→59 buckets |
| (others pending) | | | |

## File Ownership

| Agent | Primary Directories | May Read |
|-------|-------------------|----------|
| 1 | `shared-libs/cht-datasource/`, `api/src/services/feature-flags/` (new) | `api/`, `sentinel/` |
| 2 | `sentinel/` | `shared-libs/cht-datasource/` |
| 3 | `.devcontainer/powersync-config/` | `context/`, `couchdb/`, `api/services/authorization/` |
| 4 | `api/src/services/purge-preproc/`, `shared-libs/purging-utils/` | `api/`, `sentinel/` |
| 5 | `webapp/src/ts/services/powersync/`, `webapp/src/sw.js` | `shared-libs/cht-datasource/`, `context/`, `devices.json` |
| 6 | `shared-libs/rules-engine/` | `webapp/`, `shared-libs/cht-datasource/` |
| 7 | `tests/` | Everything (read all, write only tests) |

## Device Fleet Summary (from devices.json)

Quick reference for all agents — these numbers drive implementation decisions:

| Metric | Value |
|--------|-------|
| Unique users | 2,611 |
| Go edition (<16GB) | 56.3% |
| Budget (16-32GB) | 19.0% |
| Standard (32-128GB) | 14.1% |
| High (128GB+) | 6.4% |
| OPFS supported (WV 109+) | 99.1% |
| No OPFS (WV <109) | 22 users (0.8%) — mostly desktop browsers |
| Critically low storage (<1GB free) | 66 entries across ALL tiers |
| Dominant WebView | 122.0.6261.90 (70.1% of sessions) |
| Dominant Android | 10 (68.4% of users) |
