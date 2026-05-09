---
title: Migrate `db.query(view)` callers to cht-datasource qualifiers — first batch
type: improvement
priority: high
domain: data-sync
labels:
  - cht-datasource
  - migration
  - tracking
---

## Description

The webapp, admin, and several `shared-libs/` modules currently call CouchDB views directly via `db.query('medic-client/<view>', ...)`. Every such call site is a hard coupling to PouchDB / CouchDB: each view must exist on whichever DB is being queried, and PouchDB ships those views to clients in a way that other backends do not.

This umbrella tracks the first batch of view→qualifier migrations: small-blast-radius views where the existing `*.v1.getUuidsPage` / `*.v1.getPage` pagination methods on `Contact.v1` and `Report.v1` only need a new qualifier added to their dispatch — no new top-level API methods.

Each child ticket lands as a single mergeable PR.

The pattern is established in #10973 (`byPhone`). Subsequent tickets follow the same recipe with the qualifier name and view swapped.

## Technical Context

**Components:**
- `shared-libs/cht-datasource/src/qualifier.ts` — new qualifier types per view
- `shared-libs/cht-datasource/src/{contact,report}.ts` — extend `getUuidsPage`'s declarative API
- `shared-libs/cht-datasource/src/local/{contact,report}.ts` — new dispatch arms
- `shared-libs/cht-datasource/src/remote/{contact,report}.ts` — new dispatch arms
- `api/src/controllers/{contact,report}.js` — new HTTP endpoints
- `api/src/routing.js` — wire new routes
- Caller sweeps in `webapp/src/ts/services/`, `admin/src/js/`, `shared-libs/{lineage,validation,transitions,rules-engine}/`

**Existing References:**
- #10973 — pilot ticket, `byPhone` qualifier. Recipe other tickets follow.
- PR [#10083](https://github.com/medic/cht-core/pull/10083) — added create/update qualifiers + Local/Remote dispatch. Canonical pattern reference.
- Issue [#9751](https://github.com/medic/cht-core/issues/9751) — `shared-libs/search` refactor to call cht-datasource freetext APIs. Caller-sweep precedent.
- Issue [#10079](https://github.com/medic/cht-core/issues/10079) — webapp contact-by-id sweep. Caller-sweep precedent.

## Requirements

Each child ticket follows the recipe:

1. Add one qualifier type (or a small qualifier family for a single view) to `shared-libs/cht-datasource/src/qualifier.ts` with `byX(...)` builder, `isXQualifier(...)` type guard, and validation that throws `InvalidArgumentError`.
2. Extend the existing dispatch in `local/{concept}.ts` and `remote/{concept}.ts` with one new arm per added qualifier.
3. Add a Remote endpoint in `api/src/controllers/{concept}.js` for the new qualifier shape.
4. Sweep every caller of the corresponding `db.query('<ddoc>/<view>', ...)` and rewrite it to the new typed call. Caller lists are explicit in each child ticket.
5. Unit tests across qualifier validation, Local adapter dispatch, Remote adapter dispatch, and at least one new caller-side sinon-spy test per modified caller.
6. Pagination tested with `limit: 5` so the cursor path is actually exercised (per the discipline established in PR [#9625](https://github.com/medic/cht-core/pull/9625)).

## Acceptance Criteria

- All eight per-view child tickets merged.
- `npm run unit-shared-lib` and `npm run unit-api` pass on each child PR.
- No `db.query('medic-client/<viewname>', ...)` calls remain for any view whose ticket has merged. Verified by:
  ```
  grep -rnE "\\.query\\(['\"]medic-client/(contacts_by_phone|contacts_by_reference|reports_by_(date|validity|verification|subject|form|place))['\"]" \
    webapp/src admin/src shared-libs
  ```
  zero matches once the batch is complete.

## Constraints

- No new top-level API methods on `Contact.v1` / `Report.v1`. New methods are out of scope for this batch — only qualifier extensions to the existing pagination methods.
- Backwards-compatible: existing `Contact.v1.getUuidsPageByType`, `Report.v1.getUuidsPageByFreetext`, etc. must continue to work unchanged.
- Do not relax `Input.v1.*Input._id?: never`. Any client-supplied IDs go through the existing `idHint` curried-arg pattern in `shared-libs/cht-datasource/src/local/libs/doc.ts`, not via input qualifiers.
- Each child ticket lands as a single mergeable PR scoped to one view (or one qualifier-family for a single view).

## References

- PR #10083 — create/update qualifier + dispatch pattern
- PR #9625 — freetext search pagination discipline
- PR #10127 — webapp contact-by-id caller sweep pattern
- Pilot: #10973

## Subtasks

- [x] `byPhone` — #10973 (`medic-client/contacts_by_phone`)
- [ ] `byShortcode` + `byExternalRef` — `medic-client/contacts_by_reference`
- [ ] `byDateRange` — `medic-client/reports_by_date`
- [ ] `byValidity` — `medic-client/reports_by_validity`
- [ ] `byVerification` — `medic-client/reports_by_verification`
- [ ] `bySubjects` — `medic-client/reports_by_subject`
- [ ] `byForm` — `medic-client/reports_by_form` (page query only)
- [ ] `byPlaces` — `medic-client/reports_by_place`
