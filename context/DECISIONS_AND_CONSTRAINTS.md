# Architectural Decisions & Constraints

## Hard Constraints (Non-Negotiable)

1. **Offline-first**: CHWs collect data without connectivity. Any solution must support full offline form submission with reliable sync on reconnect. This is the core value proposition of CHT.

2. **Progressive Web App**: CHT runs as a PWA in Android Chrome, NOT a native app. Any client-side solution must work in browser context (Service Workers, IndexedDB/OPFS, no native APIs).

3. **Low-end devices**: Target devices are 1-2GB RAM Android phones. Solutions must work within severe memory and storage constraints. PowerSync's OPFSCoopSyncVFS is recommended for production.

4. **Angular framework**: CHT webapp is Angular + NgRx. PowerSync has an Angular demo confirming compatibility, but integration work is needed.

5. **Partner configurability**: CHT deployments are configured per partner via `app_settings.json`, custom forms, and `purge.js`. The migration cannot break this configurability — partners must be able to define custom purge logic, task rules, and target definitions.

6. **47 Kenya instances → 1**: The migration must eventually consolidate 47 separate county CouchDB instances into a single national PostgreSQL instance. This is the scalability goal.

7. **Data sovereignty**: Health data for Kenya eCHIS must remain within approved infrastructure. Self-hosting capability required.

## Soft Constraints (Strong Preferences)

1. **Fall 2027 target deadline**: Government handover timeline. Not a hard cutoff but strong political and organizational pressure.

2. **Minimize CHP disruption**: The app experience should not change for community health workers. "What CHPs see and use on their phones — the app experience — does not change."

3. **MoH maintainability**: The resulting system should be operable by MoH technical teams without specialized CouchDB expertise. PostgreSQL is widely understood.

4. **Open source**: CHT belongs to a global community of 47 organizations across 24 countries. Solutions should be open source or have clear open-source paths.

## Key Architectural Decisions Made

### AD-001: PowerSync over Custom REST Sync
**Decision**: Use PowerSync as the client sync engine rather than building custom REST sync.
**Rationale**: 5x cost advantage ($120K vs $637K over 5 years), 3-6 month timeline advantage, eliminates O(N²) filtered replication. Sync semantics gaps (purge, rules engine) are addressable with preprocessing layers.
**Risks**: Vendor dependency (mitigated by Apache 2.0 client SDKs, self-host option). SQL-based Sync Streams can't express arbitrary JS logic (mitigated by purge preprocessing).
**Revisit if**: PoC reveals Sync Streams can't handle CHT authorization at scale.

### AD-002: cht-sync as Migration Bridge
**Decision**: Evolve cht-sync from analytics replicator to real-time operational sync engine.
**Rationale**: Already deployed on all 47 instances. Continuous changes feed already near real-time. Proven PostgreSQL schema exists. Incremental evolution vs greenfield.
**Key change**: Reduce DATAEMON_INTERVAL from daily to 60-300 seconds. Convert materialized views to incremental dbt models.

### AD-003: Hybrid JSONB + Normalized Schema
**Decision**: Preserve full CouchDB documents as JSONB while building normalized tables via dbt.
**Rationale**: JSONB provides schema flexibility during transition (no data loss). Normalized tables provide query performance. Generated columns enable indexing of frequently queried JSONB fields. dbt handles transformation without expensive ALTER TABLE operations.
**Trade-off**: ~2x storage vs pure normalized, but preserves all data and enables gradual migration.

### AD-004: Phased Regional Rollout (Not Big-Bang)
**Decision**: 5 cohorts of 8-12 counties each, ~8 months total.
**Rationale**: CommCare's lesson — don't rush. Pilot with small counties first, progressively increase complexity. Parallel migrations within cohort for efficiency.
**Rollback**: Per-county rollback capability for 3 months post-migration.

### AD-005: Purge Preprocessing Service
**Decision**: Run purge.js server-side, write results to purge_status table, reference in Sync Streams.
**Rationale**: PowerSync Sync Streams are SQL-only. CHT's purge.js is Turing-complete JavaScript evaluated against document relationships. The preprocessing layer bridges these models.
**Schedule**: Nightly (matching current CHT purge cadence). Can increase frequency if latency acceptable.
**Risk**: Stale purge status between runs. Mitigated by purge changes being additive (once purged, stays purged) and nightly cadence matching current behavior.

### AD-006: Server-Authoritative Conflict Resolution
**Decision**: PostgreSQL server is authoritative for all conflict resolution. No client-side merge.
**Rationale**: Matches CHT's current model (CouchDB server is source of truth). PowerSync's upload queue is FIFO with server-side validation. Simplifies conflict handling vs CouchDB's revision tree.
**Implementation**: Write handler validates data server-side, rejects invalid writes, applies business rules (Sentinel-equivalent).

## Decisions Deferred to PoC

### PD-001: PL/Proxy Sharding
**Question**: Does CHT need PostgreSQL sharding at the 100K+ user scale?
**Options**: Single large instance with read replicas, PL/Proxy with 1024 shards, Citus distributed PostgreSQL
**Decision criteria**: Measure query performance at 100K users with realistic data volume. DHIS2 runs 100K+ users on a single tuned instance. Sharding may be unnecessary.

### PD-002: PowerSync Cloud vs Self-Hosted
**Question**: Use PowerSync Cloud (managed) or self-host Open Edition?
**Options**: Cloud Pro ($49/mo + usage), Cloud Team ($599/mo + usage), Self-hosted Open Edition
**Decision criteria**: Data sovereignty requirements, operational capacity, cost at scale. Start with Cloud for PoC, evaluate self-hosting for production.

### PD-003: Sentinel Replacement Strategy
**Question**: How do Sentinel transitions work in a PostgreSQL-primary world?
**Options**: PostgreSQL triggers, event-driven service consuming WAL changes, keep Sentinel reading from PostgreSQL
**Decision criteria**: Depends on Phase 2 real-time write architecture. Sentinel currently watches CouchDB changes feed — could watch PostgreSQL logical replication instead.

### PD-004: Rules Engine Client Storage
**Question**: How does the rules engine generate tasks/targets with PowerSync SQLite instead of PouchDB?
**Options**: Adapt rules engine to SQLite queries, run rules engine server-side and sync results, hybrid (rules engine uses PowerSync read + write)
**Decision criteria**: Performance on low-end devices. Rules engine must remain client-side for offline-first. Highest code migration effort (~6-8 weeks).

## Organizational Context

### Key Stakeholders
- **Tom**: Engineering voice arguing CouchDB is replaceable (CHT doesn't use native sync)
- **Diana**: Engineering voice arguing migration is massive undertaking (pragmatic risk concern)
- **Dykki**: Relationship/communications role managing donor expectations
- **Andra**: Synthesis role (blog post strategy, layered timeline framing)
- **Derick**: Ground-level implementation representative
- **Gareth (Bowen)**: Original filtered replication performance analysis

### Tension Points
- Engineering reality vs stakeholder/donor expectations on timeline
- Storage bloat is a compaction/upgrade bug, not genuine data growth — framing matters
- "Mixed architecture" proposed by powerful donor champion, unanimously rejected by engineering
- Mid-term politics: "always easier to sell the challenger" — CouchDB replacement narrative must be managed carefully
- External messaging must not overstate CouchDB's indispensability (per Tom's correction) or box the team into keeping it

### Recommended External Messaging
> "Storage costs are driven by provisioning overhead, not data volume. We're fixing that now. Longer term, we're building the architecture to evolve the database layer, but we won't rush that at the expense of the offline-first capability that makes CHT work in your counties."