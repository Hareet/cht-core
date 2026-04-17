# Agent Handoff Notes from Config-Loader

These notes document findings from loading the MoH-CIV config that affect other agents.

## For Agent 3 (Sync Streams)

### Critical: refresh_user_facilities() must support configurable hierarchy

The deployed `v1.refresh_user_facilities()` function only matched legacy types (`clinic`, `health_center`, `district_hospital`) in its descendant walk. The MoH-CIV config uses the configurable hierarchy with `type='contact'` + `contact_type='c80_family'`, `c90_household`, etc.

**Fix applied**: Updated Step 1 to include `c.doc ->> 'type' = 'contact'` with exclusion of person contact_types. Person contacts are:
- c12_central, c22_region, c32_district, c42_supervision_area, c52_health_area, c62_locality, c72_chw_site, c82_family, c92_household

Place contact_types are:
- c10_central, c20_region, c30_district, c40_supervision_area, c50_health_area, c60_locality, c70_chw_site, c80_family, c90_household

### Critical: resolve_subject_place() person detection

The `resolve_subject_place()` function determines if a subject is a person (returns parent place) or a place (returns self). It currently checks:
```sql
WHEN c.doc ->> 'type' = 'contact' AND COALESCE(c.doc ->> 'contact_type', 'person') = 'person' THEN parent
```

For CIV, person contacts have `contact_type` values like `c92_household`, NOT `person`. The function needs to know which contact_types are persons. Options:
1. Check the `contact_types` config for `person: true` 
2. Maintain a list of person contact_type IDs
3. Use a heuristic: if the contact_type is in the list of place_hierarchy_types from app_settings, it's a place; otherwise it's a person

### Bucket count estimate

With the CIV hierarchy at full depth per CHW:
- ~35 families (c80_family)
- ~70 households (c90_household)  
- ~7 ancestors (c60→c10)
- ~100+ primary contacts
- = ~220 buckets from accessible_facilities CTE
- + 3 fixed buckets (own reports, user_settings, tasks)
- **Total: ~223 buckets per CHW**

This is higher than the ~60 target. The deep hierarchy (10 levels) creates more place entries than a standard 4-level CHT hierarchy.

### contact_parent_place population

The `auto_update_contact_parent_place` trigger checks `COALESCE(contact_type, 'person') = 'person'` which won't match CIV's `c92_household` type. The trigger was fixed, and the table was batch-populated for all CIV person types (335,922 rows).

## For Agent 4 (Purge)

**No purge.js exists** in the MoH-CIV config. The purge preprocessor will have no rules to evaluate. All documents will have `purge_status.purged = false` (bulk-initialized with 941,606 rows).

## For Agent 5 (PowerSync SDK)

### Role hashes for CIV users
- `chw_min_5km` → role_hash: `33cef624b67bfa992677c539081c7df0`
- `chw_max_5km` → role_hash: (same md5 of 'chw_max_5km')
- `supervisor` → role_hash: `09348c20a019be0318387c08df7a783d`
- `dedicated_supervisor` → (online role, no PowerSync)

### Test user credentials
- CHW: `chw_test_1` through `chw_test_10`, password: `Secret1!pass`
- Supervisor: `supervisor_1` through `supervisor_3`, password: `Secret1!pass`
- All users at: `http://api:5988`

## For Agent 7 (Integration Tests)

### Dataset scale
- 10 CHW users × ~20K docs each = ~200K CIV-specific docs
- Each CHW has ~545 contacts + ~19,500 reports under their site
- Total CouchDB: ~811K docs (including ~600K legacy + ~211K CIV)
- Total PostgreSQL: matches CouchDB (couch2pg verified)

### Important: Legacy vs CIV data
The database contains ~600K documents from a previous config with old-style hierarchy (`type: 'person'`, `type: 'clinic'`, etc.). These are inert for the CIV workflow but present in PostgreSQL. Integration tests should filter for CIV-specific data using `doc ->> 'type' = 'contact'` AND `doc ->> 'contact_type' LIKE 'c%'`.

## For Agent 1 (cht-datasource) — PowerSync→Postgres Wiring (added 2026-04-17)

### What is proven working (playtime HEAD)
End-to-end PowerSync write path is validated browser-side:

```
Browser (WASM SQLite, AccessHandlePoolVFS)
  → INSERT INTO reports
  → PowerSync upload queue
  → POST /api/v1/powersync/upload  (batched CrudEntry[])
  → transformCrudEntry (maps contact_id → contact UUID)
  → ctx.bind(Report.v1.create)
  → getLocalDataContext  ←  HARDCODED in api/src/services/data-context.js
  → CouchDB
```

Verified: docs appear in CouchDB with cht-datasource's full contact-lineage expansion (8 levels deep for CIV). Test user `chw_test_1` (role `chw_min_5km`, contact `4ebb22c9-0f8c-4775-87da-30454446745d`), form `anc_followup`. Local persist ~14ms avg on standard tier; upload batches of 100 honored per `MAX_BATCH_SIZE`.

### The gap: no path to PostgreSQL
`api/src/services/data-context.js` is two lines and offers no way to select the Postgres adapter:

```js
const { getLocalDataContext } = require('@medic/cht-datasource');
module.exports = getLocalDataContext(config, db);
```

Meanwhile Postgres adapters exist and are hydrated (`shared-libs/cht-datasource/src/postgres/{report,person,place,contact,target}.ts` — created by Agent 1 in iteration 1). They just are not reachable from the API.

### What Agent 1 should do next
1. **Wire data-context selection** — introduce `CHT_DB_BACKEND` env var (`couchdb` default, `postgres` opt-in). When `postgres`, call `getPostgresDataContext(pgPool, settingsService, schemaConfig)` from `src/postgres/libs/data-context.ts`. Backward compat: default unchanged.
2. **Preserve client UUIDs** (important for PowerSync semantics) — today `Report.v1.create` mints a new `_id`; the client UUID only survives in `fields.iteration`. PowerSync best practice requires client-side UUIDs to become the server `_id` for conflict-free offline writes. Options:
   - Add `_id?: string` to `ReportInput` (relax the `_id?: never` ban for server-trusted callers) and have `powersync-upload.js` pass `_id: crudEntry.id`
   - Or bypass cht-datasource for the create path in the upload controller and do a direct `db.put` with the client UUID (less clean)
   - Or add a `create({ idHint })` variant
3. **Benchmark integration** — once wiring lands, `tests/benchmark/benchmark-write-path.js` needs a third section that exercises `CHT_DB_BACKEND=postgres` and confirms docs land in `v1.couchdb` via the couch2pg schema view (or wherever the Postgres adapter writes). Suggestion: add env gate `BENCHMARK_TARGET=postgres` and swap the Test B detection to poll Postgres instead of CouchDB.

### Bringing our uncommitted work into agent-1 worktree
Our session left these changes on playtime (uncommitted at handoff time):

| File | What changed |
|---|---|
| `webapp/src/ts/services/powersync/powersync-connector.ts` | Rewrote `uploadData` to batched POST /api/v1/powersync/upload; fixed `fetchCredentials` URL |
| `api/src/controllers/powersync-upload.js` | `transformCrudEntry` now maps `contact_id` → `contact` for reports |
| `tests/benchmark/benchmark-write-path.js` | Real `contact` UUID + `anc_followup` form; Test B detection via `_find` + marker substring |
| `webapp/src/ts/services/powersync/powersync.service.ts` | PRAGMA-after-connect() ordering (Opus 4.6 session) |
| `webapp/angular.json` | Duplicate WASM asset copy for webpack publicPath (Opus 4.6 session) |
| `.devcontainer/powersync-config/nginx-powersync.conf` | Regex location for /powersync/*.{js,wasm,map} (Opus 4.6 session) |

The parent (me) will commit these on `playtime` before handing over. Agent 1 from its worktree:

```bash
cd .agents/worktrees/agent-1
git fetch .              # local-only; no remotes allowed
git merge playtime       # expect clean merge — agent-1 hasn't touched these files
# If conflicts: most likely in api/src/controllers/powersync-upload.js.
# The transformCrudEntry contact_id→contact mapping from playtime should win.
```

### Key references
- cht-datasource ReportInput schema: `shared-libs/cht-datasource/src/input.ts` — `_id?: never` currently
- Postgres context constructor: `shared-libs/cht-datasource/src/postgres/libs/data-context.ts:PostgresDataContext`
- Postgres report adapter: `shared-libs/cht-datasource/src/postgres/report.ts`
- PG schema the adapter reads/writes: `v1.couchdb` (JSONB `doc` column, per cht-sync dbt layout)
- PowerSync docs best-practice on UUIDs: https://docs.powersync.com/intro/setup-guide.md ("Best practice: Use UUIDs when inserting new rows on the client side")

### Open architectural question
The Postgres adapter currently reads from `v1.couchdb` (JSONB snapshot of CouchDB, populated by couch2pg). For real PowerSync→Postgres writes, the adapter needs either:
- To write to `v1.couchdb` as a forward-sync pattern (PowerSync writes here; couch2pg still populates historical data; CouchDB becomes the read replica during migration), or
- To write to a new native schema that PowerSync Sync Streams can read directly without the couch2pg bridge.

Flag this for the Medic team in the next review. The decision affects whether Phase 2 of the migration roadmap ("Real-time transactional writes to PostgreSQL") happens in-place (writes to `v1.couchdb`) or via schema split. Either works technically; they have different operational profiles.
