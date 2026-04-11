# Agent-3 Task: Fix Remaining Bucket Multipliers

## Current State After Previous Optimizations

| Stream | Buckets | Expected | Issue |
|--------|---------|----------|-------|
| accessible_data | **2,021** | ~1,010 | Still 2× despite removing contacts OR |
| report_data | **1,651** | ~1,010 | INNER JOIN report_subjects creates extra bucket keys |
| Others | 4 | 4 | Fine |
| **Total** | **3,676** | ~2,024 | |

## Problem 1: accessible_data 2,021 (still 2×)

### Root cause identified

The contacts OR was removed — `contacts._id IN accessible_facilities` is the only CTE reference in that query. **But the needs_signoff query (lines 96-123 of powersync.yaml) has 5 `IN accessible_facilities` references:**

```sql
AND (
  reports.doc -> 'contact' ->> '_id' IN accessible_facilities
  OR reports.doc -> 'contact' -> 'parent' ->> '_id' IN accessible_facilities
  OR reports.doc -> 'contact' -> 'parent' -> 'parent' ->> '_id' IN accessible_facilities
  OR reports.doc -> 'contact' -> 'parent' -> 'parent' -> 'parent' ->> '_id' IN accessible_facilities
  OR reports.doc -> 'contact' -> 'parent' -> 'parent' -> 'parent' -> 'parent' ->> '_id' IN accessible_facilities
)
```

Each `IN accessible_facilities` arm creates its own set of bucket keys. With 5 arms, this inflates the accessible_data bucket count even though all other queries in the stream only use the CTE once.

### Fix: Pre-compute needs_signoff submitter visibility

Instead of walking the ancestor chain in the Sync Streams query (5 CTE references), pre-compute which needs_signoff reports are visible to each user. Add a `report_needs_signoff_visible` table:

```sql
CREATE TABLE IF NOT EXISTS v1.report_needs_signoff_visible (
  report_id TEXT NOT NULL,
  visible_to_user TEXT NOT NULL,
  PRIMARY KEY (report_id, visible_to_user)
);
```

Populated by: for each needs_signoff report, walk its submitter's ancestor chain, find which users have those ancestors in their `user_accessible_facilities`, and insert a row.

**Or simpler approach:** Move the needs_signoff query OUT of `accessible_data` into its own stream. This way, the 5× CTE references only affect the needs_signoff stream, not the shared bucket count for contacts + sms + targets.

**Simplest approach (recommended):** Move needs_signoff into `report_data` stream. It uses `accessible_facilities` CTE but report_data already has its own `report_facilities` CTE. Add `accessible_facilities` as a second CTE in report_data. The needs_signoff query creates its own bucket set (separate from report_facilities), but it no longer inflates the accessible_data bucket count shared by contacts + sms + targets.

```yaml
# accessible_data: contacts + sms + targets ONLY (no needs_signoff)
# Each uses accessible_facilities CTE once → N buckets
accessible_data:
  with:
    accessible_facilities: ...
  queries:
    - contacts query (_id IN accessible_facilities)
    - sms query (contact._id IN accessible_facilities)
    - targets query (owner IN accessible_facilities)

# report_data: subject reports + own reports + needs_signoff
report_data:
  with:
    report_facilities: ...
    accessible_facilities: ...   # second CTE for needs_signoff
  queries:
    - subject reports (subject_id IN report_facilities)         # M buckets
    - own reports (contact._id = auth.parameter)                # 1 bucket
    - needs_signoff (5-level ancestor IN accessible_facilities) # separate bucket set
```

This way accessible_data has only 3 queries each referencing the CTE once → **N buckets (not 2N)**. The needs_signoff bucket overhead moves to report_data where it's additive with report_facilities (N + M + needs_signoff), not multiplicative.

**Expected result:** accessible_data drops from 2,021 → ~1,010.

### Also fix: Step 1.5 (child expansion) not working

`user_accessible_facilities` is still 1,010 for ac1 — Step 1.5 didn't add children. Check the Step 1.5 implementation in `refresh_user_facilities()`. It should insert direct children of all accessible facilities. If ac1's accessible facilities already include all descendants (because the recursive CTE in Step 1 walks to replication_depth), then there are no additional children to add — meaning the function is correct but the data already covers all children.

In that case, the contacts OR wasn't actually needed (all contacts' `_id`s were already in the table), and the 2× was purely from the needs_signoff query sharing the bucket set. Verify by checking:

```sql
-- Are there contacts whose parent is accessible but who are NOT in user_accessible_facilities?
SELECT count(*) FROM v1.couchdb c
JOIN v1.user_accessible_facilities uaf
  ON uaf.user_id = 'org.couchdb.user:ac1'
  AND ifnull(c.doc -> 'parent' ->> '_id', c.doc ->> 'parent') = uaf.facility_id
WHERE NOT COALESCE(c._deleted, false)
  AND c.doc ->> 'type' IN ('contact', 'person', 'clinic', 'health_center', 'district_hospital')
  AND c._id NOT IN (SELECT facility_id FROM v1.user_accessible_facilities WHERE user_id = 'org.couchdb.user:ac1');
```

If 0, all children are already included and Step 1.5 is a no-op (which is correct).

## Problem 2: report_data 1,651 (should be ~1,010)

### Root cause

Query 1 uses `INNER JOIN report_subjects rs ON rs.report_id = reports._id WHERE rs.subject_id IN report_facilities`. The JOIN against `report_subjects` may be creating bucket keys per JOIN row (per report), not per CTE value.

From our empirical testing, JOINs create N buckets per joined row. The query has both a JOIN (against report_subjects) and an IN CTE (report_facilities). PowerSync may be creating bucket keys from the JOIN rather than from the CTE, giving ~1,455 buckets (one per report_subject) + 1 (own reports) = ~1,456. The actual 1,651 suggests some additional factor.

### Fix: Eliminate the JOIN

Instead of `INNER JOIN report_subjects`, use a CTE that returns the report IDs directly:

```yaml
report_data:
  with:
    report_facilities: |
      SELECT facility_id FROM v1.user_report_facilities
      WHERE user_id = auth.user_id()
    user_report_ids: |
      SELECT rs.report_id
      FROM v1.report_subjects rs
      JOIN v1.user_report_facilities urf
        ON urf.facility_id = rs.subject_id
        AND urf.user_id = auth.user_id()
  queries:
    - |
      SELECT reports._id AS id, ...
      FROM "v1"."couchdb" reports
      WHERE reports._deleted != true
        AND reports.doc ->> 'type' = 'data_record'
        AND reports._id IN user_report_ids
```

Wait — this CTE would return N report IDs, creating N buckets per report. That's worse.

**Better fix:** Keep the current pattern but verify the bucket key source. If the JOIN is creating the bucket keys (not the CTE), then the only fix is to ensure `report_subjects` is included in the publication and PowerSync can track it.

Actually, the simplest fix: **remove the INNER JOIN and use a subquery instead:**

```sql
SELECT reports._id AS id, ...
FROM "v1"."couchdb" reports
WHERE reports._deleted != true
  AND reports.doc ->> 'type' = 'data_record'
  AND reports.doc ->> 'form' IS NOT NULL
  AND reports._id IN (
    SELECT rs.report_id FROM v1.report_subjects rs
    WHERE rs.subject_id IN report_facilities
  )
```

This nests the report_subjects lookup inside the CTE expansion. The bucket key should come from `report_facilities` (the CTE), not from the subquery. **Test this empirically** — if it reduces to ~1,010, the JOIN was the issue.

**Risk:** The nested subquery may hit `max_parameter_query_results` if `report_facilities` has many entries. With 1,010 facilities, the inner CTE expands to 1,010 parameters, then the outer subquery returns matching report IDs. Should be within the 10,000 limit.

## Files to Modify

| File | Change |
|------|--------|
| `powersync.yaml` | Move needs_signoff out of accessible_data; replace report JOIN with subquery |
| `sync-config.yaml` | Same changes |

## Verification

```bash
# Restart PowerSync
docker restart cht-powersync && sleep 15

# Test ac1 bucket count
curl -s -X POST http://localhost:8080/sync/stream \
  -H "Authorization: Bearer $(cat /tmp/token_ac1.txt)" \
  -H "Content-Type: application/json" \
  -d '{"buckets":[],"include_checksum":true}' 2>&1 | head -c 1000000 | python3 -c "
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

**Target:** accessible_data ~1,010, report_data ~1,010, total ~2,024

## Priority

1. **Move needs_signoff out of accessible_data** — this is the clear fix for the 2× multiplier. Quick change.
2. **Replace report JOIN with subquery** — needs empirical testing. May or may not reduce bucket count depending on how PowerSync handles nested subqueries within CTEs.
