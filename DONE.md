# Agent 1 — cht-datasource PowerSync→Postgres Wiring (iteration 2, 2026-04-17)

## Summary

Wired the Postgres adapter into the API service layer and extended
`Report/Person/Place.v1.create` so PowerSync-supplied client UUIDs become the
server `_id`. Defaults are unchanged — CouchDB is still the backend until the
operator sets `CHT_DB_BACKEND=postgres`.

## Changes

### 1. Adapter selection — `api/src/services/data-context.js`

Replaced the two-line hardcoded `getLocalDataContext(...)` with a selector:

- `CHT_DB_BACKEND=couchdb` (default, unchanged) → `getLocalDataContext(config, db)`
- `CHT_DB_BACKEND=postgres` → `getPostgresDataContext(pgPool, config, schemaConfig)`
  - Pool: `new Pool({ connectionString })` from `POSTGRES_URL` (or individual
    `POSTGRES_{HOST,PORT,DB,USER,PASSWORD}` envs — matches the pattern already
    used in `tests/utils/agent-harness.js` and `tests/integration/postgresql/`).
  - `schemaConfig`: `{ schema: CHT_PG_SCHEMA ?? 'v1', table: CHT_PG_TABLE ?? 'couchdb' }`.
  - `pg` is lazy-required so CouchDB-only deployments don't need it loaded.
- Logs which backend was selected at startup.

No public module shape change — still exports a `DataContext` with `.bind`.

### 2. Client-UUID preservation — optional `idHint` parameter

Chosen from the handoff's three options: **extended the curried create fn with
an optional second arg (`idHint`)** — option 3 refined. Kept `ReportInput._id?: never`
intact, so:

- No validator test churn.
- No breaking type change for existing API callers.
- Server-trusted callers (the PowerSync upload controller) opt in explicitly.

Edited:
- `shared-libs/cht-datasource/src/local/libs/doc.ts` — `createDoc(db)` now
  takes `(data, idHint?)`. When `idHint` is set it uses `db.put` with
  `_id: idHint`; otherwise it falls back to `db.post` (old behaviour).
- `shared-libs/cht-datasource/src/postgres/libs/doc.ts` — `createDoc(ctx)` now
  uses `idHint ?? crypto.randomUUID()` as `_id`.
- `shared-libs/cht-datasource/src/local/{report,person,place}.ts` — the async
  function returned by `v1.create` accepts `(input, idHint?)` and passes
  `idHint` through to `createMedicDoc` only when truthy (keeps existing sinon
  `calledOnceWithExactly(input)` assertions green).
- `shared-libs/cht-datasource/src/postgres/{report,person,place}.ts` — same
  pattern.
- `shared-libs/cht-datasource/src/{report,person,place}.ts` — the public
  `v1.create(ctx)` now returns `(input, idHint?) => Promise<...>` and threads
  `idHint` into `fn(input, idHint)`. JSDoc updated.

### 3. PowerSync upload controller — `api/src/controllers/powersync-upload.js`

On `PUT` for a new row, calls `tableConfig.create(doc, id)` where `id` is
`CrudEntry.id` (the client-minted UUID). Idempotent retries now hit the
existing row instead of creating a second copy with a different `_id`.

### 4. Tests

Added:
- `shared-libs/cht-datasource/test/local/libs/doc.spec.ts` — two new `createDoc`
  tests (happy-path `idHint`, `db.put` failure).
- `shared-libs/cht-datasource/test/postgres/libs/doc.spec.ts` — one new
  `createDoc` test asserting the `idHint` is used as `_id`.
- `shared-libs/cht-datasource/test/report.spec.ts` — new test that the public
  `Report.v1.create` threads `idHint` through to the adapter.
- `api/tests/mocha/controllers/powersync-upload.spec.js` — new test that the
  controller passes `CrudEntry.id` as the second positional arg.

Updated assertions in `test/{report,person,place}.spec.ts` from
`calledOnceWithExactly(input)` → `calledOnceWithExactly(input, undefined)`
because the public wrapper always forwards the optional arg.

## Verification (MCP collation)

Before implementing I cross-referenced:

- **PowerSync docs** (`mcp__powersync-docs`): `/sync/advanced/client-id.mdx`
  — "For tables where the client will create new rows: Postgres… use a UUID
  for id." And on `uploadData()`: "ensure that uploadData() isn't blindly using
  a field named id when handling CRUD operations." Client UUIDs must round-trip
  for offline conflict-free writes.
- **cht-core OpenDeepWiki**: `5-shared-libs.1-cht-datasource.6-report`
  confirmed `Report.v1.create` currently uses `createDoc(medicDb)` → `db.post()`
  (server-minted UUID).
- **cht-core OpenDeepWiki**: `5-shared-libs.1-cht-datasource.2-data-contexts`
  confirmed the adapter dispatch pattern (Local/Remote/Postgres via `adapt()`)
  — the same strategy I extend here.
- **cht-kapa-docs**: "The current `cht-datasource` API does not expose a
  server-trusted, client-UUID-preserving create path." Confirms the gap.

## Test gates

- `npm run unit-shared-lib` — **3,557 passing, 0 failing**.
- `npm run unit-api` — 1,618 passing, 2 failing. Both failures pre-exist on
  playtime (confirmed by stashing my changes and re-running):
  - `Monitoring service … includes view_index data` — needs
    `api/build/ddocs/medic.json` (ddoc bundle build artifact).
  - `User DB service … creates the db if it does not exist` — expects
    minified view function (ddoc compilation artifact).
  Neither touches `data-context.js`, `cht-datasource`, `powersync-upload.js`,
  or any file I modified.
- All 52 data-context-adjacent tests pass
  (`data-context.spec.js`, `powersync-upload.spec.js`, and the
  `report/person/place/contact` controllers).

## Open architectural question — **needs Medic team sign-off**

Per handoff instruction: flag but do not resolve.

**The question.** The Postgres adapter reads/writes `v1.couchdb` (the JSONB
snapshot that `cht-sync` / `couch2pg` populates from CouchDB). For real
PowerSync→Postgres *writes*, there are two viable target shapes:

1. **Write to `v1.couchdb` (forward-sync pattern).** The adapter stays
   pointed at the same table `cht-sync` writes to. `couch2pg` continues to
   backfill historical data. CouchDB effectively becomes a read replica
   during the transition. Upside: no schema split — the same JSONB row
   layout serves analytics and application reads. Downside: PowerSync Sync
   Streams must read from a derived view (since it cannot efficiently
   filter on JSONB at scale), and the dual writer (API + cht-sync) needs
   conflict rules on `saved_timestamp`.

2. **Write to a new native schema that PowerSync Sync Streams reads
   directly.** Normalised tables (contacts, reports, tasks, targets)
   with generated columns — the `IMPLEMENTATION_GUIDE.md` "Layer 2" design.
   Upside: Sync Streams queries are first-class SQL; analytics dbt can
   follow the same shape. Downside: during the transition the adapter has
   to write twice (or a trigger mirrors into `v1.couchdb` to keep
   cht-sync happy), and the cut-over order is harder.

**Which this iteration's wiring assumes.** Option 1. The
`getPostgresDataContext` defaults to `schema=v1, table=couchdb`. If Medic
lands on option 2, the only API-side change is the `CHT_PG_SCHEMA` /
`CHT_PG_TABLE` env vars plus matching schema migration — the adapter code
itself doesn't need to change because it's driven by `schemaConfig`.

**Roadmap alignment.** This question affects Phase 2 of
`CHT_ARCHITECTURE_ROADMAP.md` ("Real-time transactional writes to
PostgreSQL"). Agent 5 / Hareet's benchmark (the third "BENCHMARK_TARGET=
postgres" section called out in the handoff) is the right place to stress
each option and get empirical input to the decision.

## Not done (explicitly out of scope for this iteration)

- **Benchmark integration.** The handoff says the third benchmark section
  (`BENCHMARK_TARGET=postgres`) is Agent 5 / Hareet's work; I have not
  touched `tests/benchmark/benchmark-write-path.js`.
- **Schema migration / cht-sync bridge.** Depends on the open
  architectural question above.
- **Sentinel / analytics dbt updates.** Out of Agent 1's scope.

## Files touched

```
api/src/services/data-context.js
api/src/controllers/powersync-upload.js
api/tests/mocha/controllers/powersync-upload.spec.js
shared-libs/cht-datasource/src/local/libs/doc.ts
shared-libs/cht-datasource/src/local/report.ts
shared-libs/cht-datasource/src/local/person.ts
shared-libs/cht-datasource/src/local/place.ts
shared-libs/cht-datasource/src/postgres/libs/doc.ts
shared-libs/cht-datasource/src/postgres/report.ts
shared-libs/cht-datasource/src/postgres/person.ts
shared-libs/cht-datasource/src/postgres/place.ts
shared-libs/cht-datasource/src/report.ts
shared-libs/cht-datasource/src/person.ts
shared-libs/cht-datasource/src/place.ts
shared-libs/cht-datasource/test/local/libs/doc.spec.ts
shared-libs/cht-datasource/test/postgres/libs/doc.spec.ts
shared-libs/cht-datasource/test/report.spec.ts
shared-libs/cht-datasource/test/person.spec.ts
shared-libs/cht-datasource/test/place.spec.ts
```
