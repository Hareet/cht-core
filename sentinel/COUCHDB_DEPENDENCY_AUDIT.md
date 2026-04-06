# Sentinel CouchDB Dependency Audit — Deep Dive

**Date**: 2026-04-06
**Scope**: `sentinel/src/` + `shared-libs/transitions/`, `shared-libs/infodoc/`, `shared-libs/lineage/`
**Purpose**: Exhaustive mapping of every CouchDB dependency to inform the PostgreSQL migration
**Cross-referenced with**: cht-core-wiki (OpenDeepWiki), cht-sync-wiki, CHT Docs (Kapa AI), source code

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Database Module — The Single Chokepoint](#2-database-module)
3. [Changes Feed — The Critical Path](#3-changes-feed)
4. [CouchDB Views — Complete SQL Mapping](#4-couchdb-views)
5. [Sentinel Database Operations](#5-sentinel-database-operations)
6. [Infodoc System — Transition State Tracking](#6-infodoc-system)
7. [Lineage — Document Hydration](#7-lineage-hydration)
8. [Shared-libs/transitions — Engine Internals](#8-transitions-engine)
9. [Purging System — Highest Complexity](#9-purging-system)
10. [Replications — User Meta Databases](#10-replications)
11. [Scheduled Tasks — Reminders & Outbound](#11-scheduled-tasks)
12. [cht-datasource — Existing Abstraction Layer](#12-cht-datasource)
13. [cht-sync PostgreSQL Schema — Migration Target](#13-cht-sync-schema)
14. [CouchDB-Specific Patterns & PostgreSQL Equivalents](#14-patterns)
15. [Complete Migration Matrix](#15-migration-matrix)
16. [Recommended Architecture](#16-recommended-architecture)

---

## 1. Executive Summary

Sentinel is the server-side document transition/workflow engine for CHT. It watches CouchDB's changes feed, processes documents through 18 configurable transitions, manages purging, reminders, outbound pushes, and background cleanup.

**Key findings from deep analysis:**

- **~80 distinct CouchDB API call sites** across sentinel/src/ and shared-libs/ (transitions, infodoc, lineage)
- **13 CouchDB views + 1 Nouveau index** referenced (6 from sentinel directly, 7 more from shared-libs)
- **4 separate changes feed consumers** (transition processing, config reload, background cleanup, replications)
- **`db.js` is the single chokepoint** — all access flows through it. A feature-flagged swap is architecturally sound.
- **The `cht-datasource` adapter** already exists but covers only ~15% of Sentinel's data needs (contacts/persons/places/reports/targets CRUD). The remaining 85% is views, changes feeds, infodocs, purge DBs, and sentinel-specific operations.
- **cht-sync already provides the PostgreSQL schema** (`v1.couchdb` table with JSONB docs) that can serve as the read source for a PostgreSQL-backed Sentinel.

**Effort estimate by component:**

| Component | Call Sites | Effort | Weeks |
|-----------|-----------|--------|-------|
| metadata.js | 4 | LOW | 0.5 |
| config.js | 4 | LOW | 0.5 |
| feed.js (changes feed) | 3 | HIGH | 3-4 |
| infodoc system | 12 | MEDIUM | 2 |
| lineage hydration | 6 | MEDIUM | 2 |
| outbound.js | 8 | MEDIUM | 1.5 |
| reminders.js | 10 | MEDIUM | 2 |
| background-cleanup.js | 8 | MEDIUM | 1.5 |
| purging.js | 15+ | HIGH | 4-6 |
| replications.js | 10 | HIGH | 3 |
| transitions library (18 modules) | ~25 | HIGH | 4-6 (Agent 1 scope) |

---

## 2. Database Module

**File**: `sentinel/src/db.js` (104 lines)

The central abstraction layer. ALL CouchDB access flows through this module.

### PouchDB Instances

| Export | CouchDB Target | PouchDB Plugins |
|--------|---------------|-----------------|
| `db.medic` | `{couchUrl}` (main medic DB) | pouchdb-core, pouchdb-adapter-http, pouchdb-mapreduce, pouchdb-replication |
| `db.sentinel` | `{couchUrl}-sentinel` | Same |
| `db.users` | `{serverUrl}/_users` | Same |

### Utility Functions

| Export | CouchDB API | Migration Path |
|--------|-------------|---------------|
| `db.allDbs()` | `GET /_all_dbs` | `SELECT datname FROM pg_database` or app-level table of user DBs |
| `db.get(name)` | `new PouchDB(name)` | Table partition or schema per logical DB |
| `db.close(db)` | `PouchDB.close()` | Connection pool return |
| `db.queryMedic(view, params, body)` | `GET/POST _design/{ddoc}/_view/{view}` | SQL query (see Section 4) |

### Audit Headers
Sentinel adds `X-Medic-Service: sentinel` and `X-Medic-User: sentinel` headers to all CouchDB requests via a custom `fetchFn`. In PostgreSQL, this maps to `SET app.current_user = 'sentinel'` for audit logging via `current_setting()`.

### PouchDB API Surface — Complete Inventory

| Method | db.medic | db.sentinel | db.users | Other DBs | Total |
|--------|----------|-------------|----------|-----------|-------|
| `.get()` | 2 | 5 | 0 | 2 | 9 |
| `.put()` | 0 | 5 | 0 | 2 | 7 |
| `.post()` | 0 | 0 | 0 | 0 | 0 |
| `.allDocs()` | 4 | 4 | 1 | 3 | 12 |
| `.bulkDocs()` | 2 | 2 | 0 | 2 | 6 |
| `.query()` | 2 | 0 | 0 | 0 | 2 |
| `.changes()` | 3 | 0 | 0 | 2 | 5 |
| `.info()` | 0 | 0 | 0 | 2 | 2 |
| `.replicate.to()` | 0 | 0 | 0 | 1 | 1 |
| `queryMedic()` | 3 | — | — | — | 3 |
| `couch-request` | 3 | — | — | — | 3 |
| **Total** | **19** | **16** | **1** | **14** | **50** |

*Note: shared-libs add ~30 more call sites (see sections 6-8)*

---

## 3. Changes Feed — The Critical Path

### 3.1 Primary Feed: Transition Processing

**File**: `sentinel/src/lib/feed.js`
**Source confirmed by**: cht-core-wiki "Changes Feed Processing" (752 lines), Kapa AI docs

```
db.medic.changes({ live: true, since: seq })
```

**Architecture** (from wiki):
```
CouchDB medic DB
  → Live Changes Feed (since: last_seq)
    → Change Filters (ddocs, tombstones, retry-exceeded)
      → Async Queue (concurrency: 1, max: 100)
        → processChange() [fetch + hydrate doc, get infodoc]
          → applyTransitions() [18 transitions in order]
            → saveDoc() [db.medic.put]
            → saveTransitions() [db.sentinel infodoc]
              → updateMetadata(seq) [db.sentinel checkpoint]
```

**Key parameters:**
- `RETRY_TIMEOUT`: 60,000ms (reconnect delay on error)
- `MAX_QUEUE_SIZE`: 100 (backpressure threshold)
- `PROGRESS_REPORT_INTERVAL`: 500 items
- `MAX_RETRIES`: 5 per change (keyed by `{id}{rev}`)

**PostgreSQL equivalent**: LISTEN/NOTIFY on the `v1.couchdb` table with a trigger on INSERT/UPDATE. The `saved_timestamp` column provides the sequence analog. A polling fallback with `WHERE saved_timestamp > $last_seen ORDER BY saved_timestamp LIMIT 100` provides identical semantics.

### 3.2 Config Reload Feed

**File**: `sentinel/src/config.js:40-54`

```
db.medic.changes({ live: true, since: 'now' })
  .on('change', change => {
    if (change.id === 'settings') { reloadConfig(); }
    if (change.id.startsWith('messages-')) { reloadTranslations(); }
  })
```

**PostgreSQL equivalent**: `LISTEN config_changes` + trigger that fires NOTIFY on settings/translation doc updates.

### 3.3 Background Cleanup Feed

**File**: `sentinel/src/schedule/background-cleanup.js`

```
db.medic.changes({ since: seq, limit: BATCH })  // BATCH = 1000
```

Non-live, batch-mode. Processes deletions to clean up `-info` docs and `read:` docs.

**PostgreSQL equivalent**: Poll `saved_timestamp > $last_seq` with `WHERE _deleted = true`.

### 3.4 Replications Feed

**File**: `sentinel/src/schedule/replications.js`

```
sourceDb.changes(opts)           // User-meta DBs, batch mode
targetDb.changes({ doc_ids: ids }) // Filtered by specific IDs
```

**PostgreSQL equivalent**: These collapse entirely — user-meta data becomes a single table with `user_id` column. No replication needed.

---

## 4. CouchDB Views — Complete SQL Mapping

### 4.1 Views Used Directly by sentinel/src/

| # | View | File | SQL Equivalent |
|---|------|------|---------------|
| 1 | `medic-client/doc_by_type` | config.js | `SELECT doc FROM couchdb WHERE doc->>'type' = $1` |
| 2 | `medic/reports_by_form_and_parent` | reminders.js | See 4.2 below |
| 3 | `medic-client/contacts_by_type` | purging.js, reminders.js | See 4.3 below |
| 4 | `medic/tasks_in_terminal_state` | purging.js | See 4.4 below |
| 5 | `allDocs` (key range `target~`) | purging.js | `SELECT * FROM couchdb WHERE _id LIKE 'target~%' AND _id < $end` |
| 6 | `_nouveau/docs_by_replication_key` | purging.js | See 4.5 below |

### 4.2 `medic/reports_by_form_and_parent` → SQL

**CouchDB map**: Emits `[form, parent._id]` with `reported_date` as value. Reduce: `_stats`.

```sql
-- Equivalent of query({ keys: [[form, place_id]], group: true })
SELECT
  doc->>'form' AS form,
  doc->'contact'->'parent'->>'_id' AS parent_id,
  COUNT(*) AS count,
  MIN((doc->>'reported_date')::bigint) AS min,
  MAX((doc->>'reported_date')::bigint) AS max,
  SUM((doc->>'reported_date')::bigint) AS sum
FROM v1.couchdb
WHERE doc->>'type' = 'data_record'
  AND doc->>'form' IS NOT NULL
  AND doc->'contact'->'parent'->>'_id' IS NOT NULL
  AND (doc->>'form', doc->'contact'->'parent'->>'_id') IN (($1,$2), ($3,$4))
GROUP BY doc->>'form', doc->'contact'->'parent'->>'_id';

-- Index needed:
CREATE INDEX idx_reports_form_parent ON v1.couchdb
  ((doc->>'form'), (doc->'contact'->'parent'->>'_id'))
  WHERE doc->>'type' = 'data_record';
```

### 4.3 `medic-client/contacts_by_type` → SQL

**CouchDB map**: Emits `[type]` with sort key `dead + ' ' + muted + ' ' + idx + ' ' + name`.

```sql
-- Equivalent of batch iteration with startkey_docid
SELECT
  _id,
  doc,
  COALESCE(doc->>'contact_type', doc->>'type') AS contact_type
FROM v1.couchdb
WHERE COALESCE(doc->>'contact_type', doc->>'type') = ANY($types)
  AND (_id > $startkey_docid OR $startkey_docid IS NULL)
ORDER BY
  (doc->>'date_of_death' IS NOT NULL)::text,
  (doc->>'muted' IS NOT NULL)::text,
  LOWER(doc->>'name')
LIMIT $batch_size;

-- Index needed:
CREATE INDEX idx_contacts_by_type ON v1.couchdb
  (COALESCE((doc->>'contact_type'), (doc->>'type')))
  WHERE doc->>'type' IN ('contact','person','clinic','health_center','district_hospital');
```

### 4.4 `medic/tasks_in_terminal_state` → SQL

**CouchDB map**: Emits `emission.endDate` for tasks in Cancelled/Completed/Failed state.

```sql
SELECT _id, doc->'emission'->>'endDate' AS end_date
FROM v1.couchdb
WHERE doc->>'type' = 'task'
  AND doc->>'state' IN ('Cancelled', 'Completed', 'Failed')
  AND doc->'emission'->>'endDate' IS NOT NULL
  AND doc->'emission'->>'endDate' <= $max_date
ORDER BY doc->'emission'->>'endDate';

-- Index needed:
CREATE INDEX idx_tasks_terminal ON v1.couchdb
  ((doc->'emission'->>'endDate'))
  WHERE doc->>'type' = 'task'
  AND doc->>'state' IN ('Cancelled', 'Completed', 'Failed');
```

### 4.5 `_nouveau/docs_by_replication_key` → SQL

**CouchDB Nouveau**: Full-text Lucene index. Complex logic indexing by `key`, `type`, `subject`, `submitter`, `needs_signoff`, `private`.

```sql
-- Equivalent of: q = 'key:(id1 OR id2 OR ...) AND type:data_record'
SELECT _id,
  doc->>'type' AS type,
  COALESCE(
    doc->>'patient_id',
    doc->'fields'->>'patient_id',
    doc->>'place_id',
    doc->'fields'->>'place_id',
    doc->'fields'->>'patient_uuid',
    doc->'contact'->>'_id'
  ) AS subject,
  (doc->'fields'->>'needs_signoff')::boolean AS needs_signoff
FROM v1.couchdb
WHERE doc->>'type' = 'data_record'
  AND (
    COALESCE(doc->>'patient_id', doc->'fields'->>'patient_id',
             doc->>'place_id', doc->'fields'->>'place_id',
             doc->'fields'->>'patient_uuid',
             doc->'contact'->>'_id', '_unassigned')
  ) = ANY($subject_ids);

-- Index needed (GIN for array containment, or B-tree composite):
CREATE INDEX idx_docs_by_replication_key ON v1.couchdb
  (COALESCE(
    (doc->>'patient_id'), (doc->'fields'->>'patient_id'),
    (doc->>'place_id'), (doc->'fields'->>'place_id'),
    (doc->'fields'->>'patient_uuid'),
    (doc->'contact'->>'_id'), '_unassigned'
  ))
  WHERE doc->>'type' = 'data_record';
```

*Note: This Nouveau index was migrated FROM a CouchDB view for performance (2-3x speedup per GitHub issue #10262). The SQL version should be faster still with proper indexing.*

### 4.6 Views Used by shared-libs/transitions/ (Agent 1 Scope, Documented Here for Completeness)

| # | View | Transition | Purpose |
|---|------|-----------|---------|
| 7 | `medic-client/contacts_by_phone` | update_clinics, self_report, registration | Find contact by phone number |
| 8 | `medic-client/contacts_by_reference` | lineage, transitions/utils | Resolve shortcodes to contacts |
| 9 | `medic/contacts_by_depth` | muting_utils | Find all descendants of a contact |
| 10 | `medic-client/reports_by_date` | lib/utils | Recent reports by date range |
| 11 | `medic-client/registered_patients` | lib/utils | Find registrations by patient/place ID |
| 12 | `medic-client/reports_by_subject` | lib/utils | Find reports by subject ID |
| 13 | `medic/docs_by_shortcode` | lib/ids | Check shortcode uniqueness |
| 14 | `medic/messages_by_state` | schedule/due_tasks | Find scheduled messages due for sending |

---

## 5. Sentinel Database Operations

The `medic-sentinel` CouchDB database stores operational metadata. In PostgreSQL, this becomes a dedicated table (or set of tables).

### Document Types in Sentinel DB

| Pattern | Example `_id` | Purpose | PostgreSQL Table |
|---------|--------------|---------|-----------------|
| Transition seq | `_local/sentinel-meta-data` | Changes feed checkpoint | `sentinel_metadata` |
| Background seq | `_local/background-cleanup-seq` | Cleanup checkpoint | `sentinel_metadata` |
| Info docs | `{docId}-info` | Per-document transition state | `sentinel_infodocs` |
| Outbound tasks | `task:outbound:{docId}` | Queued outbound pushes | `sentinel_outbound_tasks` |
| Reminder logs | `reminderlog:{form}:{timestamp}` | Tracks when reminders sent | `sentinel_reminder_logs` |
| Purge logs | `purgelog:{timestamp}` | Purge run completion | `sentinel_purge_logs` |
| Purge DB info | `_local/purge-db-info` | Role info per purge DB | `sentinel_purge_roles` |

### Proposed PostgreSQL Schema

```sql
CREATE TABLE sentinel_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sentinel_infodocs (
  doc_id TEXT PRIMARY KEY,
  transitions JSONB DEFAULT '{}',
  initial_replication_date TIMESTAMPTZ,
  latest_replication_date TIMESTAMPTZ,
  completed_tasks JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sentinel_outbound_tasks (
  id TEXT PRIMARY KEY,  -- task:outbound:{doc_id}
  doc_id TEXT NOT NULL,
  queue JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sentinel_reminder_logs (
  id TEXT PRIMARY KEY,
  form TEXT NOT NULL,
  scheduled_date TIMESTAMPTZ,
  duration REAL,
  reminder JSONB,
  reported_date TIMESTAMPTZ
);

CREATE TABLE sentinel_purge_logs (
  id TEXT PRIMARY KEY,
  date TIMESTAMPTZ,
  roles JSONB,
  duration REAL,
  skipped_contacts TEXT[],
  error TEXT
);
```

---

## 6. Infodoc System — Transition State Tracking

**Source**: `shared-libs/infodoc/src/infodoc.js`
**Confirmed by**: Kapa AI docs, cht-core-wiki

### What Infodocs Store

```json
{
  "_id": "f8cc78d0-info",
  "type": "info",
  "doc_id": "f8cc78d0",
  "initial_replication_date": "2018-08-13T22:02:46.699Z",
  "latest_replication_date": "2018-08-14T10:02:13.625Z",
  "transitions": {
    "registration": { "ok": true, "last_rev": 2, "seq": "123", "run_date": "..." },
    "default_responses": { "ok": true, "last_rev": 2, "seq": "124", "run_date": "..." }
  }
}
```

### CouchDB Operations

| Operation | API | Purpose |
|-----------|-----|---------|
| `resolveInfoDocs` | `db.sentinel.allDocs` + `db.medic.allDocs` | Find infodocs in sentinel (or legacy medic) |
| `saveTransitions` | `db.sentinel.get` + `db.sentinel.put` | Save transition results (retry on 409) |
| `saveProperty` | `db.sentinel.get` + `db.sentinel.put` | Generic property update (retry on 409) |
| `bulkGet` | `db.sentinel.allDocs` | Fetch multiple infodocs |
| `bulkUpdate` | `db.sentinel.bulkDocs` | Write multiple infodocs (intelligent merge on 409) |
| `saveCompletedTasks` | `db.sentinel.get` + `db.sentinel.put` | Mark outbound tasks complete |
| `recordDocumentWrite` | `db.sentinel.get` + `db.sentinel.put` | Update replication dates (API-initiated) |
| `recordDocumentWrites` | `db.sentinel.bulkDocs` | Bulk update replication dates |

### Conflict Resolution Strategy (Critical for PostgreSQL)

The infodoc library implements a **3-layer conflict resolution** strategy for CouchDB 409 conflicts:
1. **Single writes**: Retry loop — re-fetch, re-apply property, re-save
2. **Bulk writes**: Collect 409 errors, re-fetch those IDs, intelligent merge, retry
3. **Intelligent merge**: Preserve API-written fields (`initial_replication_date`, `latest_replication_date`, `completed_tasks`) from the fresh version, keep caller's `transitions`

**PostgreSQL equivalent**: Use `INSERT ... ON CONFLICT (doc_id) DO UPDATE SET transitions = excluded.transitions, updated_at = NOW()` with advisory locks for concurrent writes. The "intelligent merge" becomes a `jsonb_concat` in the ON CONFLICT clause.

---

## 7. Lineage — Document Hydration

**Source**: `shared-libs/lineage/src/`
**Confirmed by**: cht-core-wiki "Transitions Library"

### What Lineage Does

Transforms minified CouchDB documents (which store only `{ _id: "parent-uuid" }` stubs) into fully hydrated documents with complete parent chains.

### Multi-Round Hydration Process

1. **fetchHydratedDoc(id)**: Fetch doc + resolve shortcodes via `contacts_by_reference` view + fetch full parent chain via `docs_by_id_lineage` view
2. **hydrateDocs(docs)**: Batch version — collects all referenced IDs, fetches in bulk via `allDocs`, reconstructs parent chains in memory

### CouchDB Operations

| Operation | API | Purpose |
|-----------|-----|---------|
| `DB.get(id)` | PouchDB get | Fetch single document |
| `DB.allDocs({ keys, include_docs })` | PouchDB allDocs | Bulk fetch documents by ID array |
| `DB.query('medic-client/contacts_by_reference')` | PouchDB query | Resolve shortcodes to UUIDs |
| `DB.query('medic-client/docs_by_id_lineage')` | PouchDB query | Fetch doc + ancestors |

### PostgreSQL Equivalent

```sql
-- Hydrate a document with its full parent chain
WITH RECURSIVE lineage AS (
  SELECT doc, _id, doc->'parent'->>'_id' AS parent_id, 0 AS depth
  FROM v1.couchdb WHERE _id = $doc_id
  UNION ALL
  SELECT c.doc, c._id, c.doc->'parent'->>'_id', l.depth + 1
  FROM v1.couchdb c JOIN lineage l ON c._id = l.parent_id
  WHERE l.parent_id IS NOT NULL
)
SELECT * FROM lineage ORDER BY depth;
```

*This recursive CTE replaces both the `docs_by_id_lineage` view query and the multi-round allDocs fetching.*

---

## 8. Transitions Engine — Internals

**Source**: `shared-libs/transitions/src/transitions/index.js`
**Confirmed by**: cht-core-wiki "Transitions Library" (728 lines)

### Initialization

```javascript
// sentinel/src/config.js:80
transitionsLib = require('@medic/transitions')(db, module.exports, require('./data-context'));
```

The transitions library receives the `db` object from Sentinel. Inside, `db.init(sourceDb)` copies these references. This means **swapping `db.js` exports affects all transitions automatically**.

### 18 Available Transitions (Execution Order)

| # | Transition | DB Operations | Key Dependency |
|---|-----------|---------------|----------------|
| 1 | `update_clinics` | query contacts_by_reference, contacts_by_phone | Lineage |
| 2 | `self_report` | query contacts_by_phone | — |
| 3 | `registration` | query contacts_by_phone, post (create patient/place) | IDs, lineage |
| 4 | `accept_patient_reports` | put (update registration) | Utils queries |
| 5 | `accept_case_reports` | — (delegates to utils) | Utils queries |
| 6 | `generate_shortcode_on_contacts` | query docs_by_shortcode | IDs |
| 7 | `generate_patient_id_on_people` | query docs_by_shortcode | IDs |
| 8 | `default_responses` | — (message generation only) | — |
| 9 | `update_sent_by` | query contacts_by_phone | — |
| 10 | `death_reporting` | Person.v1.get (cht-datasource!), put patient | **Already uses cht-datasource** |
| 11 | `conditional_alerts` | — (message generation) | — |
| 12 | `multi_report_alerts` | allDocs, bulkDocs | Lineage |
| 13 | `update_notifications` | — (delegates to muting_utils) | Muting utils |
| 14 | `update_scheduled_reports` | query, bulkDocs | — |
| 15 | `resolve_pending` | — (state change only) | — |
| 16 | `muting` | query contacts_by_depth, bulkDocs contacts, bulkDocs registrations | Muting utils |
| 17 | `mark_for_outbound` | sentinel.get + sentinel.put (task doc) | — |
| 18 | `create_user_for_contacts` | Uses Person/User via cht-datasource | **Already uses cht-datasource** |

**Key insight**: Transitions #10 (`death_reporting`) and #18 (`create_user_for_contacts`) **already use cht-datasource** instead of direct DB calls. This validates the migration path.

### `canRun()` — Revision-Based Deduplication

```javascript
const isRevSame = (doc, info) => {
  const transition = info.transitions?.[key] || doc.transitions?.[key] || false;
  return transition && parseInt(doc._rev) === parseInt(transition.last_rev);
};
```

This relies on CouchDB's `_rev` field (integer prefix). **PostgreSQL equivalent**: Use a `version` column or `updated_at` timestamp in the infodoc table. The check becomes: `transition.last_version === doc.version`.

---

## 9. Purging System — Highest Complexity

**Source**: `sentinel/src/lib/purging.js` (695 lines)
**Confirmed by**: Kapa AI docs (detailed purging documentation)

### Architecture

```
_users DB → getRoles() → unique role hashes
  → Per-role purge DBs: medic-purged-role-{md5(roles)}
  → For each contact batch (from contacts_by_type view):
    → Get records (from _nouveau/docs_by_replication_key)
    → Hydrate records (db.medic.allDocs)
    → Group by contact
    → Execute purge function per (group × role)
    → Diff against already-purged (purgeDb.allDocs)
    → Write changes (purgeDb.bulkDocs)
  → Also purge: unallocated records, terminal tasks, old targets
  → Write purge log to sentinel DB
```

### CouchDB Dependencies (15+ call sites)

| Operation | API | Count | PostgreSQL Equivalent |
|-----------|-----|-------|----------------------|
| Get all users | `db.users.allDocs({ include_docs })` | 1 | `SELECT * FROM users` |
| Open purge DB | `db.get(purgeDbName)` | per-role | Single `purge_status` table |
| Init purge DB | `purgeDb.put({ roles })` | per-role | `INSERT INTO purge_roles` |
| Close purge DB | `db.close(purgeDb)` | per-role | N/A (connection pool) |
| Iterate contacts | `db.queryMedic('medic-client/contacts_by_type')` | batched | SQL with cursor pagination |
| Search records | `request.post('_nouveau/docs_by_replication_key')` | batched | SQL with index (Section 4.5) |
| Hydrate records | `db.medic.allDocs({ keys, include_docs })` | batched | SQL `WHERE _id = ANY($ids)` |
| Check purge state | `purgeDb.allDocs({ keys: purgeIds })` | per-role | `SELECT FROM purge_status WHERE ...` |
| Update purge state | `purgeDb.bulkDocs(docs)` | per-role | `INSERT/DELETE FROM purge_status` |
| Write purge log | `db.sentinel.put(purgeLog)` | 1 | `INSERT INTO sentinel_purge_logs` |

### Proposed `purge_status` Table

```sql
CREATE TABLE purge_status (
  doc_id TEXT NOT NULL,
  role_hash TEXT NOT NULL,
  purged_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (doc_id, role_hash)
);

CREATE INDEX idx_purge_by_role ON purge_status (role_hash);
```

This replaces ALL per-role purge databases with a single table. The `purgeDb.allDocs({ keys })` becomes `SELECT doc_id FROM purge_status WHERE role_hash = $1 AND doc_id = ANY($2)`. The `bulkDocs` for add/remove becomes `INSERT/DELETE FROM purge_status`.

---

## 10. Replications — User Meta Databases

**Source**: `sentinel/src/schedule/replications.js`
**Confirmed by**: Kapa AI docs

### Current Architecture

```
medic-user-{username}-meta (per-user CouchDB databases)
  → replicate.to() → medic-users-meta (aggregated DB)
  → _purge API → permanently remove replicated telemetry/feedback
```

### CouchDB-Specific APIs

| API | Purpose | PostgreSQL Equivalent |
|-----|---------|----------------------|
| `db.allDbs()` | List all databases | N/A — single table |
| `sourceDb.replicate.to(targetDb, { filter })` | CouchDB replication | N/A — already in one table |
| `sourceDb.info()` | Get DB metadata | N/A |
| `request.post('{db}/_purge')` | Permanent doc removal | `DELETE FROM user_meta WHERE ...` |
| `sourceDb.changes(opts)` | Track replication state | N/A |
| `targetDb.changes({ doc_ids })` | Check doc existence | `SELECT _id FROM user_meta WHERE _id = ANY($ids)` |

### PostgreSQL Simplification

The entire replication schedule collapses into a single table:

```sql
CREATE TABLE user_meta (
  _id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  doc JSONB NOT NULL,
  doc_type TEXT GENERATED ALWAYS AS (doc->>'type') STORED,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_user_meta_user ON user_meta (user_id);
CREATE INDEX idx_user_meta_type ON user_meta (doc_type);
```

The replication job becomes unnecessary. Telemetry/feedback purging becomes `DELETE FROM user_meta WHERE doc_type IN ('telemetry', 'feedback') AND created_at < NOW() - INTERVAL '30 days'`.

---

## 11. Scheduled Tasks — Reminders & Outbound

### 11.1 Reminders (`sentinel/src/schedule/reminders.js`)

**10 CouchDB operations:**

| Operation | Purpose | PostgreSQL Equivalent |
|-----------|---------|----------------------|
| `db.sentinel.allDocs(reminderlog range)` | Find last reminder run | `SELECT FROM sentinel_reminder_logs WHERE form = $1 ORDER BY scheduled_date DESC LIMIT 1` |
| `request.get(contacts_by_type view)` | Get place IDs by type | SQL query with pagination |
| `db.medic.allDocs({ keys: reminderIds })` | Check existing reminders | `SELECT _id FROM couchdb WHERE _id = ANY($ids)` |
| `db.medic.query(reports_by_form_and_parent)` | Check mute-after-form | SQL aggregate query (Section 4.2) |
| `db.medic.allDocs({ keys: placeIds, include_docs })` | Get place documents | `SELECT FROM couchdb WHERE _id = ANY($ids)` |
| `lineage.hydrateDocs(places)` | Hydrate with parent chain | Recursive CTE (Section 7) |
| `db.medic.bulkDocs(reminderDocs)` | Save reminder documents | `INSERT INTO couchdb` |
| `db.sentinel.put(reminderLog)` | Record reminder completion | `INSERT INTO sentinel_reminder_logs` |

### 11.2 Outbound (`sentinel/src/schedule/outbound.js`)

**8 CouchDB operations:**

| Operation | Purpose | PostgreSQL Equivalent |
|-----------|---------|----------------------|
| `db.sentinel.allDocs(task:outbound range)` | Fetch queued tasks | `SELECT FROM sentinel_outbound_tasks ORDER BY id LIMIT $batch` |
| `db.medic.allDocs({ keys, include_docs })` | Fetch associated docs | `SELECT FROM couchdb WHERE _id = ANY($ids)` |
| `lineage.hydrateDocs(docs)` | Hydrate for template | Recursive CTE |
| `db.sentinel.put(taskDoc)` | Update task queue | `UPDATE sentinel_outbound_tasks SET queue = $1 WHERE id = $2` |
| `db.sentinel.bulkDocs(toDelete)` | Delete processed tasks | `DELETE FROM sentinel_outbound_tasks WHERE id = ANY($ids)` |
| `db.sentinel.allDocs(infodoc keys)` | Get info docs for tasks | `SELECT FROM sentinel_infodocs WHERE doc_id = ANY($ids)` |

### 11.3 Due Tasks (`shared-libs/transitions/src/schedule/due_tasks.js`)

Uses `messages_by_state` view via direct HTTP:

```javascript
const options = {
  url: `${couchUrl}/_design/medic/_view/messages_by_state`,
  qs: { include_docs: true, endkey: ['scheduled', now], startkey: ['scheduled', overdue] }
};
```

**PostgreSQL equivalent**:
```sql
SELECT _id, doc FROM v1.couchdb
WHERE doc->>'type' = 'data_record'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(doc->'scheduled_tasks') AS task
    WHERE task->>'state' = 'scheduled'
      AND COALESCE(task->>'due', task->>'timestamp', doc->>'reported_date')::bigint
          BETWEEN $overdue AND $now
  );
```

---

## 12. cht-datasource — Existing Abstraction Layer

**Source**: `shared-libs/cht-datasource/`
**Confirmed by**: Kapa AI docs, cht-core-wiki "Overview and API"

### Current Coverage

| Concept | Operations Available | Used by Sentinel? |
|---------|---------------------|------------------|
| Contact | getByUuid, getByUuidWithLineage, getPageByType | Not directly |
| Person | getByUuid, getByUuidWithLineage, getPageByType, getByType | `death_reporting` transition |
| Place | getByUuid, getByUuidWithLineage, getPageByType, create, update | Not directly |
| Report | create, update | Not directly |
| Target | getById, getByReportingPeriod | Not directly |

### Gap Analysis for Sentinel

| Sentinel Need | cht-datasource Coverage | Gap |
|---------------|------------------------|-----|
| Changes feed | None | Full gap — needs new API |
| View queries (13 views) | None | Full gap — needs query builders |
| Infodoc CRUD | None | Full gap — sentinel-specific |
| Bulk document operations | None | Partial — only single-doc CRUD |
| Purge database operations | None | Full gap — sentinel-specific |
| User role queries | None | Full gap — needs users API |
| Lineage hydration | Implicit (getWithLineage) | Partial — but batch hydration missing |

**Conclusion**: cht-datasource covers ~15% of Sentinel's needs. The `db.js` swap strategy is more practical for Sentinel specifically, with cht-datasource adoption expanding incrementally.

---

## 13. cht-sync PostgreSQL Schema — Migration Target

**Source**: cht-sync-wiki "Database Setup", "Contacts Model"

### Raw Data Table (Already Exists)

```sql
-- v1.couchdb — created by cht-sync
CREATE TABLE v1.couchdb (
  _id VARCHAR PRIMARY KEY,
  saved_timestamp TIMESTAMP DEFAULT NOW(),
  _deleted BOOLEAN DEFAULT FALSE,
  source VARCHAR,
  doc JSONB
);

CREATE INDEX ON v1.couchdb (_deleted);
CREATE INDEX ON v1.couchdb (saved_timestamp);
CREATE INDEX ON v1.couchdb (source);
```

### dbt-Transformed Tables (Already Exist)

```sql
-- contacts (materialized by dbt)
-- uuid, saved_timestamp, _deleted, name, contact_type, parent_uuid, phone, phone2, ...

-- persons (materialized by dbt)
-- uuid, saved_timestamp, date_of_birth, sex, ...

-- reports (materialized by dbt, similar structure)
```

### What Sentinel Needs Added

For Sentinel to use PostgreSQL as primary backend, the cht-sync schema needs:

1. **Additional JSONB indexes** on `v1.couchdb.doc` for the view equivalents (Section 4)
2. **Sentinel-specific tables** (Section 5)
3. **LISTEN/NOTIFY triggers** for change detection
4. **A version/sequence column** for checkpoint tracking

```sql
-- Change notification trigger
CREATE OR REPLACE FUNCTION notify_doc_change() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('doc_changes', json_build_object(
    'id', NEW._id,
    'deleted', NEW._deleted,
    'timestamp', NEW.saved_timestamp
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER doc_change_trigger
  AFTER INSERT OR UPDATE ON v1.couchdb
  FOR EACH ROW EXECUTE FUNCTION notify_doc_change();
```

---

## 14. CouchDB-Specific Patterns & PostgreSQL Equivalents

### 14.1 Revision-Based Conflict Model

| CouchDB Pattern | Where Used | PostgreSQL Equivalent |
|----------------|-----------|----------------------|
| `_rev` for optimistic concurrency | metadata.js get-then-put | `version` column + `WHERE version = $expected` |
| `_rev` prefix for transition dedup | canRun() `isRevSame` check | `updated_at` timestamp or monotonic `version` |
| 409 conflict retry | infodoc saves | Advisory locks or `ON CONFLICT DO UPDATE` |
| Tombstones (deleted doc stubs) | feed.js filtering | `_deleted` boolean column (cht-sync already has this) |

### 14.2 Sequence Numbers

| CouchDB Pattern | Where Used | PostgreSQL Equivalent |
|----------------|-----------|----------------------|
| Opaque seq string | transition checkpoint, cleanup checkpoint | `saved_timestamp` (cht-sync already provides) |
| `since: 'now'` | config reload feed | `NOW()` or `pg_current_wal_lsn()` |
| `since: seq, limit: N` | batch processing | `WHERE saved_timestamp > $last AND ORDER BY saved_timestamp LIMIT $n` |

### 14.3 Database-per-Entity Pattern

| CouchDB Pattern | Where Used | PostgreSQL Equivalent |
|----------------|-----------|----------------------|
| Per-user meta DBs: `medic-user-{name}-meta` | replications.js | Single `user_meta` table with `user_id` column |
| Per-role purge DBs: `medic-purged-role-{hash}` | purging.js | Single `purge_status` table with `role_hash` column |
| `_all_dbs` enumeration | replications.js, background-cleanup.js | `SELECT DISTINCT user_id FROM user_meta` |

### 14.4 View Query Patterns

| CouchDB Pattern | Where Used | PostgreSQL Equivalent |
|----------------|-----------|----------------------|
| `startkey_docid` pagination | purging.js, reminders.js | `WHERE _id > $cursor ORDER BY ... LIMIT $n` |
| `reduce: _stats` with `group: true` | reminders.js | `GROUP BY` with aggregate functions |
| `allDocs({ keys })` bulk fetch | everywhere | `WHERE _id = ANY($ids)` |
| `allDocs({ startkey, endkey })` range | outbound.js, background-cleanup.js | `WHERE _id BETWEEN $start AND $end` |

---

## 15. Complete Migration Matrix

| File | CouchDB Calls | Views | Changes Feeds | Complexity | Priority |
|------|--------------|-------|---------------|-----------|----------|
| **db.js** | Module definition | — | — | CRITICAL | Foundation |
| **metadata.js** | 4 (get/put) | 0 | 0 | LOW | Week 1 |
| **config.js** | 4 (get/query/changes) | 1 | 1 live | LOW | Week 1 |
| **feed.js** | 3 (changes/cancel) | 0 | 1 live | HIGH | Week 2-3 |
| **outbound.js** | 8 (allDocs/put/bulkDocs) | 0 | 0 | MEDIUM | Week 3-4 |
| **reminders.js** | 10 (views/allDocs/bulkDocs/query) | 2 | 0 | MEDIUM | Week 4-5 |
| **background-cleanup.js** | 8 (changes/allDocs/bulkDocs/allDbs) | 0 | 1 batch | MEDIUM | Week 5 |
| **purging.js** | 15+ (views/nouveau/purgeDBs/users) | 3 | 0 | HIGH | Week 6-8 |
| **replications.js** | 10 (replicate/purge/changes/allDbs) | 0 | 2 | HIGH | Week 8-9 |
| **shared-libs/infodoc** | 12 (get/put/allDocs/bulkDocs) | 0 | 0 | MEDIUM | Week 2 |
| **shared-libs/lineage** | 6 (get/allDocs/query) | 2 | 0 | MEDIUM | Week 2-3 |
| **shared-libs/transitions** | ~25 (across 18 modules) | 7 | 0 | HIGH | Agent 1 scope |

---

## 16. Recommended Architecture

### Feature-Flagged `db.js` Swap

```javascript
// sentinel/src/db.js — proposed structure
if (process.env.CHT_DB_BACKEND === 'postgresql') {
  const pg = require('./db-postgresql');
  module.exports = pg;
} else {
  // existing PouchDB code
  const PouchDB = require('pouchdb-core');
  // ...
}
```

The PostgreSQL `db.js` would export the same API surface:
- `db.medic.get(id)` → `SELECT doc FROM couchdb WHERE _id = $1`
- `db.medic.put(doc)` → `INSERT INTO couchdb ... ON CONFLICT (_id) DO UPDATE`
- `db.medic.allDocs(opts)` → `SELECT ... WHERE _id = ANY($keys)` or range query
- `db.medic.bulkDocs(docs)` → Batch `INSERT ... ON CONFLICT`
- `db.medic.query(view, opts)` → Pre-mapped SQL queries (Section 4)
- `db.medic.changes(opts)` → LISTEN/NOTIFY + polling hybrid
- `db.sentinel.*` → Operations on sentinel-specific tables (Section 5)
- `db.queryMedic(view, opts)` → Same pre-mapped SQL queries

### Migration Sequence

```
Phase 1 (Foundation):
  db-postgresql.js module with PouchDB-compatible API surface
  sentinel_metadata table + LISTEN/NOTIFY trigger

Phase 2 (Core Processing):
  Changes feed via LISTEN/NOTIFY
  Infodoc operations on sentinel_infodocs table
  Lineage hydration via recursive CTE

Phase 3 (Scheduled Tasks):
  View query replacements for reminders, outbound, due_tasks
  Background cleanup on PostgreSQL

Phase 4 (Complex Systems):
  Purge system rewrite with purge_status table
  Replications collapse to user_meta table
  All 13 view replacements validated
```

---

## Appendix: Cross-Reference Verification Log

| Claim | Source | Verified By | Status |
|-------|--------|-------------|--------|
| Sentinel uses live CouchDB changes feed | Source code | cht-core-wiki, Kapa AI | Confirmed |
| 18 transitions in fixed order | Source code | cht-core-wiki "Transitions" | Confirmed |
| Backpressure at 100 items | Source code | cht-core-wiki "Changes Feed" | Confirmed |
| Infodocs use 409 retry with merge | Source code | Kapa AI infodoc docs | Confirmed |
| Per-role purge DBs with MD5 hash | Source code | Kapa AI purging docs | Confirmed |
| Purge function is eval'd JavaScript | Source code (purging.js:137) | Kapa AI purging docs | Confirmed |
| docs_by_replication_key moved to Nouveau | Source code | Kapa AI (GitHub #10262) | Confirmed |
| death_reporting uses cht-datasource | Source code | Agent exploration | Confirmed |
| create_user_for_contacts uses cht-datasource | Source code | Agent exploration | Confirmed |
| cht-sync schema: v1.couchdb with JSONB | cht-sync-wiki | cht-sync-wiki "Database Setup" | Confirmed |
| cht-sync uses saved_timestamp for ordering | cht-sync-wiki | cht-sync-wiki "Change Detection" | Confirmed |
| contacts_by_depth traverses parent chain | View map.js source | Kapa AI docs | Confirmed |
| messages_by_state emits [state, due] | View map.js source | Kapa AI docs | Confirmed |
