# PowerSync Known Issues

Issues discovered while building the CHT PowerSync scalability benchmark suite.
Tested against `@powersync/node@0.12.0`, PowerSync Service v1.20.4, `powersync_rs 0.4.6`.

---

## 1. CJS bundle: `BetterSQLite3Database is not a constructor`

**Severity:** Blocks all usage from CommonJS projects

When using `@powersync/node` from a CommonJS project (no `"type": "module"` in package.json), database initialization fails:

```
TypeError: BetterSQLite3Database is not a constructor
    at openDatabase$1 (.../node_modules/@powersync/node/dist/DefaultWorker.cjs:87:20)
```

**Root cause:** In `dist/DefaultWorker.cjs`, `dynamicImport` is compiled to `require()`. Then `loadBetterSqlite3()` does `return module.default` — but `require('better-sqlite3')` returns the constructor directly with no `.default` property. Under ESM `import()`, Node wraps CJS exports in `{ default: <constructor> }`, so `.default` works.

**Workaround:** Set `"type": "module"` in package.json and use ESM imports.

**Suggested fix for PowerSync:**
```js
async loadBetterSqlite3() {
    const module = await dynamicImport('better-sqlite3');
    return module.default || module;
}
```

**Reproduction:**
```bash
mkdir repro && cd repro
npm init -y  # no "type": "module"
npm install @powersync/node better-sqlite3

node -e "
const { PowerSyncDatabase, column, Schema, Table } = require('@powersync/node');
const schema = new Schema({ test: new Table({ name: column.text }) });
const db = new PowerSyncDatabase({ schema, database: { dbFilename: '/tmp/test.db' } });
db.get('SELECT 1').then(console.log).catch(console.error);
"
```

---

## 2. Sync Streams: table alias determines client-side table name

**Severity:** All synced data lands in `ps_untyped`, zero rows in typed tables

In Sync Streams edition 3, the SQL table alias in the `FROM` clause determines the `row_type` sent to clients. If you write:

```sql
SELECT c._id AS id, ... FROM "v1"."couchdb" c WHERE ...
```

The `row_type` will be `"c"` (the alias). The SDK looks for a client table named `"c"`, doesn't find one, and dumps all rows into `ps_untyped`.

**Fix:** Use the stream name as the table alias:

```yaml
streams:
  contacts:
    query: |
      SELECT contacts._id AS id, ...
      FROM "v1"."couchdb" contacts
      WHERE ...
```

This is undocumented as of April 2026.

---

## 3. Global `with` block causes circular reference error

**Severity:** PowerSync service fails to load sync rules

PowerSync v1.20.x cannot have a global `with` block when any stream also has a local `with` block. The query graph resolver treats this as a circular dependency:

```
error: Failed to update sync rules from configuration
  internal error: circular reference when resolving result set
```

**Fix:** Remove the global `with` block. Give each stream that needs the CTE its own local `with`.

```yaml
# BAD — global with + local with = circular reference
with:
  accessible_facilities: |
    SELECT facility_id FROM ...

streams:
  reports:
    with:
      report_facilities: |
        SELECT facility_id FROM ...
    query: |
      SELECT ... WHERE ... IN report_facilities
        OR ... IN accessible_facilities  -- references global with

# GOOD — all local
streams:
  reports:
    with:
      report_facilities: |
        SELECT facility_id FROM ...
      accessible_facilities: |
        SELECT facility_id FROM ...
    query: |
      SELECT ... WHERE ... IN report_facilities
        OR ... IN accessible_facilities
```

---

## 4. `db.connect()` requires prior database initialization

**Severity:** Sync never starts, no errors, process exits silently

Calling `db.connect(connector)` without first forcing the database worker to initialize results in `connect()` resolving immediately but sync never starting. `fetchCredentials` is never called.

**Fix:** Execute any query before `connect()` to force initialization:

```js
const db = new PowerSyncDatabase({ schema, database: { dbFilename: '...' } });

// Required: force worker init
await db.get('SELECT powersync_rs_version()');

// Now connect works
await db.connect(connector, {
  connectionMethod: SyncStreamConnectionMethod.WEB_SOCKET,
  clientImplementation: SyncClientImplementation.RUST,
});
```

The official Node.js example at `demos/example-node/src/main.ts` includes this pattern but doesn't document why it's necessary.
