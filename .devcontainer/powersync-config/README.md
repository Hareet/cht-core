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
| `sync-config.yaml` | Sync Streams definitions (edition 3) — 9 streams |
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
  └─ PowerSync Sync Streams (9 streams)
        ├─ contacts:          hierarchy-filtered by accessible_facilities
        ├─ reports:           hierarchy + report_depth + own-report bypass + privacy + needs_signoff
        ├─ sms_messages:      data_records without form, filtered by contact hierarchy
        ├─ unassigned_reports: reports without subject (requires can_view_unallocated JWT claim)
        ├─ tasks:             user-scoped via auth.user_id() (CouchDB user ID)
        ├─ targets:           hierarchy-scoped (owner IN accessible_facilities)
        ├─ global_config:     no filter (_all replication key docs + _design/medic-client)
        ├─ user_settings_doc: user's own org.couchdb.user:* document
        └─ user_meta:         user-scoped feedback/telemetry
```

## Sync Streams Detail

### contacts (priority 1, auto_subscribe)
Contacts filtered by `user_accessible_facilities` pre-computed table.
Supports all CHT contact types: `contact`, `person`, `clinic`, `health_center`, `district_hospital`.
Uses `COALESCE(contact_type, type)` for field compatibility.

### reports (priority 2, auto_subscribe)
Most complex stream. Implements:
- **Subject resolution** following CHT's `getSubject()` fallback chain:
  `patient_id → fields.patient_id → place_id → fields.place_id → patient_uuid → fields.patient_uuid → contact._id`
- **Shortcode matching**: `report_facilities` table contains both UUIDs and shortcodes (patient_id, place_id)
  so subject matching works for both identifier types
- **Own-report bypass**: Submitter always sees their own reports regardless of `report_depth`
  (CHT `authorization.js` line 600)
- **report_depth** filtering via local CTE `report_facilities` (limits OTHER users' reports by depth)
- **needs_signoff** support: walks up submitter's ancestor chain (5 levels) to replicate to supervisors
- **Privacy** filter: `fields.private=true` reports only visible to submitter

### sms_messages (priority 3, auto_subscribe)
Data records WITHOUT a `form` field — SMS/messages. Their replication key in CHT is
`doc.contact._id` (the sender). Filtered by `contact._id IN accessible_facilities`.

### unassigned_reports (priority 3, auto_subscribe)
Reports without any subject (patient_id, place_id, patient_uuid, contact all null).
These map to the `_unassigned` replication key in CHT. Only synced when the user's JWT
includes `can_view_unallocated = 'true'` (requires both app_settings config flag and
`can_view_unallocated_data_records` permission).

### tasks (priority 3, auto_subscribe)
`task.user` = CouchDB user ID (`org.couchdb.user:<username>`), NOT contact UUID.
Uses `auth.user_id()` which maps to the JWT `sub` claim.

### targets (priority 3, auto_subscribe)
`target.owner` = contact UUID of who the target belongs to.
Syncs to ANY user who can see the owner contact (`owner IN accessible_facilities`).
Supervisors see subordinate targets.

### global_config (priority 1, auto_subscribe)
Two queries (multi-query stream):
1. By type: `form`, `translations`
2. By `_id`: `resources`, `branding`, `partners`, `service-worker-meta`, `zscore-charts`, `settings`, `privacy-policies`, `_design/medic-client`

Matches the `_all` replication key in CHT's `docs_by_replication_key` index plus
the `_design/medic-client` design doc (always allowed per `authorization.js`).

### user_settings_doc (priority 1, auto_subscribe)
User's own `org.couchdb.user:<username>` document (roles, facility, etc.).

### user_meta (priority 3, auto_subscribe)
Feedback, telemetry, read-status docs filtered by user.

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

5. **Report bucket explosion**: The reports stream has multiple OR branches for subject
   matching (patient_id, fields.patient_id, place_id, etc.) plus needs_signoff ancestor
   chain checks. Each OR branch with `IN report_facilities` creates N buckets (one per
   facility). With 9 subject OR branches and N facilities, this creates up to 9*N buckets
   per user. PowerSync's default limit is 1,000 buckets per user, which could be reached
   with ~110 facilities. Mitigation: pre-compute a `report_subjects` table mapping
   (doc_id, subject_id) so the reports stream only needs a single `subject_id IN
   report_facilities` check, collapsing 9 OR branches to 1. See "Scalability Notes" below.

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

### Shortcode separation (UUIDs vs shortcodes)
Shortcodes (`patient_id`, `place_id` human-readable identifiers like "13602") are critical
for report subject matching because CHT reports reference subjects by shortcode. However,
shortcodes must ONLY live in `user_report_facilities`, NOT in `user_accessible_facilities`.

`user_accessible_facilities` is used by the contacts, targets, and sms_messages Sync Streams,
all of which match by document `_id` (always a UUID). If shortcodes were in this table, each
shortcode would create an empty PowerSync bucket per stream, wasting bandwidth and counting
against the 1,000 bucket limit per user.

`user_report_facilities` contains BOTH UUIDs and shortcodes, allowing the reports stream to
match subjects by either identifier type with a single `IN` clause.

## Scalability Notes

### Bucket count at scale
PowerSync creates one bucket per unique `(stream, parameter_value)` combination. The
default limit is 1,000 buckets per user. At eCHIS scale:

| User role | ~Facilities | Contacts buckets | Reports buckets (est.) | Total (est.) |
|-----------|-------------|-----------------|----------------------|-------------|
| CHW | 10-30 | 10-30 | ~270 (9 OR branches) | ~310 |
| Supervisor | 50-200 | 50-200 | ~1,400+ | **risk** |
| County admin | 1,000+ | 1,000+ | **over limit** | **over limit** |

The reports stream is the primary concern due to its 9 subject-matching OR branches
(patient_id, fields.patient_id, place_id, fields.place_id, patient_uuid,
fields.patient_uuid, place_uuid, fields.place_uuid, contact._id).
Each branch creates one bucket per `report_facilities` entry. Mitigation strategies:

1. **Pre-computed report_subjects table** (recommended): Map each report to its resolved
   subject_id in PostgreSQL, then the Sync Stream only needs `subject_id IN report_facilities`
   (1 OR branch instead of 9). Reduces report buckets by ~9x.

2. **Increase PowerSync bucket limit**: Configurable per-instance, but higher limits
   increase memory and bandwidth usage.

3. **Scope supervisor/admin access**: In practice, county admins may not need offline
   access to ALL reports — they could use online-only dashboards for aggregate data.

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
