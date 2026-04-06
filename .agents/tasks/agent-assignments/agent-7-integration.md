# Agent 7: Integration Tests for PostgreSQL Code Paths

## Objective
Build integration tests that validate the PostgreSQL migration path end-to-end. These tests verify that Agents 1, 2, 4 (server-side) and Agents 5, 6 (client-side) produce correct behavior.

## Scope
- **Primary directory**: `tests/` (integration tests)
- **May read**: Everything in the repository
- **Do NOT modify**: Any source code outside `tests/`

## Phase Dependency
Phase 2 (PostgreSQL running) for server-side tests. Phase 3 for client-side sync tests.

## Tasks
1. Study existing integration test framework: `tests/utils/index.js`, `tests/integration/`
2. Create agent-compatible test harness (`tests/utils/agent-harness.js`):
   - No-op `prepServices`/`tearDownServices` (services already running)
   - Connect to services via hostname (couchdb, api, postgres, powersync)
   - Keep all existing helper functions (setupSettings, loginUser, etc.)
3. Write cht-datasource PostgreSQL adapter tests:
   - CRUD operations via PostgreSQL backend
   - Query by document type, facility, reported_date
   - Changes feed / polling mechanism
4. Write Sentinel PostgreSQL transition tests:
   - Document state transitions via PG backend
   - Changes detection mechanism
5. Write purge preprocessing tests:
   - Purge evaluation produces correct purge_status entries
   - Incremental processing works correctly
6. Write cht-sync bridge tests:
   - Documents written to CouchDB appear in PostgreSQL via cht-sync
   - Verify data integrity and schema correctness
7. Write PowerSync sync tests (Phase 3):
   - Documents sync from PG through PowerSync to client
   - Filtered sync respects facility hierarchy
   - Purge exclusions work end-to-end

## Key Context
- Existing integration tests use `docker compose` for service management — you CANNOT use this
- The `agent-harness.js` wrapper skips Docker operations, assumes services are pre-running
- Use environment variables for service URLs: `COUCH_URL`, `POSTGRES_URL`, `API_URL`
- Tests should be additive (new files) not modifications of existing test files
- Follow existing mocha/chai patterns from `tests/integration/`

## Ralph Wiggum Loop
This agent is ideal for a continuous test loop:
1. Run all PostgreSQL integration tests
2. On failure: log which tests failed, create detailed failure report
3. Check if other agents committed new code (git fetch worktree branches)
4. Re-run tests to validate other agents' latest changes
5. Repeat

## Success Criteria
- `agent-harness.js` correctly wraps existing test framework for containerized agents
- Server-side tests pass against PostgreSQL (cht-datasource, Sentinel, purge)
- cht-sync bridge test validates CouchDB → PostgreSQL data flow
- All tests are self-contained and can run independently
- Test results clearly indicate which agent's code caused failures
