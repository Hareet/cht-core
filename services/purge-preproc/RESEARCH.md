# Purge Logic Research Summary

## Overview

CHT's purge system removes documents from offline users' devices to keep replication
sizes manageable. It is **server-side only** — the server decides what to purge, and
clients download the purge list periodically (default every 7 days). The purge does NOT
delete documents from the server; it only prevents them from being replicated to offline
users.

## The purge.js Contract

### Function Signature

```js
function purgeFn(userCtx, contact, reports, messages, chtScriptApi, permissions)
```

**Parameters:**

| # | Name | Type | Description |
|---|------|------|-------------|
| 1 | `userCtx` | `{ roles: string[] }` | User context with the role set being evaluated |
| 2 | `contact` | `object` | Contact document (person/place). Empty `{}` for reports without subjects; `{ _deleted: true }` for deleted contacts |
| 3 | `reports` | `object[]` | All reports about this contact (by subject, NOT by submitter) |
| 4 | `messages` | `object[]` | SMS messages sent/received by this contact |
| 5 | `chtScriptApi` | `object` (optional) | CHT datasource API (added 4.3.0) |
| 6 | `permissions` | `object` (optional) | Permission settings (added 4.3.0) |

**Returns:** `string[]` — Array of `_id` values of documents to purge. Only IDs that were
passed into the function (from `contact`, `reports`, or `messages`) are valid.

### Configuration

Defined in `purge.js` at project root, compiled by `cht-conf`, stored in
`app_settings.purge.fn` as a stringified function. The function is `eval()`-ed at runtime
in `sentinel/src/lib/purging.js:getPurgeFn()`.

Schedule is configured via `cron` or `text_expression` (LaterJS format).

### Example purge.js

```js
module.exports = {
  text_expression: 'at 9 am on Sunday',
  run_every_days: 7,
  fn: function(userCtx, contact, reports, messages) {
    const oneYearAgo = Date.now() - (1000 * 60 * 60 * 24 * 365);
    const ninetyDaysAgo = Date.now() - (1000 * 60 * 60 * 24 * 90);
    return [
      ...reports.filter(r => r.reported_date < oneYearAgo).map(r => r._id),
      ...messages.filter(m => m.reported_date < ninetyDaysAgo).map(m => m._id),
    ];
  }
};
```

## How Purge Gets Invoked (Current CouchDB System)

### Entry Point

`sentinel/src/schedule/purging.js` — scheduled via LaterJS, calls `purgeLib.purge()`.

### Execution Flow (sentinel/src/lib/purging.js)

1. **Get purge function**: `getPurgeFn()` reads `config.get('purge').fn`, `eval()`s it
2. **Get roles**: `getRoles()` reads all user docs from `_users` database, deduplicates
   by unique role sets, creates an MD5 hash per role set
3. **Init purge databases**: Creates a CouchDB database per role hash:
   `<dbname>-purged-role-<md5hash>`. Each DB stores `purged:<doc_id>` documents.
4. **Purge contacts** (`purgeContacts`):
   - Iterates through all contacts via `medic-client/contacts_by_type` view in batches
   - For each contact, gets `subjectIds` (patient_id, place_id, etc.)
   - Queries `docs_by_replication_key` (Nouveau/full-text index) for all reports/messages
     matching those subject IDs
   - Groups results: each group = `{ contact, reports[], messages[], ids[] }`
   - Calls `purgeFn(userCtx, contact, reports, messages, chtScriptApi, permissions)` for
     each (group x role_hash) combination
   - Compares result against already-purged docs; writes additions/removals to purge DB
5. **Purge unallocated records** (`purgeUnallocatedRecords`):
   - Queries `docs_by_replication_key` with key `_unassigned`
   - For each doc, calls purgeFn with empty contact and the doc as either report or message
6. **Purge tasks** (`purgeTasks`):
   - Automatic, NOT via purge.js — queries `medic/tasks_in_terminal_state` view
   - Purges tasks in terminal state (Cancelled/Completed/Failed) older than 60 days
7. **Purge targets** (`purgeTargets`):
   - Automatic, NOT via purge.js — purges target docs with reporting period > 6 months ago
8. **Write purge log**: Records duration, errors, skipped contacts to sentinel DB

### Batch Size Management

- Contact batch size starts at `MAX_CONTACT_BATCH_SIZE` (Nouveau batch limit)
- If a contact has too many records (>20,000), batch size halves
- If records < 5,000, batch size doubles back up
- Contacts that exceed limits even at batch size 1 are skipped and logged

### Storage Model (CouchDB)

Per-role-hash CouchDB databases store documents like:
```
{ _id: "purged:<original_doc_id>" }
```

The API layer (`api/src/services/purged-docs.js`) queries these per-role purge databases
to filter document IDs during replication. The replication service
(`api/src/services/replication.js`) calls `purgedDocs.getUnPurgedIds()` to exclude purged
docs from the replication response.

### Utility Functions (shared-libs/purging-utils)

- `getRoleHash(roles)` — MD5 hash of sorted unique roles array
- `getPurgeDbName(dbName, hash)` — `<dbName>-purged-role-<hash>`
- `getPurgedId(id)` — `purged:<id>`
- `extractId(purgedId)` — strips `purged:` prefix
- `sortedUniqueRoles(roles)` — dedup + sort

## Key Observations for PostgreSQL Migration

### What Maps Directly

1. **The purge function contract is stable** — 6 parameters, returns array of IDs. This
   is the interface we must preserve exactly.
2. **Task/target purging is time-based and automatic** — no purge.js needed. Can be
   expressed as simple SQL `DELETE FROM purge_status WHERE ...` or date-based queries.
3. **Role hashing** — we can reuse `shared-libs/purging-utils` directly.
4. **The grouping logic** — (contact, reports[], messages[]) tuples are the core unit of
   work. In PostgreSQL, this becomes a query joining contacts with their reports/messages.

### What Changes

1. **Storage**: Instead of per-role CouchDB databases with `purged:<id>` documents, we use
   a single `purge_status` table with `(doc_id, role_hash)` composite key.
2. **Data source**: Instead of CouchDB views (`contacts_by_type`, `docs_by_replication_key`),
   we query PostgreSQL tables directly (from cht-sync's `couchdb` JSONB table or
   normalized dbt tables).
3. **Consumption**: Instead of the API querying per-role purge DBs, PowerSync Sync Streams
   JOIN against `purge_status` to exclude purged docs from sync bucket rules.
4. **Scheduling**: Instead of LaterJS inside Sentinel, the preprocessing service runs on
   its own schedule (cron/interval), independent of Sentinel.

### Grouping Logic (Critical to Replicate)

The current system groups documents as follows:
- Each contact is a group key
- `registrationUtils.getSubjectIds(contact)` extracts all subject identifiers (patient_id,
  place_id, _id, etc.)
- Reports are matched to contacts by their subject ID (patient_id field matching a
  contact's subject IDs)
- Messages are matched by sender/receiver
- Reports without subjects or with invalid subjects get their own group with empty contact
- Unallocated records (key `_unassigned`) are processed individually

### Performance Considerations

- Current system processes contacts in batches with adaptive batch sizing
- At Kenya scale (47 counties, 100K+ CHWs), expect millions of contacts and reports
- Incremental evaluation (only re-process changed docs) is essential
- The purge function is Turing-complete JS — cannot be optimized or parallelized by the
  framework; each invocation is a black box

## Source Files Analyzed

| File | Purpose |
|------|---------|
| `shared-libs/purging-utils/src/index.js` | Utility functions (hash, naming, ID manipulation) |
| `sentinel/src/lib/purging.js` | Core purge engine — grouping, evaluation, storage |
| `sentinel/src/schedule/purging.js` | Scheduler (LaterJS cron trigger) |
| `api/src/services/purged-docs.js` | API-side purge lookup for replication filtering |
| `api/src/services/replication.js` | Replication service that consumes purge decisions |
| `api/src/services/purged-docs-cache.js` | In-memory cache for purge lookups |

## Verified Against

- CHT official documentation (via Kapa AI MCP): Confirmed purge.js contract, 6 parameters,
  return type, task/target auto-purge rules, schedule configuration
- `sentinel/tests/unit/lib/purging.spec.js`: Confirmed invocation pattern with test
  assertions showing exact argument shapes passed to purgeFn
