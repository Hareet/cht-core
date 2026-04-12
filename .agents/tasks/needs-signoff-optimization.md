# Agent-3 Task: Pre-compute needs_signoff visibility to reduce report_data buckets

## Current State

After stream consolidation + previous optimizations:
- accessible_data: **1,010 buckets** (optimized, 1×)
- report_data: **3,672 buckets** (still inflated)
- Total: **4,686 buckets**, sync time: **5.7s**

## Root Cause

The `report_data` stream has 3 queries with 2 CTEs:

1. **Subject-matched reports** via `report_facilities` CTE + `INNER JOIN report_subjects` → ~1,651 buckets
2. **User's own reports** via `auth.parameter('contact_id')` → 1 bucket
3. **needs_signoff reports** via `accessible_facilities` CTE with **5 OR arms** → ~2,021 buckets

The needs_signoff query (query 3) has 5 `IN accessible_facilities` references for the ancestor chain walk:
```sql
AND (
  reports.doc -> 'contact' ->> '_id' IN accessible_facilities
  OR reports.doc -> 'contact' -> 'parent' ->> '_id' IN accessible_facilities
  OR reports.doc -> 'contact' -> 'parent' -> 'parent' ->> '_id' IN accessible_facilities
  OR reports.doc -> 'contact' -> 'parent' -> 'parent' -> 'parent' ->> '_id' IN accessible_facilities
  OR reports.doc -> 'contact' -> 'parent' -> 'parent' -> 'parent' -> 'parent' ->> '_id' IN accessible_facilities
)
```

Each `IN accessible_facilities` arm creates separate bucket keys. This is the dominant contributor to report_data's bucket count.

## Fix: Pre-compute needs_signoff visibility

### New table: `v1.report_needs_signoff_visible`

```sql
CREATE TABLE IF NOT EXISTS v1.report_needs_signoff_visible (
  report_id TEXT NOT NULL,
  visible_to_user TEXT NOT NULL,
  PRIMARY KEY (report_id, visible_to_user)
);

CREATE INDEX idx_rnsv_user ON v1.report_needs_signoff_visible(visible_to_user);
```

### Population logic

For each report with `fields.needs_signoff = 'true'`:
1. Get the submitter's contact._id
2. Walk the submitter's ancestor chain (contact → parent → parent.parent → ...)
3. For each ancestor ID, find all users who have that ancestor in their `user_accessible_facilities`
4. Insert a row `(report_id, user_id)` for each match

```sql
CREATE OR REPLACE FUNCTION v1.refresh_needs_signoff_visibility()
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM v1.report_needs_signoff_visible;

  -- For each needs_signoff report, walk submitter ancestor chain,
  -- match against user_accessible_facilities
  INSERT INTO v1.report_needs_signoff_visible (report_id, visible_to_user)
  SELECT DISTINCT r._id, uaf.user_id
  FROM v1.couchdb r
  -- Walk submitter's ancestor chain (up to 5 levels)
  CROSS JOIN LATERAL (
    SELECT r.doc -> 'contact' ->> '_id' AS ancestor_id
    UNION ALL
    SELECT c1.doc -> 'parent' ->> '_id'
    FROM v1.couchdb c1 WHERE c1._id = r.doc -> 'contact' ->> '_id' AND NOT COALESCE(c1._deleted, false)
    UNION ALL
    SELECT c2.doc -> 'parent' ->> '_id'
    FROM v1.couchdb c1
    JOIN v1.couchdb c2 ON c2._id = c1.doc -> 'parent' ->> '_id' AND NOT COALESCE(c2._deleted, false)
    WHERE c1._id = r.doc -> 'contact' ->> '_id' AND NOT COALESCE(c1._deleted, false)
    UNION ALL
    SELECT c3.doc -> 'parent' ->> '_id'
    FROM v1.couchdb c1
    JOIN v1.couchdb c2 ON c2._id = c1.doc -> 'parent' ->> '_id' AND NOT COALESCE(c2._deleted, false)
    JOIN v1.couchdb c3 ON c3._id = c2.doc -> 'parent' ->> '_id' AND NOT COALESCE(c3._deleted, false)
    WHERE c1._id = r.doc -> 'contact' ->> '_id' AND NOT COALESCE(c1._deleted, false)
    UNION ALL
    SELECT c4.doc -> 'parent' ->> '_id'
    FROM v1.couchdb c1
    JOIN v1.couchdb c2 ON c2._id = c1.doc -> 'parent' ->> '_id' AND NOT COALESCE(c2._deleted, false)
    JOIN v1.couchdb c3 ON c3._id = c2.doc -> 'parent' ->> '_id' AND NOT COALESCE(c3._deleted, false)
    JOIN v1.couchdb c4 ON c4._id = c3.doc -> 'parent' ->> '_id' AND NOT COALESCE(c4._deleted, false)
    WHERE c1._id = r.doc -> 'contact' ->> '_id' AND NOT COALESCE(c1._deleted, false)
  ) ancestors
  JOIN v1.user_accessible_facilities uaf ON uaf.facility_id = ancestors.ancestor_id
  WHERE NOT COALESCE(r._deleted, false)
    AND r.doc ->> 'type' = 'data_record'
    AND r.doc ->> 'form' IS NOT NULL
    AND r.doc -> 'fields' ->> 'needs_signoff' = 'true'
    AND ancestors.ancestor_id IS NOT NULL;
END;
$$;
```

Note: The CROSS JOIN LATERAL approach may be slow. A simpler approach using a recursive CTE to walk the ancestor chain for each report's submitter would also work. Choose whichever performs better.

### Simplified needs_signoff query in Sync Streams

Replace the 5-arm OR with a direct `auth.user_id()` filter:

```yaml
# Query 3 in report_data: needs_signoff reports
- |
  SELECT
    reports._id AS id,
    reports.doc ->> 'form' AS form,
    reports.doc ->> 'patient_id' AS patient_id,
    reports.doc -> 'contact' ->> '_id' AS submitter_id,
    reports.doc ->> 'reported_date' AS reported_date,
    reports.doc -> 'fields' ->> 'private' AS is_private,
    reports.doc -> 'fields' ->> 'needs_signoff' AS needs_signoff,
    CAST(reports.doc -> 'fields' AS TEXT) AS fields,
    CAST(reports.doc AS TEXT) AS doc
  FROM "v1"."couchdb" reports
  INNER JOIN "v1"."report_needs_signoff_visible" rnsv
    ON rnsv.report_id = reports._id
    AND rnsv.visible_to_user = auth.user_id()
  WHERE reports._deleted != true
    AND reports.doc ->> 'type' = 'data_record'
    AND reports.doc ->> 'form' IS NOT NULL
    AND reports.doc -> 'fields' ->> 'needs_signoff' = 'true'
    AND (
      ifnull(reports.doc -> 'fields' ->> 'private', 'false') != 'true'
      OR reports.doc -> 'contact' ->> '_id' = auth.parameter('contact_id')
    )
```

The `rnsv.visible_to_user = auth.user_id()` is a direct auth filter → **1 bucket per user** for this query.

### Remove `accessible_facilities` CTE from report_data

After this change, report_data no longer needs the `accessible_facilities` CTE at all. The stream only has:
- `report_facilities` CTE (for subject-matched reports)
- `auth.parameter('contact_id')` (for own reports)
- `auth.user_id()` via the JOIN (for needs_signoff)

### Add to publication

```sql
DROP PUBLICATION IF EXISTS powersync;
CREATE PUBLICATION powersync FOR TABLE
  v1.couchdb,
  v1.user_settings,
  v1.user_accessible_facilities,
  v1.user_report_facilities,
  v1.purge_status,
  v1.report_subjects,
  v1.report_needs_signoff_visible;  -- ADD THIS
```

### Auto-trigger for new needs_signoff reports

```sql
CREATE OR REPLACE FUNCTION v1.auto_refresh_needs_signoff()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.doc -> 'fields' ->> 'needs_signoff' = 'true'
     AND NEW.doc ->> 'type' = 'data_record' THEN
    -- Refresh visibility for this specific report
    DELETE FROM v1.report_needs_signoff_visible WHERE report_id = NEW._id;
    -- (insert logic for this single report - similar to the batch function but for one doc)
  END IF;
  RETURN NEW;
END;
$$;
```

## Files to Modify

| File | Change |
|------|--------|
| `setup.sql` | Add `report_needs_signoff_visible` table, `refresh_needs_signoff_visibility()` function, trigger, publication update |
| `powersync.yaml` | Replace needs_signoff query 3 in report_data, remove `accessible_facilities` CTE from report_data |
| `sync-config.yaml` | Same changes |

## Expected Impact

| Stream | Before | After |
|--------|--------|-------|
| accessible_data | 1,010 | 1,010 (unchanged) |
| report_data | 3,672 | ~1,652 (subject reports ~1,651 + own reports 1 + needs_signoff 1) |
| Others | 4 | 4 |
| **Total** | **4,686** | **~2,666** |

Sync time projection: 5.7s × (2,666/4,686) ≈ **3.2s** (from 11.4s original)

## Verification

```bash
# Apply schema
docker exec -i cht-postgres psql -U cht -d cht < .devcontainer/powersync-config/setup.sql

# Refresh data
docker exec -i cht-postgres psql -U cht -d cht -c "
  SELECT v1.refresh_user_facilities('org.couchdb.user:ac1');
  SELECT v1.refresh_report_subjects();
  SELECT v1.refresh_needs_signoff_visibility();
"

# Restart PowerSync
docker restart cht-powersync && sleep 15

# Test bucket count (regenerate token first if needed)
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

**Target:** report_data ≈ 1,652, total ≈ 2,666
