# CHT Integration Test Framework — Research Summary

## Agent 7 — Task 1: Study of Existing Test Infrastructure

### Overview

The CHT integration test framework is built on **Mocha/Chai** with PouchDB clients for CouchDB interaction. It supports two infrastructure modes: **Docker Compose** (default) and **K3D** (Kubernetes). The framework manages the full lifecycle of services — starting, monitoring, and tearing down containers for each test run.

### Key Files

| File | Purpose |
|------|---------|
| `tests/utils/index.js` | Central test utility — service lifecycle, HTTP helpers, DB operations |
| `tests/integration/hooks.js` | Mocha root hooks — calls `prepServices` in `beforeAll`, `tearDownServices` in `afterAll` |
| `tests/integration/hooks-k3d.js` | Alternate hooks for K3D infrastructure — calls `prepK3DServices` |
| `tests/integration/.mocharc-base.js` | Mocha config — chai plugins, timeout (200s), spec list, requires hooks.js |
| `tests/constants.js` | Connection constants — `BASE_URL`, `USERNAME`, `PASSWORD`, `DB_NAME` |
| `tests/aliases.js` | Module alias setup from `jsconfig.json` — `@utils`, `@constants`, `@factories`, etc. |

### Service Lifecycle (Docker Mode)

The `prepServices(defaultSettings)` function in `tests/utils/index.js:1368` does:

1. **`createLogDir()`** — Wipes and recreates `tests/logs/`
2. **`generateComposeFiles()`** — Renders mustache templates for Docker Compose with repo/tag/db_name
3. **`updateContainerNames()`** — Maps service keys to container names (e.g., `cht-e2e-api-1`)
4. **`tearDownServices()`** — Saves container logs, then runs `docker compose down -t 0 --remove-orphans --volumes`
5. **`startServices()`** — Creates temp dirs for CouchDB data, runs `docker compose up -d`, verifies containers started
6. **`listenForApi()`** — Polls `GET /api/info` up to 180 times (3 min) until API responds
7. **`setupSettings()`** (if `defaultSettings=true`) — PUTs default app settings with transitions disabled
8. **`setUserContactDoc()`** — Creates the default user contact document
9. **`getDefaultForms()`** — Loads default forms
10. **`loginUser()`** — POSTs to `/medic/login`
11. **`setupUserDoc()`** — Updates user settings doc

The `tearDownServices()` function at line 1425:
1. **`saveLogs()`** — Streams container logs to `tests/logs/`
2. **`dockerComposeCmd('down ...')`** — Destroys all containers and volumes (unless DEBUG mode)

### Services Managed

```javascript
const SERVICES = {
  haproxy: 'haproxy',
  nginx: 'nginx',
  couchdb1: 'couchdb-1.local',
  couchdb2: 'couchdb-2.local',
  couchdb3: 'couchdb-3.local',
  api: 'api',
  sentinel: 'sentinel',
  'haproxy-healthcheck': 'healthcheck',
  'couchdb-nouveau': 'couchdb-nouveau',
};
```

### Connection Architecture

- **Constants** (`tests/constants.js`): `BASE_URL` = `https://localhost[:NGINX_HTTPS_PORT]`
- **Auth**: `admin:pass` hardcoded as defaults, passed via PouchDB `auth` option or Basic auth header
- **PouchDB clients**: Five database connections created at module level:
  - `db` → `medic-test`
  - `sentinelDb` → `medic-test-sentinel`
  - `usersDb` → `_users`
  - `logsDb` → `medic-test-logs`
  - `auditDb` → `medic-test-audit`
- **HTTP client**: Custom `request()` wrapper around `fetch()` with auth injection, JSON handling, X-Forwarded-For spoofing

### Helper Functions Available (Exported)

**Document operations**: `saveDoc`, `saveDocs`, `getDoc`, `getDocs`, `deleteDoc`, `deleteDocs`, `deleteAllDocs`, `saveMetaDocs`, `getMetaDocs`

**Settings management**: `updateSettings`, `revertSettings`, `getSettings`, `getDefaultSettings`, `setupUserDoc`

**Service control**: `stopSentinel`, `startSentinel`, `stopApi`, `startApi`, `stopHaproxy`, `startHaproxy`, `stopCouchDb`, `startCouchDb`

**Log monitoring**: `waitForApiLogs`, `waitForSentinelLogs`, `collectSentinelLogs`, `collectApiLogs`

**User management**: `createUsers`, `deleteUsers`, `getCreatedUsers`, `getUserSettings`, `loginUser` (internal)

**Utilities**: `request`, `delayPromise`, `deepFreeze`, `waitForDocRev`, `waitForIndexes`, `addTranslations`

### Test Patterns Observed

1. Tests import `@utils` (which is `tests/utils/index.js`) and use its helpers
2. Factory functions from `@factories/cht/*` create test documents
3. Tests use `utils.deepFreeze()` for immutable fixtures
4. `beforeEach`/`afterEach` hooks log test names via API
5. Tests clean up after themselves using `utils.revertDb()` and `utils.deleteUsers()`
6. 200-second timeout accommodates slow service startup

### What Needs to Change for agent-harness.js

The agent-harness wrapper must:

1. **No-op `prepServices` and `tearDownServices`** — Services are pre-running in the containerized agent environment. Skip Docker Compose generation, container startup, and teardown.

2. **Replace connection URLs** — Instead of `localhost` with Docker port mappings, connect to services by hostname:
   - `couchdb` (or `couchdb-1.local`) for CouchDB
   - `api` for CHT API
   - `postgres` for PostgreSQL (new)
   - `powersync` for PowerSync service (new)

3. **Keep `listenForApi()`** — Still useful to verify API is ready before tests run, but configure shorter timeout since services should already be up.

4. **Keep all helper functions** — `request()`, document CRUD, settings management, user management, and log utilities should all work unchanged since they use `constants.BASE_URL` which can be overridden via env vars.

5. **Add PostgreSQL client** — New `pg` Pool connection for direct PostgreSQL assertions (verify data in PG tables after operations).

6. **Add PowerSync client** — HTTP client for PowerSync management API (verify sync streams, check bucket assignments).

7. **New hooks file** — `tests/integration/postgresql/hooks.js` that uses agent-harness instead of the default hooks, with `beforeAll` that:
   - Verifies all services are reachable (CouchDB, API, PostgreSQL, PowerSync)
   - Runs `setupSettings`, `setUserContactDoc`, `loginUser`, `setupUserDoc` (same as existing)
   - Verifies PostgreSQL schema is ready

8. **New mocharc** — Points to PostgreSQL test specs and uses the new hooks file.

### Environment Variables for Agent Harness

```
COUCH_URL=https://admin:pass@couchdb:5984
API_URL=https://api:5988
POSTGRES_URL=postgresql://postgres:postgres@postgres:5432/cht
POWERSYNC_URL=http://powersync:8080
```

### Risk Areas

- **Module aliases** (`@utils`, `@constants`) must still resolve correctly — the aliases.js + jsconfig.json system is path-relative and should work from any working directory within the repo.
- **TLS certificates** — Existing tests set `NODE_TLS_REJECT_UNAUTHORIZED=0` for self-signed certs. Agent environment may use different cert setup.
- **PouchDB clients are module-level singletons** — They're created when `tests/utils/index.js` is first imported, using `constants.BASE_URL`. The harness must ensure env vars are set BEFORE the module is imported.
