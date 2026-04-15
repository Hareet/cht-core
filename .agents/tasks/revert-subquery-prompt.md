# Agent-3 Task: Revert report_data subquery, keep needs_signoff move

## Results

Fix 1 (move needs_signoff out of accessible_data): **SUCCESS** — accessible_data dropped from 2,021 → 1,010.

Fix 2 (replace INNER JOIN with nested subquery in report_data): **FAILED** — report_data went from 1,651 → 3,672. The nested subquery `reports._id IN (SELECT rs.report_id FROM report_subjects rs WHERE rs.subject_id IN report_facilities)` created MORE bucket keys than the JOIN.

## Action

Revert ONLY Fix 2 in both `powersync.yaml` and `sync-config.yaml`. Restore the INNER JOIN pattern for the subject-matched reports query:

```sql
-- REVERT TO THIS (the INNER JOIN pattern that gave 1,651 buckets):
SELECT reports._id AS id, ...
FROM "v1"."couchdb" reports
INNER JOIN "v1"."report_subjects" rs
  ON rs.report_id = reports._id
WHERE reports._deleted != true
  AND reports.doc ->> 'type' = 'data_record'
  AND reports.doc ->> 'form' IS NOT NULL
  AND rs.subject_id IN report_facilities
  AND (
    ifnull(reports.doc -> 'fields' ->> 'private', 'false') != 'true'
    OR reports.doc -> 'contact' ->> '_id' = auth.parameter('contact_id')
  )
```

Keep Fix 1 (needs_signoff in report_data with its own accessible_facilities CTE). Do NOT change accessible_data — it's correct at 1,010 buckets.

**Expected result after revert:** accessible_data ~1,010 + report_data ~1,651 + needs_signoff overhead + 4 = ~3,000-3,500 total (better than 4,686 and better than the original 6,040).

## Files to modify
- `.devcontainer/powersync-config/powersync.yaml` — revert report_data Query 1 to INNER JOIN
- `.devcontainer/powersync-config/sync-config.yaml` — same
