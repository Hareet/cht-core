# Agent 1: cht-datasource PostgreSQL Adapter + Feature Flag

## Iteration 2 — Hardening + Production Feature Flag

### Objective
Harden the cht-datasource PostgreSQL adapter (from Iteration 1) and implement a **server-side feature flag system** that controls per-facility PowerSync rollout. This flag gates whether the API returns PowerSync JWT tokens or falls back to CouchDB replication.

**Why this matters**: Production rollout must be controllable per-facility. If Go edition devices in one facility have problems, operators need to disable PowerSync for that facility without affecting others.

## Scope
- **Primary directory**: `shared-libs/cht-datasource/`
- **May modify**: `api/` (feature flag endpoint, JWT issuing), `api/src/services/` (new feature-flags service)
- **Do NOT modify**: `sentinel/`, `webapp/`, `tests/integration/`

## Phase Dependency
Phase 2 (PostgreSQL running). Feature flag code can start at Phase 0.

## Iteration 1 Work — Review Before Continuing
Read existing PG adapter code in `shared-libs/cht-datasource/src/`. Check git log for recent fixes (SQL injection fix, report hydration from Iteration 1 logs).

## Tasks

### Continuing: PG Adapter Hardening
1. **Review and fix** any remaining issues from Iteration 1 (SQL injection, query performance)
2. **Connection pool tuning**: Ensure pool settings work for national-scale (100K users):
   - `max: 20` (default), configurable via `CHT_PG_POOL_MAX`
   - Idle timeout, connection timeout, statement timeout
3. **Query performance**: Add EXPLAIN ANALYZE for common queries at scale. Ensure indexes exist.
4. **Backward compatibility**: Verify `CHT_DB_BACKEND=couchdb` still works unchanged

### NEW: Feature Flag System
5. **Design feature flag in `app_settings`**:
   ```json
   {
     "powersync": {
       "enabled": false,
       "facilities": [],
       "rollout_percentage": 0
     }
   }
   ```
   - `enabled: true` + empty `facilities` = enabled for ALL
   - `enabled: true` + `facilities: ["facility-uuid-1"]` = enabled only for listed facilities
   - `rollout_percentage` = gradual rollout (0-100, consistent hash of user_id)

6. **Create feature flag service**: NEW `api/src/services/feature-flags.js`
   - `isFeatureEnabled(feature, userCtx)` → boolean
   - Reads from `app_settings` (already cached in API)
   - For PowerSync: checks `powersync.enabled`, `powersync.facilities` against user's `facility_id`

7. **Gate PowerSync JWT issuance**: MODIFY `api/src/controllers/powersync-upload.js` or auth endpoint
   - Before issuing PowerSync JWT: `if (!isFeatureEnabled('powersync', userCtx)) return 403`
   - Client (Agent 5) checks for 403 and falls back to PouchDB

8. **Admin API for feature flag management**: NEW endpoint `PUT /api/v1/admin/feature-flags/powersync`
   - Body: `{ enabled, facilities, rollout_percentage }`
   - Requires admin role
   - Updates `app_settings` in database
   - Returns current state

### Testing
9. **Unit tests**: Feature flag service with various configs (all enabled, facility-scoped, percentage rollout)
10. **Integration test**: JWT issuance gated by feature flag
11. Run `npm run unit-api` and `npm run unit-shared-lib` after each change

## Key Context
- `app_settings` is stored in CouchDB as a doc, cached in API memory, synced to clients
- Existing feature flags in CHT: check `api/src/services/` for patterns to follow
- Agent 5 consumes this flag client-side: if PowerSync JWT returns 403, instantiate PouchDB instead
- The flag must support per-facility granularity (47 counties in Kenya, rollout by county)

## Success Criteria
- PG adapter: all existing unit tests pass, no SQL injection, connection pooling configured
- Feature flag: `isFeatureEnabled('powersync', userCtx)` correctly evaluates against app_settings
- JWT gating: PowerSync JWT only issued when feature enabled for user's facility
- Admin endpoint: feature flag can be toggled per-facility via API
- `CHT_DB_BACKEND=couchdb` still works unchanged (backward compat)
- `npm run unit-api` and `npm run unit-shared-lib` pass
