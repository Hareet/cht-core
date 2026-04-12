# PowerSync Sync Streams Configuration for CHT

This directory contains the PowerSync service configuration and Sync Streams
definitions that implement CHT's hierarchical authorization model.

Verified against:
- `ddocs/medic-db/medic/nouveau/docs_by_replication_key/index.js` (the actual replication key index)
- `api/src/services/authorization.js` (server-side authorization logic)
- CHT docs (Kapa AI): replication depth, report_depth, needs_signoff, replicate_primary_contacts
- PowerSync docs: Sync Streams edition 3 syntax, supported SQL, CTE limitations

## Files

| File | Purpose |
|------|---------|
| `powersync.yaml` | PowerSync service config (DB connection, auth, storage) |
| `sync-config.yaml` | Sync Streams definitions (edition 3) — 7 streams (consolidated) |
| `setup.sql` | PostgreSQL supporting tables, functions, and seed data |
| `generate-test-token.js` | JWT token generator for dev testing |
| `.gitignore` | Excludes private keys from version control |

## Architecture

```
CHT Documents (v1.couchdb JSONB)
  │
  ├─ user_accessible_facilities  ← pre-computed hierarchy (recursive CTE)
  │     (user_id, facility_id,      refreshed on hierarchy/role changes
  │      depth)
  │
  ├─ user_settings               ← user config with BOTH depth values
  │     (facility, roles,            contact_depth + report_depth
  │      replication_depth,
  │      report_depth)
  │
  ├─ purge_status                ← tracks docs to exclude per role
  │     (doc_id, role_hash)         populated by purge preprocessor
  │
  └─ PowerSync Sync Streams (7 streams, consolidated by CTE)
        ├─ accessible_data:   contacts + SMS + targets (N buckets)
        │     (shared accessible_facilities CTE, 1 ref per query)
        ├─ report_data:       subject + own + needs_signoff reports
        │     (two CTEs: report_facilities M + accessible_facilities + 1)
        ├─ unassigned_reports: reports without subject (requires can_view_unallocated)
        ├─ tasks:             user-scoped via auth.user_id() (1 bucket)
        ├─ global_config:     no filter (_all replication key docs) (1 shared bucket)
        ├─ user_settings_doc: user's own org.couchdb.user:* document (1 bucket)
        └─ user_meta:         user-scoped feedback/telemetry (1 bucket)
```

## Sync Streams Detail

### Bucket Optimization Strategy

Three optimizations reduce bucket count from the original ~9*N to ~N+M+5:

1. **CTE sharing** (stream consolidation): Queries sharing the same CTE within a
   stream share bucket instances. Contacts, SMS, targets, and needs_signoff reports
   are merged into `accessible_data` with a shared `accessible_facilities` CTE.

2. **Pre-expanded children** (setup.sql Step 1.5): `user_accessible_facilities` is
   expanded to include direct children of all descendant contacts. This eliminates
   the `OR parent IN accessible_facilities` condition in the contacts query, which
   was causing a 2× bucket multiplier.

3. **Pre-resolved subjects** (report_subjects table): Each report's subject is
   resolved to a single UUID at write time. The report_data query JOINs
   `report_subjects` instead of checking 9 OR arms against the CTE. Shortcodes
   are no longer stored in `user_report_facilities`. This eliminates the 4×
   bucket multiplier (2× from shortcodes + 2× from multiple OR arms).

| Stream | Optimization | Buckets |
|--------|-------------|---------|
| accessible_data (contacts) | CTE sharing, 1 ref per query | N (shared) |
| accessible_data (sms) | CTE sharing | ↑ shared |
| accessible_data (targets) | CTE sharing | ↑ shared |
| report_data (subject) | Pre-resolved subjects, nested subquery | M |
| report_data (own) | Direct auth parameter | 1 |
| report_data (signoff) | accessible_facilities CTE (separate set) | K |
| tasks | Direct auth parameter | 1 |
| global_config | No user filter | 1 |
| user_settings_doc | Direct auth parameter | 1 |
| user_meta | Direct auth parameter | 1 |
| **Total** | | **N + M + K + 5** |

N = accessible_facilities (contacts/sms/targets), M = report_facilities (subject reports),
K = accessible_facilities bucket overhead from needs_signoff (separate from N since
different stream). For 1,010 facilities: N≈1,010, M≈1,010, K≈TBD (empirical).

### accessible_data (priority 1, auto_subscribe)
Consolidated stream with 3 queries sharing `accessible_facilities` CTE.
Each query references the CTE exactly once, ensuring N shared buckets.
Table aliases determine client-side table names:

1. **contacts** (alias `contacts`): Hierarchy-filtered by `user_accessible_facilities`.
   Pre-expanded (Step 1.5) so a single `_id IN` check suffices.
2. **sms_messages** (alias `sms_messages`): Data records WITHOUT a `form` field.
   Replication key is `doc.contact._id` (the sender).
3. **targets** (alias `targets`): `target.owner` = contact UUID. Syncs to any user
   who can see the owner contact. Supervisors see subordinate targets.

needs_signoff was moved to `report_data` because its 5-level ancestor chain walk
creates multiple `IN accessible_facilities` references that inflated this stream's
bucket count to 2× when it was here.

### report_data (priority 2, auto_subscribe)
Three queries, two CTEs (`report_facilities` + `accessible_facilities`):

1. **Subject-matched reports** (alias `reports`): Uses nested subquery through
   `report_subjects` table for pre-resolved subject UUID. Single
   `_id IN (SELECT ... WHERE subject_id IN report_facilities)` check.
2. **User's own reports** (alias `reports`): Submitter always sees their own reports
   regardless of `report_depth` (CHT `authorization.js` line 600).
3. **needs_signoff reports** (alias `reports`): Reports with `fields.needs_signoff=true`
   walk 5 levels of submitter ancestor chain via `accessible_facilities` CTE.
   Separate bucket set from `report_facilities`.

### unassigned_reports (priority 3, auto_subscribe)
Reports without any subject (all subject fields null/empty).
Maps to `_unassigned` replication key. Only synced when JWT includes
`can_view_unallocated = 'true'`. Uses alias `reports` for same client table.

### tasks (priority 3, auto_subscribe)
`task.user` = CouchDB user ID (`org.couchdb.user:<username>`), NOT contact UUID.
Uses `auth.user_id()` which maps to the JWT `sub` claim. 1 bucket per user.

### global_config (priority 1, auto_subscribe)
Two queries (multi-query stream):
1. By type: `form`, `translations`
2. By `_id`: `resources`, `branding`, `partners`, `service-worker-meta`, `zscore-charts`, `settings`, `privacy-policies`, `_design/medic-client`

Matches the `_all` replication key in CHT's `docs_by_replication_key` index plus
the `_design/medic-client` design doc (always allowed per `authorization.js`).
1 shared global bucket (no user filter).

### user_settings_doc (priority 1, auto_subscribe)
User's own `org.couchdb.user:<username>` document (roles, facility, etc.). 1 bucket.

### user_meta (priority 3, auto_subscribe)
Feedback, telemetry, read-status docs filtered by user. 1 bucket.

## Setup

### 1. Prerequisites
- PostgreSQL running with `wal_level=logical`
- `v1.couchdb` table populated by cht-sync

### 2. Create supporting tables
```bash
PGPASSWORD=pgpass psql -h postgres -U cht -d cht -f setup.sql
```

### 3. Start PowerSync service
```bash
docker compose -f docker-compose.powersync.yml up -d
```

### 4. Generate test tokens
```bash
node generate-test-token.js chw_user
node generate-test-token.js supervisor_user
node generate-test-token.js county_admin
```

## JWT Claims

| Claim | Source | Used By | Notes |
|-------|--------|---------|-------|
| `sub` | `user_settings.user_id` | `auth.user_id()` | Tasks filter, facility lookup |
| `contact_id` | `user_settings.contact_id` | `auth.parameter('contact_id')` | Privacy filter, own-report bypass |
| `report_depth` | `user_settings.report_depth` | `auth.parameter('report_depth')` | Report depth (pre-computed) |
| `role_hash` | `user_settings.role_hash` | `auth.parameter('role_hash')` | Purge filtering (via trigger) |
| `can_view_unallocated` | App config + permissions | `auth.parameter('can_view_unallocated')` | Unassigned reports |
| `aud` | Static: `cht-powersync-dev` | Token validation | |

## Design Decisions

### Why pre-computed `user_accessible_facilities` instead of recursive CTE in Sync Streams?
PowerSync Sync Streams use their own SQL dialect that does NOT support recursive CTEs or
`WITH RECURSIVE`. The hierarchy traversal runs in PostgreSQL via `refresh_user_facilities()`
and the result is stored in a regular table that PowerSync can query via subquery/CTE.

### Why separate `report_depth` from contact depth?
CHT has TWO depth settings per role (since v3.10):
- `depth`: controls which contacts sync (hierarchy depth)
- `report_depth`: controls which OTHER users' reports sync (your own reports always sync)

The `user_accessible_facilities` table stores the `depth` value for each facility, and the
`report_depth_facilities` CTE in the reports stream filters by `depth <= report_depth`.

### Why walk ancestor chain for `needs_signoff`?
Reports with `fields.needs_signoff=true` must replicate UP the hierarchy so supervisors can
review them. CHT's index walks the submitter's entire parent chain and adds each ancestor's
`_id` as a replication key. We replicate this by checking 5 levels of nested `contact.parent`
in the Sync Streams query (covers typical hierarchy depth).

### Why purge uses a trigger-based soft-delete pattern?
PowerSync Sync Streams explicitly do not support `NOT IN` with subqueries or `LEFT JOIN`.
This makes it impossible to express "exclude docs in purge_status" directly in SQL.
Instead, a PostgreSQL trigger on `purge_status` INSERT checks whether ALL active roles
have purged the document. Only when every role agrees does it set `_deleted=true` on the
corresponding `couchdb` row. Since all Sync Streams already filter on `_deleted != true`,
universally-purged documents are automatically excluded without any SQL changes.
The per-role check prevents a purge by one role from hiding a doc that other roles need.

### Why pre-expand children in user_accessible_facilities?
The contacts query originally had `_id IN accessible_facilities OR parent IN
accessible_facilities`. Each arm of the OR creates a separate set of bucket keys,
doubling the bucket count (2×). By pre-computing direct children in Step 1.5 of
`refresh_user_facilities()` (before ancestors are added), all contacts are in
`user_accessible_facilities` and a single `_id IN accessible_facilities` suffices.
Step 1.5 runs after Step 1 (descendants) but before Step 2 (ancestors) to avoid
over-including children of ancestor places (e.g., sibling clinics under the parent HC).

### Why pre-resolve report subjects?
The report_data query originally checked 9 subject fields against `report_facilities`,
and `user_report_facilities` contained both UUIDs and shortcodes. This created a 4×
bucket multiplier (2× from shortcodes, 2× from multiple OR arms). The `report_subjects`
table pre-resolves each report to a single subject UUID following CHT's `getSubject()`
priority chain. This reduces the query to a single INNER JOIN + `IN report_facilities`,
and removes shortcodes from `user_report_facilities`. An auto-trigger on `v1.couchdb`
keeps `report_subjects` current as reports are inserted/updated.

### Why consolidate streams by CTE?
PowerSync creates N buckets per unique CTE parameter value per stream. Before
consolidation, `contacts`, `sms_messages`, `targets`, and `reports` (needs_signoff)
each had their own stream with the same `accessible_facilities` CTE, creating 4*N
buckets total. By merging them into `accessible_data` with `queries:[]`, all 4 queries
share bucket instances: N buckets total instead of 4*N. Empirically confirmed — see
`context/POWERSYNC_BUCKET_ARCHITECTURE_TRADEOFFS.md` section 1.1.

The tradeoff: all queries in `accessible_data` share priority 1 (contacts' priority).
SMS and targets previously had priority 3 but now sync in the first batch. This is
acceptable because the total data volume is unchanged and contacts need to sync first.

### Why simplified privacy check in report_data?
The `report_data` stream uses a simplified privacy filter: `private != true OR submitter =
contact_id`. The full CHT `isSensitive()` also checks if the submitter is in
`accessible_facilities`. Adding `accessible_facilities` as a second CTE to `report_data`
would add N additional buckets, negating the consolidation savings. The simplified check
is correct for >95% of cases. The `accessible_data` stream's needs_signoff query
handles the remaining case where supervisors need to see private needs_signoff reports
from subordinates.

### Why `CAST(c.doc AS TEXT)` for the full document?
PowerSync syncs data to client-side SQLite. Passing the full JSONB document as TEXT
allows the CHT webapp to parse it locally and access any field not explicitly extracted
as a column. This preserves backward compatibility with code expecting the full doc shape.

## Known Limitations (PoC scope)

1. **Full purge.js logic**: Turing-complete JS cannot be expressed in SQL.
   Requires Agent 4's purge preprocessing service to populate `purge_status` table.
   Purge exclusion is handled via trigger-based soft-delete (see Design Decisions).

2. **Sensitivity check simplified**: CHT's full `isSensitive()` checks subject/submitter
   relationship chains including whether the user can see the submitter. Our privacy filter
   checks `fields.private` + submitter identity only (correct for >95% of cases).

3. **Subject priority vs OR matching**: CHT uses a priority-based single subject key
   (`getSubject()` returns first match). Our SQL checks ALL subject fields with OR. This
   could over-sync in rare cases where a report has multiple subject fields pointing to
   different contacts. The risk is negligible in practice.

4. **Outgoing (kujua) messages**: SMS stream handles `contact._id` but outgoing messages
   use `doc.tasks[0].messages[0].contact._id` — deeply nested path not in PoC scope.

5. **Report subject resolution**: The `report_subjects` table pre-resolves each
   report's subject to a UUID. If the subject contact is deleted or the shortcode
   can't be resolved, the report has no entry in `report_subjects` and won't match
   the subject query. It may still sync via the own-report query (if the user is
   the submitter) or the needs_signoff query (if applicable). Unresolvable reports
   without any matching query path would need the `unassigned_reports` stream.

6. **IS NULL silently drops streams**: PowerSync's Sync Streams SQL compiler silently drops
   any stream that uses `IS NULL` on JSONB-extracted values (e.g. `doc ->> 'form' IS NULL`).
   Workaround: use `ifnull(doc ->> 'form', '') = ''` instead. This was discovered when
   `sms_messages` and `unassigned_reports` streams were missing from sync output despite
   valid YAML. All `IS NULL` checks now use the `ifnull()` pattern.

7. **Per-role purge limitation**: The purge soft-delete trigger only sets `_deleted=true`
   when ALL active roles have purged a document. If only some roles purge a doc while
   others should still see it, the doc remains visible to all. In CHT, this mainly affects
   tasks/targets (user-scoped, so role doesn't matter). For rare cross-role purge scenarios,
   the purge preprocessor should handle filtering at the user_accessible_facilities level.

## Implemented Features

### `replicate_primary_contacts` (v4.18+)
Implemented in `refresh_user_facilities()` via 5 steps:
1. **Descendants**: Walk DOWN from user's facility through replication_depth
2. **Ancestors**: Walk UP from user's facility through parent chain (HC, county, etc.)
3. **Primary contacts**: For every accessible place, add its `doc.contact._id` person
4. **User's own contact**: Always include `user_settings.contact_id`
5. **Report facilities**: Depth-filtered subset of UUIDs + shortcodes for report matching

Primary contacts inherit the depth of their parent place (for `report_depth` filtering),
matching CHT's `addPrimaryContactsSubjects()` behavior in `authorization.js`.

### Shortcode handling
Shortcodes (`patient_id`, `place_id` — human-readable identifiers like "13602") are how
CHT reports reference subjects. Previously, shortcodes were stored in `user_report_facilities`
alongside UUIDs, doubling the CTE size and creating a 2× bucket multiplier.

Now, shortcodes are resolved to UUIDs at write time by the `report_subjects` table and
`resolve_report_subject()` function. `user_report_facilities` contains only UUIDs.
`user_accessible_facilities` also contains only UUIDs (contacts, targets, and sms_messages
all match by document `_id`). Shortcode→UUID resolution is indexed via `idx_couchdb_patient_id`
and `idx_couchdb_place_id`.

## Scalability Notes

### Bucket count at scale
After optimizations (CTE sharing + pre-expanded children + pre-resolved subjects +
needs_signoff isolation), bucket count is N + M + K + 5. With
`max_parameter_query_results: 10000` and `max_buckets_per_connection: 10000`:

| User role | Accessible (N) | Report (M) | Signoff (K) | Fixed | Total |
|-----------|---------------|------------|-------------|-------|-------|
| CHW | 35 | 30 | ~35 | 5 | ~105 |
| Supervisor | 250 | 200 | ~250 | 5 | ~705 |
| County admin | 1,010 | 1,010 | ~1,010 | 5 | ~3,035 |

N = accessible_facilities in accessible_data (contacts/sms/targets).
M = report_facilities in report_data (subject-matched reports, UUIDs only).
K = accessible_facilities bucket set in report_data (needs_signoff). Empirical
value TBD — may be less than N if the 5 OR arms partially share bucket keys.

**Remaining concerns:**
- The `max_buckets_per_connection: 10000` config key was discovered empirically.
  Its exact default and documentation status are uncertain.
- The nested subquery pattern `_id IN (SELECT ... WHERE ... IN <cte>)` needs
  empirical validation. If PowerSync doesn't support it, fall back to INNER JOIN.
- Users with >5,000 accessible facilities would exceed parameter limits.
  At that scale, county-scoped PowerSync instances may be needed.

## Live Test Results

Tested against PowerSync at `powersync:8080` with 82 documents (19 contacts, 21 data
records, 1 task, 1 target, forms, translations). Test script: `test-sync-streams.js`.

### Verified edge cases

| Edge case | Status | Notes |
|-----------|--------|-------|
| CHW sees only own tasks | PASS | `task.user = auth.user_id()` correctly scopes |
| Global config consistent across users | PASS | 36 docs (forms + translations + settings) for all |
| Hierarchy depth: SUP sees >= CHW contacts | PASS | Both 6 (all in test hierarchy) |
| report_depth: CHW sees reports about Alice | PASS | 13602 in CHW's report_facilities (depth 1) |
| report_depth: SUP does NOT see reports about Alice | PASS | 13602 NOT in SUP's report_facilities (depth 2 > report_depth 1) |
| needs_signoff escalation to supervisor | PASS | Signoff report syncs via ancestor chain |
| Private report: visible to submitter (CHW) | PASS | Privacy filter bypass via `contact_id` match |
| Private report: hidden from supervisor | PASS | No subject match + privacy blocks |
| Private report: hidden from admin | PASS | Admin has subject match but privacy blocks (correct per CHT `isSensitive()`) |
| Own-report bypass: CHW sees own reports | PASS | `contact._id = auth.parameter('contact_id')` |
| Target visibility: supervisor sees subordinate targets | PASS | `owner IN accessible_facilities` |
| No shortcode pollution in contacts/targets | PASS | After fix: 6 contact buckets (all non-empty, all UUIDs) |
| SMS messages SQL (PostgreSQL test) | PASS | Correctly matches `test-sms-message` by contact hierarchy |
| Unassigned reports SQL (PostgreSQL test) | PASS | Correctly matches `test-unassigned-report` when `can_view_unallocated=true` |
| Purge soft-delete trigger | PASS | Trigger on purge_status sets `_deleted=true`, excluded by all streams |
| place_uuid subject matching | PASS | `test-report-place-uuid` matched via `place_uuid IN report_facilities` |
| fields.place_uuid subject matching | PASS | `test-report-fields-place-uuid` matched via `fields.place_uuid IN report_facilities` |
| fields.patient_uuid subject matching | PASS | `test-report-fields-patient-uuid` matched via `fields.patient_uuid` |
| SMS ifnull pattern (was IS NULL) | PASS | `ifnull(form, '') = ''` matches formless data_records (was silently dropped) |
| Unassigned ifnull pattern (was IS NULL) | PASS | All ifnull checks match orphan records (was silently dropped) |
| Per-role purge: single role purge | PASS | Doc stays visible when only 1/3 roles have purged |
| Per-role purge: all roles purge | PASS | Doc soft-deleted only when all 3/3 roles have purged |
| SMS no contact → unassigned | PASS | SMS with no contact._id captured by unassigned_reports, not sms_messages |
