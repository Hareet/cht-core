# Agent 2: Sentinel PostgreSQL Transition

## Iteration 2 — LISTEN/NOTIFY Reliability + Changes Feed

### Objective
Complete the Sentinel PostgreSQL transition focusing on reliable changes detection via LISTEN/NOTIFY. Iteration 1 identified and started fixing reconnection reliability — Iteration 2 finishes this work and ensures Sentinel processes document transitions correctly against PostgreSQL.

**Why this matters**: Sentinel is the workflow engine that processes document state transitions (registration, death reporting, muting, schedules). If it can't reliably detect changes in PostgreSQL, workflows break silently.

## Scope
- **Primary directory**: `sentinel/`
- **May read**: `shared-libs/cht-datasource/` (Agent 1's adapter)
- **Do NOT modify**: `shared-libs/cht-datasource/`, `webapp/`, `api/`

## Phase Dependency
Phase 2 (PostgreSQL running). Depends on Agent 1's cht-datasource PostgreSQL adapter.

## Iteration 1 Work — Review Before Continuing
Check git log on your branch. From ralph loop logs:
- Fixed LISTEN/NOTIFY pending poll logic
- Fixed reconnection reliability
Review what was committed and what remains broken.

## Tasks

### Continuing: Changes Feed
1. **Verify LISTEN/NOTIFY implementation**: Does it reliably detect all document changes?
   - PostgreSQL trigger on `couchdb` table (or normalized tables) → NOTIFY on INSERT/UPDATE
   - Sentinel subscribes via `pg` client `LISTEN` command
   - Handle: connection drops, PostgreSQL restarts, notification overflow

2. **Reconnection reliability**: Implement robust reconnection:
   - Exponential backoff on connection loss (1s → 2s → 4s → ... → 30s cap)
   - Resume from last processed `seq` / `saved_timestamp` (no gap, no duplicate)
   - Log reconnection events for monitoring

3. **Fallback to polling**: If LISTEN/NOTIFY has issues:
   - Poll `saved_timestamp > last_processed` at configurable interval (default 5s)
   - This is the safety net — LISTEN/NOTIFY is the primary, polling is backup

### Continuing: Transition Logic
4. **Replace direct CouchDB calls** with cht-datasource adapter calls
   - Map: `db.medic.get(id)` → `chtDatasource.get(id)`
   - Map: `db.medic.bulkDocs(docs)` → `chtDatasource.bulkSave(docs)`
   - Map: `infodoc` system → adapt for PostgreSQL (infodocs track processing state per document)

5. **Handle revision model difference**:
   - CouchDB: optimistic concurrency via `_rev` field, conflicts possible
   - PostgreSQL: last-write-wins with `updated_at` timestamp, or advisory locks
   - Sentinel must handle conflicts gracefully in both modes

### Testing
6. **Unit tests**: LISTEN/NOTIFY subscription, reconnection, transition logic
7. **Integration tests** (Phase 2): Full document transition cycles against PostgreSQL
   - Registration → schedules fire
   - Death reporting → muting cascade
   - Sentinel processes in correct order, no missing transitions
8. **Dual-mode test**: Same transitions produce same results on CouchDB vs PostgreSQL
9. Run `npm run unit-sentinel` after each change

## Key Context
- Sentinel currently watches CouchDB `_changes` feed with `since` parameter
- PostgreSQL equivalent: `pg_notify()` trigger on table changes, or polling `saved_timestamp`
- Read `context/IMPLEMENTATION_GUIDE.md` for PostgreSQL trigger patterns
- Feature flag `CHT_DB_BACKEND=postgres|couchdb` (from Agent 1) controls which backend
- Sentinel uses `shared-libs/` utilities — check which ones assume CouchDB

## Success Criteria
- LISTEN/NOTIFY reliably detects all document changes (zero missed transitions)
- Reconnection: survives PostgreSQL restart with zero data loss
- All document transitions work against PostgreSQL backend
- `npm run unit-sentinel` passes
- Dual-mode: Sentinel works with both CouchDB and PostgreSQL via feature flag
