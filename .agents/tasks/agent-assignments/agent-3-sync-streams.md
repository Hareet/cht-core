# Agent 3: Sync Streams Configuration

## Objective
Design and implement PowerSync Sync Streams YAML configuration that expresses CHT's hierarchical authorization model, including facility-scoped sync, role-based replication depth, and purge exclusions.

## Scope
- **Primary directory**: `.devcontainer/powersync-config/` (new)
- **May read**: `context/`, `couchdb/`, `api/src/services/authorization/`, `ddocs/`
- **Do NOT modify**: Any existing source code

## Phase Dependency
Phase 3 (PowerSync running) for deployment. Design and YAML authoring can start at Phase 0.

## Tasks
1. Study CHT authorization model: `api/src/services/authorization/` and `ddocs/`
2. Read `context/IMPLEMENTATION_GUIDE.md` — Sync Streams YAML examples
3. Read PowerSync skills: `/workspace/cht-core/.agents/skills/powersync/references/sync-config.md`
4. Design Sync Streams for each document type:
   - **contacts**: Hierarchical by `parent_id`, scoped by `facility_id`
   - **reports**: Scoped by `facility_id` with `private` field filtering
   - **tasks/targets**: User-scoped, purge-excluded via `purge_status` table
   - **global config**: `app_settings`, forms, translations — sync to ALL users
5. Implement recursive CTE for `replication_depth` JWT parameter
6. Implement purge exclusion (join against `purge_status` table)
7. Create `powersync.yaml` service config (connection, auth, sync config)
8. Test against PowerSync diagnostics API (Phase 3)

## Key Context
- CHT authorization: users have `facility_id` + `replication_depth` per role
- `docs_by_replication_key` CouchDB view indexes docs by replication key
- Sensitive docs (`private: true`) excluded from subordinate users
- ~10,000 doc limit per user
- Purge.js is Turing-complete JS — cannot express in SQL. Uses `purge_status` table (Agent 4)

## Success Criteria
- `sync-config.yaml` validates against PowerSync schema
- Sync Streams correctly filter by facility hierarchy + replication depth
- Purge exclusions work via `purge_status` join
- Global config documents sync to all users without filtering
- Recursive CTE for replication depth performs at scale (test with explain analyze)
