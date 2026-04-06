# CHT PostgreSQL Migration — Claude Code Context

## What This Project Is

We are evaluating and prototyping the migration of the Community Health Toolkit (CHT) from CouchDB/PouchDB to PostgreSQL as the primary data layer. The CHT powers Kenya's eCHIS deployment serving 100,000+ community health workers across 47 county instances. The goal is a single national PostgreSQL instance replacing 47 separate CouchDB instances.

## Available MCP Servers & Agent Skills

Use these proactively — query live docs and code architecture instead of relying on training data.

### CHT Code Context (OpenDeepWiki)
Tools: `get_document_catalog`, `read_document`, `search_documents`, `list_repositories`. Always specify `owner=medic` and the repo `name`.

| Server | Use For |
|--------|---------|
| `cht-core-wiki` | Replication logic, cht-datasource, rules engine, Sentinel, Angular webapp |
| `cht-sync-wiki` | couch2pg pipeline, dbt models, PostgreSQL schema |
| `cht-conf-wiki` | Configuration compilation, purge.js, tasks.js, targets.js |
| `cht-watchdog-wiki` | Monitoring and alerting |

**Query pattern**: `get_document_catalog` → `search_documents` → `read_document`

### CHT Docs (Kapa AI)
Searches CHT documentation site, forum posts, and GitHub issues. "What the docs say" vs code context's "how the code works."

### PowerSync Docs MCP
Searches PowerSync documentation. Use for Sync Streams syntax, SDK APIs, write handler patterns, VFS options, deployment config. Append `.md` to any PowerSync docs URL for markdown (e.g., `https://docs.powersync.com/sync/overview.md`).

### PowerSync Agent Skills
PowerSync-specific context for AI agents — APIs, patterns, best practices. https://github.com/powersync-ja/agent-skills

### Tool Routing

| Task | Use |
|------|-----|
| CHT replication internals | `cht-core-wiki` → search "replication" |
| purge.js arguments and behavior | `cht-core-wiki` → search "purge" OR CHT Docs MCP |
| cht-sync data pipeline | `cht-sync-wiki` → search "dbt" or "couch2pg" |
| PowerSync Sync Streams SQL | PowerSync Docs MCP |
| PowerSync web SDK | PowerSync Docs MCP or Agent Skills |
| CHT configuration reference | CHT Docs MCP |
| cht-datasource abstraction | `cht-core-wiki` → search "cht-datasource" |

## Context Documents

The following documents in this directory provide deep background from our research:

| Document | Contents |
|----------|----------|
| `RESEARCH_DISCOVERY_LOG.md` | Chronological investigation path across 7 phases — what was evaluated, rejected, and why |
| `IMPLEMENTATION_GUIDE.md` | PostgreSQL schemas, PowerSync Sync Streams YAML, purge preprocessing code, cht-datasource adapter, write handler |
| `DECISIONS_AND_CONSTRAINTS.md` | Hard constraints, architectural decisions with rationale, deferred decisions, organizational context |
| `RESOURCES.md` | All repository URLs, documentation links, GitHub issues, and MCP usage notes |
| `POWERSYNC_ANALYSIS.md` | Full PowerSync vs Custom REST Sync comparison with sync semantics gap analysis |
| `CHT_ARCHITECTURE_ROADMAP.md` | Medic's official 2026-2027 roadmap for the CouchDB→PostgreSQL transition |

## Key Repositories

- **cht-core**: https://github.com/medic/cht-core — Primary CHT codebase (Node.js, Angular PWA)
- **cht-sync**: https://github.com/medic/cht-sync — CouchDB → PostgreSQL replication (the migration linchpin)
- **cht-datasource**: `@medic/cht-datasource` within cht-core — API abstraction layer being expanded
- **PowerSync JS SDK**: https://github.com/powersync-ja/powersync-js — Client sync engine
- **PowerSync Service**: Self-hosted sync service (FSL licensed, converts to Apache 2.0 after 2 years)

## Architecture Context

### Current State
```
CHT Mobile Client (Angular PWA in Android browser)
├── PouchDB (IndexedDB) — local data store
├── Custom v5 replication algorithm (NOT CouchDB native sync)
└── Offline form submission + background sync

CHT Server
├── API (Node.js) — custom filtered replication endpoint
├── Sentinel — document transitions/workflows on change
├── CouchDB — primary data store + 47 per-county instances
└── cht-sync → PostgreSQL (analytics, currently 2-3 day lag)
```

### Target State
```
CHT Mobile Client (Angular PWA)
├── PowerSync SDK + wa-sqlite (WASM SQLite in browser)
├── Sync Streams (server-filtered bucket replication)
└── Upload queue (persistent offline writes)

CHT Server
├── API (Node.js) — write handler for PowerSync uploads
├── Sentinel — adapted for PostgreSQL triggers
├── PostgreSQL — single national instance (primary)
├── PowerSync Service — sync engine (reads PostgreSQL WAL)
└── cht-sync — retained during transition for CouchDB→PG bridge
```

### Critical Insight: CHT v5 Already Decoupled from CouchDB Sync
Tom (CHT engineer) pointed out that CHT does NOT use CouchDB's built-in sync protocol. The v5 replication algorithm is custom — it calls `GET api/replication/get-ids` which queries a CouchDB view, filters purged docs, and returns doc IDs. The client then fetches docs via `POST medic/_bulk_get`. This means the server-side database CAN be swapped without rewriting the client sync protocol — the abstraction point already exists at the API layer.

## The cht-sync Pipeline (Migration Linchpin)

cht-sync is how we get from CouchDB to PostgreSQL. Current architecture:

```
CouchDB → couch2pg (continuous changes feed) → PostgreSQL (JSONB) → dbt (transformation) → Normalized tables
```

**Key finding: The reported "2-3 day lag" is a configuration issue, not architectural.** couch2pg writes to PostgreSQL in near real-time via CouchDB's continuous changes feed. The lag comes from `DATAEMON_INTERVAL` being set too high for dbt batch runs. Reducing to 60-300 seconds achieves <5 second end-to-end latency without architectural changes.

### cht-sync PostgreSQL Schema
```sql
CREATE TABLE couchdb (
  uuid TEXT PRIMARY KEY,
  doc_id TEXT,
  doc JSONB,              -- Full CouchDB document preserved
  saved_timestamp TIMESTAMP DEFAULT NOW(),
  source VARCHAR,
  seq TEXT
);
```

dbt transforms this into normalized tables for analytics. For application workloads, we extend with generated columns and proper indexes.

## Decision Log

### Ruled Out
- **RxDB**: Dropped PouchDB support, CouchDB sync limitations, browser constraints at CHT scale
- **WatermelonDB**: Browser implementation uses in-memory LokiJS (catastrophic for large datasets), no CouchDB sync compatibility
- **Electric SQL**: 2025 rewrite removed bidirectional sync — unsuitable for offline data collection
- **Big-bang CouchDB replacement**: Too risky. Phased migration following CommCare's 8-year model-by-model pattern

### Selected: PowerSync + PostgreSQL
- **PowerSync** identified as leading sync engine candidate
- Production-ready with healthcare deployments
- JavaScript Web SDK with Angular compatibility confirmed
- wa-sqlite for browser-side SQLite (WASM)
- Sync Streams for server-side filtered replication (eliminates O(N²) CouchDB scanning)
- Self-hostable, client SDKs Apache 2.0

### Known PowerSync Sync Semantics Gaps
PowerSync eliminates the performance bottleneck but CANNOT natively handle all CHT sync scenarios:

1. **Custom purge functions (purge.js)** — Turing-complete JS evaluated against document relationships. Cannot express in SQL Sync Stream rules. REQUIRES: Server-side purge preprocessing service writing to `purge_status` table. (~4-6 weeks)

2. **Role-based replication depth** — Configurable per deployment/role. REQUIRES: JWT parameterization with `replication_depth` claim + recursive CTE in Sync Streams. (~1 week)

3. **Task/target documents (rules engine)** — Rules engine writes to PouchDB, reads back. REQUIRES: Adapting rules engine to use PowerSync SQLite queries instead of PouchDB allDocs/query. (~6-8 weeks, highest code migration effort)

4. **Configuration documents** — Global docs (app_settings, forms, translations) sync to ALL users. REQUIRES: Dedicated global Sync Stream with no user filtering. (~1 week)

5. **Per-user meta databases** — CHT uses `medic-user-{username}-meta` for feedback/telemetry. PowerSync has no per-user DB concept. REQUIRES: Collapse into single table + user_id filtering. Actually an operational improvement. (~2-3 weeks)

6. **Sensitive/private documents** — Reports with `fields.private = 'yes'`. Maps cleanly to SQL WHERE clause. ✅ No issue.

7. **Authorization filtering (core perf win)** — PowerSync bucket partitioning eliminates full-database scans. ✅ This is the big win.

## CHT Document Types and Sync Model

### Document Types
- **contacts**: Persons, clinics, health_centers, districts (hierarchical via `parent` field)
- **reports**: Form submissions (pregnancy registration, home visits, assessments)
- **tasks**: Generated client-side by rules engine, terminal states purged after 60 days
- **targets**: Performance indicators per reporting period, purged after 6 months
- **messages**: SMS messages sent/received
- **feedback**: Error reports from client (stored in per-user meta DB)
- **telemetry**: Usage/performance metrics (stored in per-user meta DB)
- **read status**: Tracks which docs user has opened (per-user meta DB)

### Authorization Model
- Users are assigned a `facility_id` (their place in the hierarchy)
- `replication_depth` per role determines how many levels down they see
- `docs_by_replication_key` CouchDB view indexes documents by their replication key (usually facility or patient)
- Server-side purge runs `purge.js` per (role, contact, reports) tuple
- Sensitive documents (`private: true`) excluded from subordinate users
- ~10,000 doc replication limit warning per user

### Hierarchy
```
National
└── County (47 in Kenya)
    └── Sub-county
        └── Facility (health_center)
            └── CHW Area (clinic)
                └── Household
                    └── Patient (person)
```

## Reference Implementations

### CommCare (Dimagi) — CouchDB→PostgreSQL Migration
- Took ~8 years, model-by-model approach
- Dual-write mixin pattern: `SyncCouchToSQLMixin` / `SyncSQLToCouchMixin`
- Minimum 3 separate deployments per model migration
- PL/Proxy sharding with immutable shard count (must be power of 2, recommend 1024)
- Kafka-based change propagation
- Key lesson: Don't rush. Extended validation period essential.

### Simple.org — PostgreSQL at National Health Scale
- ~7 million patients across 5 countries, 5,000+ facilities
- PostgreSQL backend, offline-first Android app, REST API sync
- Bi-temporal modeling for conflict resolution
- UUID-based offline ID generation
- Facility-scoped selective sync
- 13-second follow-up data entry (83s new registration)
- Valuable as reference architecture, not reusable code

### DHIS2 — PostgreSQL Tuning for 100K+ Users
- Essential config: `work_mem=20MB`, `shared_buffers=3GB`, `jit=off`
- Up to 5 read replicas for analytics workload separation
- 64GB+ RAM, 16+ CPU cores recommended at national scale

## Timeline

- **Phase 1 (Now)**: v5.x upgrades complete, data archiving to PostgreSQL, refactor largest CouchDB indexes, expand cht-datasource
- **Phase 2 (2026)**: Real-time transactional writes to PostgreSQL (fix cht-sync lag), enable cht-datasource to use PostgreSQL directly
- **Phase 3 (2026-2027)**: Workflow migration based on evidence, PowerSync client deployment, pilot in 2+ counties, prove 100K+ single instance
- **Phase 4 (2027)**: Complete CouchDB retirement, government handover
- **Target deadline**: Fall 2027

## What to Build in This Session

Use the CHT and PowerSync MCPs to:
1. Explore cht-sync's current PostgreSQL schema and identify what needs to change for application workloads
2. Prototype PowerSync Sync Streams rules for CHT's hierarchical authorization model
3. Test the purge preprocessing pattern (purge.js → purge_status table → Sync Stream exclusion)
4. Evaluate PowerSync Web SDK integration points with CHT's Angular webapp
5. Prototype the cht-datasource PostgreSQL adapter
6. Validate recursive CTE performance for replication depth at scale