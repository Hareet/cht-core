# Agent-1 Task: Build PowerSync Write Handler in CHT API

## Context

The CHT→PostgreSQL migration needs a write path for PowerSync clients. When a CHW submits a form on their phone, the PowerSync SDK calls `uploadData()` which must hit a CHT API endpoint that validates and persists the data to PostgreSQL. Currently no such endpoint exists — the PowerSync benchmark writes directly to PostgreSQL, bypassing the API.

### The full target data flow:
```
CHW phone
  → PowerSync SDK uploadData()
    → POST /api/v1/powersync/upload (new endpoint)
      → CHT API validates + transforms
        → cht-datasource PostgreSQL adapter (agent-1's work)
          → INSERT/UPDATE v1.couchdb
            → PostgreSQL WAL
              → PowerSync Service detects change
                → WebSocket push to other clients
```

### What exists:
- **cht-datasource PostgreSQL adapter** (agent-1 built this): `shared-libs/cht-datasource/src/postgres/` with `create`, `update`, `getDocById`, etc.
- **PowerSync SDK connector** (`webapp/src/ts/services/powersync/powersync-connector.ts`): has `uploadData()` stub that calls `getCrudBatch()` and needs a backend endpoint
- **CouchDB write path** (`api/src/controllers/`): existing endpoints like `POST /api/v1/records`, `POST /api/v1/people`, `POST /api/v1/places` that write to CouchDB via PouchDB

### What's missing:
- API endpoint that receives PowerSync CRUD operations and routes them through cht-datasource to PostgreSQL
- Validation layer (ensure submitted docs pass CHT's schema rules)
- Conflict resolution (PowerSync's `_crud` queue may replay writes — need idempotency)
- Sentinel integration (triggers/workflows that fire on new data records)

## Requirements

### 1. Upload Endpoint

Create `POST /api/v1/powersync/upload` that:

1. Receives a batch of CRUD operations from the PowerSync SDK
2. For each operation:
   - **PUT (create/update)**: Validate the doc, then call cht-datasource's PostgreSQL adapter to persist
   - **DELETE**: Soft-delete via `_deleted = true`
   - **PATCH**: Merge fields into existing doc
3. Return success/failure per operation
4. Handle conflicts (doc already exists with different data — use last-write-wins or CHT's merge strategy)

### PowerSync CRUD batch format

The PowerSync SDK sends CRUD operations via `getCrudBatch()`:
```typescript
interface CrudEntry {
  op: 'PUT' | 'PATCH' | 'DELETE';
  type: string;      // table name (contacts, reports, etc.)
  id: string;        // document ID
  data?: Record<string, any>;  // the row data
  metadata?: any;    // optional client metadata
}

interface CrudBatch {
  crud: CrudEntry[];
  haveMore: boolean;
  complete: (writeCheckpoint?: string) => Promise<void>;
}
```

The `uploadData()` method in the connector must:
1. Call `db.getCrudBatch(100)` to get up to 100 pending operations
2. POST them to the API endpoint
3. Call `batch.complete()` on success (clears the local upload queue)
4. If `haveMore` is true, repeat

### 2. Doc Type Routing

Different CHT doc types need different validation:

| PowerSync table | CHT doc type | Validation |
|----------------|--------------|------------|
| `reports` | `data_record` with `form` | Validate form fields against XML form definition |
| `contacts` | `person`, `clinic`, `health_center`, `district_hospital` | Validate hierarchy (parent exists), required fields |
| `tasks` | `task` | Validate task schema, ensure `user` matches authenticated user |
| `targets` | `target` | Validate target schema, ensure `owner` matches user's facility |
| `user_meta` | `telemetry-*`, `feedback-*`, `read:report:*` | Minimal validation, ensure `user` matches |

For the initial implementation, focus on `reports` (form submissions) — this is the primary write path for CHWs.

### 3. Integration with cht-datasource

The PostgreSQL adapter in cht-datasource provides:
```javascript
// From shared-libs/cht-datasource/src/postgres/
const pgAdapter = require('@medic/cht-datasource').postgres;

// Create a new document
await pgAdapter.create(doc);

// Update an existing document
await pgAdapter.update(docId, updates);

// Get a document by ID
const doc = await pgAdapter.getDocById(docId);
```

The write handler should:
1. Transform the PowerSync CRUD entry into a CouchDB-style document (add `type`, `reported_date`, etc.)
2. Call the appropriate cht-datasource method
3. The adapter writes to `v1.couchdb` table (same table PowerSync reads via WAL)

### 4. Sentinel Compatibility

CHT's Sentinel service watches for document changes and triggers workflows (e.g., creating tasks when a pregnancy registration is submitted). Currently Sentinel watches CouchDB's `_changes` feed.

For PostgreSQL, Sentinel needs to watch for changes too. Options:
- PostgreSQL LISTEN/NOTIFY on `v1.couchdb` inserts
- Poll `v1.couchdb` for new `saved_timestamp` values
- Use PowerSync's webhook/trigger mechanism

This is a larger architectural question. For now, the write handler should ensure docs are written in a format Sentinel can process. Don't implement Sentinel PostgreSQL integration — just ensure compatibility.

### 5. Authentication & Authorization

The write handler must:
- Authenticate the user via the same JWT used for PowerSync sync
- Verify the user has permission to write to the facility (check `user_accessible_facilities`)
- Reject writes to facilities outside the user's scope

Use the existing CHT authorization module: `api/src/services/authorization.js`

## Files to Create/Modify

| File | Action |
|------|--------|
| `api/src/controllers/powersync-upload.js` | CREATE — upload endpoint controller |
| `api/src/routes/powersync-upload.js` | CREATE — Express route definition |
| `api/src/routing.js` | MODIFY — register new route |
| `api/tests/unit/controllers/powersync-upload.spec.js` | CREATE — unit tests |
| `webapp/src/ts/services/powersync/powersync-connector.ts` | MODIFY — implement `uploadData()` |

## Scope Boundaries

**In scope:**
- API endpoint for receiving PowerSync CRUD batches
- Routing PUT operations for `reports` type through cht-datasource to PostgreSQL
- Basic validation (doc type, required fields, user authorization)
- Unit tests

**Out of scope (for now):**
- Full form validation against XML definitions
- Sentinel PostgreSQL integration
- Contact/place write operations (focus on reports first)
- Conflict resolution beyond last-write-wins
- Performance optimization

## Verification

1. Unit tests pass: `npm run unit-api`
2. Manual test: PowerSync SDK `uploadData()` → API endpoint → doc appears in `v1.couchdb`
3. Verify the doc triggers PowerSync WAL replication to other clients
4. Benchmark: measure write-through latency (SDK → API → PG → PowerSync → other client)

## Reference

- cht-datasource PostgreSQL adapter: `shared-libs/cht-datasource/src/postgres/`
- PowerSync uploadData contract: `webapp/src/ts/services/powersync/powersync-connector.ts`
- Existing CouchDB write endpoints: `api/src/controllers/records.js`, `api/src/controllers/people.js`
- PowerSync CRUD batch docs: https://docs.powersync.com/client-sdks/usage/writing-data
- CHT authorization: `api/src/services/authorization.js`
- Benchmark context: PowerSync incremental sync = 462ms, CouchDB API = 879ms (single user, ac1)
