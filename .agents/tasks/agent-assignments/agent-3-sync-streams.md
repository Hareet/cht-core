# Agent 3: Sync Streams — Purge Validation & Scale Performance

## Iteration 2 — Purge Integration + 100K Scale

### Objective
Validate that Sync Streams correctly exclude purged documents via `purge_status` JOIN and perform at 100K document scale. Also validate the bucket consolidation (Iteration 1) holds under load with the Go edition's 60-bucket target.

**Why this matters**: Agent 4 writes `purge_status`. Agent 3's Sync Streams must consume it efficiently. A bad JOIN at 100K docs means slow initial sync — which Agent 7's device tests will catch as >60 seconds on Go edition.

## Scope
- **Primary directory**: `.devcontainer/powersync-config/`
- **May read**: `context/`, `couchdb/`, `api/src/services/authorization/`, `api/src/services/purge-preproc/` (Agent 4's work)
- **Do NOT modify**: Any source code outside `.devcontainer/powersync-config/`

## Phase Dependency
Phase 3 (PowerSync running). YAML authoring and SQL testing can start at Phase 2.

## Iteration 1 Completed Work
- Sync Streams YAML with 7 streams: `all_data`, `report_data`, `unassigned_reports`, `tasks`, `global_config`, `user_settings_doc`, `user_meta`
- Bucket consolidation: 16K → 59 buckets per CHW user (merged to `playtime`)
- `user_accessible_facilities` table for hierarchy resolution
- JWT parameters: `sub`, `contact_id`, `role_hash`, `report_depth`, `can_view_unallocated`

**First action**: Read current `sync-config.yaml` and `setup.sql` to see Iteration 1 state.

## Tasks

### NEW: Prioritized Sync (Critical for Go Edition)
0. **Add `priority` levels to all Sync Streams**: This is the documented PowerSync mechanism for controlling sync order (available since JS Web SDK v1.14.2). This replaces the undocumented `fetchStrategy: 'sequential'` approach from the hardware analysis.
   ```yaml
   streams:
     global_config:
       priority: 0     # Sync FIRST — app_settings, forms, translations needed for UI render
     user_settings_doc:
       priority: 0     # Sync with global config
     all_data:
       priority: 1     # Sync SECOND — contacts + reports for CHW navigation
     tasks:
       priority: 2     # Sync THIRD — task list loads after contacts visible
     user_meta:
       priority: 3     # Sync LAST — telemetry/feedback lowest priority
   ```
   **Why**: On Go edition (3-8s WASM compile + sync), user sees contacts after priority 1 completes (~2-4s post-compile), not after full sync. Agent 5 uses `waitForFirstSync({ priority: 1 })` on the client.

### Purge Integration
1. **Add purge exclusion to Sync Streams**: Modify `sync-config.yaml`
   - Each data stream that syncs to users must exclude purged docs:
   ```yaml
   # In each relevant stream's SELECT:
   WHERE NOT EXISTS (
     SELECT 1 FROM purge_status ps
     WHERE ps.doc_id = {table}.id
     AND ps.role = token_parameters.role_hash
     AND ps.purged = true
   )
   ```
   - Apply to: `all_data`, `report_data`, `unassigned_reports`, `tasks` streams
   - Do NOT apply to: `global_config`, `user_settings_doc` (never purged)
   - Handle both standard and aggressive purge (`purge_status.aggressive` column from Agent 4)
   
   **WARNING from MCP validation**: PowerSync Sync Streams only support `JOIN` / `INNER JOIN` with simple equality conditions (see PowerSync docs: Supported SQL — JOIN syntax). `NOT EXISTS` subqueries may not be supported. **Test this against the PowerSync Service before committing.** Alternative if NOT EXISTS fails: add a `purged` boolean column to source tables, maintained by trigger, and filter directly: `WHERE purged = false`

2. **Update `setup.sql`**: Ensure `purge_status` table definition matches Agent 4's schema (including `aggressive`, `requested_by`, `reason` columns). Add indexes that support the Sync Stream JOINs.

### Scale Performance Validation
3. **EXPLAIN ANALYZE at 100K docs**: Connect to PostgreSQL and run:
   - Each Sync Stream query with `purge_status` JOIN at 100K document scale
   - The recursive CTE for `replication_depth` with purge JOIN
   - `user_accessible_facilities` lookup with purge JOIN
   - Target: each query <100ms for a single user's sync
   - Document results in `.devcontainer/powersync-config/README.md`

4. **Validate bucket count stability**: After adding purge exclusion:
   - Confirm bucket count remains ~60 per CHW (not inflated by purge logic)
   - Verify `max_buckets_per_connection: 20000` is still sufficient
   - Test with a user who has aggressive purge active vs standard purge

5. **Test initial sync size**: For a typical CHW user (50 contacts, 200 reports, 30 tasks):
   - Measure total data transfer on initial sync
   - Estimate SQLite DB size after initial sync
   - Verify it fits within Go edition budget (200MB target)

### Edge Cases
6. **Purge race condition**: What happens when a document is purged server-side while the client has it cached? PowerSync should remove it on next sync — verify this behavior.
7. **Aggressive purge reversal**: If storage pressure clears and aggressive purge is reversed (doc un-purged), does the doc re-sync to the client? Verify.

### Testing
8. Deploy updated `sync-config.yaml` to PowerSync Service (Phase 3)
9. Validate via PowerSync diagnostics API: `GET :8080/api/admin/v1/diagnostics`
10. Generate test tokens with purge-active and purge-inactive users, compare sync results

## Key Context
- PowerSync reads PostgreSQL WAL — `purge_status` changes are picked up automatically
- Sync Streams support subqueries in WHERE clauses (NOT EXISTS works)
- Current bucket limit settings: `max_parameter_query_results: 20000`, `max_buckets_per_connection: 20000`
- The 60-bucket target was achieved via person-bucket elimination (place-level matching)
- Go edition budget: 200MB SQLite DB. A typical CHW with 5,000 docs ≈ 50-100MB uncompressed JSON, ~30-60MB in normalized SQL

## Success Criteria
- Purge exclusion in all data Sync Streams, not in global/user_settings
- EXPLAIN ANALYZE: all queries <100ms at 100K doc scale with purge JOIN
- Bucket count stable at ~60 per CHW (not inflated by purge)
- Initial sync data size fits within Go edition 200MB budget
- Purge removal propagates to client on next sync cycle (verified)
- Aggressive purge reversal re-syncs documents (verified)
- `sync-config.yaml` validates against PowerSync schema
