# Agent 6: Rules Engine SQLite Adapter

## Iteration 2 — Performance Validation on Device Constraints

### Objective
Complete the rules engine PowerSync SQLite adapter (from Iteration 1) and validate that task/target generation performs within timeout thresholds on Go edition device constraints (2GB RAM, single-connection SQLite, 200MB DB budget).

**Why this matters**: The rules engine is the highest code migration effort. It generates tasks and targets client-side by evaluating JavaScript functions against local data. On Go edition devices with constrained resources, task generation must complete within existing timeout thresholds or CHPs see stale/missing tasks.

## Scope
- **Primary directory**: `shared-libs/rules-engine/`
- **May read**: `webapp/src/ts/services/powersync/` (Agent 5's PowerSync services), `shared-libs/cht-datasource/`
- **Do NOT modify**: `api/`, `sentinel/`, `webapp/`

## Phase Dependency
Phase 3 (PowerSync running). Depends on Agent 5's PowerSync SDK integration. Unit tests with mocks can start at Phase 0.

## Iteration 1 Work — Review Before Continuing
Check existing adapter code:
- `shared-libs/rules-engine/src/adapters/index.js` — Factory pattern
- `shared-libs/rules-engine/src/adapters/powersync-adapter.js` — SQL query translation
- `shared-libs/rules-engine/src/adapters/powersync-schema.js` — SQLite table definitions
- `shared-libs/rules-engine/src/adapters/powersync-connector.js` — Backend connector
- `shared-libs/rules-engine/test/powersync-adapter.spec.js` — Unit tests
- `shared-libs/rules-engine/test/powersync-integration.spec.js` — Integration tests

**First action**: Read ALL existing adapter files. Note what works, what's broken, what's missing.

## Tasks

### Continuing from Iteration 1
1. **Complete adapter if not finished**: Ensure all PouchDB API equivalents are implemented:
   - `allDocs` → `SELECT * FROM {table} WHERE id IN (...)`
   - `query` (CouchDB views) → SQL queries with proper indexes
   - `put` → PowerSync upload queue via `uploadData()`
   - Handle chunking: `MAX_SQL_ITEMS=300` to stay within SQLite's 999 parameter limit

2. **Task/target document lifecycle**:
   - Rules engine generates tasks → written to local SQLite
   - Tasks synced to server via upload queue
   - Terminal tasks purged server-side (Agent 4) → removed from client on next sync
   - Targets: per reporting period, purged after 6 months server-side

3. **Verify dual-mode operation**: `CHT_CLIENT_DB=powersync|pouchdb` runtime selection
   - PouchDB adapter: existing behavior, no regression
   - PowerSync adapter: identical task/target output from same input data

### NEW: Performance Under Device Constraints
4. **Benchmark task generation**: Create performance test that measures:
   - Time to generate tasks for 50 contacts with 200 reports (typical CHW caseload)
   - Compare: PouchDB adapter vs PowerSync adapter
   - Run with constrained resources simulating Go edition (throttled CPU, limited memory)
   - Target: task generation within existing timeout threshold (check `rules-engine/src/` for value)

5. **Single-connection contention**: The PowerSync Web SDK has a single database connection.
   - Rules engine queries compete with sync operations for the connection
   - Test: run task generation during active sync → measure latency increase
   - If contention is severe: implement query batching or defer task generation until sync pause
   - Agent 5's `fetchStrategy: 'sequential'` for Go edition should help here

6. **Memory footprint**: Rules engine loads contact+report data into memory for evaluation.
   - Measure peak memory during task generation for a typical CHW caseload
   - If >50MB peak: implement streaming/pagination (evaluate per-contact, not bulk)

### Testing
7. **Unit tests**: All adapter methods, chunking logic, dual-mode selection
8. **Integration tests**: Rules engine produces identical tasks from PouchDB vs PowerSync data
9. **Performance test**: Task generation within timeout on constrained resources
10. Run `npm run unit-shared-lib` after each change

## Key Context
- Rules are JavaScript functions defined in app config (tasks.js, targets.js)
- Rules engine must continue working with PouchDB for backward compat
- PowerSync SQLite queries go through wa-sqlite (WASM) — single connection, no WAL mode
- On Go edition: 2GB RAM, MediaTek Helio A22, fetchStrategy='sequential'
- Agent 5's DeviceTierService determines which strategy to use
- Read `context/IMPLEMENTATION_GUIDE.md` for rules engine migration notes

## Success Criteria
- Rules engine generates identical tasks/targets from both PouchDB and PowerSync data
- Adapter pattern allows runtime selection (`CHT_CLIENT_DB=powersync|pouchdb`)
- Task generation completes within existing timeout thresholds on simulated Go edition
- Single-connection contention: <2x latency increase during active sync
- Memory: peak <50MB for typical CHW caseload (50 contacts, 200 reports)
- No regression in PouchDB mode
- `npm run unit-shared-lib` passes with all tests
