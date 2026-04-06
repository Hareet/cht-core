# PowerSync vs Custom REST Sync for CHT: Trade-offs and Sync Semantics Analysis

**PowerSync is the recommended approach** for CHT's PostgreSQL migration, but the recommendation carries important caveats. PowerSync eliminates the core *performance* bottleneck of filtered replication but cannot natively handle several critical CHT sync scenarios including partner-configurable purging, per-user meta databases, and the rules engine's local document model. A custom REST sync approach (modeled on Simple.org's proven architecture) would provide more control over these edge cases at significantly higher cost and timeline risk. This analysis evaluates both approaches honestly, including the specific scenarios where PowerSync's Sync Streams break down.

---

## Two viable architectural approaches

**Option A: Custom REST Sync (Simple.org-style)**

Simple.org built a custom bidirectional REST API sync between a native Android app (local SQLite) and a central PostgreSQL server. CHT would need to design its own equivalent for its PWA context — replacing Simple.org's Android-specific components (WorkManager, Room Database, Android Sync Adapters) with browser equivalents (Service Workers, wa-sqlite/IndexedDB, Background Sync API). This is a significant engineering effort but provides complete control over sync semantics, conflict resolution, and the ability to implement CHT's full authorization model natively.

Key design decisions CHT would borrow from Simple.org: UUID-based primary keys for offline ID generation, bi-temporal modeling (mobile timestamp + server timestamp) for conflict resolution, facility-scoped selective sync for bandwidth optimization, and last-write-wins strategies for medical records. The sync protocol, conflict resolution, and filtering logic would all be purpose-built for CHT's specific document model and authorization rules.

**Option B: PowerSync (managed sync layer)**

PowerSync provides a turnkey PostgreSQL-to-SQLite sync engine with built-in filtered replication via Sync Streams. The @powersync/web SDK (v1.36.0) provides browser support using wa-sqlite (WebAssembly SQLite), includes an Angular demo application confirming CHT framework compatibility, supports multi-tab coordination via shared web workers, and handles offline queuing with automatic sync on reconnect. Bundle size is approximately 14.2 MB.

---

## PowerSync and CHT's filtered replication: honest assessment

The previous analysis claimed PowerSync "eliminates CHT's filtered replication pain point." This is partially true — **PowerSync eliminates the performance problem but cannot natively handle the full semantic complexity of CHT's sync model.** This section provides a scenario-by-scenario evaluation.

### Where PowerSync genuinely wins: the performance bottleneck

CHT's current replication flow calls `GET api/replication/get-ids`, which queries the CouchDB view `medic/docs_by_replication_key`, filters out purged docs, and returns all doc ids/revs accessible to the user. The roadmap document states: *"Download sync must verify all documents a user has access to against the full database, meaning users with access to large numbers of documents can cause disproportionate CPU and performance impact."*

PowerSync's bucket architecture pre-partitions data so each client requests only its assigned buckets — no full-database scan. This is a real, substantial improvement that eliminates the O(N²) scaling problem. Expected improvement: 10-100x reduction in server CPU per sync operation.

### Scenario 1: Custom Purge Functions — THE HARDEST PROBLEM ⚠️⚠️⚠️

**Status: NOT natively supported. Requires custom preprocessing layer.**

CHT purging receives a self-contained JavaScript function via `purge.js` that takes `(userCtx, contact, reports, messages, chtScriptApi)` and returns which documents to purge. Partners write custom logic like "purge pregnancy reports older than 1 year where the outcome has been recorded" or "purge home visit reports for muted contacts." This is Turing-complete JavaScript evaluated against document *relationships* — a contact and all its associated reports, considered together.

PowerSync Sync Streams are SQL-based rules. You cannot express arbitrary JavaScript relationship logic in SQL WHERE clauses. There is no way to write a Sync Stream rule that says "include this report unless the purge function for this partner's configuration returns true for this report given this contact's full report history."

**Workaround:** Continue running `purge.js` server-side (as CHT already does for server-side purge), write results to a `purge_status` table in PostgreSQL, and have Sync Streams reference that table:

```sql
-- In Sync Stream data query
SELECT r.* FROM reports r
WHERE r.facility_id = bucket.facility_id
  AND r.id NOT IN (
    SELECT doc_id FROM purge_status 
    WHERE user_role = bucket.user_role
  )
```

This preserves partner-configurable purge logic but adds a dependency — the purge preprocessing service must run before Sync Streams can reflect purge decisions. **Estimated effort: 4-6 weeks.**

### Scenario 2: Role-Based Replication Depth — SOLVABLE BUT FIDDLY ⚠️⚠️

**Status: Achievable with JWT parameterization, but not automatic.**

CHT configures replication depth per role — for example, a `district_manager` at depth 1 sees facilities but not individual patients, while a `chw` at depth 2 sees their facility plus patients. This depth is configurable per deployment and per role.

PowerSync Sync Streams can handle this with recursive CTEs parameterized by JWT claims:

```sql
-- Parameter query
WITH RECURSIVE hierarchy AS (
  SELECT id, 0 as depth FROM locations WHERE id = token_parameters.facility_id
  UNION ALL
  SELECT l.id, h.depth + 1 FROM locations l 
  JOIN hierarchy h ON l.parent_id = h.id
  WHERE h.depth < token_parameters.replication_depth  -- from JWT
)
SELECT id as location_id FROM hierarchy
```

This works but requires encoding `replication_depth` into the JWT token per user session, and updating Sync Streams whenever the CHT deployment changes its depth configuration. **Estimated effort: ~1 week.**

### Scenario 3: Sensitive/Private Documents — CLEAN FIT ✅

**Status: Natively supported.**

Reports with `fields.private = 'yes'` should not replicate to subordinate users — only the submitter should see them. This includes checking all subject identifiers (uuid, patient_id, place_id).

This maps to SQL cleanly:

```sql
SELECT * FROM reports 
WHERE facility_id = bucket.facility_id
  AND NOT (is_private = true AND submitter_id != bucket.user_id)
```

PowerSync handles this well. No issue.

### Scenario 4: Task and Target Documents — WORKS BUT CHANGES THE MODEL ⚠️⚠️

**Status: Achievable with code migration. Actually simpler than CouchDB model.**

Task documents are generated client-side by the rules engine and are safe to purge when 60 days past `end_date` in a terminal state. Target documents are safe to purge when the reporting period is over. These are hard-coded rules, not partner-configurable.

In CouchDB, tasks/targets are regular documents that sync bidirectionally and get purged by the server-side purge process. In PowerSync, the client generates task/target documents, uploads them via the write queue to PostgreSQL, and purge becomes a PostgreSQL cron job:

```sql
DELETE FROM tasks 
WHERE status IN ('Cancelled','Completed','Failed') 
  AND end_date < NOW() - INTERVAL '60 days';

DELETE FROM targets 
WHERE reporting_period_end < NOW() - INTERVAL '6 months';
```

This is actually *simpler and more reliable* than the CouchDB model. PowerSync picks up the deletion via logical replication and removes it from clients.

**However**, the CHT rules engine currently writes tasks/targets to PouchDB and expects to read them back from the same local database. With PowerSync, it writes to local SQLite and reads from local SQLite. The rules engine code needs to be adapted to use SQL queries instead of PouchDB `allDocs`/`query`. This is a significant code migration touching the rules engine internals. **Estimated effort: 6-8 weeks.**

### Scenario 5: Configuration Documents (app_settings, forms, translations) — REQUIRES SEPARATE STREAM ⚠️

**Status: Achievable with dedicated global stream.**

CHT stores configuration as CouchDB documents that sync to ALL users regardless of hierarchy position. CouchDB is used as the primary store for all app data *and configuration*. The authorization function includes these global documents for every user.

PowerSync Sync Streams filter data into buckets. You need a separate "global config" stream with no user-specific filtering:

```sql
-- Global stream: no parameters, all users get everything
SELECT * FROM config_documents;
```

PowerSync supports multiple streams per client, so this is architecturally straightforward. But it means CHT's configuration deployment model (`cht-conf` uploads to CouchDB, all clients pick it up on next sync) needs to be reworked to write to PostgreSQL instead, with a global stream delivering updates. **Estimated effort: ~1 week.**

### Scenario 6: Per-User Meta Databases — SCHEMA REDESIGN REQUIRED ⚠️⚠️

**Status: Achievable but requires redesign.**

CHT uses per-user databases (`medic-user-{username}-meta`) for feedback documents, read status tracking, and telemetry data. These are separate CouchDB databases with their own bidirectional replication.

PowerSync has no concept of per-user databases. The workaround is collapsing these into a single PostgreSQL table with a `user_id` column and a Sync Stream filtering by user:

```sql
-- Sync Stream for user meta
SELECT * FROM user_meta WHERE user_id = token_parameters.user_id;
```

This is actually an operational improvement — instead of managing thousands of tiny CouchDB databases, you have one table. But it requires redesigning how the CHT Android/web app creates, reads, and syncs meta documents. The replication of feedback and telemetry to the shared `medic-users-meta` database (which Sentinel currently handles) becomes a simple PostgreSQL query instead. **Estimated effort: 2-3 weeks.**

### Scenario 7: The "docs_by_replication_key" Authorization Flow — THE ACTUAL PERFORMANCE WIN ✅

**Status: This is where PowerSync genuinely eliminates the bottleneck.**

The current CHT replication flow queries `medic/docs_by_replication_key`, which must scan the full database to determine which documents each user can access. Download sync runs on a 5-minute timer specifically because of this heavy cost.

PowerSync's bucket architecture pre-partitions data so each client requests only its assigned buckets — the server never scans the full database. This is the single biggest improvement PowerSync delivers.

### Summary: PowerSync sync semantics gap analysis

| Scenario | Status | Effort | Notes |
|----------|--------|--------|-------|
| Custom purge functions (`purge.js`) | ⚠️ Preprocessing required | 4-6 weeks | Hardest problem. SQL can't express arbitrary JS logic |
| Role-based replication depth | ⚠️ JWT parameterization | ~1 week | Solvable but requires JWT claim management |
| Sensitive/private documents | ✅ Native | 0 | Clean SQL mapping |
| Tasks/targets (rules engine) | ⚠️ Code migration | 6-8 weeks | PouchDB→SQLite API change in rules engine |
| Global config documents | ⚠️ Separate stream | ~1 week | Straightforward dedicated stream |
| Per-user meta databases | ⚠️ Schema redesign | 2-3 weeks | Actually an improvement operationally |
| Authorization filtering (core) | ✅ Native | 0 | The big performance win |

**Total additional engineering effort for sync semantics: ~14-19 weeks (3-4 months)** on top of the PowerSync integration itself.

### What this means for the custom sync alternative

A custom REST sync approach (Simple.org-style) would handle scenarios 1, 2, 4, and 6 natively because you control the entire sync protocol. You could implement `purge.js` evaluation directly in the sync decision path, encode replication depth as a first-class sync parameter, write the rules engine to target whatever local storage you choose, and design per-user data isolation however you want.

The trade-off: you're building and maintaining the entire sync engine yourself — the performance optimization (scenario 7), conflict resolution, offline queuing, retry logic, delta sync, and all edge cases that PowerSync handles out of the box. Simple.org has invested years of engineering into their sync layer, and they describe sync as "really hard" — acknowledging challenges with maintaining API backward compatibility, handling concurrent edits, and balancing sync frequency against battery drain.

---

## Fall 2027 target deadline analysis

CHT has approximately 18 months from March 2026 to the Fall 2027 target deadline, with 3-6 months of stability testing required before deployment for government handover. This leaves an effective development window of 12-15 months.

**Custom REST sync timeline: 12-15 months (TIGHT FIT).** Phase 1 foundation and core sync takes 3-4 months with 2-3 engineers, client integration adds 3-4 months with 2-3 engineers, testing and hardening requires 2 months, leading to production readiness around Summer 2027. This timeline has limited buffer for unexpected issues but is achievable with a dedicated team starting immediately.

**PowerSync approach timeline: 9-12 months (COMFORTABLE FIT).** Core integration takes 1-2 months with 2 engineers, sync semantics gap work (purge preprocessing, rules engine migration, meta database redesign) adds 3-4 months with 2-3 engineers, testing and national rollout completes in months 7-10. This achieves production readiness around January-March 2027, providing a 6-8 month buffer for comprehensive load testing, multiple rollout waves, and a safe rollback window.

The timeline differential favors PowerSync but does not categorically eliminate the custom approach — it depends on team capacity and risk tolerance.

---

## Engineering effort and migration complexity

**Custom REST sync: 18-24 person-months, ~$637K over 5 years.** This requires building 8,000-12,000 lines of backend code (sync protocol layer, data model transformation, authentication, delta sync logic) plus 5,000-7,000 lines of mobile/client code. The team must design and implement bidirectional sync, sequence-based change tracking, conflict resolution engines, and extensive testing of edge cases. Ongoing maintenance requires 0.5-1 FTE ($75K-150K annually) for bug fixes, performance tuning, and updates as scale increases.

This approach provides complete control over the sync protocol, native support for CHT's full authorization model (including purge.js, replication depth, and per-user meta databases), and zero vendor dependency. The downside is massive complexity and timeline risk.

**PowerSync integration: 10-14 person-months (including sync semantics gap work), ~$120K over 5 years.** Core integration requires 2,000-4,000 lines of code for Sync Streams configuration, write handler API, and schema adapter layer. The sync semantics gap work adds approximately 3-4 months: purge preprocessing service (~4-6 weeks), rules engine PouchDB→SQLite migration (~6-8 weeks), per-user meta redesign (~2-3 weeks), and JWT/config stream setup (~2 weeks). Ongoing maintenance at 0.25-0.5 FTE ($37,500-75,000 annually).

For cht-datasource integration, PowerSync's approach aligns with CouchDB's document model through JSONB columns. The PowerSync adapter wraps the SDK in CHT's abstraction layer (approximately 1,500 lines of code, 3-4 person-weeks), maps CRUD operations to PowerSync methods, and uses SQLite views to match cht-datasource expectations.

The 47 instances → 1 national instance consolidation is simpler with PowerSync. Its Sync Streams provide built-in dynamic partial replication — define rules per user/facility hierarchy, and PowerSync automatically segments data. Setup takes 2-3 weeks for logical replication configuration plus 2-3 weeks defining CHT hierarchy rules. The custom approach requires manual implementation of PostgreSQL partitioning, row-level security policies, and custom sync protocol modifications for facility-based filtering — a 2-3 month effort.

---

## Performance characteristics and real-world validation

**Simple.org demonstrates proven scale** at nearly 7 million patients across 5,000 facilities in 5 countries, with clinicians managing 200 patients per day in high-volume clinical environments. The app maintains an under-20MB footprint and works reliably for days offline. Field deployment across rural India, Bangladesh, Ethiopia, and Sri Lanka validates performance in challenging connectivity environments. However, Simple.org lacks published performance benchmarks — no specific metrics for initial sync time, incremental sync latency, or bandwidth usage.

**PowerSync provides detailed benchmarks.** Initial sync performance on Android (Pixel 8a, mid-range 8GB RAM) shows 10k rows in 1.4 seconds (7.1k rows/sec), 100k rows in 21.8 seconds (4.6k rows/sec), and 1M rows in 344 seconds (2.9k rows/sec). Incremental sync latency is 143-200ms for single updates, 178-229ms for 100 batched updates, and 528-613ms for 1000 updates.

**Critical gap for both approaches:** Neither has been tested on the 1-2GB RAM low-end Android devices CHT targets for 100,000+ community health workers. PowerSync's wa-sqlite offers OPFSCoopSyncVFS (recommended for low-end devices, handles databases exceeding 1GB) and IDBBatchAtomicVFS (performs well under 100MB but degrades beyond that). A PoC must validate performance on actual CHW devices regardless of which approach is chosen.

PowerSync's healthcare case study — a healthcare app migrating from MongoDB Realm to PowerSync in 2 weeks with a single frontend developer — demonstrates viability for healthcare workflows, though not at CHT's 100K user scale.

---

## Filtered sync: the core comparison

CHT's biggest pain point is filtered replication. The current CouchDB model downloads documents then filters client-side, causing O(N²) performance degradation. Both approaches solve this differently.

**Custom REST sync filtering:** You implement filtering in the API endpoint. The server queries PostgreSQL with the user's facility, role, and replication depth, applies purge logic inline, and returns only relevant document IDs. This is conceptually identical to CHT's current `get-ids` endpoint but backed by PostgreSQL instead of CouchDB views — with dramatically better query performance due to proper indexing. You have complete control to embed `purge.js` evaluation, replication depth, sensitive document filtering, and any future authorization logic directly in the sync decision path.

**PowerSync Sync Streams filtering:** Data is pre-partitioned into buckets on the server. Clients request bucket IDs and receive only their data. For CHT's hierarchy:

```yaml
streams:
  patient_data:
    parameters:
      - SELECT chp_id, facility_id FROM user_hierarchy
        WHERE user_id = token_parameters.user_id
    data:
      - SELECT * FROM contacts WHERE facility_id = bucket.facility_id
      - SELECT * FROM reports WHERE facility_id = bucket.facility_id
        AND id NOT IN (SELECT doc_id FROM purge_status WHERE role = bucket.user_role)
```

PowerSync's bucket deduplication is a significant advantage: shared data (like facility-level protocols) exists in a single bucket accessed by multiple users. At 100K users, this eliminates enormous redundant storage and bandwidth. A custom sync approach would need to implement similar caching/deduplication manually.

**Verdict:** PowerSync wins on performance architecture. Custom sync wins on semantic flexibility. PowerSync with the preprocessing layer (purge_status table, JWT claims) reaches approximate parity on semantics at the cost of added infrastructure complexity.

---

## Build vs buy analysis

**Simple.org's sync code cannot be adopted as a library.** The MIT-licensed repositories have excellent code, but sync logic is tightly embedded within the application, built specifically for hypertension/diabetes tracking workflows. There is no abstraction layer separating sync from domain models. To use it, you'd need to fork the entire codebase and extract/refactor the sync layer — essentially rebuilding from scratch.

Simple.org's value is as a **reference implementation** showing healthcare-specific offline patterns: bi-temporal modeling for conflict resolution, UUID-based offline ID generation, facility-scoped sync for bandwidth optimization, and last-write-wins strategies for medical records. These are architectural principles to adopt, not code to reuse.

**PowerSync licensing supports adoption.** Client SDKs (JavaScript, Flutter, Kotlin, Swift) are Apache 2.0 licensed — truly open source and forkable. The PowerSync Service uses FSL (Functional Source License), which is source-available but not OSI-approved open source. FSL automatically converts to Apache 2.0 after 2 years.

**Vendor lock-in is medium-low severity.** Client SDKs are Apache 2.0 (forkable), standard databases are used without modification, self-hosting via Open Edition is available, and local data is stored in standard portable SQLite format. The exit strategy to self-hosted Open Edition takes 2-4 weeks of DevOps work; migrating away from PowerSync entirely to custom sync would require 6-12 months of rebuilding.

---

## Total cost of ownership comparison

**Custom REST sync build: ~$637,200 over 5 years.** Year 1 development $150K (1 FTE × 12 months), infrastructure $3,600. Years 2-5: ongoing development ($50K, $50K, $25K, $25K), infrastructure scaling ($4,800-$12,000), maintenance staffing at 0.5 FTE ($75K annually). Hidden costs include 12+ months of opportunity cost to production-ready sync.

**PowerSync Cloud Pro: ~$120,000 over 5 years** (including sync semantics gap work engineering). Year 1: integration + gap work engineering ~$75K, PowerSync fees ~$888. Years 2-5: PowerSync usage fees scaling from ~$1,500 to ~$25,000 as user count grows, plus 0.25 FTE maintenance ($37,500). Even at 500K users in Year 5, PowerSync costs approximately $25K annually in platform fees — a fraction of custom sync maintenance.

**PowerSync Open Edition (self-hosted): ~$260,000 over 5 years** including infrastructure ($6K/year), 0.25 FTE DevOps ($37,500/year), and Year 1 integration + gap work ($75K). More expensive than cloud but provides full data sovereignty.

---

## Coexistence strategy and rollback safety

**PowerSync enables cleaner cutover.** Phase 1 (Months 1-2): PostgreSQL setup with no client changes — rollback is trivial. Phase 2 (Months 3-6): Deploy to single pilot facility running both systems in parallel. Phase 3 (Months 7-10): Progressive rollout by facility, allowing gradual CouchDB decommissioning while maintaining rollback for 3 months post-migration.

**Custom sync requires complex dual-write strategy.** Phase 1: reads from CouchDB while writing to both CouchDB and PostgreSQL for 3+ months. Phase 2: gradually migrates clients to PostgreSQL sync while maintaining CouchDB for legacy clients. Phase 3: forces client upgrades, shifts CouchDB to read-only. This dual-write introduces consistency challenges, complex rollback procedures, and higher infrastructure costs during the 7-9 month transition period.

For the Fall 2027 target deadline, PowerSync's cleaner cutover reduces risk. Progressive facility-by-facility rollout means that if issues arise, only affected facilities roll back rather than requiring system-wide reversions.

---

## Community and ecosystem

**Simple.org has limited external community** (~320 GitHub stars, email-only support) but is backed by Resolve to Save Lives (Bloomberg Philanthropies) with government partnerships providing operational stability. Excellent reference for healthcare patterns but not a reusable platform.

**PowerSync has active, growing community** (~1,800 GitHub stars, active Discord, weekly blog posts, comprehensive documentation). Backed by JourneyApps with 10+ years of production history. Commercial model provides sustainability. Support scales from community (free) through Pro (email) to Enterprise (24/7/365 with HIPAA compliance and SOC 2 Type 2 certification).

---

## Recommendation: PowerSync with explicit acknowledgment of sync semantics gaps

**PowerSync is recommended** for CHT's PostgreSQL migration based on the combination of faster timeline (6-8 month buffer vs minimal buffer), dramatically lower cost (5-year TCO ~80% less), elimination of the core performance bottleneck, and browser/PWA-native support.

**However, the recommendation must be honest about what PowerSync does NOT solve natively.** The sync semantics gaps — particularly partner-configurable purging and the rules engine migration — add approximately 3-4 months of engineering work and introduce architectural dependencies (purge preprocessing service, JWT claim management) that increase system complexity. If the team underestimates this work, the timeline advantage narrows significantly.

**Critical implementation phases:**

1. **Months 1-2: Core PowerSync integration.** PostgreSQL setup, logical replication, basic Sync Streams for contacts and reports, write handler API. No client changes yet.

2. **Months 3-4: Sync semantics gap work (parallel tracks).**
   - Track A: Purge preprocessing service — run `purge.js` server-side, write results to `purge_status` table, integrate into Sync Stream queries.
   - Track B: Rules engine migration — adapt task/target generation from PouchDB to PowerSync SQLite.
   - Track C: Per-user meta database redesign and global config stream.

3. **Months 5-6: Pilot deployment.** Deploy to 2-3 small counties running parallel with CouchDB. Validate all sync scenarios including purge, depth, sensitive docs, tasks/targets.

4. **Months 7-10: Progressive national rollout.** 5 cohorts of 8-12 counties. Consolidate 47 instances → single national instance using Sync Streams for hierarchical data partitioning.

5. **Months 11-14: Buffer period through Fall 2027.** Load testing, optimization, rollback window.

**When to reconsider custom sync:** If the PoC reveals that PowerSync's Sync Streams cannot express CHT's authorization model with acceptable performance (e.g., the purge preprocessing adds unacceptable latency, or recursive CTE parameter queries timeout at scale), then a custom REST sync approach becomes necessary despite the higher cost and timeline risk. The PoC in months 1-2 should explicitly test these edge cases before committing.

**For the 47→1 instance consolidation,** PowerSync's dynamic partial replication is purpose-built for this scenario. Define Sync Streams rules mapping CHT's hierarchy (national → county → sub-county → facility → CHP), configure PowerSync Service with logical replication from the consolidated PostgreSQL instance, and let PowerSync handle automatic data segmentation per user. This takes 4-6 weeks total versus 2-3 months of manual implementation.

**Risk mitigation:** Start development immediately to maximize available time. Pilot in a single county before national rollout. Maintain CouchDB instances in read-only mode for 3 months post-cutover. Choose OPFSCoopSyncVFS for production deployment (Safari compatibility, large database support) with IDBBatchAtomicVFS fallback for older browsers. Consider PowerSync Enterprise once scaled for dedicated support and HIPAA compliance.

PowerSync provides the strongest overall path for CHT's PostgreSQL migration — but the path includes non-trivial engineering work to bridge the gap between PowerSync's SQL-based sync model and CHT's JavaScript-based authorization semantics. Acknowledging and planning for this gap is the difference between a successful migration and a stalled one.