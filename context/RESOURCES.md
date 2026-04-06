# Key Resources & References

## MCP Servers (Installed)

### CHT Code Context (OpenDeepWiki)
Tools per repo: `get_document_catalog`, `read_document`, `search_documents`, `list_repositories`.

| Server | Key Areas |
|--------|-----------|
| `cht-core-wiki` | Replication, cht-datasource, rules engine, Sentinel, webapp |
| `cht-sync-wiki` | couch2pg, dbt models, PostgreSQL schema |
| `cht-conf-wiki` | Configuration compilation, purge.js, tasks.js |
| `cht-watchdog-wiki` | Monitoring, alerting |

Docs: https://docs.communityhealthtoolkit.org/ai/mcp-servers/cht-code-context-mcp-server/

### CHT Docs (Kapa AI)
Searches CHT docs site, forum posts, and GitHub issues. Docs: https://docs.communityhealthtoolkit.org/ai/mcp-servers/cht-docs-mcp-server/

### PowerSync Docs MCP
Searches PowerSync documentation. Additional resources:
- Full docs single file: https://docs.powersync.com/llms-full.txt
- Page index: https://docs.powersync.com/llms.txt
- Any page as markdown: append `.md` to URL

Docs: https://docs.powersync.com/tools/ai-tools

### PowerSync Agent Skills
PowerSync-specific agent context — APIs, patterns, best practices. Source: https://github.com/powersync-ja/agent-skills

---

## CHT Repositories and Documentation

| Resource | URL | Notes |
|----------|-----|-------|
| cht-core | https://github.com/medic/cht-core | Primary codebase. Node.js API + Angular PWA |
| cht-sync | https://github.com/medic/cht-sync | CouchDB→PostgreSQL bridge. The migration linchpin |
| cht-datasource | http://docs.communityhealthtoolkit.org/cht-datasource/ | API abstraction layer docs |
| CHT Architecture | https://docs.communityhealthtoolkit.org/technical-overview/architecture/cht-core/ | Current architecture overview with diagrams |
| CHT Sync Architecture | https://docs.communityhealthtoolkit.org/technical-overview/architecture/cht-sync/ | cht-sync technical details |
| CHT Purging | https://docs.communityhealthtoolkit.org/technical-overview/data/performance/purging/ | Purge function configuration |
| CHT Replication | https://docs.communityhealthtoolkit.org/technical-overview/data/performance/replication/ | Filtered replication docs |
| CHT Database Management | https://docs.communityhealthtoolkit.org/technical-overview/data/ | All database types and schemas |
| CHT App Settings | https://docs.communityhealthtoolkit.org/building/reference/app-settings/ | Configuration reference |
| CHT Sync Docker Setup | https://docs.communityhealthtoolkit.org/hosting/analytics/setup-docker-compose/ | Deployment guide |
| dbt Tuning | https://docs.communityhealthtoolkit.org/hosting/analytics/tuning-dbt/ | dbt performance optimization |
| CHT Forum | https://forum.communityhealthtoolkit.org/ | Community discussions |

## PowerSync Resources

| Resource | URL | Notes |
|----------|-----|-------|
| PowerSync Docs | https://docs.powersync.com | Main documentation |
| JavaScript Web SDK | https://docs.powersync.com/client-sdks/reference/javascript-web | Browser/PWA SDK |
| Sync Streams | https://docs.powersync.com/sync/overview | Filtering and bucket partitioning |
| PowerSync Protocol | https://docs.powersync.com/architecture/powersync-protocol | Wire protocol details |
| PowerSync Philosophy | https://docs.powersync.com/intro/powersync-philosophy | Design principles |
| Web SDK npm | https://www.npmjs.com/package/@powersync/web | @powersync/web package |
| JS SDK GitHub | https://github.com/powersync-ja/powersync-js | Source code, examples |
| Flutter Benchmarks | https://www.powersync.com/blog/how-fast-is-powersync-performance-benchmarks-for-flutter | Performance numbers |
| SQLite Web Persistence | https://www.powersync.com/blog/sqlite-persistence-on-the-web | VFS options for browsers |
| Web Support Announcement | https://www.powersync.com/blog/announcing-web-support | PWA capabilities |
| Healthcare Migration Case | https://www.powersync.com/blog/atlas-device-sync-migration-example-healthcare-app-moves-to-powersync | MongoDB→PowerSync in 2 weeks |
| PowerSync Pricing | https://www.powersync.com/pricing | Cloud and self-host options |
| Open Source Packages | https://www.powersync.com/open-source | License details |
| PowerSync GitHub Org | https://github.com/powersync-ja | All repositories |

## Reference Implementations

### CommCare (Dimagi) — CouchDB→PostgreSQL Migration
| Resource | URL | Notes |
|----------|-----|-------|
| Migration Guide | https://commcare-hq.readthedocs.io/couch_to_sql_models.html | Step-by-step dual-write pattern |
| Migrations in Practice | https://commcare-hq.readthedocs.io/migrations_in_practice.html | Practical migration guide |
| Architecture Overview | https://commcare-hq.readthedocs.io/overview/architecture.html | Full system architecture |
| Database Configuration | https://commcare-hq.readthedocs.io/databases.html | PL/Proxy sharding config |

### Simple.org — PostgreSQL Health Platform at Scale
| Resource | URL | Notes |
|----------|-----|-------|
| Simple.org | https://www.simple.org/ | ~7M patients, 5 countries |
| simple-server (Rails) | https://github.com/simpledotorg/simple-server | PostgreSQL backend |
| simple-android | https://github.com/simpledotorg/simple-android | Offline-first Android app |
| Offline-First Blog Post | https://www.simple.org/blog/offline-first-apps/ | Architecture rationale |
| API Docs | https://api.simple.org/api-docs | Swagger/OpenAPI spec |

### DHIS2 — PostgreSQL at National Scale
| Resource | URL | Notes |
|----------|-----|-------|
| PostgreSQL Setup | https://docs-new.dhis2.org/manage/how-to-guides/postgresql-setup.html | Tuning for scale |
| PostgreSQL Reference | https://docs.dhis2.org/en/manage/reference/postgresql.html | Configuration reference |

## CouchDB References

| Resource | URL | Notes |
|----------|-----|-------|
| Changes Feed API | https://docs.couchdb.org/en/stable/api/database/changes.html | cht-sync's data source |
| Filtered Replication Analysis | https://gareth.nz/couchdb-filtered-replication.html | Gareth Bowen's performance analysis |

## PostgreSQL References

| Resource | URL | Notes |
|----------|-----|-------|
| Row-Level Security | https://www.postgresql.org/docs/current/ddl-rowsecurity.html | Authorization at DB layer |
| Logical Replication | https://www.postgresql.org/docs/current/logical-replication.html | PowerSync reads from WAL |

## Comparison Resources

| Resource | URL | Notes |
|----------|-----|-------|
| ElectricSQL vs PowerSync vs Replicache | https://queryplane.com/docs/blog/electricsql-vs-powersync-vs-replicache | Sync engine comparison |

## Key GitHub Issues (CHT)

| Issue | URL | Relevance |
|-------|-----|-----------|
| Server-side purge | https://github.com/medic/cht-core/issues/5443 | Purge architecture |
| Task/target purging | https://github.com/medic/cht-core/issues/6181 | Hard-coded purge rules |
| Client purge implementation | https://github.com/medic/cht-core/issues/5048 | PouchDB purge patterns |
| Sensitive document filtering | https://github.com/medic/cht-core/issues/6660 | isSensitive replication logic |
| User replication monitoring | https://github.com/medic/cht-core/issues/6251 | Replication count limits |
| Read doc cleanup | https://github.com/medic/cht-core/issues/6116 | Per-user meta DB operations |
| facility_id authorization | https://github.com/medic/cht-core/issues/4774 | Authorization context source |
| Purge + replication crash | https://github.com/medic/cht-core/issues/5348 | IndexedDB failure during purge |

## CHT Sync Performance

### Quick Win: Fix the 2-3 Day Lag
```bash
# In cht-sync docker-compose environment variables:
DATAEMON_INTERVAL=120        # Poll dbt every 2 minutes (was daily)
DBT_THREADS=5                # Parallel dbt model execution  
DBT_BATCH_SIZE=500000        # Larger batch for incremental processing
```

### dbt Model Optimization
- Convert large materialized views to incremental tables
- Use `saved_timestamp` filtering for incremental processing
- Refresh concurrently to avoid locking: `REFRESH MATERIALIZED VIEW CONCURRENTLY`

## MCP Usage Patterns

### CHT Code Context MCP (OpenDeepWiki)
Always discover structure first, then drill down:
1. `get_document_catalog` (owner: "medic", name: "cht-core") — see the full wiki TOC
2. `search_documents` (owner: "medic", name: "cht-core", query: "replication") — find relevant pages
3. `read_document` (owner: "medic", name: "cht-core", path: "/path/from/catalog") — get details

Key areas to explore via cht-core-wiki:
- `api/src/services/` — replication logic, authorization
- `shared-libs/cht-datasource/` — the abstraction layer
- `shared-libs/rules-engine/` — task/target generation
- `sentinel/` — document transitions and workflows
- `webapp/src/ts/` — Angular client-side code

Key areas via cht-sync-wiki:
- couch2pg pipeline and continuous changes feed
- dbt model definitions
- PostgreSQL schema for analytics

### PowerSync MCP
Use to look up:
- Sync Streams / Sync Rules syntax and configuration
- JavaScript Web SDK initialization and API
- Write handler (uploadData) patterns
- wa-sqlite VFS options (OPFSCoopSyncVFS, IDBBatchAtomicVFS)
- Self-hosting configuration
- Performance benchmarks and limits