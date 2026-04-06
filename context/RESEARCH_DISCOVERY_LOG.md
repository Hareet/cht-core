# Research Discovery Log

This documents the full investigation path for the CHT CouchDB→PostgreSQL migration, in chronological order of discovery. Each section represents a research phase with findings, dead ends, and decisions.

---

## Phase 1: Client-Side Database Alternatives

### Question: Can we replace PouchDB on the client with something better?

**RxDB Evaluation**
- RxDB removed native PouchDB storage adapter as of v13+
- RxDB's CouchDB plugin implements a custom protocol, NOT the official CouchDB replication protocol
- No attachment replication support, different conflict resolution timing
- HTTP/1.1 concurrent connection limits in browser
- **Verdict: REJECTED.** Abandoning PouchDB requires either abandoning CouchDB or accepting significant replication limitations.

**WatermelonDB Evaluation**
- Superior mobile performance (275ms initial render vs PouchDB's 826ms)
- Uses completely custom sync protocol incompatible with CouchDB
- **Critical disqualifier**: Browser/PWA implementation uses in-memory LokiJS, NOT persistent storage. At CHT's scale (thousands of documents per user), this would be catastrophic — data lost on tab close.
- Zero CouchDB compatibility, no healthcare encryption, rigid schema
- **Verdict: REJECTED.** Browser limitation is a dealbreaker for CHT's PWA architecture.

**Dexie.js Evaluation**
- Requires either Dexie Cloud (vendor lock-in) or custom sync implementation
- No CouchDB compatibility
- **Verdict: NOT PURSUED further** — custom sync needed anyway.

### Key Insight from This Phase
The client-side database isn't the real problem. The problem is the server-side CouchDB and the filtered replication pattern. Optimizing the client won't fix O(N²) server-side document scanning.

---

## Phase 2: Server-Side Architecture — The Real Bottleneck

### Question: What actually causes the performance problems?

**Gareth Bowen's filtered replication analysis** (gareth.nz)
- CHT's custom replication queries `medic/docs_by_replication_key` CouchDB view
- 25% of CPU time wasted querying which documents have been purged BEFORE any actual data filtering
- CouchDB's download-then-filter model: fetch every document from disk, serialize to JSON, pass to filter function
- Performance degrades quadratically as users and documents grow

**Tom's critical correction** (CHT forum discussion)
- "The CHT does not even use CouchDB's sync, it has its own custom protocol"
- CHT v5 replication algorithm abandons CouchDB's native replication
- This is actually *harder* to scale because it assumes CouchDB as backend
- Sharp question: "Are we now saying that we are 100% committed to server side CouchDB indefinitely, because we need the offline sync functionality that the CHT isn't using?"

**Diana's pragmatic response**
- Doesn't disagree that CouchDB *could* be replaced
- Argues the project is "the largest project Medic has ever undertaken — 1-2 years minimum"
- Pragmatic objection (cost/benefit), not technical refutation

**Storage bloat reality**
- Kenya eCHIS: 200TB provisioned CouchDB storage vs ~2TB actual data needed
- Driven by compaction bugs and upgrade issues, not genuine data growth
- CouchDB indexes are orders of magnitude larger than PostgreSQL equivalents
- CouchDB's append-only model requires 2x storage during compaction

### Key Insight from This Phase
The v5 custom replication algorithm IS the abstraction point. Because CHT already doesn't use CouchDB's native sync, the server-side database can be swapped. The performance problem is structural (CouchDB architecture), not tuneable.

---

## Phase 3: PostgreSQL Client-Side Cache Pattern

### Question: What's the best way to get data from PostgreSQL to client browsers?

**PowerSync Deep Dive**
- Production-ready sync engine: PostgreSQL ↔ SQLite
- Uses PostgreSQL logical replication (WAL) for change detection
- Sync Streams (formerly Sync Rules) partition data into buckets server-side
- Clients request only their assigned buckets — filter-before-download
- wa-sqlite for browser WASM SQLite, with multiple VFS options
- Angular demo app exists, confirming framework compatibility
- Published benchmarks: 10K rows in 1.4s, 100K in 21.8s, 1M in 344s
- Healthcare case study: app migrated from MongoDB Realm in 2 weeks
- JourneyApps backing (10+ years production), client SDKs Apache 2.0
- Self-hostable Open Edition available
- **Verdict: SELECTED as leading candidate**

**Electric SQL Evaluation**
- 2025 rewrite ("Electric Next") removed bidirectional sync entirely
- Read-only sync only — unusable for CHT's offline form submission
- PGlite (WASM) approach, not SQLite
- **Verdict: REJECTED.** No write-path sync.

**Supabase Realtime/Offline**
- Adding offline-first features but immature
- Cloud-dependent for real-time features
- Row-level security available but offline support insufficient
- **Verdict: NOT PURSUED** — not production-ready for offline-first healthcare.

### Key Insight from This Phase
PowerSync's bucket architecture directly addresses CHT's O(N²) filtered replication problem. The combination of cht-sync (CouchDB→PostgreSQL bridge already running on all 47 instances) and PowerSync (PostgreSQL→client sync) creates the complete pipeline.

---

## Phase 4: cht-sync Evolution Analysis

### Question: How does cht-sync become the backbone of the new data layer?

**cht-sync Current Architecture**
- Layer 1: couch2pg (Node.js, continuous CouchDB changes feed → PostgreSQL JSONB)
- Layer 2: PostgreSQL raw storage (couchdb table with doc JSONB column)
- Layer 3: dbt transformation (JSONB → normalized tables, incremental models)
- Deployed via Docker Compose on every eCHIS instance

**The 2-3 Day Lag Discovery**
- couch2pg writes to PostgreSQL in near real-time (continuous changes feed)
- The lag comes from `DATAEMON_INTERVAL` — the polling interval for dbt runs
- If set to daily (86400s), dbt transformation waits a full day
- **Fix**: Reduce to 60-300 seconds + convert large materialized views to incremental tables
- Expected improvement: 2-3 days → <5 seconds without architectural changes
- This is the single most impactful quick win

**Phase 2 Real-Time Writes Architecture**
- Enhance continuous feed with exponential backoff reconnection, circuit breaker
- Transactional outbox pattern for reliable writes
- Bidirectional sync infrastructure (PostgreSQL trigger → reverse sync to CouchDB during transition)
- Hybrid JSONB + normalized schema via dbt incremental models

### Key Insight from This Phase
cht-sync already provides 90% of Phase 2 capabilities. The continuous changes feed enables real-time replication. The "2-3 day lag" is a configuration issue, not an architecture limitation.

---

## Phase 5: Reference Implementation Study

### CommCare (Dimagi) — 8-Year Migration

**Migration Pattern: Model-by-Model with Dual-Write Mixins**
- `SyncCouchToSQLMixin`: Primary write to CouchDB, async sync to PostgreSQL
- `SyncSQLToCouchMixin`: Primary write to PostgreSQL, async sync back to CouchDB
- Minimum 3 separate deployments per model:
  1. Add SQL models with SyncSQLToCouchMixin
  2. Add SyncCouchToSQLMixin to Couch classes + bulk migration command
  3. Cutover to SQL, remove Couch classes
- Silent exceptions hide data corruption bugs — extensive sync testing required

**PL/Proxy Sharding**
- Total shards must be power of 2: 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024
- **Cannot change shard count after data exists** — choose correctly upfront
- Recommendation: Start with 1024 shards even if using fewer initially
- Single-shard queries should bypass PL/Proxy for better performance

**Kafka-Based Change Propagation**
- Pillowtop processors consume CouchDB changes feed, publish to Kafka topics
- Downstream processors build PostgreSQL views from Kafka events
- Enabled eventual consistency between data stores

**Key Lesson**: Don't rush. Extended validation period (6-12 months dual-database) essential.

### Simple.org — PostgreSQL at Health Scale

**Architecture (reference, not reusable code)**
- Ruby on Rails + PostgreSQL 14 + Redis + Sidekiq
- Native Android app with local SQLite, REST API sync
- Offline-first: UUID-based IDs, bi-temporal modeling, facility-scoped sync
- ~7 million patients, 5,000+ facilities, 5 countries
- 13-second follow-up data entry
- MIT licensed but sync logic tightly coupled to domain models

**Architectural Patterns to Adopt**
- Bi-temporal modeling (mobile timestamp + server timestamp)
- UUID-based offline ID generation (conflict-free)
- Facility-scoped selective sync (bandwidth optimization)
- Structured schema management via Rails-style migrations
- Multiple test dataset sizes for performance validation

### DHIS2 — PostgreSQL Tuning

**Essential configuration for 100K+ users**
```
max_connections = 200
shared_buffers = 3GB          # 25% of RAM
work_mem = 20MB               # Critical for aggregation queries
maintenance_work_mem = 512MB
effective_cache_size = 8GB    # 80% remaining RAM
synchronous_commit = off      # Acceptable for write-heavy health systems
random_page_cost = 1.1        # SSD optimization
jit = off                     # Causes slowdowns on specific query patterns
```
- Up to 5 read replicas per instance for analytics workload separation
- 64GB+ RAM, 16+ CPU cores, NVMe SSD recommended

---

## Phase 6: PowerSync Sync Semantics Gap Analysis

### Question: Does PowerSync actually handle every CHT sync scenario?

**Stress-tested against 7 specific CHT sync scenarios:**

| Scenario | PowerSync Native? | Workaround | Effort |
|----------|-------------------|------------|--------|
| Custom purge (purge.js) | ❌ No | Purge preprocessing service → purge_status table | 4-6 weeks |
| Replication depth per role | ⚠️ Partial | JWT claims + recursive CTE in Sync Streams | ~1 week |
| Sensitive/private docs | ✅ Yes | SQL WHERE clause | 0 |
| Tasks/targets (rules engine) | ❌ No | Rules engine PouchDB→SQLite migration | 6-8 weeks |
| Global config docs | ⚠️ Partial | Dedicated unfiltered global stream | ~1 week |
| Per-user meta databases | ❌ No | Collapse to single table + user_id filtering | 2-3 weeks |
| Authorization (core perf) | ✅ Yes | Bucket partitioning eliminates O(N²) scanning | 0 |

**Total gap work: ~14-19 weeks (3-4 months)**

### Key Insight from This Phase
PowerSync is the right choice but the analysis documents must be honest about what it doesn't do. The purge preprocessing and rules engine migration are non-trivial. The PoC must explicitly test these edge cases.

---

## Phase 7: Final Comparison — PowerSync vs Custom REST Sync

**PowerSync recommended** based on:
- Timeline: 9-12 months vs 12-15 months (custom), with Fall 2027 target deadline
- Cost: ~$120K 5-year TCO vs ~$637K (custom)
- Performance: Bucket architecture eliminates O(N²) (proven)
- Risk: Managed sync layer vs building from scratch

**Custom REST sync is the fallback** if PoC reveals:
- Purge preprocessing adds unacceptable latency
- Recursive CTE parameter queries timeout at scale
- Sync Streams can't express CHT authorization model
- PowerSync vendor relationship deteriorates

**The decision point is the PoC** (months 1-2). Test the hard cases first.