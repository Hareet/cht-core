# PowerSync Sync Streams Configuration for CHT

This directory contains the PowerSync service configuration and Sync Streams
definitions that implement CHT's hierarchical authorization model.

## Files

| File | Purpose |
|------|---------|
| `powersync.yaml` | PowerSync service config (DB connection, auth, storage) |
| `sync-config.yaml` | Sync Streams definitions (edition 3) |
| `setup.sql` | PostgreSQL supporting tables and seed data |
| `generate-test-token.js` | JWT token generator for dev testing |
| `.gitignore` | Excludes private keys from version control |

## Architecture

```
CHT Documents (v1.couchdb JSONB)
  │
  ├─ user_accessible_facilities  ← pre-computed hierarchy (recursive CTE)
  │     (user_id, facility_id)      refreshed on hierarchy/role changes
  │
  ├─ purge_status                ← tracks docs to exclude per role
  │     (doc_id, role_hash)         populated by purge preprocessor
  │
  └─ PowerSync Sync Streams      ← filters docs per user via subqueries
        ├─ contacts:   hierarchy-filtered (facility + depth)
        ├─ reports:    hierarchy-filtered + privacy exclusion
        ├─ tasks:      user-scoped (contact_id)
        ├─ targets:    user-scoped (contact_id)
        ├─ global_config: no filter (forms, translations, meta)
        └─ user_meta:  user-scoped (feedback, telemetry)
```

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
# Copy the dev private key (generated during setup)
node generate-test-token.js chw_user
node generate-test-token.js supervisor_user
node generate-test-token.js county_admin
```

## JWT Claims

The Sync Streams expect these JWT claims:

| Claim | Source | Used By |
|-------|--------|---------|
| `sub` | `user_settings.user_id` | Facility access lookup |
| `role_hash` | `user_settings.role_hash` | Purge status filtering |
| `contact_id` | `user_settings.contact_id` | Task/target ownership |
| `aud` | Static: `cht-powersync-dev` | Token validation |

## Design Decisions

### Why pre-computed `user_accessible_facilities` instead of recursive CTE in Sync Streams?
PowerSync Sync Streams use their own SQL dialect that does NOT support recursive CTEs.
The hierarchy traversal runs in PostgreSQL via `refresh_user_facilities()` and the
result is stored in a regular table that PowerSync can query via subquery.

### Why no `NOT IN (subquery)` for purge exclusion?
PowerSync Sync Streams explicitly do not support `NOT IN` with subqueries. For the PoC,
purge is handled via:
1. Time-based conditions (tasks > 60 days, targets > 6 months)
2. The `purge_status` table is available for `INNER JOIN` patterns once the purge
   preprocessing service (Agent 4) populates it.

### Why `CAST(c.doc AS TEXT)` for the full document?
PowerSync syncs data to client-side SQLite. Passing the full JSONB document as TEXT
allows the CHT webapp to parse it locally and access any field not explicitly extracted
as a column. This preserves backward compatibility with code expecting the full doc shape.
