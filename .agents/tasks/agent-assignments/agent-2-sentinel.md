# Agent 2: Sentinel PostgreSQL Transition Support

## Objective
Adapt Sentinel (the document transition/workflow engine) to work with PostgreSQL via the cht-datasource adapter, instead of directly querying CouchDB.

## Scope
- **Primary directory**: `sentinel/`
- **May read**: `shared-libs/cht-datasource/` (Agent 1's work)
- **Do NOT modify**: `shared-libs/cht-datasource/`, `webapp/`, `api/`

## Phase Dependency
Phase 2 (PostgreSQL running). Depends on Agent 1 completing the cht-datasource PostgreSQL adapter.

## Tasks
1. Audit Sentinel's CouchDB dependencies: `sentinel/src/` — identify all direct CouchDB calls
2. Map each CouchDB interaction to its cht-datasource equivalent
3. Replace direct CouchDB calls with cht-datasource adapter calls
4. Handle the changes feed transition: CouchDB `_changes` → PostgreSQL LISTEN/NOTIFY or polling
5. Adapt transition logic that depends on CouchDB revision (`_rev`) conflict model
6. Update Sentinel tests to work with both backends
7. Test Sentinel transitions against PostgreSQL (Phase 2)

## Key Context
- Sentinel processes document transitions (state machines triggered by doc changes)
- Currently watches CouchDB `_changes` feed
- PostgreSQL equivalent: LISTEN/NOTIFY on table changes, or polling `saved_timestamp`
- Read `context/IMPLEMENTATION_GUIDE.md` for PostgreSQL trigger patterns
- Sentinel uses `shared-libs/` utilities — check which ones have CouchDB assumptions

## Success Criteria
- `npm run unit-sentinel` passes with adapted tests
- Sentinel can process document transitions reading from PostgreSQL
- Changes detection works via PostgreSQL mechanism
- Existing CouchDB mode still functions (feature flag: `CHT_DB_BACKEND`)
