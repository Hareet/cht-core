# Agent-3 Task: Consolidate Sync Streams to Reduce Bucket Count

## Context

Empirical testing on 2026-04-11 resolved the bucket architecture question. Results committed to `playtime` branch in `context/POWERSYNC_BUCKET_ARCHITECTURE_TRADEOFFS.md` section 1.1 and test code at `tests/scalability/powersync-benchmark/bucket-semantics-test.js`.

### Key Findings

All query patterns (INNER JOIN, inline subquery `IN (SELECT ...)`, named CTE `IN <cte>`) create **N buckets per facility**. There is no way to collapse to 1 bucket using intermediary table lookups. The ONLY 1-bucket pattern is `WHERE col = auth.user_id()` (direct equality).

**However: multiple `queries:[]` within one stream sharing the same CTE DO share buckets.** Two queries using the same CTE with 15 facilities = 15 buckets (not 30). This was confirmed empirically.

### Current Problem

The current powersync.yaml inlines 9 streams, each with its own INNER JOIN against `user_accessible_facilities` or `user_report_facilities`. Each stream independently creates N buckets:

| Stream | Filter | Buckets |
|--------|--------|---------|
| contacts | JOIN accessible_facilities | N |
| reports (3 queries) | JOIN report_facilities + accessible_facilities | M + N |
| sms_messages | JOIN accessible_facilities | N |
| targets | JOIN accessible_facilities | N |
| tasks | `WHERE user = auth.user_id()` | 1 |
| global_config | no user filter | 1 |
| user_settings_doc | `WHERE _id = auth.user_id()` | 1 |
| user_meta | `WHERE user = auth.user_id()` | 1 |
| **Total** | | **4N + M + 4** |

For a user with 1,010 facilities: ~5,050 buckets. Exceeds limits, unusable sync performance.

## Task: Implement Stream Consolidation

Restructure the sync config so that streams sharing the same CTE are merged into one stream with `queries:[]`. This makes them share bucket instances.

### Target Architecture

**Stream 1: `accessible_data`** — All queries filtered by `accessible_facilities` CTE
- CTE: `accessible_facilities` → `SELECT facility_id FROM v1.user_accessible_facilities WHERE user_id = auth.user_id()`
- Query 1: contacts (alias `contacts`) — existing contacts query logic
- Query 2: sms_messages (alias `sms_messages`) — existing sms query logic
- Query 3: targets (alias `targets`) — existing targets query logic
- Query 4: needs_signoff reports (alias `reports`) — the subset of reports that uses `accessible_facilities` for ancestor chain matching
- **Buckets: N** (shared via CTE)

**Stream 2: `report_data`** — Reports filtered by `report_facilities` CTE + user's own reports
- CTE: `report_facilities` → `SELECT facility_id FROM v1.user_report_facilities WHERE user_id = auth.user_id()`
- Query 1: reports by subject (alias `reports`) — patient_id/place_id/contact IN report_facilities
- Query 2: user's own reports (alias `reports`) — `contact._id = auth.parameter('contact_id')`
- **Buckets: M + 1**

**Stream 3: `tasks`** — unchanged, already 1 bucket
**Stream 4: `global_config`** — unchanged, already 1 bucket (global)
**Stream 5: `user_settings_doc`** — unchanged, already 1 bucket
**Stream 6: `user_meta`** — unchanged, already 1 bucket

**New total: N + M + 1 + 4 = N + M + 5**

For 1,010 facilities: ~2,500 buckets (down from ~5,050). Fits within `max_parameter_query_results: 5000`.

### Critical Constraints

1. **Table alias = client table name.** In Sync Streams edition 3, the SQL table alias in `FROM "v1"."couchdb" <alias>` determines the `row_type` sent to clients. Each query MUST use the alias matching the intended client table (e.g., `contacts`, `reports`, `sms_messages`). Different queries in one stream CAN have different aliases — this is how one stream feeds multiple client tables.

2. **CTE sharing only works within a stream.** Two streams with identical CTEs do NOT share buckets. Only `queries:[]` within the same stream share.

3. **Different CTEs in one stream create separate bucket sets.** If `accessible_data` stream had both `accessible_facilities` and `report_facilities` CTEs, the bucket count would be N + M (additive, not shared). Group queries by CTE.

4. **`max_parameter_query_results: 5000`** is configured at `api.parameters.max_parameter_query_results` in powersync.yaml. CTEs are expanded to parameterized `IN ($1, $2, ..., $N)` lists and are subject to this limit. Users with >5,000 facilities will still fail — that's a separate problem for later.

5. **Separate "Too many buckets" limit exists** (default 1,000, shown as `PSYNC_S2305: Too many buckets: N (limit of 1000)`). This is distinct from `max_parameter_query_results`. We haven't found its config key yet. After consolidation, county admin users with ~2,500 total buckets may hit this. Finding and raising this limit is a secondary task.

6. **Switch from JOINs to CTEs.** The current inlined config uses `INNER JOIN`. To enable CTE sharing, rewrite queries to use `WITH ... IN <cte>` pattern instead. CTEs and JOINs create identical bucket counts (confirmed empirically), but only CTEs enable sharing across queries.

### Files to Modify

- `.devcontainer/powersync-config/powersync.yaml` — the inlined sync config (this is what the Docker container mounts)
- `.devcontainer/powersync-config/sync-config.yaml` — the separate reference config (keep in sync)
- `.devcontainer/powersync-config/README.md` — update architecture docs to reflect consolidation

### Verification

After implementing, verify with the bucket test harness:

1. Ensure bucket-test-setup.sql has been run (test user with 15 facilities)
2. Run: `POWERSYNC_URL=http://localhost:8080 node tests/scalability/powersync-benchmark/bucket-semantics-test.js`
   - This tests against whatever sync config is deployed. You may need to adapt it for the consolidated stream names.
3. Connect as one of the ac1-ac4 users (1,010 facilities) and check docker logs for bucket count:
   ```bash
   docker logs --tail 50 cht-powersync 2>&1 | grep -E "checkpoint|bucket|param_results|PSYNC_S2305"
   ```
4. Target: total buckets for ac1 should be ~2,500 (down from ~9,000)

### Reference

- Empirical test results: `context/POWERSYNC_BUCKET_ARCHITECTURE_TRADEOFFS.md` section 1.1
- Test code: `tests/scalability/powersync-benchmark/bucket-semantics-test.js`
- Test config (5 experiments): `tests/scalability/powersync-benchmark/bucket-test-config.yaml`
- Current production streams: `powersync.yaml` lines 33-248 (inlined sync_config)
- PowerSync docs on CTE sharing: "Queries using the same CTE within a stream may share buckets; the compiler can merge them into a single set."
- Config key for parameter limit: `api.parameters.max_parameter_query_results: 5000`
