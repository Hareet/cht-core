# Agent 4: Purge Preprocessing Service

## Objective
Build a server-side service that evaluates CHT's `purge.js` functions against PostgreSQL data and writes results to a `purge_status` table. This table is consumed by Sync Streams (Agent 3) to exclude purged documents from sync.

## Scope
- **Primary directory**: `services/purge-preproc/` (new directory)
- **May modify**: `shared-libs/purging-utils/` if needed
- **May read**: `api/`, `sentinel/`, `ddocs/`
- **Do NOT modify**: `webapp/`, `shared-libs/cht-datasource/`

## Phase Dependency
Phase 2 (PostgreSQL running).

## Tasks
1. Study existing purge logic: `shared-libs/purging-utils/`, `api/src/services/purging/`
2. Understand `purge.js` contract: called with `(userCtx, contact, reports)` tuple per role
3. Design `purge_status` PostgreSQL table:
   ```sql
   CREATE TABLE purge_status (
     doc_id TEXT NOT NULL,
     role TEXT NOT NULL,
     purged BOOLEAN DEFAULT false,
     evaluated_at TIMESTAMP DEFAULT NOW(),
     PRIMARY KEY (doc_id, role)
   );
   ```
4. Build preprocessing service (Node.js) that:
   - Reads contacts + reports from PostgreSQL
   - Groups by (role, contact) tuples
   - Evaluates `purge.js` function for each tuple
   - Writes results to `purge_status`
   - Runs on a configurable schedule (cron or interval)
5. Handle incremental evaluation (only re-evaluate changed documents)
6. Write unit tests with mock purge functions
7. Write integration tests against live PostgreSQL (Phase 2)

## Key Context
- purge.js is Turing-complete JavaScript — cannot be expressed as SQL
- Current system evaluates purge per (role, contact, reports) tuple
- Tasks purge after 60 days terminal state, targets after 6 months
- This is the ~4-6 week effort identified in the PowerSync gap analysis
- The purge_status table is consumed by Agent 3's Sync Streams via SQL JOIN

## Success Criteria
- Purge preprocessing service evaluates purge.js correctly against PG data
- `purge_status` table populated with correct purge decisions
- Incremental mode only processes changed documents
- Service runs as standalone Node.js process (containerizable)
- Unit tests cover: standard purge, no-purge, mixed roles, edge cases
