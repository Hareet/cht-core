# Concurrent Sync Benchmark Plan

**Goal**: Measure PouchDB vs PowerSync incremental sync under concurrent load — 10 CHW users syncing simultaneously with Go edition throttling.

## What We Want to Measure

### Client-side (per user)
- Time from doc insertion to detection in local DB
- Sync cycle duration (get-ids round trip for PouchDB, checkpoint delta for PowerSync)
- Memory/storage per concurrent client

### Server-side
- CouchDB CPU under 10 concurrent get-ids calls vs PowerSync WAL serving 10 WebSocket streams
- API response times under load
- PostgreSQL/PowerSync service resource usage

## Existing Infrastructure

### Already Have
- **jMeter test plans**: `tests/scalability/sync.jmx` (CouchDB) and `tests/scalability/powersync-sync.jmx` (PowerSync)
- **Worker scripts**: `tests/scalability/initial-replication.js` (PouchDB per-thread), existing PowerSync benchmark
- **Config**: `tests/scalability/config.json` with user list
- **10 CIV test users**: `chw_test_1` through `chw_test_10` (created by config-loader agent)
- **Go edition throttle profiles**: `tests/benchmark/benchmark-powersync-browser.js` has the PROFILES object

### Need to Build
1. **Updated config.json** with CIV test users and passwords
2. **Incremental sync worker** — a per-thread script that:
   - Connects (PouchDB or PowerSync)
   - Completes initial sync
   - Enters a loop: insert doc → measure detection time → repeat
   - Reports timing per iteration
3. **Doc insertion coordinator** — inserts docs for specific users at coordinated times
4. **Results aggregator** — collects per-thread results, computes p50/p95/p99 latencies

## Test Scenarios

### Scenario 1: PouchDB Concurrent Incremental Sync
```
10 Puppeteer instances, each:
  - Go edition throttled (CPU 4x, optional 3G)
  - Logged in as chw_test_N
  - Initial sync complete
  - Sync interval set to minimum (trigger manually)
  
Coordinator:
  - Inserts 1 report per user into CouchDB every 30 seconds
  - Each user's report is in their facility
  
Measure per user:
  - get-ids response time (concurrent)
  - Time from insert to PouchDB detection
  - Server CPU during concurrent get-ids calls
```

### Scenario 2: PowerSync Concurrent Incremental Sync
```
10 @powersync/node instances (or Puppeteer), each:
  - Connected as chw_test_N via WebSocket
  - Initial sync complete
  - Live delta stream active
  
Coordinator:
  - Inserts 1 report per user directly into PostgreSQL every 30 seconds
  - Each user's report resolves to their facility
  
Measure per user:
  - WAL → PowerSync → client detection time
  - No get-ids cost (WebSocket push)
  - Server CPU during concurrent WebSocket streams
```

### Scenario 3: Mixed Concurrent (Production Simulation)
```
5 PouchDB users + 5 PowerSync users simultaneously:
  - Simulates the dual-backend rollout
  - PouchDB users insert to CouchDB → couch2pg → PG
  - PowerSync users insert to PG directly
  - Cross-backend visibility via pg2couch (if built)
```

## Implementation Approach

### Option A: jMeter + Worker Scripts (matches existing framework)
- Update `config.json` with CIV users
- Write new worker scripts for incremental sync (not just initial)
- jMeter handles concurrency, ramp-up, and result collection
- Requires jMeter installed in the container

### Option B: Node.js Cluster (simpler, no jMeter dependency)
- Single Node.js script using `child_process.fork()` for concurrency
- Each child runs the incremental sync worker for one user
- Parent coordinates doc insertion and collects results
- Can run directly in agent-7 container

### Option C: Puppeteer Pool (most realistic for client-side)
- 10 Puppeteer instances in parallel
- Each with Go edition throttle
- Most realistic for client-side measurement
- Highest resource usage (~500MB per Chromium instance = 5GB for 10)

**Recommended: Option B for initial benchmarking** (lightweight, measures sync engine directly), then **Option C for validation** (realistic client-side with WASM).

## Config Update Needed

```json
{
  "url": "http://api:5988",
  "couch_url": "http://admin:secret21512@couchdb:5984/medic",
  "powersync_url": "http://powersync:8080",
  "powersync_key_path": "../../.devcontainer/powersync-config/dev-private-key.pem",
  "users": [
    { "name": "chw_test_1", "pass": "Secret1!pass", "role": "chw_min_5km" },
    { "name": "chw_test_2", "pass": "Secret1!pass", "role": "chw_min_5km" },
    { "name": "chw_test_3", "pass": "Secret1!pass", "role": "chw_min_5km" },
    { "name": "chw_test_4", "pass": "Secret1!pass", "role": "chw_min_5km" },
    { "name": "chw_test_5", "pass": "Secret1!pass", "role": "chw_min_5km" },
    { "name": "chw_test_6", "pass": "Secret1!pass", "role": "chw_min_5km" },
    { "name": "chw_test_7", "pass": "Secret1!pass", "role": "chw_min_5km" },
    { "name": "chw_test_8", "pass": "Secret1!pass", "role": "chw_min_5km" },
    { "name": "chw_test_9", "pass": "Secret1!pass", "role": "chw_min_5km" },
    { "name": "chw_test_10", "pass": "Secret1!pass", "role": "chw_min_5km" }
  ]
}
```

## Prerequisite: Fix User Passwords

All 10 users may have password-reset flags. Run:
```bash
for i in $(seq 1 10); do
  docker exec cht-agent-1 node /tmp/fix-user-password.js chw_test_$i 'Secret1!pass'
done
```
