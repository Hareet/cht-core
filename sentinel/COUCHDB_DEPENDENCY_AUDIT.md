# Sentinel CouchDB Dependency Audit

**Date**: 2026-04-06
**Scope**: `sentinel/src/` — all direct CouchDB/PouchDB interactions
**Purpose**: Map every CouchDB dependency to inform the PostgreSQL migration strategy

---

## 1. Database Module (`sentinel/src/db.js`)

The central database abstraction. All CouchDB access flows through this module.

### PouchDB Instances
| Export | Target | Usage |
|--------|--------|-------|
| `db.medic` | `PouchDB(couchUrl)` | Primary medical data (contacts, reports, tasks, targets) |
| `db.sentinel` | `PouchDB(couchUrl + '-sentinel')` | Transition metadata, info docs, purge logs, outbound tasks |
| `db.users` | `PouchDB(serverUrl + '/_users')` | CouchDB `_users` database for role lookups |

### Utility Functions
| Export | CouchDB API | Usage |
|--------|-------------|-------|
| `db.allDbs()` | `GET /_all_dbs` | Lists all databases (for user meta DBs, purge DBs) |
| `db.get(name)` | `new PouchDB(name)` | Opens arbitrary DB by name (user-meta, purge DBs) |
| `db.close(db)` | `db.close()` | Closes a PouchDB instance |
| `db.queryMedic(view, params, body)` | `GET/POST _design/{ddoc}/_view/{view}` | Direct HTTP view query (bypasses PouchDB for `startkey_docid` support) |

### PouchDB API Surface Used
All PouchDB method calls found across `sentinel/src/`:

| Method | Used On | Count | Files |
|--------|---------|-------|-------|
| `.get(id)` | medic, sentinel | ~8 | config.js, metadata.js, replications.js, outbound.js |
| `.put(doc)` | medic, sentinel | ~8 | metadata.js, purging.js, replications.js, outbound.js, reminders.js |
| `.allDocs(opts)` | medic, sentinel | ~12 | reminders.js, outbound.js, purging.js, background-cleanup.js |
| `.bulkDocs(docs)` | medic, sentinel | ~6 | reminders.js, outbound.js, purging.js, background-cleanup.js |
| `.query(view, opts)` | medic | ~2 | config.js, reminders.js |
| `.changes(opts)` | medic | ~4 | feed.js, config.js, background-cleanup.js, replications.js |
| `.info()` | source DBs | ~2 | replications.js |
| `.replicate.to()` | source DBs | ~1 | replications.js |

---

## 2. Changes Feed Usage (CRITICAL PATH)

### Primary Feed: Transition Processing (`sentinel/src/lib/feed.js`)
```
db.medic.changes({ live: true, since: seq })
```
- **Purpose**: Core event loop — listens for ALL document changes to trigger transitions
- **Backpressure**: Queue capped at 100 items; feed paused when exceeded
- **Checkpoint**: Sequence stored in `sentinel` DB via `metadata.setTransitionSeq()`
- **Migration impact**: **HIGH** — Must be replaced with PostgreSQL LISTEN/NOTIFY or polling

### Config Reload Feed (`sentinel/src/config.js`)
```
db.medic.changes({ live: true, since: 'now' })
```
- **Purpose**: Watches for settings doc or translation changes to reload config
- **Watches**: `settings` doc ID and `messages-*` doc IDs
- **Migration impact**: **MEDIUM** — Can use PostgreSQL LISTEN/NOTIFY on settings table

### Background Cleanup Feed (`sentinel/src/schedule/background-cleanup.js`)
```
db.medic.changes({ since: seq, limit: BATCH })
```
- **Purpose**: Batch processing of deleted docs to clean up info-docs and read-docs
- **Checkpoint**: Stored via `metadata.setBackgroundCleanupSeq()`
- **Migration impact**: **MEDIUM** — Replace with polling `saved_timestamp` or WAL-based tracking

### Replications Feed (`sentinel/src/schedule/replications.js`)
```
sourceDb.changes(opts)  // on user-meta DBs
targetDb.changes({ doc_ids: ids })  // filtered by IDs
```
- **Purpose**: Replicates telemetry/feedback from per-user meta DBs to aggregated DB
- **Migration impact**: **LOW** — User-meta DBs collapse into single table with user_id filtering

---

## 3. CouchDB View Queries

### Via PouchDB `.query()`
| View | File | Purpose |
|------|------|---------|
| `medic-client/doc_by_type` | config.js | Load translation documents |
| `medic/reports_by_form_and_parent` | reminders.js | Check if reminder forms already sent |

### Via `db.queryMedic()` (Direct HTTP)
| View | File | Purpose |
|------|------|---------|
| `medic-client/contacts_by_type` | purging.js | Iterate contacts in batches for purge evaluation |
| `medic/tasks_in_terminal_state` | purging.js | Find expired tasks for purging |
| `allDocs` (with key range) | purging.js | Find expired targets by ID prefix `target~` |

### Via `@medic/couch-request` (Direct HTTP)
| Endpoint | File | Purpose |
|----------|------|---------|
| `_design/medic-client/_view/contacts_by_type` | reminders.js | Get place IDs for reminder generation (uses `start_key_doc_id`) |
| `_design/medic/_nouveau/docs_by_replication_key` | purging.js | Nouveau (Lucene) search for records by replication key |
| `{db}/_purge` | replications.js | CouchDB document purge API (permanent deletion) |

---

## 4. Sentinel Database Operations

The `sentinel` (medic-sentinel) database stores operational metadata:

| Document Pattern | File | Purpose |
|-----------------|------|---------|
| Transition seq metadata | metadata.js | Checkpoint for changes feed position |
| Background cleanup seq | metadata.js | Checkpoint for cleanup batch position |
| `task:outbound:*` | outbound.js | Outbound push queue tasks |
| `{docId}-info` | outbound.js | Info docs tracking transition state per document |
| `reminderlog:{form}:{timestamp}` | reminders.js | Tracks when reminders were last sent |
| `purgelog:{timestamp}` | purging.js | Purge run completion logs |
| `purge_db_info` | purging.js | Stores role info per purge database |

---

## 5. Purge Database Operations (`sentinel/src/lib/purging.js`)

**Complexity**: HIGH — Most CouchDB-coupled code in Sentinel.

### Purge DB Pattern
- Creates per-role-hash databases: `{db}-purged-role-{hash}`
- Each DB opened via `db.get(name)` → `new PouchDB(name)`
- Operations: `allDocs`, `bulkDocs`, `put` on purge DBs

### Purge Flow CouchDB Dependencies
1. `db.users.allDocs({ include_docs: true })` — Read all users for role extraction
2. `db.queryMedic('medic-client/contacts_by_type')` — Batch iterate contacts
3. `request.post('_nouveau/docs_by_replication_key')` — Nouveau search for records
4. `db.medic.allDocs({ keys, include_docs: true })` — Hydrate record documents
5. Per-role purge DBs: `allDocs` (check purge state), `bulkDocs` (update purge state)
6. `db.sentinel.put(purgeLog)` — Write completion log

### Migration Impact
- **Purge DBs**: Entire concept replaced by `purge_status` table in PostgreSQL
- **Nouveau search**: Replaced by SQL queries with proper indexes
- **User role queries**: Replaced by PostgreSQL `users` table query

---

## 6. Replications (`sentinel/src/schedule/replications.js`)

**Complexity**: MEDIUM — Uses CouchDB-specific replication protocol.

### CouchDB-Specific APIs
- `sourceDb.replicate.to(targetDb, { filter })` — CouchDB replication protocol
- `sourceDb.info()` — Get DB metadata for purge endpoint
- `request.post({ uri: '{db}/_purge' })` — CouchDB purge API (permanent doc removal)
- `sourceDb.changes()` / `targetDb.changes({ doc_ids })` — Track replication state

### Migration Impact
- **Per-user meta DBs**: Collapse into single `user_meta` table
- **Replication**: Replaced by simple SQL INSERT/UPDATE
- **CouchDB _purge API**: Replaced by SQL DELETE

---

## 7. Shared Library Dependencies with CouchDB Coupling

### `@medic/transitions` (shared-libs/transitions/src/)
- Receives `db` object from Sentinel via `db.init(db)`
- Uses: `db.medic.get`, `db.medic.put`, `db.medic.bulkDocs`, `db.medic.query`, `db.sentinel.get`, `db.sentinel.put`
- 15+ transition modules with direct PouchDB calls
- **Migration impact**: HIGH — Core transition logic deeply coupled to PouchDB API

### `@medic/lineage`
- Initialized with `db.medic`: `require('@medic/lineage')(Promise, db.medic)`
- Used in: reminders.js, outbound.js
- Uses `.allDocs()` for document hydration
- **Migration impact**: MEDIUM — Needs PostgreSQL-aware hydration

### `@medic/infodoc`
- Initialized with `db.medic, db.sentinel`
- Manages transition tracking documents in sentinel DB
- **Migration impact**: MEDIUM — Info docs become PostgreSQL table rows

### `@medic/user-management`
- Initialized with `config, db, dataContext`
- Used in purging.js for role checks
- **Migration impact**: LOW — Already partially abstracted via dataContext

### `@medic/couch-request`
- Direct HTTP client for CouchDB endpoints
- Used for: view queries with `startkey_docid`, Nouveau search, CouchDB `_purge` API
- **Migration impact**: HIGH — All calls must be replaced with SQL queries

---

## 8. CouchDB-Specific Patterns

### Revision-Based Conflict Model
- `_rev` used in purge DB operations (delete by `_id` + `_rev`)
- Info docs use `_rev` for update-or-create pattern
- Metadata docs use get-then-put with `_rev` for optimistic concurrency
- **Migration**: Replace with PostgreSQL `ON CONFLICT` / `INSERT ... ON CONFLICT DO UPDATE`

### Sequence Numbers
- CouchDB sequences are opaque strings (e.g., `"123-abc..."`)
- Used for: transition checkpoint, background cleanup checkpoint, replication tracking
- **Migration**: Replace with PostgreSQL `saved_timestamp` or LSN (Log Sequence Number)

### Tombstones
- CouchDB tombstones (deleted doc stubs) filtered in changes feed
- `@medic/tombstone-utils.isTombstoneId()` used in feed.js
- **Migration**: PostgreSQL soft-delete column or separate deletions table

### Database-per-User Pattern
- Per-user meta DBs: `medic-user-{username}-meta`
- Per-role purge DBs: `medic-purged-role-{hash}`
- Accessed via `db.allDbs()` + `db.get(name)`
- **Migration**: Collapse into single tables with user/role filtering columns

---

## 9. Migration Complexity Summary

| Component | File(s) | CouchDB Coupling | Migration Effort |
|-----------|---------|-------------------|-----------------|
| **Changes feed (transitions)** | feed.js | `.changes({ live: true })` | HIGH — Core event loop |
| **Changes feed (config)** | config.js | `.changes({ live: true, since: 'now' })` | MEDIUM |
| **Purging** | lib/purging.js | Views, Nouveau, purge DBs, user DB | HIGH — Most complex |
| **Replications** | schedule/replications.js | `.replicate.to()`, `_purge` API, per-user DBs | HIGH — CouchDB-native |
| **Outbound** | schedule/outbound.js | `.allDocs()`, `.put()`, `.bulkDocs()` on sentinel | MEDIUM |
| **Reminders** | schedule/reminders.js | Views, `.allDocs()`, `.bulkDocs()`, `.query()` | MEDIUM |
| **Background cleanup** | schedule/background-cleanup.js | `.changes()`, `.allDocs()`, `.bulkDocs()`, per-user DBs | MEDIUM |
| **Metadata** | lib/metadata.js | `.get()`, `.put()` on sentinel | LOW — Simple key-value |
| **Config** | config.js | `.get()`, `.query()` on medic | LOW |
| **Transitions library** | shared-libs/transitions/ | 15+ modules with PouchDB calls | HIGH — Out of scope (Agent 1) |

---

## 10. Recommended Migration Order

1. **metadata.js** (LOW) — Simple get/put → PostgreSQL key-value table. Foundation for everything else.
2. **config.js** (LOW) — Settings fetch + change watch → PostgreSQL query + LISTEN/NOTIFY.
3. **feed.js** (HIGH) — Changes feed → PostgreSQL LISTEN/NOTIFY or polling `saved_timestamp`. Unlocks transition processing.
4. **outbound.js** (MEDIUM) — Task queue in sentinel DB → PostgreSQL `outbound_tasks` table.
5. **reminders.js** (MEDIUM) — View queries → SQL queries with proper indexes.
6. **background-cleanup.js** (MEDIUM) — Changes-based cleanup → PostgreSQL trigger-based or polling.
7. **purging.js** (HIGH) — Complete rewrite: purge DBs → `purge_status` table, Nouveau → SQL, views → SQL.
8. **replications.js** (HIGH) — CouchDB replication → SQL operations on unified `user_meta` table.

---

## 11. Abstraction Points

### Already Abstracted
- **cht-datasource** (`sentinel/src/data-context.js`): `getLocalDataContext(config, db)` — used in purging.js via `cht.getDatasource(dataContext)`. This is the intended migration path.

### Not Yet Abstracted (Direct CouchDB)
- All PouchDB method calls (`get`, `put`, `allDocs`, `bulkDocs`, `query`, `changes`)
- All `db.queryMedic()` calls (direct HTTP to CouchDB views)
- All `@medic/couch-request` calls (Nouveau search, `_purge` API)
- `@medic/lineage` hydration
- `@medic/infodoc` operations
- `db.allDbs()` and `db.get()` for dynamic database access

### Key Insight
The `db.js` module is the **single chokepoint** for all CouchDB access. A feature-flagged PostgreSQL backend can be implemented by swapping the `db.js` exports based on `CHT_DB_BACKEND` environment variable, providing the same API surface backed by PostgreSQL queries instead of PouchDB.

---

## 12. Verification Against MCP Wiki

Findings cross-referenced with `cht-core-wiki` documentation:

- **Confirmed**: Sentinel uses CouchDB live changes feed as its core event loop (wiki: "Changes Feed Processing")
- **Confirmed**: Transitions are processed sequentially via async.queue with concurrency 1
- **Confirmed**: Sequence checkpoint stored in sentinel DB metadata document
- **Confirmed**: Info docs in sentinel DB track per-document transition state
- **Confirmed**: Scheduled tasks run every 5 minutes via polling loop
- **Confirmed**: `db.queryMedic()` exists because PouchDB doesn't support `startkey_docid`
- **Confirmed**: Backpressure at 100 items, retry with 60s timeout, max 5 retries per change

---

*Total CouchDB API calls in sentinel/src/: ~55 direct calls across 10 files*
*Total CouchDB views referenced: 6 views + 1 Nouveau index*
*Total unique PouchDB methods used: 8 (get, put, allDocs, bulkDocs, query, changes, info, replicate.to)*
