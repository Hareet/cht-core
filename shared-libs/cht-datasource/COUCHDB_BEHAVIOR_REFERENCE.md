# CouchDB Behavior Reference for PostgreSQL Adapter

Documented from live CHT 4.21.0 instance (CouchDB 3.5.0) with test data hierarchy:
- District Hospital → Health Center → Clinic → Person (CHW) + Person (Patient)

## Critical Finding: Parent Field Has Two Formats

The `parent` field in CouchDB documents is stored in **two different formats** depending on how the document was created:

### Format 1: Nested Object (places created via API)
```json
{
  "_id": "clinic-id",
  "type": "clinic",
  "parent": {
    "_id": "health-center-id",
    "parent": {
      "_id": "district-id"
    }
  }
}
```

### Format 2: Plain String (persons created via API)
```json
{
  "_id": "person-id",
  "type": "person",
  "parent": "clinic-id"
}
```

**Impact on PostgreSQL adapter**: The recursive CTE for lineage resolution must handle BOTH formats:
```sql
COALESCE(
  doc->'parent'->>'_id',
  CASE WHEN jsonb_typeof(doc->'parent') = 'string' THEN doc->>'parent' ELSE NULL END
)
```

This was discovered because `docs_by_id_lineage` view only returns depth=0 for persons (whose parent is a string), since the view's map function walks `doc.parent._id` which is `undefined` for string parents. The `@medic/lineage` library handles this by separately resolving string parents.

## View Behavior Reference

### 1. `medic-client/contacts_by_type`

**Emit**: `key=[type]`, `value="dead muted typeIndex lowercase_name"`

```
key=["clinic"]               value="false false 2 kibera clinic a"
key=["district_hospital"]    value="false false 0 nairobi county"
key=["health_center"]        value="false false 1 kibera health center"
key=["person"]               value="false false 3 alice wanjiku"
key=["person"]               value="false false 3 bob odhiambo"
```

**Sort order** (within a type): `dead_status, muted_status, type_index, lowercase_name`
- `dead` = `!!doc.date_of_death` → "false" or "true"
- `muted` = `!!doc.muted` → "false" or "true"
- `type_index` = index in `['district_hospital', 'health_center', 'clinic', 'person']` (or the contact_type string for custom types)

**PostgreSQL equivalent**:
```sql
WHERE COALESCE(doc->>'contact_type', doc->>'type') = $1
ORDER BY
  (doc->>'date_of_death' IS NOT NULL),
  (doc->>'muted' IS NOT NULL),
  LOWER(doc->>'name')
```

**Pagination**: Supports `limit` and `skip` parameters. CouchDB returns results sorted by the emitted value within the key group.

### 2. `medic-client/docs_by_id_lineage`

**Emit**: `key=[doc._id, depth]`, walks parent chain in the stored document.

For a **clinic** (parent is object with nested lineage):
```
key=["clinic-id", 0]   → clinic doc
key=["clinic-id", 1]   → health_center doc (parent)
key=["clinic-id", 2]   → district_hospital doc (grandparent)
```

For a **person** (parent is plain string):
```
key=["person-id", 0]   → person doc ONLY (no lineage emitted!)
```

**Impact**: The PostgreSQL CTE handles both parent formats and always walks the full chain. This actually produces BETTER lineage than the CouchDB view for string-parent documents.

### 3. `medic-client/contacts_by_reference`

**Emit**: `key=["shortcode", shortcode_value]`, `value=reported_date`

```
key=["shortcode", "13602"]  → person (patient_id match)
key=["shortcode", "99739"]  → clinic (place_id match)
```

Resolves `patient_id`, `place_id`, and `rc_code` (uppercase) shortcodes.

**PostgreSQL equivalent**:
```sql
WHERE (doc->>'patient_id' = $1
       OR doc->>'place_id' = $1
       OR UPPER(doc->>'rc_code') = UPPER($1))
```

### 4. `_all_docs` with ID range (form lookup)

Used to discover supported forms: `startkey="form:"`, `endkey="form:\ufff0"`.

Returns 19 form documents in the default config:
```
form:contact:clinic:create
form:contact:clinic:edit
form:contact:district_hospital:create
...
form:pregnancy
form:delivery
```

**PostgreSQL equivalent**: `WHERE _id >= 'form:' AND _id <= 'form:\ufff0'`

### 5. `_all_docs` with keys (bulk fetch)

Used by `getDocsByIds`. Returns docs in the order of requested keys. Missing docs return `{"key": "...", "error": "not_found"}`.

**PostgreSQL equivalent**: Query with `WHERE _id = ANY($1)`, then reorder results to match input key order (implemented in `getDocsByIds`).

### 6. `_all_docs` with ID range (target lookup)

Target IDs follow pattern: `target~{YYYY-MM}~{contactId}~org.couchdb.user:{username}`

Range scan: `startkey="target~2025-01~"`, `endkey="target~2025-01~\ufff0"`

**PostgreSQL equivalent**: `WHERE _id >= $1 AND _id <= $2`

## Document Shape Reference

### Person (API-created, after Sentinel processing)
```json
{
  "_id": "3ec4f112db4527a356e1aa8593002fbc",
  "_rev": "2-19f9449bac298ce7f7bfd6a6ad0a92cf",
  "name": "Alice Wanjiku",
  "type": "person",
  "parent": "3ec4f112db4527a356e1aa8593002eb1",
  "phone": "+254712345678",
  "sex": "female",
  "date_of_birth": "1990-05-15",
  "reported_date": 1775505110160,
  "patient_id": "13602"
}
```
Note: `_rev` is `2-*` (Sentinel already modified it). `parent` is a plain string. `patient_id` auto-generated.

### Place — Clinic (API-created, after Sentinel processing)
```json
{
  "_id": "3ec4f112db4527a356e1aa8593002eb1",
  "_rev": "2-9a4be5a48a8ec32d51f52c90f6736f9b",
  "name": "Kibera Clinic A",
  "type": "clinic",
  "parent": {
    "_id": "3ec4f112db4527a356e1aa8593001f1e",
    "parent": {
      "_id": "3ec4f112db4527a356e1aa8593001299"
    }
  },
  "reported_date": 1775505110063,
  "place_id": "99739"
}
```
Note: `parent` is a nested object containing the full minified lineage. `place_id` auto-generated.

### Place — District Hospital (top-level, no parent)
```json
{
  "_id": "3ec4f112db4527a356e1aa8593001299",
  "_rev": "2-2f5b3c2812c2b4bfa8cf46f351087d7e",
  "name": "Nairobi County",
  "type": "district_hospital",
  "reported_date": 1775504660037,
  "place_id": "53235"
}
```

## Auto-Generated Fields (by Sentinel)

| Field | Applied To | Example |
|-------|-----------|---------|
| `patient_id` | Persons | `"13602"` (numeric string shortcode) |
| `place_id` | Places (all levels) | `"99739"` |
| `reported_date` | All contacts | Unix ms timestamp |
| `_rev` increment | All docs | `1-xxx` → `2-xxx` after Sentinel processes |

## Test Data IDs

```
DISTRICT_ID=3ec4f112db4527a356e1aa8593001299  (Nairobi County)
HC_ID=3ec4f112db4527a356e1aa8593001f1e        (Kibera Health Center)
CLINIC_ID=3ec4f112db4527a356e1aa8593002eb1     (Kibera Clinic A)
PERSON_ID=3ec4f112db4527a356e1aa8593002fbc     (Alice Wanjiku, patient_id=13602)
PATIENT_ID=3ec4f112db4527a356e1aa8593002fc0    (Bob Odhiambo)
```
