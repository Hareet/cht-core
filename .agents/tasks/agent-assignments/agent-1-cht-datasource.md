# Agent 1: cht-datasource PostgreSQL Adapter

## Objective
Extend the `@medic/cht-datasource` shared library to support PostgreSQL as a backend alongside CouchDB. This is the **foundation** — all other agents depend on this abstraction layer.

## Scope
- **Primary directory**: `shared-libs/cht-datasource/`
- **May modify**: `api/` (to wire new adapter), `shared-libs/cht-datasource/test/`
- **Do NOT modify**: `sentinel/`, `webapp/`, `tests/integration/`

## Phase Dependency
Phase 2 (PostgreSQL running) required for integration testing. Unit tests with mocks can start at Phase 0.

## Tasks
1. Read current cht-datasource architecture: `shared-libs/cht-datasource/src/`
2. Identify all CouchDB-specific calls (view queries, allDocs, bulkGet, changes feed)
3. Design PostgreSQL adapter interface matching existing CouchDB adapter
4. Implement PostgreSQL adapter using `pg` npm package
5. Add connection pooling configuration
6. Write unit tests for all adapter methods (mock pg)
7. Write integration tests against live PostgreSQL (Phase 2)
8. Ensure backward compatibility — CouchDB adapter still works, adapter selected by config

## Key Context
- Read `context/IMPLEMENTATION_GUIDE.md` — PostgreSQL schema design (Layer 1 JSONB, Layer 2 normalized)
- Read `context/DECISIONS_AND_CONSTRAINTS.md` — dual-write pattern from CommCare
- The existing `cht-datasource` is the API abstraction being expanded per Medic's official roadmap
- cht-sync puts CouchDB docs into `couchdb` table with JSONB `doc` column
- Generated columns (`doc_type`, `facility_id`, `reported_date`) enable efficient queries

## Success Criteria
- `npm run unit-shared-lib` passes with new adapter tests
- PostgreSQL adapter can perform: get by ID, query by type, query by facility, changes since seq
- CouchDB adapter still passes all existing tests unchanged
- Adapter selection via environment variable (`CHT_DB_BACKEND=postgres|couchdb`)
