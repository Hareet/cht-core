# PowerSync Bucket Architecture Tradeoffs for CHT Migration

## Decision Document: National-Scale eCHIS Deployment (100K+ CHWs, 47 Counties)

**Date:** 2026-04-10
**Updated:** 2026-04-11 — Empirical bucket semantics test completed (see Section 1.1)
**Status:** Empirically validated. Consolidation strategy confirmed viable.
**Authors:** Hareet (CHT migration lead) + Claude Code analysis

---

## 1. Executive Summary

**Recommendation: Stream consolidation with CTE sharing.** Empirical testing on 2026-04-11 confirmed that all query patterns (JOIN, inline subquery, named CTE) create N buckets per facility — there is no "1 bucket" collapse. However, **multiple queries within one stream sharing the same CTE DO share buckets** (confirmed: 2 queries, 15 facilities = 15 buckets, not 30).

The strategy: merge streams that use the same CTE (`accessible_facilities` or `report_facilities`) into consolidated streams with `queries:[]`. Combined with raising `max_parameter_query_results` to 5,000 via `api.parameters.max_parameter_query_results`, this reduces total buckets from `9×N` to `N_accessible + N_report + 4`.

**Projected bucket counts after consolidation:**
- CHW (30 facilities): ~70 buckets (was ~270)
- Supervisor (200 facilities): ~450 buckets (was ~1,800)
- County admin (1,010 facilities): ~2,500 buckets (was ~9,000, fits in 5,000 limit)

### 1.1 Empirical Test Results (2026-04-11)

Test user `bucket_test_user` with exactly 15 facilities, 5 experiment streams:

| Experiment | Pattern | Buckets | Result |
|------------|---------|---------|--------|
| exp1_direct | `WHERE col = auth.user_id()` | **1** | Control confirmed |
| exp2_join | `INNER JOIN ... ON auth.user_id()` | **15** | N buckets confirmed |
| exp3_subquery | `WHERE _id IN (SELECT ... WHERE user_id = auth.user_id())` | **15** | N buckets — no collapse |
| exp4_cte | `WITH my_fac AS (...) WHERE _id IN my_fac` | **15** | CTE = subquery = JOIN |
| exp5_consolidated | Two `queries:[]` sharing one CTE | **15** | SHARING WORKS (not 30) |

Total: 61 buckets (1 + 15 + 15 + 15 + 15). Test code at `tests/scalability/powersync-benchmark/bucket-semantics-test.js`.

**Key finding:** The ONLY way to get 1 bucket per user is `WHERE col = auth.user_id()` — a direct equality against the auth parameter with no intermediary table. All forms of intermediary lookup (JOIN, subquery, CTE) create N buckets. But queries within the same stream sharing the same CTE merge their bucket sets.

---

## 2. PowerSync Bucket Mechanics

### 2.1 What Is a Bucket?

A bucket is PowerSync's fundamental unit of data partitioning. Each bucket:
- Contains an ordered sequence of operations (PUT, REMOVE, MOVE, CLEAR)
- Maintains recent history, not just current state
- Is stored in durable bucket storage (MongoDB or PostgreSQL)
- Has a checksum computed at each checkpoint for consistency verification
- Is synced as a complete unit -- clients subscribe to whole buckets

A row is only deleted from the client when it has been removed from **all** buckets synced to that client. Buckets can overlap -- the same row can appear in multiple buckets.

### 2.2 How Buckets Are Created in Sync Streams (Edition 3)

The PowerSync documentation states:

> "One bucket is created per unique value of the filter expression -- whether a subquery result, a JOIN, an auth parameter, or a subscription parameter."

The bucket creation rules are:

| Query Pattern | Buckets Created Per User |
|---|---|
| No parameters (global query, e.g. `SELECT * FROM categories`) | 1 shared bucket across ALL users |
| Direct auth filter only (`WHERE owner_id = auth.user_id()`) | 1 per user |
| JWT array parameter (`json_each(auth.parameter('ids'))`) | N (one per array element) |
| Subscription parameter (`subscription.parameter('id')`) | 1 per unique subscribed value |
| Subquery returning N rows (`WHERE id IN (SELECT ...)`) | N buckets |
| Combined subquery + subscription | N x M (multiplicative) |
| INNER JOIN through intermediary table | N (one per joined row) |

**The critical insight:** When a stream uses `INNER JOIN` against `user_accessible_facilities` and gets 1,010 matched rows, PowerSync creates 1,010 buckets for that user from that stream alone.

### 2.3 The 1,000 Bucket Limit

- **Default limit:** 1,000 buckets per user/client
- **Scope:** Total across ALL active streams for a single user
- **Error:** PSYNC_S2305 -- sync fails completely, zero data sent
- **Configurable:** `max_parameter_query_results` in the API service config (self-hosted)
- **Documented max:** "Configurable up to 10,000 by request" for Cloud; self-hosted has no documented hard ceiling
- **Important:** The limit is per-user, not global. A service can track millions of total buckets as long as no single user exceeds the per-user cap.

### 2.4 Performance Impact Per Bucket

PowerSync's documentation is explicit:

> "Incremental sync overhead scales roughly linearly with the number of buckets per user. Doubling the bucket count approximately doubles sync latency."

Specific impacts:
- **CPU:** Doubles with doubled bucket count (both server and client)
- **Memory:** Doubles with doubled bucket count (both server and client)
- **Sync latency:** Linear scaling -- each bucket requires a checkpoint checksum computation and operation history check
- **API containers:** Target 100 concurrent connections per container; more buckets per connection = fewer sustainable connections
- **Client-side:** Each bucket is checked for new operations at every sync cycle

**No specific per-bucket memory figures are published.** The documentation focuses on relative scaling rather than absolute numbers. However, the deployment architecture guide recommends 1GB RAM per API container supporting ~100 connections, suggesting ~10MB per connection at baseline. With 1,000 buckets, overhead would be significant.

### 2.5 Bucket Storage Architecture

Bucket state persists in durable storage (MongoDB or PostgreSQL bucket storage, separate from the source database). This means:
- The PowerSync Service has a low memory footprint even at scale
- Bucket data survives service restarts
- Compaction reduces historical operation bloat

### 2.6 How Sync Streams Queries Map to Buckets

In Sync Streams edition 3, the bucket identity is determined by the **filter expression values**. For a query like:

```yaml
query: |
  SELECT * FROM items
  INNER JOIN user_items ON user_items.item_id = items.id
    AND user_items.user_id = auth.user_id()
```

Each unique `item_id` matched by the JOIN becomes a separate bucket. If the user has 500 items, that is 500 buckets from this one stream.

Contrast with:

```yaml
query: |
  SELECT * FROM items WHERE owner_id = auth.user_id()
```

This creates exactly 1 bucket per user, regardless of how many items match.

---

## 3. Analysis of the Current CHT Implementation

### 3.1 Current Architecture (powersync.yaml)

The current `powersync.yaml` uses `INNER JOIN` against pre-computed mapping tables:

```yaml
# Contacts stream (simplified)
FROM "v1"."couchdb" contacts
INNER JOIN "v1"."user_accessible_facilities" uaf
  ON uaf.user_id = auth.user_id()
  AND (
    contacts._id = uaf.facility_id
    OR ifnull(contacts.doc -> 'parent' ->> '_id', contacts.doc ->> 'parent') = uaf.facility_id
  )
```

### 3.2 Bucket Count Analysis

For a typical CHW with `replication_depth=1` assigned to a clinic with 50 households and 200 patients:
- `user_accessible_facilities` rows: ~255 (1 clinic + 50 households + 200 patients + ancestors + primary contacts)
- Contacts stream buckets: **~255** (one per facility_id in the JOIN)
- Reports stream buckets: **~350** (includes shortcodes in `user_report_facilities`)
- SMS messages stream buckets: **~255**
- Targets stream buckets: **~255**
- Tasks: **1** (filtered by `auth.user_id()` only)
- Global config: **1** (global bucket)
- User settings: **1** (filtered by `auth.user_id()` only)
- User meta: **1** (filtered by `auth.user_id()` only)
- **Total: ~1,120 buckets** -- exceeds the 1,000 limit

For a supervisor (`replication_depth=2`) at a health center with 5 clinics, 250 households, 1,000 patients:
- `user_accessible_facilities` rows: ~1,260
- **Total across streams: ~4,000+ buckets** -- catastrophically over limit

For a county admin (`replication_depth=-1` / unlimited):
- `user_accessible_facilities` rows: potentially 5,000-50,000+
- **Total: tens of thousands of buckets** -- completely unworkable

### 3.3 The CTE vs JOIN Paradox (KNOWN_ISSUES.md #5)

The codebase documents a critical discovery:

1. **CTE approach** (`IN accessible_facilities`): Limited to 1,000 CTE results because PowerSync expands the CTE into `IN ($1, $2, ..., $N)` parameters
2. **JOIN approach** (`INNER JOIN user_accessible_facilities`): No result limit, but creates one bucket per joined row

Both approaches break at CHT scale. The CTE approach fails with an error at 1,000+ facilities. The JOIN approach creates 1,000+ buckets. Neither is viable for supervisors or county admins without modification.

---

## 4. Option Analysis

### Option A: Raise the Bucket Limit

**How it works:** Set `max_parameter_query_results` to 5,000-10,000 in the self-hosted PowerSync YAML config. Keep the current JOIN architecture unchanged.

**Configuration (estimated, needs verification):**
```yaml
# In powersync.yaml (self-hosted service config)
api:
  max_parameter_query_results: 10000
```

**Bucket count per user:**
- CHW: ~1,120 (same as current)
- Supervisor: ~4,000
- County admin: ~20,000-50,000+ (may still exceed even raised limits)

**Implementation complexity:** Trivial -- single config change.

**Performance characteristics:**
- CHW (1,120 buckets): Sync latency ~1.12x baseline, likely acceptable
- Supervisor (4,000 buckets): Sync latency ~4x baseline, problematic on mobile
- County admin (20,000+ buckets): Sync latency ~20x+ baseline, **unacceptable**
- Server-side: Each API container handles fewer connections (bucket overhead per connection increases linearly)
- At 100K users with avg 2,000 buckets: massive server-side resource consumption

**Data freshness:** Real-time (direct WAL replication, no intermediate processing).

**WAL compatibility:** Full -- no architectural changes, all tables already published.

**Scalability to 100K users:**
- Server cost scales linearly with (users x buckets_per_user)
- A supervisor with 4,000 buckets consumes 4x the server resources of a CHW with 1,000
- County admins (even if few) create extreme hot spots on API containers
- At national scale: estimated 100K CHWs x 1,120 + 5K supervisors x 4,000 + 500 county admins x 20,000 = 132M total bucket subscriptions. With 100 connections per API container, need 1,000+ containers.

**Failure modes:**
- County admins still hit limits even at 10,000 if hierarchy is deep
- Performance degradation is user-visible (slow sync for supervisors)
- No graceful degradation -- either sync works or completely fails (PSYNC_S2305)
- Mobile devices (CHW phones are often low-end) may struggle with memory overhead of 1,000+ buckets

**Verdict:** Viable as a **temporary** stopgap for CHW-tier users only. Not viable for supervisors or county admins. Not a long-term architecture for national scale.

---

### Option B: Pre-computed Mapping Tables with Subquery Filtering (1 Bucket Per User)

**How it works:** Keep the existing `user_accessible_facilities` and `user_report_facilities` tables, but restructure the Sync Streams queries so that the subquery is evaluated **inside** the WHERE clause rather than through a JOIN or named CTE.

**Target query pattern:**
```yaml
streams:
  contacts:
    auto_subscribe: true
    priority: 1
    query: |
      SELECT
        contacts._id AS id,
        contacts.doc ->> 'name' AS name,
        ...
      FROM "v1"."couchdb" contacts
      WHERE contacts._deleted != true
        AND contacts.doc ->> 'type' IN '["contact", "person", "clinic", "health_center", "district_hospital"]'
        AND (
          contacts._id IN (
            SELECT facility_id FROM "v1"."user_accessible_facilities"
            WHERE user_id = auth.user_id()
          )
          OR ifnull(contacts.doc -> 'parent' ->> '_id', contacts.doc ->> 'parent') IN (
            SELECT facility_id FROM "v1"."user_accessible_facilities"
            WHERE user_id = auth.user_id()
          )
        )
```

**The critical question:** Does PowerSync treat `IN (SELECT facility_id FROM table WHERE user_id = auth.user_id())` as creating 1 bucket (because the outer filter is `auth.user_id()`) or N buckets (one per subquery result)?

Based on the bucket creation table from PowerSync docs:
- "Subquery returning N rows" -> "N buckets"

**This means inline subqueries ALSO create N buckets.** The subquery result determines the bucket partition, not just the auth parameter.

**If this is confirmed:** Option B as described here would produce the same bucket count as the current JOIN approach. The subquery pattern does NOT automatically collapse to 1 bucket per user.

**Alternative Option B architecture -- true 1-bucket-per-user:**

To achieve exactly 1 bucket per user, the query must filter using ONLY `auth.user_id()` or `auth.parameter()` -- no JOINs, no subqueries against multi-row tables, no CTEs that expand to multiple values.

This means the data itself must be pre-filtered. Two approaches:

**B1: Denormalize user_id onto each document (see Option C)**

**B2: Create per-user document tables:**
```sql
-- Instead of a mapping table, create a table that contains
-- the actual documents each user should see
CREATE TABLE v1.user_contacts (
  user_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  -- Sync Streams needs these columns:
  id TEXT NOT NULL,
  name TEXT,
  contact_type TEXT,
  parent_id TEXT,
  ...
  doc TEXT,
  PRIMARY KEY (user_id, doc_id)
);
```

```yaml
streams:
  contacts:
    query: |
      SELECT id, name, contact_type, parent_id, ...
      FROM "v1"."user_contacts"
      WHERE user_id = auth.user_id()
```

This produces exactly 1 bucket per user. But it requires:
- Denormalizing the full document into per-user rows
- Maintaining the table via triggers when documents change
- Storage: N_users x N_docs_per_user rows (massive for 100K users)
- The table must be in the publication for WAL replication to work

**Bucket count per user:** 1 per stream = ~8 total (contacts, reports, SMS, tasks, targets, global config, user settings, user meta).

**Implementation complexity:** Very high.
- Must create and maintain per-user document tables for each stream
- Triggers on `couchdb` table must propagate changes to all affected user tables
- Triggers on `user_accessible_facilities` must recompute when access changes
- Storage explosion: 100K users x avg 1,000 docs = 100M rows in `user_contacts` alone
- WAL volume: every document change generates N rows of WAL (one per user who can see it)

**Performance characteristics:**
- Sync: Optimal -- 1 bucket per user per stream
- PostgreSQL write amplification: Catastrophic -- each document write triggers 100-1,000 trigger-generated writes
- WAL volume: Proportional to (document_changes x users_affected), massively amplified
- PowerSync replication: Must process all WAL events from the user tables

**Data freshness:** Trigger latency (sub-second for PostgreSQL triggers, but throughput limited by trigger cascade volume).

**WAL compatibility:** Yes -- regular tables generate WAL events.

**Scalability:** The write amplification makes this architecture collapse at national scale. A single document change affecting 1,000 users generates 1,000 WAL events just for the user table. At 100K users, the PostgreSQL write load becomes untenable.

**Failure modes:**
- Trigger cascade failures corrupt sync state
- WAL volume overwhelms PowerSync replication (documented limit: 2,000-4,000 ops/sec for small rows)
- Storage costs scale as O(users x docs_per_user)

**Verdict:** The true 1-bucket-per-user architecture (B2) is theoretically clean but practically infeasible at national scale due to write amplification. The subquery-based approach (B as originally described) likely still creates N buckets per subquery result, making it equivalent to the current JOIN architecture.

---

### Option C: Denormalize user_id Array onto Documents

**How it works:** Add a `synced_to_users TEXT[]` (or `JSONB`) column to the `couchdb` table (or a shadow table). For each document, store the list of all user_ids who should see it. Use `auth.user_id() = ANY(synced_to_users)` or the PowerSync-supported equivalent in the Sync Stream query.

**Proposed schema change:**
```sql
ALTER TABLE v1.couchdb ADD COLUMN synced_to_users TEXT[];
CREATE INDEX idx_couchdb_synced_users ON v1.couchdb USING GIN(synced_to_users);
```

**Proposed Sync Stream:**
```yaml
streams:
  contacts:
    query: |
      SELECT contacts._id AS id, ...
      FROM "v1"."couchdb" contacts
      WHERE contacts._deleted != true
        AND contacts.doc ->> 'type' IN '["contact", "person", ...]'
        AND auth.user_id() IN (SELECT value FROM json_each(contacts.synced_to_users))
```

**Critical problem:** PowerSync Sync Streams SQL does NOT support `ANY()`, `@>` array operators, or arbitrary PostgreSQL-specific array functions. The supported SQL is a restricted subset. `json_each()` is supported but only on parameter-side (in parameter queries / CTEs), not on row-side data columns.

Even if the syntax worked, the bucket creation would be determined by the unique combinations of `auth.user_id()` matched against row data, which should produce 1 bucket per user -- **but only if PowerSync recognizes this as an auth-parameter-only filter pattern.**

**Bucket count per user:** Likely 1 per stream (if the query is recognized as auth-filtered), but the SQL compatibility is the blocker.

**Implementation complexity:** High.
- Must maintain `synced_to_users` array on every document
- Triggers on `user_accessible_facilities` changes must update arrays on all affected documents
- Array updates on high-cardinality rows (documents seen by many users) are expensive
- Uncertainty about PowerSync SQL support for this pattern

**Performance characteristics:**
- Write amplification: Moderate -- updating a document's `synced_to_users` is a single UPDATE, but must be done for every document when user access changes
- Index bloat: GIN indexes on large text arrays can be significant
- WAL: Each array update generates one WAL event (better than Option B2)

**Data freshness:** Depends on trigger/batch job frequency for maintaining `synced_to_users`.

**WAL compatibility:** Yes -- column updates on the `couchdb` table generate WAL events. However, `REFRESH MATERIALIZED VIEW` is NOT a viable approach here because materialized views do not generate WAL events (confirmed by PostgreSQL documentation: only base tables participate in logical replication publications).

**Scalability:**
- Each document update requires updating the array column
- When a user's access changes (e.g., reassigned to different facility), ALL documents in their old and new access set must be updated
- For a county admin with 50,000 accessible documents, access changes touch 50,000 rows

**Failure modes:**
- Stale `synced_to_users` arrays cause missing data (under-sync) or data leaks (over-sync)
- Large arrays on popular documents (global docs seen by all users) -- would need special handling
- PowerSync SQL compatibility is uncertain for this pattern

**Verdict:** Conceptually appealing but blocked by PowerSync SQL limitations and presents significant maintenance complexity. Not recommended.

---

### Option D: Hybrid -- Global Bucket + Client-Side Filtering

**How it works:** Sync ALL contacts/reports to all users in one or a few global buckets. Apply access control filtering client-side in the SQLite database after sync.

**Proposed Sync Stream:**
```yaml
streams:
  all_contacts:
    auto_subscribe: true
    query: |
      SELECT contacts._id AS id, ...
      FROM "v1"."couchdb" contacts
      WHERE contacts._deleted != true
        AND contacts.doc ->> 'type' IN '["contact", "person", "clinic", "health_center", "district_hospital"]'
  
  all_reports:
    auto_subscribe: true
    query: |
      SELECT reports._id AS id, ...
      FROM "v1"."couchdb" reports
      WHERE reports._deleted != true
        AND reports.doc ->> 'type' = 'data_record'
```

**Bucket count per user:** 1 per stream (global bucket). ~8 total across all streams.

**Implementation complexity:** Low for sync layer. High for client-side.
- Sync Streams become trivial
- Must implement full CHT authorization logic in client-side SQLite queries
- Must prevent client-side data leaks (users can inspect SQLite directly)
- Must handle the CHT rules engine, purge logic, and report_depth filtering client-side

**Performance characteristics:**
- **Bandwidth:** Catastrophic. Every user syncs the ENTIRE national dataset.
  - Kenya eCHIS: ~50M documents across 47 counties
  - A CHW who needs 1,000 documents syncs 50,000,000
  - On a 3G connection in rural Kenya: weeks for initial sync, assuming it doesn't timeout
- **Client storage:** 50M documents x avg 2KB = 100GB per device. Mobile phones have 16-64GB total storage.
- **Sync speed:** PowerSync handles up to 1M rows per client with "good performance" and up to 10M with caveats. 50M is beyond documented limits.
- **Server:** Excellent -- minimal per-user overhead, single global bucket

**Data freshness:** Real-time (direct WAL, no intermediate processing).

**WAL compatibility:** Full -- straightforward table scan queries.

**Scalability:** Server-side excellent. Client-side impossible at national scale.

**Failure modes:**
- Client storage exhaustion crashes the app
- Initial sync timeout on slow networks
- Data security: sensitive patient data from other counties on every device
- Regulatory: Kenya's Data Protection Act 2019 prohibits unnecessary data access

**Verdict:** Completely unviable for a national health system deployment. The bandwidth, storage, and data security requirements make this a non-starter. Only viable if the dataset is extremely small (< 10K total rows) or if county-level partitioning is applied (see section 6).

---

## 5. Comparison Matrix

| Dimension | A: Raise Limit | B: Pre-computed Tables (subquery) | B2: Per-User Doc Tables | C: Denormalize user_id | D: Global + Client Filter |
|---|---|---|---|---|---|
| **Bucket count (CHW)** | ~1,120 | ~1,120 (same as A) | ~8 | ~8 (if SQL works) | ~8 |
| **Bucket count (supervisor)** | ~4,000 | ~4,000 | ~8 | ~8 | ~8 |
| **Bucket count (county admin)** | ~20,000+ | ~20,000+ | ~8 | ~8 | ~8 |
| **Implementation effort** | 1 day | Already done | 4-6 weeks | 3-4 weeks | 2 weeks sync, 6+ weeks client |
| **Write amplification** | None | None | Extreme (N per doc change) | Moderate (1 per affected doc) | None |
| **WAL volume** | Baseline | Baseline | Nx baseline | 2-3x baseline | Baseline |
| **Sync latency (CHW)** | ~1.1x | ~1.1x | 1x (optimal) | 1x | 1x (but 50,000x data volume) |
| **Sync latency (supervisor)** | ~4x | ~4x | 1x | 1x | 1x (but 50,000x data volume) |
| **Client storage** | Minimal | Minimal | Minimal | Minimal | 100GB+ (impossible) |
| **Data security** | Server-filtered | Server-filtered | Server-filtered | Server-filtered | Client-filtered (insecure) |
| **PG storage overhead** | None | None | O(users x docs) | O(docs x array_size) | None |
| **Freshness** | Real-time | Real-time | Trigger latency | Trigger/batch latency | Real-time |
| **PowerSync SQL compat** | Full | Full | Full | Uncertain | Full |
| **Handles 100K users** | Marginal | Marginal | No (write amp) | Uncertain | No (bandwidth) |

---

## 6. Recommendation: Phased Approach

Given that none of the options is a clean win at all user tiers, the recommendation is a **tiered architecture** that applies different strategies at different hierarchy levels.

### Phase 1: Immediate (weeks 1-2) -- Raise Limit + Monitor

**Action:** Set `max_parameter_query_results: 5000` in the self-hosted config. This unblocks development and testing for all user tiers except county admins.

```yaml
# In powersync.yaml
api:
  max_parameter_query_results: 5000
  tokens:
    - !env PS_ADMIN_TOKEN
```

**Rationale:** The current JOIN-based architecture works correctly. Performance degradation at 1,000-2,000 buckets is linear and may be acceptable for initial pilot with CHWs and supervisors. County admins can be deferred.

**Test:** Benchmark sync latency at 500, 1,000, 2,000, 3,000, and 5,000 buckets per user on representative mobile hardware. This data is essential for the Phase 2 decision.

### Phase 2: Architecture Validation (weeks 3-6) -- Test Subquery Bucket Behavior

**Action:** Build a test harness that verifies exactly how many buckets each query pattern creates in PowerSync Service v1.20.x.

Test queries:
1. `WHERE col IN (SELECT id FROM table WHERE user_id = auth.user_id())` -- does this create 1 or N buckets?
2. `INNER JOIN table ON table.user_id = auth.user_id() AND col = table.id` -- confirmed N buckets
3. `WHERE col = auth.user_id()` -- confirmed 1 bucket

Use the PowerSync Sync Diagnostics Client (https://diagnostics-app.powersync.com) or checkpoint logs (which show `buckets` count) to measure actual bucket counts.

**If inline subquery creates 1 bucket:** Restructure all streams to use `IN (SELECT ...)` pattern. This is the clean solution.

**If inline subquery creates N buckets:** Proceed to Phase 3.

### Phase 3: County-Scoped Bucket Partitioning (weeks 4-8)

**Architecture:** Instead of one global PowerSync instance, partition by county. Each county gets its own PowerSync Service instance (or logical partition) that only tracks data for that county's hierarchy.

```
National PostgreSQL (single instance)
  ├── PowerSync Instance: Nairobi County
  │     └── Sync Streams filtered to Nairobi hierarchy
  ├── PowerSync Instance: Mombasa County
  │     └── Sync Streams filtered to Mombasa hierarchy
  └── ... (47 instances total)
```

**Within each county instance:**
- A CHW sees ~250 facilities (well under 1,000)
- A supervisor sees ~1,250 (manageable with raised limit)
- A county admin sees their entire county (varies, largest counties ~3,000-5,000)

**Advantages:**
- Keeps bucket counts within manageable range
- Mirrors the current 47-CouchDB-instance architecture
- Each PowerSync instance is smaller and faster
- County isolation provides data security

**Disadvantages:**
- 47 PowerSync instances to manage (but can be automated with Kubernetes)
- Cross-county users (national admins) need special handling
- Adds operational complexity vs. single-instance vision

### Phase 4: Engage PowerSync Team (concurrent with Phase 2-3)

**Action:** Contact PowerSync support with a detailed description of the CHT use case. Specific questions:

1. **Subquery bucket behavior:** Does `WHERE col IN (SELECT id FROM table WHERE user_id = auth.user_id())` create 1 or N buckets? Can they add a mode where auth-correlated subqueries create 1 bucket?

2. **Aggregate bucket mode:** Is there a planned or possible feature where all rows matching `auth.user_id()` (through any path -- subquery, JOIN, CTE) are grouped into a single per-user bucket?

3. **Performance benchmarks:** What is the measured overhead per bucket at 1K, 5K, 10K buckets? Is there a published degradation curve?

4. **Alternative patterns:** Has any PowerSync customer solved the "hierarchical access with thousands of reachable entities" problem? What pattern did they use?

5. **Roadmap:** Is there a planned Sync Streams feature for "evaluate this subquery server-side without creating per-row buckets"?

---

## 7. Technical Deep Dives

### 7.1 Why Materialized Views Cannot Work with PowerSync

PostgreSQL's logical replication (which PowerSync uses to read the WAL) only supports **base tables**. Materialized views, regular views, foreign tables, and partition root tables are all excluded from publications.

The existing `v1.unpurged_contacts` materialized view in `setup.sql` **cannot** be used in Sync Streams because:
1. It cannot be added to the `powersync` publication
2. `REFRESH MATERIALIZED VIEW` does not generate WAL events
3. PowerSync's replication container would never see changes to it

**Source:** [PostgreSQL 10 Logical Replication Restrictions](https://www.postgresql.org/docs/10/logical-replication-restrictions.html) confirms: "only base tables can be replicated."

### 7.2 Regular Tables with Triggers DO Work

The existing architecture correctly uses regular tables (`user_accessible_facilities`, `user_report_facilities`) maintained by functions (`refresh_user_facilities()`). These tables:
1. ARE included in the `powersync` publication (line 344-349 of `setup.sql`)
2. DO generate WAL events when modified
3. ARE visible to PowerSync's replication

The trigger-based approach (`purge_soft_delete` on `purge_status`) also generates WAL events because it operates on the `couchdb` base table.

### 7.3 The `max_parameter_query_results` Configuration

For self-hosted deployments, the documentation states: "configure `max_parameter_query_results` in the API service config."

The exact YAML path is not comprehensively documented, but based on the PowerSync service architecture, it belongs in the `api` section of the service YAML:

```yaml
api:
  max_parameter_query_results: 5000
  tokens:
    - !env PS_ADMIN_TOKEN
```

**Note:** This needs testing. The exact config key name and location should be verified against the PowerSync service source code or by contacting PowerSync support.

### 7.4 Multiple Queries Per Stream Reduce Bucket Count

PowerSync documents that combining multiple queries into one stream using `queries` (instead of separate streams) reduces bucket count:

> "Using multiple queries in one stream is more efficient because it uses a single subscription and reduces bucket consumption compared to separate streams."

The current implementation already uses `queries` for the reports stream (3 queries) and global_config stream (2 queries). This is correct practice.

### 7.5 The Five Bucket Reduction Strategies from PowerSync Docs

PowerSync documents these strategies for reducing bucket count:

1. **Consolidate multiple streams:** Merge separate streams into one with `queries`. Already done in current impl.

2. **Query membership tables directly with auth filter:** Instead of JOINing through intermediary tables, filter membership tables with `auth.user_id()`. Transforms N buckets to 1.

3. **Denormalize hierarchical data:** Add top-level identifier to child tables so all queries filter by the same parameter. Applicable to CHT's `parent._id` hierarchy.

4. **Many-to-many via denormalization:** Add JSON array column with related IDs, maintained by triggers. Limited by "slowdowns when over 100 rows per user."

5. **Use subscription parameters:** Create buckets only per active client subscription, not all possible values. Bounds counts to what clients actively need.

Strategy #2 is the most relevant for CHT -- but it requires that the membership table query creates 1 bucket (using `auth.user_id()`) rather than N buckets (one per membership row).

---

## 8. Open Questions Requiring PowerSync Team Input

1. **Subquery bucket semantics:** When a Sync Streams query uses `WHERE column IN (SELECT id FROM mapping_table WHERE user_id = auth.user_id())`, how many buckets are created? Is it 1 (because the auth parameter is the only partition key) or N (one per subquery result)?

2. **JOIN bucket semantics confirmation:** When using `INNER JOIN mapping_table ON mapping_table.user_id = auth.user_id() AND mapping_table.id = main_table.ref_id`, is each unique `mapping_table.id` value a separate bucket? Or does the presence of `auth.user_id()` in the JOIN condition collapse everything into one per-user bucket?

3. **Max safe value for `max_parameter_query_results`:** The docs say "configurable up to 10,000 by request." Is 10,000 a hard ceiling? For self-hosted, is there a technical limit beyond which the service becomes unstable?

4. **Performance benchmarks at scale:** Are there published benchmarks showing sync latency at 1K, 2K, 5K, 10K buckets per user? On mobile devices? On WebSocket vs HTTP streaming?

5. **Planned features:** Is there a roadmap item for "server-side subquery evaluation without bucket expansion"? This would solve the CHT use case entirely.

6. **Concurrent connections at high bucket counts:** The docs recommend 100 connections per API container. At 5,000 buckets per connection, should this be reduced? To what?

7. **Alternative architecture patterns:** Has any PowerSync customer deployed with a hierarchical authorization model (user -> sees descendants) at 1,000+ entities per user? What pattern did they use?

8. **CTE vs subquery vs JOIN behavior:** The KNOWN_ISSUES.md found that `IN <cte_name>` gets expanded to parameters (limited to 1,000). Does `IN (SELECT ... FROM table WHERE ...)` behave the same way, or is it processed differently?

---

## 9. Appendix: CHT-Specific Bucket Count Projections

### Kenya eCHIS Hierarchy Statistics (Estimated)

| Level | Count | Typical Per-Parent |
|---|---|---|
| National | 1 | -- |
| County | 47 | -- |
| Sub-county | ~300 | ~6 per county |
| Facility (health_center) | ~10,000 | ~33 per sub-county |
| CHW Area (clinic) | ~25,000 | ~2.5 per facility |
| Household | ~2,500,000 | ~100 per CHW area |
| Patient (person) | ~10,000,000 | ~4 per household |

### Bucket Counts by User Role (with JOIN Architecture)

| Role | Facility | Depth | Accessible Facilities | Buckets (4 streams) | Status |
|---|---|---|---|---|---|
| CHW | clinic | 1 | ~250 | ~1,000 | Borderline |
| CHW (large area) | clinic | 1 | ~500 | ~2,000 | Fails at default limit |
| Supervisor | health_center | 2 | ~1,260 | ~5,000 | Fails |
| Sub-county admin | sub_county | -1 | ~5,000 | ~20,000 | Fails |
| County admin | county | -1 | ~50,000+ | ~200,000+ | Fails |
| National admin | national | -1 | ~10,000,000+ | N/A | Impossible |

### Target Bucket Counts (with 1-per-user architecture)

| Role | Buckets (all streams) | Status |
|---|---|---|
| Any user | 8 (1 per stream) | Optimal |

---

## 10. References

### PowerSync Documentation
- [Organize Data Into Buckets](https://docs.powersync.com/sync/rules/organize-data-into-buckets)
- [Performance and Limits](https://docs.powersync.com/resources/performance-and-limits)
- [Troubleshooting: Too Many Buckets](https://docs.powersync.com/debugging/troubleshooting#too-many-buckets-psync_s2305)
- [Parameter Queries](https://docs.powersync.com/sync/rules/parameter-queries)
- [Global Buckets](https://docs.powersync.com/sync/rules/global-buckets)
- [Self-Hosted Instance Configuration](https://docs.powersync.com/configuration/powersync-service/self-hosted-instances)
- [Sync Streams Overview](https://docs.powersync.com/sync/streams/overview)
- [Stream Queries](https://docs.powersync.com/sync/streams/queries)
- [Using Parameters](https://docs.powersync.com/sync/streams/parameters)
- [Common Table Expressions](https://docs.powersync.com/sync/streams/ctes)
- [Many-to-Many Join Tables](https://docs.powersync.com/sync/rules/many-to-many-join-tables)
- [Compacting Buckets](https://docs.powersync.com/maintenance-ops/compacting-buckets)
- [PowerSync Service Architecture](https://docs.powersync.com/architecture/powersync-service)
- [PowerSync Protocol](https://docs.powersync.com/architecture/powersync-protocol)
- [Partitioned Tables](https://docs.powersync.com/sync/advanced/partitioned-tables)
- [Database Setup (PostgreSQL)](https://docs.powersync.com/configuration/source-db/setup)
- [Deployment Architecture](https://docs.powersync.com/maintenance-ops/self-hosting/deployment-architecture)
- [Migration: Sync Rules to Sync Streams](https://docs.powersync.com/sync/streams/migration)

### PostgreSQL Documentation
- [Logical Replication Restrictions (PostgreSQL 10)](https://www.postgresql.org/docs/10/logical-replication-restrictions.html)
- [Bug #15044: Materialized views incompatibility with logical replication](https://www.postgresql.org/message-id/151753299917.1235.5710750500940066850@wrigleys.postgresql.org)

### Project Files
- `/home/h4reet/ai_medic/cht-core/.devcontainer/powersync-config/sync-config.yaml` -- Sync Streams with CTE approach
- `/home/h4reet/ai_medic/cht-core/.devcontainer/powersync-config/powersync.yaml` -- Service config with JOIN approach
- `/home/h4reet/ai_medic/cht-core/.devcontainer/powersync-config/setup.sql` -- Schema, mapping tables, refresh functions
- `/home/h4reet/ai_medic/cht-core/tests/scalability/powersync-benchmark/KNOWN_ISSUES.md` -- CTE 1,000 limit discovery
- `/home/h4reet/ai_medic/cht-core/services/purge-preproc/sql/001-create-purge-status.sql` -- Purge status schema
