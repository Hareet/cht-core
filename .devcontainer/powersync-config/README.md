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
| `sync-config.yaml` | Sync Streams definitions (edition 3) — 7 streams |
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
  └─ PowerSync Sync Streams (7 streams)
        ├─ contacts:          hierarchy-filtered by accessible_facilities
        ├─ reports:           hierarchy + report_depth + privacy + needs_signoff
        ├─ tasks:             user-scoped via auth.user_id() (CouchDB user ID)
        ├─ targets:           hierarchy-scoped (owner IN accessible_facilities)
        ├─ global_config:     no filter (_all replication key docs)
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
  `patient_id → fields.patient_id → place_id → fields.place_id → fields.patient_uuid → contact._id`
- **report_depth** filtering via local CTE `report_depth_facilities` (limits OTHER users' reports by depth)
- **needs_signoff** support: walks up submitter's ancestor chain (5 levels) to replicate to supervisors
- **Privacy** filter: `fields.private=true` reports only visible to submitter

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
2. By `_id`: `resources`, `branding`, `partners`, `service-worker-meta`, `zscore-charts`, `settings`, `privacy-policies`

Matches the `_all` replication key in CHT's `docs_by_replication_key` index.

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
| `contact_id` | `user_settings.contact_id` | `auth.parameter('contact_id')` | Privacy filter |
| `report_depth` | `user_settings.report_depth` | `auth.parameter('report_depth')` | Report depth CTE |
| `role_hash` | `user_settings.role_hash` | Future: purge filtering | MD5 of sorted roles |
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

### Why `NOT IN (subquery)` not used for purge?
PowerSync Sync Streams explicitly do not support `NOT IN` with subqueries. For the PoC,
purge is handled via time-based conditions. The `purge_status` table is available for
`INNER JOIN` patterns once the purge preprocessing service populates it.

### Why `CAST(c.doc AS TEXT)` for the full document?
PowerSync syncs data to client-side SQLite. Passing the full JSONB document as TEXT
allows the CHT webapp to parse it locally and access any field not explicitly extracted
as a column. This preserves backward compatibility with code expecting the full doc shape.

## Known Limitations (PoC scope)

1. **`replicate_primary_contacts`** (v4.18+): Not yet implemented in Sync Streams.
   Requires pre-computing primary contacts of places at max depth and adding them to
   `user_accessible_facilities`. Deferred to Phase 2.

2. **Full purge.js logic**: Turing-complete JS cannot be expressed in SQL.
   Requires Agent 4's purge preprocessing service to populate `purge_status` table.

3. **Sensitivity check simplified**: CHT's full `isSensitive()` checks subject/submitter
   relationship chains. Our privacy filter checks `fields.private` + submitter identity only.

4. **Messages (SMS)**: `data_record` docs without `form` field (SMS messages) have different
   subject resolution. Not critical for PoC as SMS is being phased out.

5. **`_design/medic-client`**: Client design document not included (not applicable to
   PowerSync architecture — client code bundles handle this).
