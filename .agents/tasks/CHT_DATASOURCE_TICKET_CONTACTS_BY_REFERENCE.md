---
title: Add `byShortcode` and `byExternalRef` qualifiers to `Contact.v1` (replaces `medic-client/contacts_by_reference`)
type: improvement
priority: medium
domain: data-sync
labels:
  - cht-datasource
  - migration
---

## Description

Replace existing `db.query('medic-client/contacts_by_reference', ...)` call sites in cht-core with calls through cht-datasource. The migration adds two qualifiers — `byShortcode(id)` and `byExternalRef(rc)` — to `shared-libs/cht-datasource/src/qualifier.ts` and extends dispatch in Local and Remote adapters.

This view emits two distinct keys: `['shortcode', String(id)]` (covering `place_id` and `patient_id`) and `['external', String(rcCode).toUpperCase()]` (covering `rc_code`). One view, two semantically different lookups → two qualifiers.

The view implementation:

```javascript
function(doc) {
  if (doc.type === 'contact' || doc.type === 'clinic' ||
      doc.type === 'health_center' || doc.type === 'district_hospital' ||
      doc.type === 'national_office' || doc.type === 'person') {
    var emitReference = function(prefix, key) {
      emit([ prefix, String(key) ], doc.reported_date);
    };
    if (doc.place_id)   { emitReference('shortcode', doc.place_id); }
    if (doc.patient_id) { emitReference('shortcode', doc.patient_id); }
    if (doc.rc_code)    { emitReference('external',  String(doc.rc_code).toUpperCase()); }
  }
}
```

Note the `.toUpperCase()` on `rc_code`. The `byExternalRef` qualifier MUST upper-case its input to preserve view parity. `byShortcode` does not case-fold.

Part of the cht-datasource view→qualifier migration series; pattern established in #10973.

## Technical Context

**Components:**
- `shared-libs/cht-datasource/src/qualifier.ts` — add `ShortcodeQualifier`, `ExternalRefQualifier`, builders, type-guards
- `shared-libs/cht-datasource/src/contact.ts` — extend `getUuidsPage`'s declarative API
- `shared-libs/cht-datasource/src/local/contact.ts` — add two dispatch arms
- `shared-libs/cht-datasource/src/remote/contact.ts` — add two dispatch arms
- `api/src/controllers/contact.js` — new routes `GET /api/v1/contact/by-shortcode/:id` and `GET /api/v1/contact/by-external-ref/:ref`
- `api/src/routing.js` — wire the routes

**Existing References:**
- `shared-libs/cht-datasource/src/local/contact.ts` — pattern for the `getUuidsPage` dispatch arms (already has `isFreetextQualifier`, `isContactTypeQualifier` arms)
- PR [#10083](https://github.com/medic/cht-core/pull/10083) — added the create/update qualifiers + Local/Remote dispatch. Same pattern as this ticket.

## Requirements

### Adapter Additions

1. **ShortcodeQualifier and ExternalRefQualifier types:**

```typescript
export type ShortcodeQualifier = Readonly<{ shortcode: string }>;
export const byShortcode = (shortcode: string): ShortcodeQualifier => {
  if (!isString(shortcode) || shortcode.length === 0) {
    throw new InvalidArgumentError(`Invalid shortcode [${JSON.stringify(shortcode)}].`);
  }
  return { shortcode };
};
export const isShortcodeQualifier = (q: unknown): q is ShortcodeQualifier =>
  isRecord(q) && hasField(q, { name: 'shortcode', type: 'string' });

export type ExternalRefQualifier = Readonly<{ externalRef: string }>;
export const byExternalRef = (ref: string): ExternalRefQualifier => {
  if (!isString(ref) || ref.length === 0) {
    throw new InvalidArgumentError(`Invalid external ref [${JSON.stringify(ref)}].`);
  }
  return { externalRef: ref.toUpperCase() };
};
export const isExternalRefQualifier = (q: unknown): q is ExternalRefQualifier =>
  isRecord(q) && hasField(q, { name: 'externalRef', type: 'string' });
```

2. Extend `Contact.v1.getUuidsPage` JSDoc for both qualifier shapes.

3. Add dispatch arms to `local/contact.ts`:
   - `isShortcodeQualifier(qualifier)` → query `medic-client/contacts_by_reference` with `key: ['shortcode', qualifier.shortcode]`
   - `isExternalRefQualifier(qualifier)` → query with `key: ['external', qualifier.externalRef]` (already upper-cased by builder)

4. Add dispatch arms to `remote/contact.ts` calling the two new endpoints.

5. Add API endpoints in `api/src/controllers/contact.js` and wire in `api/src/routing.js`.

6. Expose `byShortcode` and `byExternalRef` from cht-datasource's `index.ts` under `Qualifier`.

### Caller Sweeps

| File:line | Today | Replacement |
|---|---|---|
| `webapp/src/ts/services/get-subject-summaries.service.ts:118` | `keys: uniqueReferences` | iterate `byShortcode(id)` per reference |
| `admin/src/js/services/message-queue.js:132` | `keys: referenceKeys` | split by prefix; `byShortcode` or `byExternalRef` |
| `admin/src/js/services/get-subject-summaries.js:110` | `keys: uniqReferences` | iterate `byShortcode` |
| `shared-libs/lineage/src/hydration.js:220` | `keys` | iterate `byShortcode` |
| `shared-libs/transitions/src/transitions/utils.js:62` | `key: ['shortcode', id]` | `Contact.v1.getUuidsPage(byShortcode(id), ...)` |
| `shared-libs/transitions/src/transitions/update_clinics.js:25` | `params` | inspect prefix; one of the two |
| `shared-libs/rules-engine/src/pouchdb-provider.js:57` | `keys, include_docs: true` | iterate `byShortcode` then `Contact.v1.get` |
| `shared-libs/transitions/src/lib/utils.js:118` | `viewOpts` | inspect prefix |

**Case-folding note:** the `byExternalRef` upper-casing happens in the qualifier builder, not in the adapter, so all backends see the same normalised value. `byShortcode` does not case-fold. Callers iterating mixed `[prefix, key]` arrays must split into separate `byShortcode` / `byExternalRef` calls — do not introduce a union qualifier.

### Tests

- Unit: `test/qualifier.spec.ts` — `byShortcode` and `byExternalRef` valid/invalid inputs; verify `byExternalRef` upper-cases its output
- Unit: `test/local/contact.spec.ts` — both new dispatch arms hit the right view + key
- Unit: `test/remote/contact.spec.ts` — endpoints called with correct path/params
- Caller-side: each modified caller keeps existing tests green; add one new test per caller asserting expected `Contact.v1.*` invocation
- Pagination: include test walking two cursor pages with `limit: 5`

## Acceptance Criteria

- Both qualifiers in `qualifier.ts` with unit tests passing
- Local and Remote adapters dispatch both qualifiers with unit tests passing
- `GET /api/v1/contact/by-shortcode/:id` and `GET /api/v1/contact/by-external-ref/:ref` endpoints return `{ data, cursor }`
- All eight callers swapped; `grep -rnE "query\(['\"]medic-client/contacts_by_reference['\"]" webapp/src admin/src shared-libs` returns zero matches
- `npm run unit-shared-lib` and `npm run unit-api` pass

## Constraints

- Backwards-compatible: existing calls continue unchanged
- No new top-level `Contact.v1` method
- Do not relax `Input.v1.*Input._id?: never`
- `byExternalRef` upper-casing happens in the qualifier builder only; adapters trust the input as-is
- Do not introduce a union qualifier for mixed prefix arrays — split at the call site

## References

- PR #10083 — create/update qualifiers + dispatch pattern
- PR #9625 — freetext search pagination discipline
- PR #10127 — webapp contact-by-id caller sweep pattern
- Pilot: #10973
