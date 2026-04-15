# Agent-3 Task: Reduce PowerSync Bucket Count from ~2,665 to ~1,000

## Why This Matters

The concurrent load benchmark (2026-04-12) revealed that each PowerSync connection consumes ~320MB memory, scaling linearly with bucket count. At 50 concurrent connections with 2,665 buckets per user (ac1, 1,010 facilities), the PowerSync service OOMs at 16GB heap. Reducing buckets from ~2,665 to ~1,000 would cut per-connection memory by ~60%, enabling 50+ concurrent connections within a single 16GB container.

Prior optimization rounds brought buckets from 9,071 → 6,040 → 4,686 → 2,665 via stream consolidation, needs_signoff pre-computation, and CTE sharing. This task continues that progression.

## Current Bucket Breakdown (ac1, 1,010 facilities)

```
accessible_data stream (1 CTE: accessible_facilities, 3 queries)
  contacts + SMS + targets share one CTE            = ~1,010 buckets

report_data stream (1 CTE: report_facilities, 3 queries)
  subject-matched via INNER JOIN report_subjects     = ~1,010 + ~640 JOIN overhead
  own reports (auth.parameter filter)                = 1
  needs_signoff (auth.user_id filter)                = 1
  subtotal                                           = ~1,651 buckets

fixed streams (5 × 1 bucket each)                   = 5

TOTAL                                                = ~2,665 buckets
```

The two big contributors: `accessible_data` (1,010) and `report_data` (1,651).

Key rule: **different streams CANNOT share buckets**, even if they use identically-named CTEs. Only queries within the SAME stream sharing the SAME CTE merge their bucket sets.

## Step 1: Merge accessible_data + report_data into one stream

### What

Create a single `all_data` stream with one `accessible_facilities` CTE containing all 6 queries (contacts, SMS, targets, subject-reports, own-reports, needs-signoff).

### Why

Currently two streams create two separate bucket namespaces: N + (M + 2) buckets. Merging them into one stream with one CTE makes all 6 queries share a single bucket set of max(N, M) buckets instead of N + M.

### How

In `powersync.yaml` (inline sync_config):

```yaml
streams:
  all_data:
    auto_subscribe: true
    priority: 1
    with:
      accessible_facilities: |
        SELECT facility_id
        FROM "v1"."user_accessible_facilities"
        WHERE user_id = auth.user_id()
    queries:
      # === From accessible_data ===
      # 1. Contacts
      - |
        SELECT ... FROM "v1"."couchdb" contacts
        WHERE ... AND contacts._id IN accessible_facilities
      # 2. SMS Messages
      - |
        SELECT ... FROM "v1"."couchdb" sms_messages
        WHERE ... AND sms_messages.doc -> 'contact' ->> '_id' IN accessible_facilities
      # 3. Targets
      - |
        SELECT ... FROM "v1"."couchdb" targets
        WHERE ... AND targets.doc ->> 'owner' IN accessible_facilities
      # === From report_data (change IN report_facilities → IN accessible_facilities) ===
      # 4. Subject-matched reports
      - |
        SELECT ... FROM "v1"."couchdb" reports
        INNER JOIN "v1"."report_subjects" rs ON rs.report_id = reports._id
        WHERE ... AND rs.subject_id IN accessible_facilities
      # 5. Own reports (unchanged — uses auth parameter, 1 bucket)
      - |
        SELECT ... FROM "v1"."couchdb" reports
        WHERE ... AND reports.doc -> 'contact' ->> '_id' = auth.parameter('contact_id')
      # 6. Needs-signoff (unchanged — uses auth.user_id(), 1 bucket)
      - |
        SELECT ... FROM "v1"."couchdb" reports
        INNER JOIN "v1"."report_needs_signoff_visible" rnsv
          ON rnsv.report_id = reports._id
          AND rnsv.visible_to_user = auth.user_id()
        WHERE ...
```

Delete the `accessible_data` and `report_data` stream definitions. Keep all other streams unchanged.

### Trade-off

Reports currently use `report_facilities` (filtered by `report_depth`). Switching to `accessible_facilities` means users with `report_depth < replication_depth` will see reports from contacts beyond their report depth. This is a minor over-sync; client-side SQLite filtering can restore exact semantics. For users with `report_depth = -1` (unlimited — the most common case), there is zero behavioral change.

### Expected result

~1,010 (shared CTE) + ~640 (JOIN overhead from report_subjects) + 2 (auth-filtered) + 5 (fixed) = **~1,657 buckets** (38% reduction)

### Verification

Count buckets for ac1 via PowerSync diagnostics or the bucket_test script. Expect ~1,657.

---

## Step 2: Eliminate report_subjects JOIN by denormalizing resolved_subject_id

### What

Add a `resolved_subject_id` column directly on `v1.couchdb` so the subject-matched reports query can use `WHERE reports.resolved_subject_id IN accessible_facilities` without a JOIN.

### Why

`INNER JOIN report_subjects rs ON rs.report_id = reports._id WHERE rs.subject_id IN accessible_facilities` creates ~640 extra bucket keys from the JOIN dimension. Each unique `(report_id, subject_id)` pair becomes a potential bucket key. Eliminating the JOIN collapses this to just the CTE values.

### How

**In `setup.sql`:**

```sql
-- Add column (idempotent)
ALTER TABLE v1.couchdb ADD COLUMN IF NOT EXISTS resolved_subject_id TEXT;

-- Index for Sync Stream queries
CREATE INDEX IF NOT EXISTS idx_couchdb_resolved_subject
  ON v1.couchdb(resolved_subject_id)
  WHERE resolved_subject_id IS NOT NULL;

-- Batch populate from existing report_subjects
UPDATE v1.couchdb c
SET resolved_subject_id = rs.subject_id
FROM v1.report_subjects rs
WHERE rs.report_id = c._id
  AND c.resolved_subject_id IS NULL;
```

**Modify the existing `trg_auto_resolve_report_subject` trigger function** to also write `resolved_subject_id` on the couchdb row:

```sql
-- In the trigger function, after inserting into report_subjects:
UPDATE v1.couchdb
SET resolved_subject_id = <resolved_value>
WHERE _id = NEW._id;
```

**In `powersync.yaml`**, replace Query 4 (subject-matched reports):

```yaml
# BEFORE:
- |
  SELECT ... FROM "v1"."couchdb" reports
  INNER JOIN "v1"."report_subjects" rs ON rs.report_id = reports._id
  WHERE ... AND rs.subject_id IN accessible_facilities

# AFTER:
- |
  SELECT ... FROM "v1"."couchdb" reports
  WHERE ... AND reports.resolved_subject_id IN accessible_facilities
```

### Risk

Adding a column to `v1.couchdb` may conflict with cht-sync's couch2pg INSERT statements. Mitigation: couch2pg uses explicit column lists or `ON CONFLICT` upserts; PostgreSQL ignores columns not mentioned in INSERT. Use `ADD COLUMN IF NOT EXISTS` for idempotency. Test that couch2pg still works after the change.

### Expected result after both steps

~1,010 (shared CTE, no JOIN overhead) + 2 (auth-filtered) + 5 (fixed) = **~1,017 buckets** (62% reduction from 2,665)

---

## Files to Modify

| File | Change |
|------|--------|
| `.agents/worktrees/agent-3/.devcontainer/powersync-config/powersync.yaml` | Merge accessible_data + report_data into all_data, remove JOIN |
| `.agents/worktrees/agent-3/.devcontainer/powersync-config/sync-config.yaml` | Keep in sync with powersync.yaml changes |
| `.devcontainer/powersync-config/setup.sql` | Add resolved_subject_id column, index, trigger update, batch populate |
| `context/POWERSYNC_BUCKET_ARCHITECTURE_TRADEOFFS.md` | Document new bucket counts and rationale |
| `tests/scalability/powersync-benchmark/KNOWN_ISSUES.md` | Update optimization history |

## Verification Checklist

- [ ] After Step 1: ac1 bucket count drops to ~1,657
- [ ] After Step 2: ac1 bucket count drops to ~1,017
- [ ] CHW user sees only contacts in their facility subtree
- [ ] Supervisor with report_depth=2 sees correct reports (minor over-sync acceptable)
- [ ] Private reports (`fields.private = 'true'`) hidden from non-submitters
- [ ] needs_signoff reports visible to correct supervisors
- [ ] couch2pg INSERT still works after column addition
- [ ] PowerSync initial sync completes for ac1 without PSYNC_S2305 errors
- [ ] Benchmark: `run-isolated-powersync.sh 1 5 10 25 50` shows improved memory and latency

## Benchmark Context

From the concurrent load test (2026-04-12), the per-connection memory breakdown:
- 2,665 buckets → ~320MB per connection → OOM at 50 connections (16GB heap)
- Target: 1,017 buckets → ~122MB per connection → 50 connections = ~6GB (fits easily)
- This would also reduce sync latency since PowerSync docs state latency scales linearly with bucket count

---

## Step 3 (CRITICAL): Person-Bucket Reduction

Steps 1 and 2 above solved the bucket problem for ac1 (1,010 facilities, small-scale
test data). At production scale (589K docs, 40 HCs, 50 clinics × 160 persons), the
bucket count explodes because **every person is in `user_accessible_facilities`**.

### The problem at production scale

Each CHW user has 8,055 entries in `user_accessible_facilities`:
- 8,003 persons (50 clinics × 160 family members)
- 50 clinics
- 1 health center + 1 district hospital

With the `all_data` merged stream, this becomes **16,115 buckets** per user (CTE rows
appear in multiple query contexts). At 10 concurrent users: ~19GB memory. PowerSync
OOMs and PostgreSQL runs out of shared memory.

### Why persons are in the facility list

`refresh_user_facilities()` Step 1.5 expands all descendants to include direct children
of every accessible place. This adds every person because:
1. Reports use `resolved_subject_id` which can be a person's `_id`
2. The Sync Streams query `reports.resolved_subject_id IN accessible_facilities`
   needs person IDs to match reports about specific people

### The fix: match reports at clinic level, not person level

Instead of putting every person in the CTE, restructure so reports match via the
person's parent clinic:

**Option A: Add `resolved_subject_clinic_id` to couchdb**

Add a second denormalized column that stores the clinic containing the report's subject:
```sql
ALTER TABLE v1.couchdb ADD COLUMN IF NOT EXISTS resolved_subject_clinic_id TEXT
  GENERATED ALWAYS AS (
    -- resolved_subject_id points to a person, but we want the person's parent (clinic)
    -- This requires a lookup or a pre-computed value
  ) STORED;
```

Problem: generated columns can't reference other rows. Need a trigger instead.

**Option B (Recommended): Pre-compute subject_clinic_id in report_subjects**

Extend the `report_subjects` table or create a `report_subject_clinics` table:
```sql
-- When resolving a report's subject, also resolve the subject's parent clinic
-- Store: report_id → clinic_id (the clinic containing the subject person)
ALTER TABLE v1.report_subjects ADD COLUMN IF NOT EXISTS subject_clinic_id TEXT;

-- Update resolve_report_subject() to also store the person's parent
-- (person.parent._id → this is the clinic)
```

Then the Sync Streams query becomes:
```sql
-- BEFORE: matches on person ID (8,000+ values in CTE)
WHERE reports.resolved_subject_id IN accessible_facilities

-- AFTER: matches on clinic ID (50 values in CTE)
WHERE reports.resolved_subject_clinic_id IN accessible_facilities
```

And `user_accessible_facilities` NO LONGER needs person IDs — only places
(clinics, HCs, districts). Remove Step 1.5 from `refresh_user_facilities()`.

**Expected bucket count after Step 3:**

| Component | Before (with persons) | After (places only) |
|-----------|----------------------|---------------------|
| Clinics | 50 | 50 |
| Health center | 1 | 1 |
| District | 1 | 1 |
| Contact persons | 0 | ~3 (primary contacts) |
| **Person entries** | **8,003** | **0** |
| Fixed streams | 5 | 5 |
| **Total buckets** | **~16,115** | **~60** |

Per-connection memory: ~60 buckets × ~120KB = **~7MB** (vs 1.9GB currently).
10 concurrent: **~70MB**. 200 concurrent: **~1.4GB**.

### Files to modify

| File | Change |
|------|--------|
| `.devcontainer/powersync-config/setup.sql` | Add `subject_clinic_id` to report_subjects, update resolve function, REMOVE Step 1.5 from refresh_user_facilities |
| Powersync.yaml | Change reports query to use `resolved_subject_clinic_id` |
| `refresh_user_facilities()` | Remove Step 1.5 (person expansion) |

### Verification

1. `user_accessible_facilities` for a CHW: ~55 rows (not 8,055)
2. PowerSync bucket count: ~60 (not 16,115)
3. Reports about persons still sync to the correct CHW
4. Memory at 10 concurrent: < 100MB (not 19GB)
5. Run `run-scaled-powersync-benchmark.sh 10` — direct comparison to CouchDB's 20.7s
