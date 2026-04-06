# Task Registry — CHT PostgreSQL Migration

## Active Assignments

| Agent | Branch | Task | Phase Dep | Status | Merge Order |
|-------|--------|------|-----------|--------|-------------|
| 1 | playtime-agent-1-cht-datasource | PostgreSQL adapter for cht-datasource | Phase 2 | NOT_STARTED | 1st |
| 2 | playtime-agent-2-sentinel | Sentinel PostgreSQL transition support | Phase 2 | NOT_STARTED | 3rd |
| 3 | playtime-agent-3-sync-streams | Sync Streams YAML for CHT hierarchy | Phase 3 | NOT_STARTED | 5th |
| 4 | playtime-agent-4-purge-preproc | Purge preprocessing service | Phase 2 | NOT_STARTED | 2nd |
| 5 | playtime-agent-5-powersync-sdk | PowerSync Web SDK Angular integration | Phase 3 | NOT_STARTED | 6th |
| 6 | playtime-agent-6-rules-engine | Rules engine SQLite adapter | Phase 3 | NOT_STARTED | 7th |
| 7 | playtime-agent-7-integration | Integration tests for PG code paths | Phase 2 | NOT_STARTED | 4th |

## Dependency Graph

```
Agent 1 (cht-datasource) ──┬──> Agent 2 (sentinel) ──> Agent 7 (integration)
                           │
Agent 4 (purge-preproc) ───┘

Agent 5 (powersync-sdk) ──> Agent 6 (rules-engine)

Agent 3 (sync-streams) — independent
```

## Merge Queue

| Branch | Merged To | Date | Notes |
|--------|-----------|------|-------|
| (none yet) | | | |

## File Ownership

| Agent | Primary Directories | May Read |
|-------|-------------------|----------|
| 1 | `shared-libs/cht-datasource/` | `api/`, `sentinel/` |
| 2 | `sentinel/` | `shared-libs/cht-datasource/` |
| 3 | `.devcontainer/powersync-config/` | `context/`, `couchdb/` |
| 4 | `services/purge-preproc/` (new), `shared-libs/purging-utils/` | `api/`, `sentinel/` |
| 5 | `webapp/` (PowerSync integration) | `shared-libs/cht-datasource/` |
| 6 | `shared-libs/rules-engine/` | `webapp/`, `shared-libs/cht-datasource/` |
| 7 | `tests/` | Everything (read all, write only tests) |
