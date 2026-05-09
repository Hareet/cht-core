---
title: cht-agent skill — automate the qualifier-extension recipe for view migrations
type: feature
priority: high
domain: data-sync
labels:
  - cht-agent
  - cht-datasource
  - automation
---

## Description

Add a cht-agent skill called `add-cht-datasource-qualifier` (or similar)
that takes a view name + concept (Contact / Report) + qualifier shape
and applies the recipe from
[`pilot-contacts-by-phone.md`](./pilot-contacts-by-phone.md):

**Stage 1 (cht-core PR against `main`) — what the skill generates:**

1. Read the view's map function from `ddocs/medic-db/<ddoc>/views/<view>/map.js`
2. Add the new qualifier type, builder, and guard to
   `shared-libs/cht-datasource/src/qualifier.ts`
3. Extend the dispatch in **`local/{concept}.ts`** and
   **`remote/{concept}.ts`** with one new arm each (these are the
   only two adapters that exist on `main`)
4. Add the Remote endpoint to `api/src/controllers/{concept}.js` and
   wire it in `api/src/routing.js`
5. Find every `db.query('<ddoc>/<view>', ...)` call site (in
   `webapp/src`, `admin/src`, `shared-libs/`) and produce a swap plan
   the human reviews before the skill commits the rewrites
6. Emit the Postgres SQL and index migration into the ticket's
   "Stage 2" body as design record — do NOT generate code for them
   in the cht-core PR

**Stage 2 (post-merge into `playtime`) — separate skill invocation:**

After the Stage 1 PR is in `playtime`, the skill (or a `--stage=2`
mode of the same skill) runs again to:

7. Extend the dispatch in `postgres/{concept}.ts` using the SQL spec
   from the ticket
8. Generate the Postgres index migration
9. Generate the parity-test fixture against the
   `tests/integration/postgresql/` harness
10. Run the parity test and post the result as a comment on the
    original ticket

The split exists because the `postgres/` adapter directory does not
exist on `main`; it was introduced as part of the playtime PoC. Stage 1
must therefore be runnable against a `main`-only checkout without any
playtime artefacts.

The skill is the unit that makes this batch tractable as a single
human-supervisable workstream rather than 8 independent reviews.
Hareet on 2026-05-02:

> "These ones could maybe benefit from a skill, since they mostly follow
> the same pattern to replace (add qualifiers to existing datasource
> endpoints)."

## Technical Context

**Components:**
- New skill in cht-agent's `src/skills/` (or wherever the existing
  skills live — confirm against current cht-agent layout)
- Reads from cht-core checkout: `shared-libs/cht-datasource/src/`,
  `ddocs/medic-db/`, `webapp/src/`, `admin/src/`, `shared-libs/`
- Writes to: same paths
- Test fixtures: `tests/integration/cht-datasource/`

**Existing References:**
- cht-agent's existing skills (`init`, `simplify`) — same shape, the new
  one follows the established skill conventions
- [`pilot-contacts-by-phone.md`](./pilot-contacts-by-phone.md) — the
  recipe being automated; the skill's prompt should bake this in as
  the canonical reference

## Requirements

- Skill takes the following arguments:
  - `concept`: `Contact` | `Report` | `Place` | `Person`
  - `view`: full ddoc/view path, e.g. `medic-client/contacts_by_phone`
  - `qualifier`: name in camelCase, e.g. `byPhone`
  - `qualifierShape`: TypeScript type for the qualifier's payload
    (e.g. `{ phone: string }`, `{ from: number; to: number; descending?: boolean }`)
  - `sqlPredicate`: the postgres `WHERE` predicate template (with
    `$1`, `$2` placeholders matching the qualifier fields)
  - `indexSql`: the postgres index migration SQL
- Outputs a single PR-ready commit (or a stack of commits, one per
  modified file).
- The skill MUST stop and prompt before committing the call-site
  rewrites — the human reviews each rewrite (file:line + before/after
  snippet) and approves or rejects per call site.
- For Stage 1: the skill MUST run `npm run unit-shared-lib` and
  `npm run unit-api` after the changes and report results before
  commit. Postgres-related test commands are skipped in Stage 1
  because the postgres adapter is not present on `main`.
- For Stage 2 (playtime): the skill MUST additionally run the
  postgres-side adapter unit tests and the integration parity test.
- The skill MUST NOT modify any of the files listed in
  [`CHT_DATASOURCE_REMAINING_WORK.md`](../CHT_DATASOURCE_REMAINING_WORK.md)
  §3c (sync-layer services, meta-DB writers, client migrations,
  bootstrap glue).

## Acceptance Criteria

### Stage 1 mode (cht-core PR against `main`)

- The skill produces a clean PR for the
  [`pilot-contacts-by-phone.md`](./pilot-contacts-by-phone.md) ticket
  end-to-end: qualifier + Local + Remote adapters + Remote endpoint +
  all six caller swaps, with `npm run unit-shared-lib` and
  `npm run unit-api` green.
- The skill does NOT touch
  `shared-libs/cht-datasource/src/postgres/` in Stage 1 mode (because
  on `main` that directory does not exist; the skill's `main`-checkout
  precondition includes verifying its absence).
- The skill is used to land at least one of the other tickets in the
  batch through Stage 1 (any of `contacts-by-reference`,
  `reports-by-date`, `reports-by-validity`, `reports-by-verification`,
  `reports-by-subject`, `reports-by-form`, `reports-by-place`).
- The skill's prompt and reference docs are checked into cht-agent and
  reference the umbrella ticket
  [`umbrella-view-migration.md`](./umbrella-view-migration.md).
- A "skill output" example PR description is generated showing the
  before/after diff summary and any caller swaps that needed human
  override.

### Stage 2 mode (playtime parity)

- The skill produces a follow-on commit on `playtime` that adds the
  Postgres adapter dispatch arm and index migration.
- Integration parity test passes against the CIV fixture; the result
  is posted as a comment on the original ticket.

## Constraints

- The skill is **scoped to the qualifier-extension pattern only**. It
  does not handle:
  - New top-level methods on `*.v1` (out of scope)
  - SQLite adapter additions (out of scope per
    [`CHT_DATASOURCE_REMAINING_WORK.md`](../CHT_DATASOURCE_REMAINING_WORK.md) §5c)
  - Aggregate/reduce variants of views (e.g. `reports_by_form` with
    `group: true`) — see [`reports-by-form.md`](./reports-by-form.md) Constraints
  - Hierarchy-walking views without the agent-3 closure column —
    see [`reports-by-place.md`](./reports-by-place.md)
- The skill MUST refuse to run on views from `medic-scripts/`,
  `medic-admin/`, `users/`, `users-meta/`, `medic-offline-tasks/`,
  `medic-offline-freetext/`, `_users/`, `builds/` — these are out of
  scope per
  [`CHT_DATASOURCE_REMAINING_WORK.md`](../CHT_DATASOURCE_REMAINING_WORK.md)
  §5b Group C and Group D.

## Gotchas

- **Don't auto-commit caller swaps.** The skill's value is in the boilerplate;
  the call sites have semantic context the skill can't reliably detect
  (e.g. `query` callers that bake in `include_docs: true` for
  immediate hydration vs. callers that just want IDs). Human-in-the-loop.
- **Match the `Input.v1.*Input._id?: never` constraint** — the skill must
  not generate qualifier-types with relaxed `_id` semantics. Reject any
  `qualifierShape` that includes `_id`.
- **The Remote-adapter HTTP route shape varies** by qualifier (path
  param vs. query string vs. POST body). The skill should pick a
  default (GET with single path param if the qualifier has one
  string field; GET with query string if 2-3 simple fields; POST body
  if array-shaped). Document the choice in the generated controller's
  JSDoc.

## References

**Similar Implementations:**
- cht-agent's `init` skill — same shape (read inputs, generate code, prompt)
- cht-agent's `simplify` skill — same shape (multi-file diff, human-in-the-loop)
- [`pilot-contacts-by-phone.md`](./pilot-contacts-by-phone.md) — the recipe being automated

**Documentation:**
- https://github.com/medic/cht-agent/blob/main/docs/ticket-format.md
- [`umbrella-view-migration.md`](./umbrella-view-migration.md)
- [`CHT_DATASOURCE_REMAINING_WORK.md`](../CHT_DATASOURCE_REMAINING_WORK.md) §5d, §5h
