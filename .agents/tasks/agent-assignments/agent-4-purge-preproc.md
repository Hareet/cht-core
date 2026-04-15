# Agent 4: Purge Preprocessing + Storage Budget API

## Iteration 2 — Device Storage Sustainability

### Objective
Complete the purge preprocessing service (from Iteration 1) and add a **storage budget enforcement API endpoint** that Go edition devices can call when their local SQLite DB exceeds the tier budget.

**Why this matters**: 56.3% of devices have ~11GB total storage. Without active purge and client-triggered aggressive purge, the PowerSync SQLite DB will grow unbounded and eventually exhaust OPFS quota. Agent 5 detects the problem client-side; Agent 4 provides the server-side solution.

## Scope
- **Primary directory**: `api/src/services/purge-preproc/` (new directory from Iteration 1)
- **May modify**: `shared-libs/purging-utils/`, `api/src/routing.js` (add endpoint)
- **May read**: `api/`, `sentinel/`, `ddocs/`, `context/powersync-hardware-analysis.md`
- **Do NOT modify**: `webapp/`, `shared-libs/cht-datasource/`, `shared-libs/rules-engine/`

## Phase Dependency
Phase 2 (PostgreSQL running).

## Iteration 1 Work — Review Before Continuing
Check what exists at `api/src/services/purge-preproc/` or `services/purge-preproc/`. Read any existing code, tests, and commits on your branch before writing new code.

## Tasks

### Continuing from Iteration 1
1. **Complete purge preprocessing service** (if not finished):
   - Reads contacts + reports from PostgreSQL, groups by (role, contact) tuples
   - Evaluates `purge.js` function for each tuple
   - Writes results to `purge_status` table
   - Runs on configurable schedule (cron or interval)
   - Incremental mode: only re-evaluate changed documents (since last `evaluated_at`)

2. **`purge_status` table** (if not created):
   ```sql
   CREATE TABLE purge_status (
     doc_id TEXT NOT NULL,
     role TEXT NOT NULL,
     purged BOOLEAN DEFAULT false,
     evaluated_at TIMESTAMP DEFAULT NOW(),
     PRIMARY KEY (doc_id, role)
   );
   CREATE INDEX idx_purge_status_role ON purge_status(role);
   CREATE INDEX idx_purge_status_doc ON purge_status(doc_id);
   ```

### NEW: Storage Budget Enforcement API
3. **Create `/api/v1/purge/request` endpoint**: NEW route in `api/src/routing.js`
   - POST body: `{ user_id, facility_id, current_db_size_mb, tier_budget_mb }`
   - Server evaluates: which docs for this user can be aggressively purged?
   - Aggressive purge = reduce retention thresholds for this user:
     - Tasks: terminal state → purge immediately (not 60 days)
     - Targets: >1 reporting period old → purge (not 6 months)
     - Reports: >90 days old with no active follow-up → eligible
   - Writes aggressive purge results to `purge_status` with `aggressive = true`
   - Returns: `{ purged_count, estimated_reduction_mb }`
   - PowerSync Sync Stream will exclude these docs on next sync

4. **Extend `purge_status` table** for aggressive mode:
   ```sql
   ALTER TABLE purge_status ADD COLUMN aggressive BOOLEAN DEFAULT false;
   ALTER TABLE purge_status ADD COLUMN requested_by TEXT; -- user_id who triggered
   ALTER TABLE purge_status ADD COLUMN reason TEXT; -- 'storage_budget', 'scheduled', 'retention'
   ```

### Testing
5. **Unit tests**: Mock purge functions, test standard + aggressive purge paths
6. **Integration tests** (Phase 2): Evaluate against live PostgreSQL, verify purge_status populated correctly
7. **Storage budget API test**: POST request → verify purge_status entries → verify doc count reduction
8. Run `npm run unit-api` after each change.

## Key Context
- purge.js is Turing-complete JavaScript — cannot be expressed as SQL
- Current system evaluates purge per (role, contact, reports) tuple
- Standard retention: tasks 60 days after terminal state, targets 6 months
- Aggressive retention (storage pressure): tasks immediate, targets 1 period, reports 90 days
- `purge_status` is consumed by Agent 3's Sync Streams: `WHERE NOT EXISTS (SELECT 1 FROM purge_status ...)`
- Agent 5's `StorageHealthMonitor` calls this API when device hits storage `critical` threshold

## Success Criteria
- Purge preprocessing service correctly evaluates purge.js against PG data
- `purge_status` table populated with correct purge decisions (standard + aggressive)
- Incremental mode only processes changed documents
- `/api/v1/purge/request` returns correct purge count and estimated reduction
- Aggressive purge reduces eligible doc count by ≥30% for storage-constrained users
- Unit tests cover: standard purge, aggressive purge, no-purge, mixed roles, edge cases
- Integration tests pass against live PostgreSQL
