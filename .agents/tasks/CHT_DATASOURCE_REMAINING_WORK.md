# cht-datasource — Endpoint Inventory + Remaining Work

Working doc for the migration off `DbService`. Compiled 2026-04-26 from:
- Local code in this worktree (`shared-libs/cht-datasource`, `webapp/src/ts/services`, `admin/src/js`)
- Recent commits and `DONE.md`/`AGENT_HANDOFF_NOTES.md` on this branch
- `cht-core-wiki` OpenDeepWiki catalog (verified with `get_document_catalog` first)
- `cht-kapa-docs` MCP for issues/PRs and roadmap state
- WebSearch (gh CLI not used per request)

The OpenDeepWiki `cht-sync-wiki`, `cht-conf-wiki`, `cht-watchdog-wiki` were also surfaced. `cht-core-wiki` (8 cht-datasource pages: Overview, Data Contexts, Contact, Person, Place, Report, Target, Qualifiers) confirms the public API surface in §1. `cht-sync-wiki` and `cht-watchdog-wiki` were used for the meta-DB downstream-consumer analysis in §3c and §4.

Update log:
- 2026-04-26 v1: initial inventory and remaining-work list.
- 2026-04-26 v2: per-item §3c rationale; new §4a on meta-DB collapse downstream-consumer risk (telemetry/feedback path through Sentinel fan-in → `medic-users-meta` → cht-sync → dbt → Superset, plus the Monitoring API hit on `users-meta/feedback_by_date`).

---

## 1. cht-datasource API surface (public)

Imperative facade in `shared-libs/cht-datasource/src/index.ts`:

| Concept   | Method                                       | Local | Remote | Postgres |
|-----------|----------------------------------------------|:-----:|:------:|:--------:|
| Contact   | `getByUuid`                                  |   ✓   |   ✓    |    ✓     |
| Contact   | `getByUuidWithLineage`                       |   ✓   |   ✓    |    ✓     |
| Contact   | `getUuidsPageBy{Type,Freetext,TypeFreetext}` |   ✓   |   ✓    |    ✓     |
| Contact   | `getUuidsBy{Type,Freetext,TypeFreetext}`     |   ✓   |   ✓    |  partial (uses page) |
| Place     | `getByUuid` / `getByUuidWithLineage`         |   ✓   |   ✓    |    ✓     |
| Place     | `getPageByType` / `getByType`                |   ✓   |   ✓    |    ✓     |
| Place     | `create` / `update`                          |   ✓   |   ✓    |    ✓     |
| Person    | `getByUuid` / `getByUuidWithLineage`         |   ✓   |   ✓    |    ✓     |
| Person    | `getPageByType` / `getByType`                |   ✓   |   ✓    |    ✓     |
| Person    | `create` / `update`                          |   ✓   |   ✓    |    ✓     |
| Report    | `getByUuid` / `getByUuidWithLineage`         |   ✓   |   ✓    |    ✓     |
| Report    | `getUuidsPageByFreetext` / `getUuidsByFreetext` | ✓ |   ✓    |    ✓ / partial |
| Report    | `create` / `update`                          |   ✓   |   ✓    |    ✓     |
| Target    | `getById`                                    |   ✓   |   ✓    |    ✓     |
| Target    | `getByReportingPeriodContactIdUsername`      |   ✓   |   ✓    |    ✓     |
| Target    | `getPageByReportingPeriodContactIds`         |   ✓   |   ✓    |    ✓     |
| Target    | `getByReportingPeriodContactIds` (generator) |   ✓   |   ✓    |  partial |
| Auth      | `hasPermissions` / `hasAnyPermission`        |   n/a (pure fn)              |

Source-of-truth files: `src/{contact,person,place,report,target,qualifier,input}.ts` and per-adapter directories `src/local/`, `src/remote/`, `src/postgres/`.

---

## 2. What this branch added / changed (vs `master`)

Two commits land the cht-datasource work:

- **`168091011` — CHT_DB_BACKEND switch + client-UUID preservation via idHint**
- Earlier postgres-adapter scaffolding shipped via the iteration-1 `playtime` merges (now in branch base).

### 2a. Added — Postgres adapter (`shared-libs/cht-datasource/src/postgres/`)

New files (all created on this branch line):
- `index.ts` exports `getPostgresDataContext`, plus Contact/Person/Place/Report/Target.
- `libs/data-context.ts` — `PostgresDataContext` with `pgPool`, `settings`, `schemaConfig {schema, table}`. Default schema `v1`, table `couchdb`.
- `libs/doc.ts` — primitive doc ops over `v1.couchdb` JSONB (`getDocById`, `getDocsByIds`, `getDocIdsByIdRange`, `queryDocsByType`, `queryDocIdsByType`, `createDoc`, `updateDoc`, `minifyDoc`, `fetchAndFilter`, `fetchAndFilterIds`).
- `libs/freetext.ts` — `queryByFreetext` (PG full-text replacement for the offline freetext views).
- `libs/lineage.ts` — recursive CTE walker for `fetchHydratedDoc` (parity with `local/libs/lineage.ts`).
- `contact.ts`, `person.ts`, `place.ts`, `report.ts`, `target.ts` — per-concept implementations of the public API.

Test coverage added: `test/postgres/{contact,person,place,report,target}.spec.ts` plus `test/postgres/libs/{data-context,doc,freetext,lineage}.spec.ts`. All run via the new `run-pg-tests.sh` and `scripts/verify-pg-adapter.sh`. New reference doc: `COUCHDB_BEHAVIOR_REFERENCE.md`.

### 2b. Added — `getPostgresDataContext` exported from `src/index.ts`

`src/index.ts` now exports `getPostgresDataContext` alongside the existing `getLocalDataContext` / `getRemoteDataContext`. No public API removals — this is purely additive.

### 2c. Changed — `idHint` parameter on create paths

To preserve PowerSync client-minted UUIDs (PowerSync best practice for offline writes), `Report.v1.create`, `Person.v1.create`, `Place.v1.create` now accept an optional second positional arg `idHint?: string`. When the caller (the API's PowerSync upload controller) supplies it, the adapter uses `db.put({ _id: idHint, ... })` instead of `db.post(...)`.

Files touched (in this worktree):
- `src/{report,person,place}.ts` — public wrapper threads `idHint` through.
- `src/local/{report,person,place}.ts` and `src/local/libs/doc.ts` — local adapter accepts and uses `idHint`.
- `src/postgres/{report,person,place}.ts` and `src/postgres/libs/doc.ts` — postgres adapter accepts and uses `idHint`.
- `src/libs/data-context.ts` — `adapt()` now also dispatches `PostgresDataContext`.
- `src/libs/error.ts` — extra error class needed by postgres update path.
- `src/contact.ts` — minor touchups for postgres binding.

`Input.v1.ReportInput._id?: never` constraint is unchanged — server-trusted callers opt in to `idHint` explicitly.

### 2d. Wired into API

Outside `shared-libs/cht-datasource`, but landed in the same commit:
- `api/src/services/data-context.js` — `CHT_DB_BACKEND` env switches between `getLocalDataContext` (default, CouchDB) and `getPostgresDataContext` (opt-in). Pool config from `POSTGRES_URL` or `POSTGRES_{HOST,PORT,DB,USER,PASSWORD}`. Schema via `CHT_PG_SCHEMA` / `CHT_PG_TABLE`.
- `api/src/controllers/powersync-upload.js` — `transformCrudEntry` maps `contact_id → contact`; calls `tableConfig.create(doc, crudEntry.id)` so the client UUID becomes the server `_id`.
- `api/tests/mocha/controllers/powersync-upload.spec.js` — controller test for the `idHint` pass-through.

### 2e. PowerSync→cht-datasource mapping (table → concept)

Already wired in `api/src/controllers/powersync-upload.js` (Agent 5/Agent 1 work, summarised here):

| PowerSync table       | cht-datasource entry point      | Notes |
|-----------------------|---------------------------------|-------|
| `reports`             | `Report.v1.create` / `update`   | `contact_id` rewritten to `contact` |
| `contacts` (person)   | `Person.v1.create` / `update`   | `idHint = CrudEntry.id` |
| `contacts` (place)    | `Place.v1.create` / `update`    | `idHint = CrudEntry.id` |
| `targets` (read-only) | `Target.v1.get` / `getPage`     | clients don't write |
| `tasks`               | (no path yet — see §4)          | rules engine still owns this |

---

## 3. Still using `DbService` directly — needs migration or rationale

I went through every webapp/admin source file that imports `DbService` (not just tests) and grouped them by what kind of API the cht-datasource would need to grow. The list below names the file, what it does today, and what cht-datasource gap (if any) blocks the refactor.

### 3a. Webapp — read paths that already have a cht-datasource match (refactor only, no new endpoint)

Same shape as the contact-by-id work that PR #10127 / Issue #10079 closed — these can move to existing `Contact/Person/Place/Report.v1.get*` or `Target.v1.get*` without growing the API.

| File | Today | Use |
|---|---|---|
| `webapp/src/ts/services/contacts.service.ts:31,84` | `db.query('medic-client/contacts_by_type'/'contacts_by_parent')` | `Contact.v1.getUuidsPageByType` + `Contact.v1.get` (or sibling-by-parent endpoint, see §3d) |
| `webapp/src/ts/services/place-hierarchy.service.ts:108` | `db.query('medic-client/contacts_by_type')` | `Place.v1.getByType` generator |
| `webapp/src/ts/services/get-data-records.service.ts:35` | `db` (likely allDocs/get) | `Report.v1.get` / `Contact.v1.get` |
| `webapp/src/ts/services/get-summaries.service.ts:109,129` | `db.allDocs` of summaries | `Contact.v1.get` per id (or new bulk-get, see §3d) |
| `webapp/src/ts/services/get-subject-summaries.service.ts` | `db.query` | `Contact.v1.get` |
| `webapp/src/ts/services/lineage-model-generator.service.ts` | `LineageFactory(db)` for non-report entities | `Contact/Person/Place.v1.getWithLineage` (PR #10127 covered the report path; siblings are still here) |
| `webapp/src/ts/services/contact-view-model-generator.service.ts` | residual `db.get` for non-`addPrimaryContact` paths | extend the existing PR #10079 work |
| `webapp/src/ts/services/uhc-stats.service.ts` / `wealth-quintiles-watcher.service.ts` / `z-score.service.ts` | `db.get('_design/medic-client')` etc. | `Settings.v1.get` (does not exist — see §3d) for the design-doc, but the actual data needs are mostly covered by `getByUuid` |
| `webapp/src/ts/modules/about/about.component.ts`, `modules/testing/testing.component.ts` | inspect `db.info()` | trivial — could stay or move to `System.v1.info` (n/a) |

### 3b. Webapp — read/write paths that need *new* cht-datasource endpoints

These are real gaps. `cht-datasource` does not currently expose a path for them, so the cleanup needs an API addition, not just a refactor.

| Concern | Files | Gap |
|---|---|---|
| **Delete docs** | `webapp/src/ts/services/delete-docs.service.ts:bulkDocs(allDocs)`, `webapp/src/ts/modals/delete-doc-confirm/delete-doc-confirm.component.ts`, `admin/src/js/controllers/delete-doc-confirm.js` | No `Contact/Person/Place/Report.v1.delete` exists. Adding it must respect CHT's "soft delete" (sets `_deleted: true` plus tombstone semantics for purge). |
| **Form save (bulk)** | `webapp/src/ts/services/form.service.ts:bulkDocs(preparedDocs)`, `webapp/src/ts/services/enketo.service.ts` (residual) | Needs a transaction-aware bulk write (form submissions can produce multiple docs — main report + child contacts). Currently bypasses cht-datasource because `Report.v1.create` is single-doc. |
| **Read attachments** | `webapp/src/ts/services/xml-forms.service.ts:getAttachment`, `webapp/src/ts/components/report-image/report-image.component.ts:getAttachment`, admin's `images-branding.js` / `images-partners.js` / `forms-xml.js` (via `DB().get` + attachments) | No attachment endpoint on any concept. CHT keeps form XML and binary report images as PouchDB attachments; both need an explicit `Form.v1.getXml`, `Form.v1.listForms`, `Report.v1.getAttachment`. |
| **List/get forms** | `webapp/src/ts/services/xml-forms.service.ts:59,74` queries `medic-client/forms` view | `Form.v1` concept does not exist. Closest is reading `form:` doc-id range — already in PG adapter as `getDocIdsByIdRange`, but unexposed publicly. |
| **Settings doc** | `webapp/src/ts/services/settings.service.ts` (`db.get(SETTINGS)`), `admin/src/js/services/settings.js` | No `Settings.v1` concept. Today everyone reads the `settings` doc directly. The settings is *also* the input to `cht-datasource` adapters, so this needs care to avoid a circular dep. |
| **Translations / branding / privacy / partner / icons** | `webapp/src/ts/services/{languages,translation-loader provider,privacy-policies,resource-icons}.service.ts`, admin `translation-loader.js`, `display-translations.js`, `display-languages.js`, `images-branding.js`, `display-privacy-policies.js`, `icons.js` | Issue [#10678](https://github.com/medic/cht-core/issues/10678) (closed) added `translate` and `getResource` for *extensions only* — they are not full cht-datasource concepts. A `Resource.v1` / `Translation.v1` would let these services drop `DbService`. |
| **Search (server-side freetext for online users)** | `webapp/src/ts/services/search.service.ts:query(...)` | The local freetext refactor (Issue [#9751](https://github.com/medic/cht-core/issues/9751)) is closed — but `search.service.ts` still has a fallback `db.get().query(...)`. Worth confirming whether the residual `dbService` import is dead code or still hit on some path. |
| **Outbound SMS / form2sms** | `webapp/src/ts/services/{send-message,form2sms,message-state,message-contact}.service.ts` | No SMS concept in cht-datasource. `Message.v1` would be a new concept; until then these stay on `DbService`. |
| **Edit groups (sentinel-style)** | `webapp/src/ts/services/edit-group.service.ts` | Editing scheduled tasks on a report. Could be modelled as `Report.v1.updateScheduledTask`. |

### 3c. Webapp — paths that arguably should *not* migrate to cht-datasource

Each entry below has a *different* reason for exclusion — they look similar (all import `DbService`) but have distinct fates. Worth flagging up front so we don't waste effort on these.

**Sync-layer services** — `db-sync.service.ts`, `db-sync-retry.service.ts`, `replication.service.ts`, `changes.service.ts`.
These call PouchDB sync primitives: `db({remote: true}).bulkGet`, `db.changes()`, `info().update_seq`, `bulkDocs({ new_edits: false })`. They are not data CRUD — they implement the *replication protocol*. cht-datasource is deliberately a *data* API (Contact/Person/Place/Report/Target). More importantly, the migration plan replaces these services *wholesale* with PowerSync (`webapp/src/ts/services/powersync/` is already the replacement). Building cht-datasource endpoints for replication primitives is wasted work — the consumers are slated for deletion, not migration.

**Meta-DB writers** — `feedback.service.ts`, `telemetry.service.ts`, `unread-records.service.ts`.
All call `db({ meta: true })` — the per-user `medic-user-{name}-meta` DB. CLAUDE.md PowerSync gap #5: PowerSync has no per-user-DB concept, so the migration plan collapses meta DBs into a single user-scoped table. That collapse changes the *data model*, not just the API surface. If we build `Feedback.v1` / `Telemetry.v1` cht-datasource endpoints now, we'd throw them away when the collapse lands. Defer until the meta-DB collapse design is final. **However**, the *reader* side of the meta-DB story is a separate audit — see §4a.

**Client-side migrations** — `migrations/migration.ts`, `migrations.service.ts`, `migrations/target-checkpointer.migration.ts`.
One-shot operations that read replication seq numbers and manipulate replication checkpoints. They need direct PouchDB control by design — they're not user-data ops. Disappear entirely after PowerSync rollout (PowerSync owns its own checkpointing).

**`db.service.ts`** itself.
Tautological: it's the PouchDB factory. It can't be migrated to use itself. Deletes when the last caller does.

**`cht-datasource.service.ts`**.
Chicken-and-egg dependency: it constructs `getLocalDataContext(settings, { medic: pouchDb })` and the `pouchDb` arg comes from `DbService`. The dependency is intrinsic to bootstrapping the local adapter. Cannot be eliminated without fundamentally changing how cht-datasource is constructed.

**`powersync/powersync.service.ts`, `powersync/powersync-contacts.service.ts`**.
The *new* sync layer (wa-sqlite + PowerSync SDK). They import `DbService` only for the transition window — bootstrap checks and PouchDB fallback while the feature flag is live. The dependency drops naturally when PouchDB does.

**`rules-engine.service.ts`**.
Read paths already migrated to `CHTDatasourceService` (PR #10127 + Agent 6 PowerSync-adapter work). Residual `DbService` import is for tasks/targets *writes* back to PouchDB — handled by Agent 6's rules-engine PowerSync adapter, not a cht-datasource expansion.

**`main.ts`, `effects/reports.effects.ts`, `providers/translation-loader.provider.ts`**.
Bootstrap glue — they receive `DbService` only to pass it to consumers that need it. They fall away once those consumers do; migrating them in isolation would be circular.

### 3d. Concretely — endpoints worth proposing on `cht-datasource` next

Pulled out of §3b above, in the order I'd attack them:

1. `Contact.v1.delete` / `Person.v1.delete` / `Place.v1.delete` / `Report.v1.delete` — soft-delete + tombstone. Unblocks `delete-docs.service`, the modal, and admin delete-doc-confirm.
2. `Contact.v1.getByParent(parentId, type)` — the `contacts_by_parent` view used by `contacts.service.getSiblings` and likely several admin controllers. Already cheap on Local (has the view) and on Postgres (already indexed); no Remote endpoint exists today.
3. `Form.v1.list()` / `Form.v1.getXml(id)` / `Form.v1.getAttachment(id, name)` — covers `xml-forms.service` and the report-image use case. The `form:` id range is already a primitive on the postgres adapter.
4. `Report.v1.bulkCreate(reports[])` — needed for form submissions that produce multiple docs in one transaction. Today `form.service` calls `db.bulkDocs` directly.
5. `Settings.v1.get()` / `Settings.v1.subscribe()` — explicit settings-doc reads. Used by ~10 webapp services. Has to be careful about the bootstrap dependency (cht-datasource itself takes settings as a constructor arg).
6. `Resource.v1.getAttachment(docId, attachmentName)` — for branding, partner logos, privacy policies, resource icons. Could share infrastructure with #3.
7. `Translation.v1.list()` / `Translation.v1.getMessages(locale)` — extension-side equivalents already partially exist (Issue #10678) but webapp still hits the DB directly.
8. (Lower priority) `Message.v1.create` / `Message.v1.updateState` for the SMS path — only if/when the SMS workflow is in scope for the migration.

---

## 4a. Meta-DB collapse — downstream-consumer risk

The §3c "defer telemetry/feedback writers" call is correct, but the meta-DB collapse is **not** a self-contained webapp change. Read-side consumers depend on the current meta-DB shape and need their own migration plan, or they break silently.

**Today's flow** (verified via cht-kapa-docs MCP, cht-sync-wiki, cht-watchdog kapa query):

```
Webapp ─▶ on-device per-day PouchDB (telemetry-YYYY-M-D-{user})
       ─▶ rolled up daily into per-user meta DB (medic-user-{name}-meta)
       ─▶ replicates to server-side per-user meta DB
       ─▶ Sentinel transition fans in to single aggregate medic-users-meta
          (and DELETES from per-user DB after success)
       ─▶ cht-sync (couch2pg) reads medic-users-meta → PostgreSQL v1.couchdb (JSONB)
       ─▶ dbt models in cht-pipeline → relational views
       ─▶ Superset / Klipfolio dashboards
```

**Consumers and what each needs preserved**:

| Consumer | What it reads today | Risk under meta-DB collapse |
|---|---|---|
| Monitoring API → watchdog `cht_feedback_total` | `medic-users-meta/feedback_by_date` CouchDB view | Breaks unless Monitoring API gains a Postgres-equivalent count. **Active code in `api/src/services/monitoring.js`.** |
| dbt models (cht-pipeline) → Superset / Klipfolio | `v1.couchdb WHERE doc->>'type' IN ('telemetry','feedback')` | Works only if the new aggregate preserves JSONB doc shape (`metrics{sum,min,max,count,sumsqr}`, `device`, `metadata{year,month,day,user,deviceId,versions}`, `dbInfo`). Otherwise every dbt model needs a rewrite. |
| Apdex telemetry / training-card telemetry query guides | named metric keys inside the JSONB `metrics` field | Metric key names must survive verbatim. Consumer-facing doc references them. |
| Support staff querying per-user `medic-user-{name}-meta` for unflushed feedback ([forum 3359](https://forum.communityhealthtoolkit.org/t/3359)) | The pre-Sentinel staging buffer | Goes away. After collapse there's no intermediate staging — writes either reach the aggregate or are stuck client-side. Acceptable if the new write path is more reliable; worth flagging. |

**Things the collapse design needs to commit to** (any one of these missing causes silent breakage):

1. Either preserve the `medic-users-meta` JSONB doc shape in whatever new table replaces it, *or* ship replacement dbt models + a migration playbook.
2. Repoint the Monitoring API's feedback count to whatever the new feedback storage is. Without this, `cht_feedback_total` quietly returns zero.
3. Keep telemetry metric key names (`metric_a`, Apdex keys, training-card keys) stable — they're documented and queried by name.
4. Decide whether the per-user staging-buffer "debug visibility" is replaced by some new diagnostic surface, or just dropped.

**Bottom-line implication for cht-datasource**: the collapse is bigger than the webapp `feedback.service` / `telemetry.service` rewrite — it touches the Monitoring API and the analytics pipeline. cht-datasource probably *doesn't* grow a `Feedback.v1` / `Telemetry.v1` even after the collapse, because the writers go through PowerSync (not cht-datasource) and the readers go through dbt + the Monitoring API (also not cht-datasource). This is good news for the §3c exclusion: those services drop their `DbService` use without ever needing a cht-datasource counterpart.

---

## 4. Other gaps / risks not directly about `DbService`

Captured for completeness; these came out of the same audit:

- **Postgres adapter `getUuids`-as-generator paths are partial.** The `getUuids*` (non-paged generators) on Contact/Report exist on `index.ts` but the postgres `report.ts` and `contact.ts` only export `getUuidsPage`. The public layer falls back to iterating the page fn — fine for correctness, but worth confirming under load before national-scale rollout.
- **Tasks have no cht-datasource path.** Rules engine still owns `tasks` round-trip via PouchDB. PowerSync adapter (Agent 6) bypasses cht-datasource for tasks. If we want symmetry with Reports, a `Task.v1.{get,create,update}` is missing. Roadmap-wise this is the largest code migration (CLAUDE.md gap #3, ~6-8 weeks).
- **`fields.iteration` is the only place a client UUID survives on legacy CouchDB writes.** With the `idHint` change, new writes preserve `_id`, but historical docs in the cht-sync `v1.couchdb` table will have CouchDB-minted IDs. Any reconciliation script comparing client UUID ↔ server `_id` needs to handle both shapes.
- **Open architectural question (still unresolved per `DONE.md`):** Postgres adapter writes to `v1.couchdb` (cht-sync's JSONB shape). If Medic chooses native normalised tables instead, the adapter only needs `CHT_PG_SCHEMA`/`CHT_PG_TABLE` env changes — but PowerSync Sync Streams downstream may need rewriting. Flag in the next review.
- **Search service residual `DbService`.** Issue #9751 is closed but `search.service.ts:query(...)` still references `DbService`. Worth a focused check on whether any code path still hits it (might just be unused import).

---

## 5. Tracked GitHub issues we cross-referenced

All from `medic/cht-core`. Cross-checked via WebSearch + cht-kapa-docs MCP:

| # | Title | State | Relevance |
|---|---|---|---|
| #9751 | Refactor `shared-libs/search` to call cht-datasource freetext search apis | closed | Search migration; some residual webapp `dbService` ref worth double-checking |
| #9838 | Refactor to use cht-datasource for reading contacts by id (with/without lineage) | closed | Read-by-id path |
| #10018 | Update code that loads contacts by id directly from Pouch to use cht-datasource | closed | Sweep work |
| #10074 | Update `api` to read contacts with cht-datasource | closed | API-side migration scripts |
| #10075 | Update `admin` to read contacts with cht-datasource | closed | `admin/edit-user.js`, `admin/lineage-model-generator.js` |
| #10077 | Update `shared-libs/transitions` to read contacts with cht-datasource | closed | Sentinel transitions |
| #10079 | Update `webapp` to read contacts with cht-datasource | closed | webapp services list above |
| #10678 | Update CHT API service in webapp to include `translate` and `getResource` | closed | extension support, NOT general translations |
| #9241 | Create API endpoint for getting people | (older) | original Person.v1 motivation |

PRs landed: #9945, #10030, #10083 (create/update for contacts and reports), #10085 (api migration scripts), #10127 (webapp+transitions), #10143.

No open issue we found tracks the `DbService` elimination as a single epic — the work has been driven file-by-file via the PRs above. Worth proposing an umbrella epic, since the §3b list is now substantial.

---

## 6. Suggested next steps for this branch / agent-1 follow-on

In rough order:

1. **Run `npm run unit-shared-lib` and `npm run unit-api` from a clean checkout** to confirm the `idHint` plumbing is green; the DONE.md says it is, but worth a fresh check before opening any review.
2. **Open an epic issue** referencing this doc — group the §3b endpoints into a tracked list. Co-worker's framing fits: *"places using the DB directly — refactor or create new cht-datasource paths."*
3. **Pick the lowest-risk new endpoint first.** `Contact.v1.getByParent` (siblings) is purely additive, has Local + Remote + Postgres equivalents already, and unblocks 3-4 services in one shot.
4. **Defer meta-DB callers (§3c) until the meta-DB collapse design lands.** No point growing cht-datasource for an API surface that's about to disappear.
5. **Decide on `Form.v1` vs reusing the existing `cht-conf` form layer** — there's an open question about whether forms belong in `cht-datasource` at all, or whether they should stay in cht-conf and be exposed via `Resource.v1` only.
6. **Settle the open architectural question from `DONE.md`** (`v1.couchdb` write target vs native normalised schema) — that decision changes which §3b endpoints we even need to write postgres-side adapters for.

---

## Sources

- Local code: `shared-libs/cht-datasource/`, `webapp/src/ts/services/`, `admin/src/js/`, `api/src/services/data-context.js`, `api/src/controllers/powersync-upload.js`
- Branch artefacts: [`DONE.md`](../../DONE.md), [`AGENT_HANDOFF_NOTES.md`](AGENT_HANDOFF_NOTES.md)
- OpenDeepWiki: `medic/cht-core` catalog (8 cht-datasource docs verified via `get_document_catalog`)
- [Issue #9751](https://github.com/medic/cht-core/issues/9751), [#9838](https://github.com/medic/cht-core/issues/9838), [#10074](https://github.com/medic/cht-core/issues/10074), [#10075](https://github.com/medic/cht-core/issues/10075), [#10077](https://github.com/medic/cht-core/issues/10077), [#10079](https://github.com/medic/cht-core/issues/10079), [#10678](https://github.com/medic/cht-core/issues/10678)
- [PR #9945](https://github.com/medic/cht-core/pull/9945), [#10030](https://github.com/medic/cht-core/pull/10030), [#10083](https://github.com/medic/cht-core/pull/10083), [#10085](https://github.com/medic/cht-core/pull/10085), [#10127](https://github.com/medic/cht-core/pull/10127), [#10143](https://github.com/medic/cht-core/pull/10143)
- [`@medic/cht-datasource` README](https://github.com/medic/cht-core/blob/master/shared-libs/cht-datasource/README.md)
- [CHT 5.0 release notes](https://docs.communityhealthtoolkit.org/releases/5_0_0/)
- [CHT roadmap](https://docs.communityhealthtoolkit.org/community/roadmap/) — for current scheduling beyond what kapa-docs sees

For §4a (meta-DB collapse downstream-consumer audit):
- [User telemetry — doc shape, daily aggregation, `_stats` reduce](https://docs.communityhealthtoolkit.org/technical-overview/data/performance/telemetry/)
- [Managing Databases — Sentinel fan-in from per-user meta to `medic-users-meta`](https://docs.communityhealthtoolkit.org/technical-overview/data/)
- [Data Flows for Analytics](https://docs.communityhealthtoolkit.org/technical-overview/data/analytics/data-flows-for-analytics/)
- [CHT Watchdog Architecture](https://docs.communityhealthtoolkit.org/technical-overview/architecture/cht-watchdog/) — confirms watchdog scrapes Monitoring API, not telemetry
- [CHT Watchdog Dashboards & Metrics Reference](https://docs.communityhealthtoolkit.org/hosting/monitoring/dashboards/) — `cht_feedback_total` definition
- [Custom Postgres metrics in CHT Watchdog](https://docs.communityhealthtoolkit.org/hosting/monitoring/postgres-ingest/)
- [`api/src/services/monitoring.js`](https://github.com/medic/cht-core/blob/master/api/src/services/monitoring.js) — hits `users-meta/feedback_by_date` view
- [`webapp/src/ts/services/telemetry.service.ts`](https://github.com/medic/cht-core/blob/master/webapp/src/ts/services/telemetry.service.ts) — daily roll-up logic stays client-side
- [Forum: Sync issues & status scrutiny](https://forum.communityhealthtoolkit.org/t/3359) — support workflow that depends on per-user staging buffer
- cht-sync-wiki: `3-core-modules/2-data-synchronization/2-data-import` — confirms couch2pg reads configured CouchDB DBs (default: `medic`, `medic-sentinel`, `medic-users-meta`) into `v1.couchdb` JSONB
