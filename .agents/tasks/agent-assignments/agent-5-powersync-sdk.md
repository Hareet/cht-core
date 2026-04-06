# Agent 5: PowerSync Web SDK Angular Integration

## Objective
Integrate the PowerSync JavaScript Web SDK into CHT's Angular webapp, replacing PouchDB as the client-side data layer.

## Scope
- **Primary directory**: `webapp/` (PowerSync integration)
- **May read**: `shared-libs/cht-datasource/`, `.agents/skills/powersync/`
- **Do NOT modify**: `api/`, `sentinel/`, `shared-libs/cht-datasource/`

## Phase Dependency
Phase 3 (PowerSync running). SDK setup and client-side code can start at Phase 0.

## Tasks
1. Read PowerSync JS SDK docs: `.agents/skills/powersync/references/sdks/powersync-js.md`
2. Study CHT webapp's current PouchDB usage: `webapp/src/ts/` and `webapp/src/js/`
3. Identify all PouchDB API calls (allDocs, query, put, bulkDocs, changes)
4. Install `@powersync/web` and `@journeyapps/wa-sqlite` packages
5. Create PowerSync database initialization:
   - Define client-side schema matching Sync Streams tables
   - Implement `fetchCredentials()` for JWT token retrieval
   - Implement `uploadData()` write handler → CHT API
6. Create Angular service wrapping PowerSync:
   - Reactive queries (watch for changes)
   - Offline write queue
   - Sync status indicators
7. Wire PowerSync service into existing Angular components (progressive — start with contacts)
8. Implement `disconnectAndClear()` on logout
9. Write unit tests for PowerSync service

## Key Context
- CHT webapp is Angular (not React) — no hooks, use services + observables
- PouchDB currently stored in IndexedDB — PowerSync uses wa-sqlite (WASM SQLite)
- `connect()` is fire-and-forget; use `waitForFirstSync()` for readiness
- `transaction.complete()` is mandatory or upload queue stalls
- Client writes go to CHT API (not through PowerSync) — PowerSync is read+sync only
- Use `column.integer` for booleans, `column.text` for ISO dates

## Success Criteria
- PowerSync SDK initializes and connects to PowerSync Service
- Client-side SQLite populated via sync from PostgreSQL
- Contacts display correctly from PowerSync data
- Offline writes queue and sync when connectivity resumes
- `npm run unit-webapp` passes with new tests
