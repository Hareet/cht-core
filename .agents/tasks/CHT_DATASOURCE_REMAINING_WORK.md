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
- 2026-05-01 v3: **reframe — view-first migration is the load-bearing scope, not generic `DbService` elimination.** New §5 with full view inventory, agent-3 vs agent-1 ownership split, and proposed cht-core issues. §3 is preserved as a callsite reference but the strategic priority is now §5. Hareet's framing: "the rest of stewardship's main objection is the amount of changes — a PoC that needs a lot of *additional* changes won't convince them. All roads lead through finishing CHT Datasource (whether we use PowerSync or roll our own custom sync)."
- 2026-05-01 v4: scope/feasibility analysis. Three MCP-sourced corrections to §5b (offline-tasks ddoc move, replication-authorization view as deletion target, dead `medic-scripts` views). §5c sharpened: SQLite cht-datasource adapter is the unowned gap that decides whether any sync-engine PoC is meaningful — agent-6's rules-engine adapter is precedent but does not satisfy the public cht-datasource contract. New §5e (difficulty classes), §5f (differential-testing proof strategy), §5g (pacing — force one hard view in early). Pilot view detail renumbered §5h.
- 2026-05-02 v5: scope/ranking refinement and ticket drafting.
  - §5e/§5g/§5d edits planned but **deferred to v6** — the analytical
    content is captured in conversation logs and reproduced verbatim in
    the per-ticket text under `.agents/tasks/tickets/`, which is the
    canonical artefact for the work going forward.
  - §5d's "first batch" is now drafted as a complete set of cht-agent
    tickets in `.agents/tasks/tickets/`. Ten files: an umbrella, a
    pilot (`contacts_by_phone`), seven per-view tickets covering the
    qualifier-extension batch Hareet identified on 2026-05-02, and a
    cht-agent skill ticket that automates the recipe. See
    [`tickets/README.md`](./tickets/README.md) for the index and the
    pattern derivation from cht-core issues #10706, #9835, #9701, #9625.
  - The right ranking axis is **call-site replacement effort**, not
    view-implementation complexity. Hareet's framing: implementing the
    SQL/SQLite is the easy part; replacing references is the hard part.
    Several §5e classifications shift under this rule (e.g.,
    `data_records_by_type` and `docs_by_shortcode` move easy→hard
    because their consumer code is gnarly even though the view is
    trivial; `registered_patients` likely deletes rather than migrates;
    freetext views drop a class because cht-datasource already wraps
    them server-side). See `tickets/README.md` "What is NOT in this
    batch" for the per-view rulings.

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

> **Note (v3): the strategic priority is §5, not §3.** This section is a complete callsite reference — every `DbService` import in webapp/admin and what kind of replacement each one would need. It's useful for planning, but the section that should drive *issues filed in cht-core* is §5, which separates the work that actually unblocks a Postgres/SQLite migration (replacing `db.query(view)`) from the work that's mostly cosmetic (replacing `db.get(uuid)`). Read §5 first; come back here for caller details.

The co-worker's framing: *"the most clear thing to work towards is eliminating the usage of the DB Service both in webapp and in admin. The places we are still using the DB directly need to be evaluated and we should either refactor them or create new cht-datasource paths for the code to use."*

Hareet refined that on 2026-05-01: *"replacing `db.query` calls to views with calls to datasource APIs could be a way to reduce the scope (plenty big enough), and is also what actually couples the code most tightly to couch/pouch. Id lookups with `get` or `allDocs` are going to look similar no matter what."* §5 carries that forward.

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

cht-watchdog is **not** a telemetry consumer (verified — the kapa-docs source explicitly states "telemetry is not directly ingested by Watchdog"). It scrapes the CHT Monitoring API for DB-level stats. But the Monitoring API itself queries `medic-users-meta/feedback_by_date` for the `cht_feedback_total` metric.

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

## 5. View-first migration — the load-bearing scope

This is the actual scope that unblocks a Postgres/SQLite-backed CHT (PowerSync or custom-sync). Filing issues from this section is the priority over filing from §3.

### 5a. Why view-first is the right framing

The §3 "DbService elimination" sweep mixes three categories with very different costs:

1. **`db.get(uuid)` and `db.allDocs({keys})`** — by-id reads. Trivial to back with Postgres (`SELECT … WHERE _id = $1`) or SQLite (same). The shape of the call doesn't change with the backend. Hareet on 2026-05-01: *"id lookups with get or allDocs are going to look similar no matter what; you could argue that maybe not every get or allDocs needs to be replaced anyway."* These are nice-to-have refactors. They are not what blocks a backend swap.
2. **`db.query('view-name', ...)`** — view-backed queries. Each one **requires a CouchDB design document to be present** on whichever DB is being queried. PouchDB ships those views to clients; nothing else does. This is what tightly couples application code to Couch/Pouch. Replacing these is the *only* way to make the storage substrate swappable without a per-feature SQL rewrite at every call site.
3. **`db({remote/meta:true})` and `db.changes()`** — the sync engine itself (§3c). Out of scope.

The PoC trap: PowerSync benchmarks demonstrate sync semantics, but if every webapp screen still calls `db.query('medic-client/contacts_by_parent', ...)`, the synced data isn't queryable by the application — you've validated the transport, not the migration. Stewardship's main objection is "this requires too many changes"; a PoC that needs a *further* large refactor to be useable can't answer that objection. **Finishing cht-datasource — specifically the view-replacement layer — is the precondition for any sync-engine PoC being convincing.** That holds whether the sync engine is PowerSync, a custom REST sync, or anything else.

### 5b. View inventory — what's covered, what isn't

Inventoried 2026-05-01 by `grep -rnE "\.query\(['\"]" webapp/src admin/src shared-libs/{lineage,validation,transitions,user-management,rules-engine}/` and cross-referencing `shared-libs/cht-datasource/src/{local,remote,postgres}/`.

**Group A — view already wrapped by cht-datasource. Callers can drop `db.query` today.** No new endpoint work; just refactor the call sites.

| View | Public cht-datasource API | Postgres adapter |
|---|---|---|
| `medic-client/contacts_by_type` | `Contact.v1.getUuidsPageByType`, `Person/Place.v1.getPageByType` | ✓ `queryDocIdsByType` |
| `medic-offline-freetext/contacts_by_freetext` | `Contact.v1.getUuidsPageByFreetext` | ✓ PG full-text |
| `medic-offline-freetext/contacts_by_type_freetext` | `Contact.v1.getUuidsPageByTypeFreetext` | ✓ |
| `medic-offline-freetext/reports_by_freetext` | `Report.v1.getUuidsPageByFreetext` | ✓ |
| `medic-client/docs_by_id_lineage` | (internal — `*.v1.getWithLineage`) | ✓ recursive CTE |
| `medic-client/contacts_by_reference` | (internal in postgres lineage at `postgres/libs/lineage.ts:307`) — **not yet exposed publicly**; see Group B |  partial |

**Group B — heavy callers, NOT yet wrapped, NO public cht-datasource API. This is the priority list.** Sorted by callsite count first, then by simplicity of the underlying view.

| View | Public callers | Notes |
|---|---|---|
| `medic-client/contacts_by_parent` | webapp `contacts.getSiblings:86`, `wealth-quintiles-watcher:38`, `contact-view-model-generator:215`, `send-message:79`; powersync-contacts.service explicitly comments itself as the replacement | Simplest view: `emit([parentId, type])`. Postgres column `contact_parent_place` already exists (agent-3). **Best first issue.** |
| `medic-client/doc_by_type` | webapp `languages:25`, `xml-forms:60`, `telemetry:73`; admin `users:26`, `display-translations:59`, `display-languages:94`, `forms-xml:26` | Simple: `emit([doc.type])`. The "list all of type X" workhorse. Postgres needs an index on `doc->>'type'` (likely already there). |
| `medic-client/contacts_by_phone` | admin `message-queue:96`; transitions `update_clinics:63`/`registration:418`/`self_report:31`/`update_sent_by:27`; `validation_utils:146` | Simple: `emit(doc.phone)`. |
| `medic-client/contacts_by_reference` | admin `message-queue:132`; webapp+admin `get-subject-summaries`; transitions `utils:62`/`update_clinics:25`; rules-engine `pouchdb-provider:57`; lineage `hydration:220` | Already implemented privately in postgres adapter — needs a public method. |
| `medic-client/registered_patients` | webapp `format-data-record:41`; transitions `utils:164`; admin `message-queue:133` | shortcodes → docs lookup. |
| `medic/doc_summaries_by_id` | webapp `get-summaries:111`; admin `get-summaries:103`; admin `message-queue:102` | Server-side only view. Postgres equivalent is a SELECT with denormalized columns. |
| `medic-client/contacts_by_place` | webapp `place-hierarchy:110` | Walks `place.parent` chain in map function; equivalent to a recursive CTE on Postgres (similar to existing lineage). |
| `medic-client/data_records_by_type` | webapp `unread-records:32` | Reduce-grouped count by type. Simple SELECT … GROUP BY on Postgres. |
| `medic-client/contacts_by_last_visited` | webapp `uhc-stats:28` | Reduce-grouped. |
| `medic-client/messages_by_contact_date` | webapp `message-contact:40` | |
| `medic-client/visits_by_date` | webapp `search:72` | |
| `medic-client/reports_by_date` | transitions `utils:106` | |
| `medic-client/reports_by_subject` | transitions `utils:190` | |
| `medic/contacts_by_depth` | transitions `muting_utils:18` | Already partially done by agent-3's `accessible_facilities`; expose via cht-datasource. |
| `medic/docs_by_shortcode` | transitions `ids:106` | |
| `medic-client/tasks_by_contact` | (legacy — see note below) | Per [issue #10749](https://github.com/medic/cht-core/issues/10749) (closed) this view was moved to `medic-offline-tasks/tasks_by_contact` (client-only ddoc). Rules engine's `pouchdb-provider.js` already uses the offline ddoc. Agent-6 owns the SQLite translation. **Not a cht-datasource migration target.** |

**Group C — admin-only, sync-internal, or out-of-scope per §3c.** Filed for completeness, not for migration.

- `medic-admin/{message_queue, contacts_by_dhis_orgunit}` — admin-only operational views; fine to keep on `DbService` until admin gets its own PG/SQLite story.
- `users/users_by_field` (in `_users` DB) — OIDC, separate authentication concern.
- `users-meta/feedback_by_date` — meta-DB collapse territory (§4a). Note: Monitoring API depends on this view.
- `medic-user/read` — per-user meta DB (§4a).
- `medic/{contacts_by_primary_contact, messages_by_state, reports_by_form_and_parent, reports_by_form_year_*, tasks_in_terminal_state}` — Sentinel/purge views; agent-2/agent-4 territory.
- `builds/releases` (in third-party `builds` DB) — upgrade controller.

**Group D — replaced rather than migrated.** Surfaced via cht-kapa-docs MCP cross-check 2026-05-01.

- **`medic/docs_by_replication_key`** (Nouveau-indexed) — the heart of the legacy v5 replication algorithm. The API queries it server-side via `authorization.js:getDocsByReplicationKey()` to compute "which doc IDs is this user allowed to see." Under PowerSync, this is *replaced* — not by a cht-datasource method but by Sync Streams partitioning (agent-3's territory: `accessible_facilities`, `report_visible_places`, `unassigned_reports`). After PowerSync rolls out and the legacy replication endpoint is retired, this view can be dropped from `medic` ddoc entirely. **Do not rebuild it in cht-datasource.** Same logic applies to its purge.js consumer in `sentinel/src/lib/purging.js` which queries `_nouveau/docs_by_replication_key` with `key:_unassigned` for unallocated-records purging — agent-4's purge-preproc service replaces that path on the Postgres side.
- **`medic-scripts` views** (`data_records_by_ancestor`, `places_by_type_parent_id_name`, `places_by_contact`, `total_clinics_by_facility`) — per [issue #10322](https://github.com/medic/cht-core/issues/10322) (closed): largely unused, only referenced by old support scripts (e.g. `delete_training_data_utils.js`). They consume disk (~2.1GB on a 5.3GB instance) but no application code depends on them. **Removal is a cleanup, not a migration.** Worth confirming none of the §5b application views *transitively* read from them, but kapa-docs found no such case.

### 5c. Agent ownership — does agent-3 own this?

No. Agent-3 (Sync Streams) and Agent-1 (cht-datasource) overlap on *infrastructure* but own different problems.

| Concern | Owner | Why |
|---|---|---|
| Sync Streams YAML/SQL config — *which rows reach the client* | **Agent-3** | Bucket partitioning, JWT params, partition pruning. |
| Postgres-side indexes / generated columns / helper functions backing Sync Streams | **Agent-3** (e.g. `accessible_facilities`, `contact_parent_place`, `refresh_user_facilities`) | Sync Streams need them to be efficient at national scale. |
| Per-view cht-datasource public API surface (Local + Remote + Postgres adapters) — *what API client code calls* | **Agent-1** | Group B above. |
| New SQLite (PowerSync wa-sqlite) adapter for cht-datasource — so client code calls the same API against synced SQLite instead of PouchDB | **Agent-1 (new — does not exist yet)** | Currently cht-datasource has Local (PouchDB) + Remote (HTTP) + Postgres (server). For a real PowerSync PoC there has to be a fourth: SQLite-backed local. |
| Application-side refactoring of `db.query(view)` call sites | **Agent-1** with collaboration from feature owners | Just plumbing once the API exists. |
| Rewriting `tasks_by_contact` and rules-engine internals | **Agent-6** | Rules engine PowerSync adapter. |

The right collaboration shape: agent-3 commits to the postgres column/index names; agent-1 reads from those columns in the cht-datasource Postgres adapter. They share infra but ship different surfaces. Neither agent can finish without the other; neither agent can be subsumed into the other.

**The unowned gap that decides whether the PoC is meaningful: a SQLite adapter for cht-datasource.**

cht-datasource today has three adapters: `Local` (PouchDB), `Remote` (HTTP), `Postgres`. PowerSync syncs server data into wa-sqlite on the client. There is no fourth adapter. Without one, the chain breaks at the client: even after every Group B view ships in cht-datasource and Sync Streams populate SQLite correctly, application code calling `Contact.v1.getByParent(...)` against a PowerSync-only client falls through to the `Local` adapter, which expects PouchDB. The client cannot get off PouchDB without this adapter, and a PoC that requires both PouchDB and SQLite on the client is not the PoC stewardship is asking about.

Agent-6 has built a SQLite adapter — but only for the rules engine, in `shared-libs/rules-engine/src/adapters/powersync-adapter.js`. That adapter is internal to the rules engine; it doesn't satisfy the public cht-datasource contract (Concept Modules, Qualifiers, `bind`/`adapt` dispatch). It is **precedent and pattern, not delivery**. Specifically reusable from agent-6's work:

- The denormalized-column schema pattern in `powersync-schema.js` (`parent_id`, `patient_id`, `place_id`, `case_id`, `subject_id`, plus `doc` JSON column) — directly applicable to a cht-datasource SQLite adapter.
- The 999-param SQLite limit + `MAX_SQL_ITEMS=300` chunking pattern.
- The CouchDB-view → SQL semantics notes (NULL-state-is-non-terminal, owner='_unassigned' fallback, JSON parsing fallbacks).

What's still needed: a `local-sqlite/` adapter directory in `shared-libs/cht-datasource/src/` parallel to `local/`, `remote/`, and `postgres/`, with adapter implementations of every public concept method, plus extension of `adapt()` in `libs/data-context.ts` to dispatch a new `SqliteDataContext`.

**Ownership options:**
1. Expand agent-1's charter to include SQLite adapter work (iteration-3+).
2. Spin up a new agent-8 dedicated to it.
3. Do nothing and accept that the PoC validates *sync transport* but not *application portability* — which is exactly the objection stewardship will raise.

Option 3 is the implicit current state and it's the wrong choice for the PoC argument. Pick (1) or (2) before ramping any further on PowerSync benchmarks.

### 5d. Proposed cht-core issues to file

> **Note (v5):** The first batch is now drafted in cht-agent ticket format
> at [`.agents/tasks/tickets/`](./tickets/). Ten files covering the
> umbrella + pilot + seven per-view tickets + a skill ticket. The
> conceptual list below is preserved for context; the *executable*
> form is the tickets directory. Per Hareet's 2026-05-02 reframing,
> these are **qualifier extensions to existing pagination methods**, not
> new top-level methods.


Each of these is sized to be a single, mergeable PR. The pattern is the same in every one: define the API on the concept module (`Contact.v1.X`), implement Local + Remote + Postgres, swap callers, ship with a deprecation comment on the old `db.query` if there are callers we can't migrate yet.

1. **`Contact.v1.getByParent` / `Contact.v1.getPageByParent`** — covers `medic-client/contacts_by_parent`. **Pilot issue.** Five callers, simplest map function, postgres column already indexed by agent-3. Once this lands, the template is reusable.
2. **`Contact.v1.getByReference` / `Contact.v1.getByPhone`** — covers `contacts_by_reference` and `contacts_by_phone`. Group these because they're both "find a contact by an indexed field" and the postgres adapter implementations share the same shape. Heavy use in `shared-libs/transitions` so this also helps Sentinel.
3. **`getByType` family expansion** — `Contact.v1.getByType` already exists for contacts; need equivalents for non-contact docs covered by `medic-client/doc_by_type`. Possibly cleanest as a generic `Document.v1.getPageByType(type)` rather than per-concept methods.
4. **`Contact.v1.getByPlace` (or `getDescendants`)** — covers `contacts_by_place`. Postgres can do this with a recursive CTE on `parent` (similar to existing lineage). Webapp has only one caller but it's the place-hierarchy panel.
5. **`Report.v1.getByDate` / `Report.v1.getBySubject`** — covers `reports_by_date` / `reports_by_subject`. Used heavily by Sentinel transitions.
6. **`Summary.v1.get`** — covers `medic/doc_summaries_by_id`. Server-side only view; webapp+admin both depend on it for list rendering.
7. **`Contact.v1.getByDepth`** — covers `medic/contacts_by_depth`. Aligns with agent-3's depth column; a thin wrapper.
8. **(Tracking issue, not a PR)** — define the SQLite adapter for cht-datasource. This is the gap that decides whether a PowerSync PoC is meaningful or just a transport benchmark.
9. **(Tracking issue, not a PR)** — extension of `Resource.v1` for forms+attachments was already on the list (§3b #3); it remains relevant but is independent of view migration.

Issues 1-7 should each link back to this doc and to the corresponding view file in `ddocs/medic-db/medic-client/views/{viewname}/map.js` for the canonical semantics.

### 5e. Difficulty classes — what's actually hard

Read every map+reduce in `ddocs/medic-db/medic-client/views/` and `ddocs/medic-db/medic/views/` on 2026-05-01. The hardness gradient, with class membership for every Group B view:

**Class 1 — Easy (~1 day each).** Single emit per doc, simple key, no map-time computation, no custom reduce. Postgres and SQLite both express these as `WHERE x = $1 ORDER BY y`. Reduce-group cases (`_count`) become `GROUP BY` in SQL.

- `medic-client/contacts_by_parent`, `medic-client/contacts_by_phone`, `medic-client/doc_by_type`, `medic-client/data_records_by_type`, `medic-client/registered_patients`, `medic-client/contacts_by_reference`, `medic-client/reports_by_date`, `medic/docs_by_shortcode`.

**Class 2 — Medium (~2-3 days each).** Computed sort value in `emit(key, value)` where the value drives ordering, OR custom reduce, OR cross-doc-type emits.

- `medic-client/contacts_by_type` — `emit([type], dead + ' ' + muted + ' ' + idx + ' ' + name)`. The *value* sorts. Postgres can compute it in `ORDER BY`, but the cursor encoding for pagination has to carry this composite key, not just `OFFSET`. SQLite same story.
- `medic-client/messages_by_contact_date` — custom reduce returns the latest row per key. PG: `SELECT DISTINCT ON (contact_id) ... ORDER BY contact_id, date DESC`. SQLite has no `DISTINCT ON`; needs `ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY date DESC) = 1`. Different SQL between adapters but same shape.
- `medic-client/contacts_by_last_visited` — cross-type emit: data_records (visit reports) AND contacts both emit to the same key. Needs `UNION ALL` between two `SELECT`s, then `GROUP BY` for the reduce. Tricky because the row provenance differs.
- `medic-client/visits_by_date`, `medic-client/reports_by_subject` — multiple emits per doc (different fields), single shape. Manageable.

**Class 3 — Hard (~1-2 weeks each).** Hierarchy walks: one map call emits *one row per ancestor* by recursing into `parent`.

- `medic-client/contacts_by_place` — walks `place.parent` chain in the map. PG: recursive CTE walking `parent_id` upward, emitting one row per ancestor place. SQLite: same recursive CTE pattern. **Likely already covered by agent-3's `accessible_facilities` work** — confirm before re-implementing. If yes, this becomes a thin wrapper, not a hard view.
- `medic/contacts_by_depth` — same shape: walks parent chain, emits `[ancestor_id, depth]`. **Almost certainly already covered by agent-3's `refresh_user_facilities` + depth column.** cht-datasource's job is just exposing the SELECT.
- `medic-client/docs_by_id_lineage` — already done as recursive CTE in `postgres/libs/lineage.ts`. **Existence proof for this class.**

**Class 4 — Hardest, tokenization risk.** Freetext search.

- `medic-offline-freetext/{contacts,reports}_by_freetext`, `medic-offline-freetext/contacts_by_type_freetext` — already done with PG full-text + Nouveau. The SQLite adapter has to land on FTS5. **Tokenization parity is the real risk.** CouchDB Nouveau (Lucene), PG `to_tsvector('simple')`, and SQLite FTS5 each tokenize differently — case folding, accent stripping, stemming, n-gram boundaries. A query that returns 47 hits on Couch may return 45 on PG and 51 on SQLite. Some divergence is acceptable; defining what's "acceptable" is the real work.

### 5f. Proof-of-correctness strategy — differential testing

For every Group B view:

1. **Build a `view-parity` test harness once.** Given `(viewName, params)`, run the query against (a) CouchDB via PouchDB, (b) Postgres via the `Contact.v1.X` cht-datasource method, (c) SQLite via the same `Contact.v1.X` (once the SQLite adapter exists). Diff the row sets.
2. **Use the existing CIV test fixture** in `tests/integration/postgresql/` — agent-7's domain, already at ~200K docs. Big enough to surface scale-dependent bugs (cursor encoding, off-by-one pagination, sort-stability under ties).
3. **Assert on three properties:**
   - **Set equality**: same rows, ignoring order (where the view doesn't promise an order).
   - **Pagination soundness**: walking pages with `getPage(cursor, limit)` produces the same union as one big call, with no duplicates and no skipped rows.
   - **Sort stability**: where the view promises an order, all three backends agree on it (or, where they don't, the divergence is documented as acceptable).
4. **For Class 4 (freetext) only:** a separate corpus test with a token rubric documenting acceptable divergence per tokenization concern (case folding required; prefix-match `pat*` finds 'patient' required; stemming best-effort; accent-stripping required). The rubric is the deliverable, not just the test.

This harness is a one-time build that pays off across all Group B views. Agent-7 owns the harness itself; agent-1 lands per-view fixtures with each issue. The harness must be in place *before* the first hard view (Class 2+) ships, otherwise verification is ad-hoc and bugs leak.

### 5g. Pacing — force one hard view in early

The §5h pilot (`contacts_by_parent`) is deliberately Class 1 — to prove the template works and produce something mergeable fast. But if we ship that and immediately pile on Class 1 view #2, view #3, view #4, we'll learn nothing about Class 2's harder shapes until issue #6. By then, #2-#5 have to be revisited because the template doesn't cover composite-cursor pagination or cross-type emits.

Recommended sequence:

1. **Pilot Class 1** — `contacts_by_parent` end-to-end. Local + Remote + Postgres + caller swaps. Proves the template.
2. **Pilot Class 2** — `messages_by_contact_date` (custom reduce, composite key) **or** `contacts_by_last_visited` (cross-type emit). Picks the harder one of those two. Proves the template generalises to non-trivial views.
3. **Pilot Class 4** — one freetext path through SQLite FTS5, even before all of Class 1/2 is done. This is where surprise hits hardest. Producing a tokenization-parity rubric early is more valuable than producing one more easy view.
4. **Then batch Class 1 and Class 2 in parallel.** Class 3 follows the lineage-CTE precedent and probably maps onto agent-3's existing infra; verify before independent work.

Pilots 1, 2, and 3 together set the template, the test harness, and the freetext rubric. Until those three are in, every additional view ships at risk.

### 5h. The pilot view in detail (proposed first issue)

`medic-client/contacts_by_parent` map:
```js
function(doc) {
  if (doc.type === 'contact' || doc.type === 'clinic' || /* … */) {
    var parentId = doc.parent && doc.parent._id;
    var type = doc.type === 'contact' ? doc.contact_type : doc.type;
    if (parentId) emit([parentId, type]);
  }
}
```

Proposed API on `shared-libs/cht-datasource/src/contact.ts`:
```ts
namespace v1 {
  export const getPageByParent: (ctx: DataContext) =>
    (parentId: string, type?: string, cursor?: Nullable<string>, limit?: number)
      => Promise<Page<Contact>>;
  export const getByParent: (ctx: DataContext) =>
    (parentId: string, type?: string) => AsyncGenerator<Contact>;
}
```

Adapters:
- **Local** (`local/contact.ts`): wraps existing view via `queryDocsByKey(medicDb, 'medic-client/contacts_by_parent', [parentId, type])`. Already a one-liner — most code in `local/libs/doc.ts` exists.
- **Remote** (`remote/contact.ts`): new endpoint `GET /api/v1/contact/by-parent/:parentId?type=X&cursor=…&limit=…` in `api/src/controllers/contact.js`.
- **Postgres** (`postgres/contact.ts`): `SELECT _id, doc FROM v1.couchdb WHERE doc->'parent'->>'_id' = $1 AND COALESCE(doc->>'contact_type', doc->>'type') = $2 ORDER BY name LIMIT $3 OFFSET $4`. Index on `(doc->'parent'->>'_id', COALESCE(doc->>'contact_type', doc->>'type'))` — confirm with agent-3 whether `contact_parent_place` already covers this or if a separate index is wanted.
- **SQLite** (future): same SQL as Postgres against the synced PowerSync table.

Callsites to swap (proof point):
- `webapp/src/ts/services/contacts.service.ts:84-90` (`getSiblings`)
- `webapp/src/ts/services/contact-view-model-generator.service.ts:215`
- `webapp/src/ts/services/wealth-quintiles-watcher.service.ts:38`
- `webapp/src/ts/services/send-message.service.ts:79`
- `webapp/src/ts/services/powersync/powersync-contacts.service.ts:76,104` (already documented as the target)

If this lands cleanly, file the next 6 issues against the same template. If it gets stuck, we learn what's hard before committing to the broader push.

---

## 6. Tracked GitHub issues we cross-referenced

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

## 7. Suggested next steps for this branch / agent-1 follow-on

In rough order (revised v4 to reflect the scope/feasibility analysis in §5e-g):

1. **Decide SQLite-adapter ownership** (per §5c) — agent-1 charter expansion vs new agent-8. This is the *first* decision. Filing pilot issues without an answer here ships work whose value depends on a downstream lift that may not happen. Until this is decided, the PoC validates sync transport, not application portability.
2. **File the pilot issue from §5h** — `Contact.v1.getByParent` end-to-end (Local + Remote + Postgres + caller swaps). Class 1 view per §5e, simplest possible template. Proves the template is sound.
3. **Build the view-parity differential test harness (§5f).** Owned by agent-7. Has to be in place *before* the first Class 2 view ships, otherwise verification is ad-hoc and bugs leak.
4. **File the Class 2 pilot** — `messages_by_contact_date` or `contacts_by_last_visited` (per §5g pacing). Proves the template generalises beyond easy views.
5. **File the Class 4 pilot** — one freetext path through SQLite FTS5 with a tokenization-parity rubric (§5e Class 4). The rubric is the deliverable, not just the test. Surfaces tokenization-divergence risk early.
6. **Coordinate with agent-3 on the postgres column/index contract.** `contact_parent_place`, `accessible_facilities`, and the depth column should be the single source of truth that both Sync Streams and the cht-datasource Postgres adapter read from. Agree on naming + lifecycle before either side merges further. Class 3 views (§5e) likely become wrappers on agent-3's infra.
7. **Run `npm run unit-shared-lib` and `npm run unit-api` from a clean checkout** to confirm the `idHint` plumbing on this branch is green — DONE.md says it is, but worth a fresh check before opening any review.
8. **File the §5d issues 2-7 in batches once pilots 2-3-5 land**, each linking back to this doc. Filing them as a set rather than one-by-one helps stewardship see the scope is finite and bounded by §5b's view inventory.
9. **Defer meta-DB callers (§3c) until the meta-DB collapse design lands.** No point growing cht-datasource for an API surface that's about to disappear; §4a captures the downstream-consumer constraints.
10. **Settle the open architectural question from `DONE.md`** (`v1.couchdb` write target vs native normalised schema) — that decision changes which §5d issues need adapter rewrites if we land on option 2.
11. **Decide on `Form.v1` vs reusing the existing `cht-conf` form layer** — independent of view migration but relevant to §3b.

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
