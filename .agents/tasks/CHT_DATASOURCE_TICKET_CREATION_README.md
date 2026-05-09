# Tickets — first batch of cht-datasource view migration

These tickets follow the cht-agent ticket format from [`docs/ticket-format.md`](https://github.com/medic/cht-agent/blob/main/docs/ticket-format.md). Each per-view ticket is intended to land as a single mergeable PR against `medic/cht-core`.

The batch implements §5d of [`CHT_DATASOURCE_REMAINING_WORK.md`](../CHT_DATASOURCE_REMAINING_WORK.md) — the **qualifier-extension** pattern Hareet identified on 2026-05-02. Most of these tickets are not new top-level methods; they are new **qualifiers** passed to the existing `*.v1.getUuidsPage` / `*.v1.getPage` pagination methods on `Contact.v1` / `Report.v1`. The dispatch in `local/{concept}.ts` / `remote/{concept}.ts` is already a switch on qualifier type — adding a new arm per view is the recurring shape.

## Status

- **Pilot published:** [#10973](https://github.com/medic/cht-core/issues/10973) (`byPhone` for `medic-client/contacts_by_phone`). The published version is the canonical format reference; subsequent tickets in this directory match it.
- Other per-view tickets are drafts in this directory ready to be filed in cht-core when the team is ready to take them.

## How these tickets were synthesized

**Reference cht-core issues read** (with comments):
- [#9835](https://github.com/medic/cht-core/issues/9835) — closed; added create/update endpoints. Canonical analog for per-concept API extension. PR [#10083](https://github.com/medic/cht-core/pull/10083) is the pattern to copy for qualifier-types-with-validation-helpers + Local/Remote dispatch.
- [#9625](https://github.com/medic/cht-core/pull/9625) — closed; freetext search PR. Showed the pagination-test discipline (low limit so cursors actually exercise).
- [#9701](https://github.com/medic/cht-core/issues/9701) — open bug; remote auth via Fetch API. Pattern for citing file:line + documenting workarounds.
- [#10706](https://github.com/medic/cht-core/issues/10706) — open feature; advanced contact management endpoints. Pattern for tracking-issue subtask checklist + explicit out-of-scope.

**cht-agent format reference:** [tickets/my-ticket.md](https://github.com/medic/cht-agent/blob/main/tickets/my-ticket.md) and [tickets/README.md](https://github.com/medic/cht-agent/blob/main/tickets/README.md).

## Recurring sections in the batch

Every per-view ticket has identical shape; the differences are in the view name, the qualifier shape, and the call-site list:

- **Frontmatter**: `type: improvement`, `priority: medium` (high for the umbrella), `domain: data-sync`, labels `cht-datasource` + `migration`. The `improvement` type fits because every ticket extends an existing public API rather than introducing a new concept.
- **Description**: short paragraph + the view's map function in a code block + one-liner noting the ticket is part of the series whose pattern is established in #10973.
- **Technical Context**: `Components:` (file paths in backticks) + `Existing References:` (canonical pattern PRs and the local-adapter dispatch precedent).
- **Requirements**: `### Adapter Additions` (numbered list with TypeScript qualifier code), `### Caller Sweeps` (table of file:line + today's call + replacement), `### Tests` (bullets).
- **Acceptance Criteria, Constraints**: flat bullet lists.
- **References**: bullet list of PRs only.

Three repeating gotchas are folded into Constraints rather than getting their own section:
1. The `Input.v1.*Input` types use `_id?: never` to forbid client-supplied IDs except via the `idHint` curried-arg pattern in `shared-libs/cht-datasource/src/local/libs/doc.ts`. New qualifiers must not relax this.
2. No new top-level method on `Contact.v1` / `Report.v1` — qualifier extensions only.
3. Backwards compatibility: existing pagination methods continue unchanged.

## Ticket index

### Publishable to cht-core

| File | Subject | View | Qualifier shape | Status |
|---|---|---|---|---|
| [`umbrella-view-migration.md`](./umbrella-view-migration.md) | Tracking issue | (n/a) | (n/a) | draft |
| [`pilot-contacts-by-phone.md`](./pilot-contacts-by-phone.md) | Pilot — full detail; the canonical recipe | `medic-client/contacts_by_phone` | `byPhone(phone)` | **published as #10973** |
| [`contacts-by-reference.md`](./contacts-by-reference.md) | Two qualifiers from one view | `medic-client/contacts_by_reference` | `byShortcode(id)` + `byExternalRef(rc)` | draft |
| [`reports-by-date.md`](./reports-by-date.md) | Range qualifier in Report namespace | `medic-client/reports_by_date` | `byDateRange({from, to, descending?})` | draft |
| [`reports-by-validity.md`](./reports-by-validity.md) | Boolean flag qualifier | `medic-client/reports_by_validity` | `byValidity(boolean)` | draft |
| [`reports-by-verification.md`](./reports-by-verification.md) | Tri-state flag qualifier | `medic-client/reports_by_verification` | `byVerification(boolean \| null)` | draft |
| [`reports-by-subject.md`](./reports-by-subject.md) | Array-of-UUIDs qualifier | `medic-client/reports_by_subject` | `bySubjects([uuid, ...])` | draft |
| [`reports-by-form.md`](./reports-by-form.md) | Form-code qualifier; aggregate variant deferred | `medic-client/reports_by_form` | `byForm(formCode)` | draft |
| [`reports-by-place.md`](./reports-by-place.md) | Array-of-UUIDs for places | `medic-client/reports_by_place` | `byPlaces([uuid, ...])` | draft |

### Internal follow-up (not for upstream)

| File | Purpose |
|---|---|
| [`playtime-parity-stage2.md`](./playtime-parity-stage2.md) | Captures the Postgres adapter dispatch + parity-test work that runs on the `playtime` branch after each upstream ticket merges. Aggregates the SQL specs by view so design intent isn't lost. Lives entirely on `playtime`. |
| [`skill-qualifier-extension.md`](./skill-qualifier-extension.md) | Proposed cht-agent skill that automates the qualifier-extension recipe. Targets `medic/cht-agent`, not `medic/cht-core`. |

## Pattern Hareet identified

> "Most of the complexity, especially for these, is more about replacing references. These ones could maybe benefit from a skill, since they mostly follow the same pattern to replace (add qualifiers to existing datasource endpoints)."

This batch is the *replacing references* work. The skill ticket ([`skill-qualifier-extension.md`](./skill-qualifier-extension.md)) is what makes the batch tractable as a single human-supervisable unit instead of N independent reviews.

## What is NOT in this batch

Per §5e of the parent doc, the following are deliberately deferred:

- `medic-client/contacts_by_place` — hierarchical, overlaps with agent-3 infra. Needs design review first.
- `medic-client/contacts_by_last_visited_date`, `medic-client/visits_by_date` — "visit" semantics aren't well-defined. Modelling decision needed before ticket.
- `medic-client/data_records_by_type`, `medic/docs_by_shortcode` — easy views, but call-site usage is gnarly.
- `medic-client/registered_patients` — likely a deletion candidate, not a migration target.
- `medic/reports_by_form_year_*` — analytics views; belong in dbt/Superset, not cht-datasource.
- All freetext views — already wrapped by cht-datasource; only the SQLite adapter is needed (separate ticket).
