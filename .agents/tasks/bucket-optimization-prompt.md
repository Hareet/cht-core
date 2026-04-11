# Agent-3 Task: Reduce Bucket Multiplier in Consolidated Sync Streams

## Context

Stream consolidation is implemented and working. But empirical benchmarking (2026-04-11) shows the bucket count has multipliers that inflate it beyond what the data scope requires:

| Stream | Facilities | Actual Buckets | Multiplier | Cause |
|--------|-----------|---------------|------------|-------|
| accessible_data | 1,010 | 2,021 | **2×** | Contacts query OR condition |
| report_data | 1,010 | 4,015 | **4×** | Shortcodes + multiple field matches |
| tasks, global, user_settings, user_meta | — | 4 | 1× | Already optimal |
| **Total** | **1,010** | **6,040** | | |

This causes 11.4 second initial sync for a 1,010-facility user. Target: ~2,030 buckets (~3-4 second initial sync).

## Problem 1: accessible_data 2× multiplier

### Root cause

The contacts query in `accessible_data` has:
```sql
WHERE contacts._id IN accessible_facilities
   OR ifnull(contacts.doc -> 'parent' ->> '_id', contacts.doc ->> 'parent') IN accessible_facilities
```

PowerSync creates separate bucket keys for each arm of the OR. Facility `fac-001` generates two bucket keys: one for `_id = fac-001` and one for `parent = fac-001`. Hence 2× buckets.

### Fix

**Expand `user_accessible_facilities` to include child IDs directly**, so the contacts query only needs `_id IN accessible_facilities` — no OR.

Currently `refresh_user_facilities()` walks descendants and stores them. But a contact whose `parent` is in `accessible_facilities` may NOT itself be in the table if it's at depth > `replication_depth`. The OR condition catches those — it says "show me any contact whose parent is accessible, even if the contact itself isn't listed."

The fix: in `refresh_user_facilities()`, after computing descendants, add a step that inserts ALL direct children of every accessible facility. This makes `_id IN accessible_facilities` sufficient.

```sql
-- Step 6 (new): Add direct children of all accessible facilities
INSERT INTO v1.user_accessible_facilities (user_id, facility_id, depth)
SELECT DISTINCT p_user_id, c._id, uaf.depth + 1
FROM v1.couchdb c
JOIN v1.user_accessible_facilities uaf
  ON uaf.user_id = p_user_id
  AND (
    c.doc -> 'parent' ->> '_id' = uaf.facility_id
    OR (jsonb_typeof(c.doc -> 'parent') = 'string' AND c.doc ->> 'parent' = uaf.facility_id)
  )
WHERE NOT COALESCE(c._deleted, false)
  AND c.doc ->> 'type' IN ('contact', 'person', 'clinic', 'health_center', 'district_hospital')
ON CONFLICT (user_id, facility_id) DO NOTHING;
```

Then simplify the contacts query in `accessible_data`:
```sql
-- Before (2× buckets):
WHERE contacts._id IN accessible_facilities
   OR ifnull(contacts.doc -> 'parent' ->> '_id', contacts.doc ->> 'parent') IN accessible_facilities

-- After (1× buckets):
WHERE contacts._id IN accessible_facilities
```

**Validation:** After the change, `accessible_data` bucket count for ac1 should drop from ~2,021 to ~1,010.

**Risk:** The `user_accessible_facilities` table will have more rows per user (adds ~1 layer of children). This increases the CTE size, which counts against `max_parameter_query_results`. For ac1 with 1,010 current entries, this might grow to ~1,500. Still well under the 10,000 limit.

## Problem 2: report_data 4× multiplier

### Root cause

Two factors multiply:

**Factor A (2×): `user_report_facilities` contains both UUIDs and shortcodes.**

`refresh_user_facilities()` Step 5b adds shortcodes (patient_id, place_id) from the couchdb docs. For 1,010 facilities, the table grows to ~2,020 entries (UUIDs + shortcodes).

**Factor B (2×): The reports query checks multiple fields against the CTE.**

The reports query (subject-matching) has:
```sql
WHERE reports.doc ->> 'patient_id' IN report_facilities
   OR reports.doc -> 'fields' ->> 'patient_id' IN report_facilities
   OR reports.doc ->> 'place_id' IN report_facilities
   OR reports.doc -> 'fields' ->> 'place_id' IN report_facilities
   OR reports.doc -> 'contact' ->> '_id' IN report_facilities
```

Each OR arm referencing `IN report_facilities` may create additional bucket keys.

### Fix (Factor A): Pre-resolve shortcodes to UUIDs

Instead of storing shortcodes in `user_report_facilities`, resolve them at query time or eliminate the need:

**Option A (recommended): Store only UUIDs in `user_report_facilities`. Change the reports query to join against couchdb to resolve shortcodes at query time:**

Remove Step 5b (shortcode insertion) from `refresh_user_facilities()`. The report query matches by UUID only. Reports that reference subjects only by shortcode (no UUID) would need a pre-computed mapping table or an additional query.

**Option B (safer): Create a `report_subject_to_uuid` mapping table** populated during `refresh_user_facilities()`:
```sql
CREATE TABLE v1.report_subject_mapping (
  shortcode TEXT PRIMARY KEY,
  uuid TEXT NOT NULL
);
```
Populated by: `SELECT doc ->> 'patient_id' AS shortcode, _id AS uuid FROM v1.couchdb WHERE doc ->> 'patient_id' IS NOT NULL`

Then `user_report_facilities` stores only UUIDs, and reports are matched by UUID only.

**Risk assessment:** CHT reports created in v3.x and earlier may only have shortcode references. A data audit is needed:
```sql
-- Count reports with shortcode-only references (no UUID match possible)
SELECT count(*) FROM v1.couchdb
WHERE doc ->> 'type' = 'data_record'
  AND doc ->> 'form' IS NOT NULL
  AND doc ->> 'patient_id' IS NOT NULL
  AND doc ->> 'patient_id' NOT IN (
    SELECT _id FROM v1.couchdb WHERE doc ->> 'type' IN ('contact', 'person')
  );
```

If the count is 0 or near-0, Option A is safe. If significant, use Option B.

### Fix (Factor B): Reduce OR arms in the reports query

Instead of checking 5+ fields against the CTE, **pre-compute a `report_subjects` table** that maps each report to its resolved subject UUID:

```sql
CREATE TABLE v1.report_subjects (
  report_id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL  -- resolved UUID of the subject contact
);

CREATE INDEX idx_report_subjects_subject ON v1.report_subjects(subject_id);
```

Populated by resolving the CHT subject resolution chain: `patient_id` → `fields.patient_id` → `place_id` → `fields.place_id` → `contact._id`, looking up shortcodes in the mapping table.

Then the reports query simplifies to:
```sql
SELECT reports._id AS id, ...
FROM v1.couchdb reports
INNER JOIN v1.report_subjects rs ON rs.report_id = reports._id
WHERE rs.subject_id IN report_facilities
```

This gives exactly 1 CTE reference per report query — no OR arms, no multiplier.

**Impact:** report_data drops from 4,015 → ~1,010 buckets.

**Effort:** Medium (2-3 days). Requires:
1. Create `report_subjects` table
2. Write population query/function
3. Add to PostgreSQL publication for PowerSync
4. Simplify the report_data stream query
5. Trigger refresh on report inserts (via trigger or periodic job)

## Files to Modify

| File | Change |
|------|--------|
| `.devcontainer/powersync-config/setup.sql` | Add Step 6 to `refresh_user_facilities()`, optionally add `report_subjects` table |
| `.devcontainer/powersync-config/powersync.yaml` | Simplify contacts query (remove OR), simplify reports query |
| `.devcontainer/powersync-config/sync-config.yaml` | Same changes (reference config) |
| `.devcontainer/powersync-config/README.md` | Update bucket count projections |

## Priority

**Problem 1 (accessible_data 2×) is the quick win.** It's a simple expansion of `refresh_user_facilities()` + removing an OR from the contacts query. Low risk, immediate 50% reduction in accessible_data buckets.

**Problem 2 (report_data 4×) is the bigger payoff but higher effort.** The `report_subjects` table is a new pre-computation step. Do the data audit first to assess shortcode risk.

## Verification

After each change, test with the threshold user and ac1:

```bash
# Recreate threshold user with 500 facilities
docker exec -i cht-postgres psql -U cht -d cht <<'SQL'
DELETE FROM v1.user_accessible_facilities WHERE user_id = 'org.couchdb.user:threshold_user';
SELECT v1.refresh_user_facilities('org.couchdb.user:threshold_user');
SELECT count(*) FROM v1.user_accessible_facilities WHERE user_id = 'org.couchdb.user:threshold_user';
SQL

# Restart PowerSync and test bucket count
docker restart cht-powersync
sleep 10

# Generate token and check buckets (use main .devcontainer key)
curl -s -X POST http://localhost:8080/sync/stream \
  -H "Authorization: Bearer $(cat /tmp/token_threshold.txt)" \
  -H "Content-Type: application/json" \
  -d '{"buckets":[],"include_checksum":true}' | head -c 500000 | python3 -c "
import sys, json
line = sys.stdin.read().split('\n')[0]
data = json.loads(line)
buckets = data['checkpoint']['buckets']
print(f'Total buckets: {len(buckets)}')
streams = {}
for b in buckets:
    name = b['bucket'].split('|')[0].split('#')[1]
    streams.setdefault(name, []).append(b)
for s, bs in sorted(streams.items()):
    print(f'  {s}: {len(bs)} bucket(s), {sum(b[\"count\"] for b in bs)} rows')
"
```

**Target bucket counts after optimization:**

| Stream | ac1 current | After Problem 1 | After Problem 1+2 |
|--------|------------|-----------------|-------------------|
| accessible_data | 2,021 | ~1,010 | ~1,010 |
| report_data | 4,015 | 4,015 | ~1,010 |
| Others | 4 | 4 | 4 |
| **Total** | **6,040** | **~5,029** | **~2,024** |

## Reference

- Benchmark results: `context/POWERSYNC_BUCKET_ARCHITECTURE_TRADEOFFS.md` section 1.1
- Bucket semantics test: `tests/scalability/powersync-benchmark/bucket-semantics-test.js`
- Current setup.sql: `.devcontainer/powersync-config/setup.sql` (refresh_user_facilities function)
- PowerSync config keys: `api.parameters.max_parameter_query_results: 10000`, `api.parameters.max_buckets_per_connection: 10000`
- Head-to-head benchmark: CouchDB 1.039s vs PowerSync 11.416s for ac1 (1,010 facilities, 6,040 buckets)
