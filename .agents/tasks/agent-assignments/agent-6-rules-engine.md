# Agent 6: Rules Engine SQLite Adapter

## Objective
Adapt CHT's rules engine to query PowerSync's client-side SQLite instead of PouchDB for task and target generation.

## Scope
- **Primary directory**: `shared-libs/rules-engine/`
- **May read**: `webapp/` (Agent 5's PowerSync integration), `shared-libs/cht-datasource/`
- **Do NOT modify**: `api/`, `sentinel/`, `webapp/`

## Phase Dependency
Phase 3 (PowerSync running). Depends on Agent 5 completing PowerSync SDK integration. Unit tests with mocks can start at Phase 0.

## Tasks
1. Study rules engine architecture: `shared-libs/rules-engine/src/`
2. Identify all PouchDB calls: `allDocs`, `query` (CouchDB views), `put` (task/target writes)
3. Design SQLite query equivalents:
   - `allDocs` → `SELECT * FROM {table} WHERE ...`
   - `query` (views) → SQL queries with proper indexes
   - `put` → PowerSync upload queue via `uploadData()`
4. Create adapter interface: `rules-engine/src/adapters/`
   - `pouchdb-adapter.js` (existing behavior, extracted)
   - `powersync-adapter.js` (new, uses PowerSync SDK queries)
5. Handle task/target document lifecycle:
   - Rules engine generates tasks client-side
   - Tasks written to local SQLite
   - Tasks synced to server via upload queue
   - Terminal tasks purged after 60 days (handled by Agent 4 server-side)
6. Write unit tests for PowerSync adapter
7. Integration test: rules engine generates correct tasks from PowerSync data

## Key Context
- Rules engine is the highest code migration effort (~6-8 weeks estimated)
- Currently writes task/target docs to PouchDB, reads them back
- Rules are JavaScript functions defined in app config (tasks.js, targets.js)
- The engine must continue working with PouchDB for backward compat
- PowerSync SQLite queries are synchronous (no async allDocs)
- Read `context/IMPLEMENTATION_GUIDE.md` for rules engine migration notes

## Success Criteria
- Rules engine generates identical tasks/targets from both PouchDB and PowerSync data
- Adapter pattern allows runtime selection (`CHT_CLIENT_DB=powersync|pouchdb`)
- Performance: task generation completes within existing timeout thresholds
- Unit tests cover both adapters
- No regression in PouchDB mode
