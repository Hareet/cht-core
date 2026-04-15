# Production-Scale Benchmark: CouchDB get-ids vs PowerSync Incremental Sync

## Background

This benchmark replicates and extends the CHT team's performance analysis from
[medic/cht-core#10262 (comment)](https://github.com/medic/cht-core/issues/10262#issuecomment-3337084204),
which measured `GET /api/v1/replication/get-ids` performance under concurrent load.
The original benchmark demonstrated that even with the Nouveau (Lucene) index
optimization in CHT 5.0, `get-ids` remains a significant bottleneck at scale — averaging
1m 17s per user at 10 concurrent on an EC2 c5.2xlarge with 3M docs and 140 users.

We replicate their methodology and add a PowerSync comparison to quantify how much
the WAL-based sync architecture improves on the filtered replication problem.

## Setup Comparison

| | CHT Team (Issue #10262) | Our Test |
|--|------------------------|----------|
| Hardware | EC2 c5.2xlarge (8 CPU, 16GB) | Dev laptop (24 CPU, 48GB) |
| Total documents | 3,000,000 | 589,002 |
| Users | 140 (~20K docs each) | 120 CHW district_admin (~15K docs each) |
| CouchDB version | CHT 5.x (Nouveau) | Same |
| PowerSync | Not tested | Self-hosted, optimized Sync Streams |
| Concurrency levels | 10, 20, 30, 40, 50 | 10, 20, 30, 40, 50 (both CouchDB and PowerSync) |

## Data Generation

We used CHT's existing `generate-real-world-data.js` with a scaled `size-config.json`
to create a realistic county-level hierarchy:

```json
{
  "number_of_district_hospitals": 1,
  "number_of_managers_per_district_hospitals": 10,
  "number_of_health_centers_per_district_hospital": 40,
  "number_of_chw_per_health_center": 3,
  "number_of_clinics_per_health_center": 50,
  "number_of_family_members": 160
}
```

This produced:
- **1 district hospital** → 40 health centers → 2,000 clinics
- **320,000 persons** (160 family members per clinic)
- **~134,000 reports** (pregnancy surveys, assessments, follow-ups)
- **130 users** (10 managers/supervisors + 120 CHW `district_admin` users)
- **~15,000 documents per CHW** in their replication scope

Data was uploaded to CouchDB using `cht upload-docs` and `cht create-users`:
```bash
cd /tmp/scaled-data/precondition-data
cht --url=http://admin:****@localhost:5988 upload-docs --source=.
cht --url=http://admin:****@localhost:5988 create-users --source=.
# Reports uploaded separately (133,429 docs)
```

## PostgreSQL Seeding and PowerSync Preparation

### couch2pg replication
The `cht-couch2pg` service replicated all 589K docs from CouchDB to PostgreSQL's
`v1.couchdb` table via the continuous `_changes` feed.

### User facility computation
User access was computed by seeding `v1.user_settings` from the CouchDB user-settings
documents, then running `refresh_user_facilities()` for each CHW user. This required:

1. **`parent_id` stored column** on `v1.couchdb` — a regular (not generated) column
   storing the parent place UUID, maintained by a BEFORE INSERT/UPDATE trigger.
   Critical for recursive CTE performance (index scan vs full table scan at each level).

2. **Parallel facility refresh** — 120 users processed in 5.5 seconds at 12-way
   concurrency using the indexed `parent_id` column.

3. **53 facilities per CHW** (50 clinics + 1 health center + 1 district + 1 primary
   contact) — only places, no persons in the facility list.

### Sync Streams optimization
The PowerSync Sync Streams configuration was optimized to minimize bucket count while
maintaining correct authorization semantics:

- **Merged streams**: `accessible_data` + `report_data` → single `all_data` stream
  with one shared `accessible_facilities` CTE
- **No JOINs against CTE**: Person contacts matched via `contacts.parent_id IN
  accessible_facilities` (not JOIN). Reports matched via `resolved_subject_place_id
  IN accessible_facilities` (denormalized column, no JOIN).
- **~59 buckets per user** (down from 16,115 before heavy sync stream optimizations)

Key discovery: PostgreSQL generated columns (`GENERATED ALWAYS AS ... STORED`) are
NOT replicated via logical replication (WAL). The `parent_id` column had to be
converted to a regular column with a trigger to be visible to PowerSync.

### Data completeness verification
Before running the benchmark, we verified that PowerSync syncs the same documents
as CouchDB for each user:

| Document type | CouchDB (get-ids) | PowerSync (Sync Streams) |
|--------------|-------------------|--------------------------|
| Places (clinics, HCs, district) | included | 53 via `_id IN CTE` |
| Persons (family members) | included | 8,013 via `parent_id IN CTE` |
| Reports (subject-matched) | included | 6,616 via `resolved_subject_place_id IN CTE` |
| **Total unique docs** | **~14,881 avg** | **14,681** |

**Zero under-sync** — every document a user should see via CouchDB is also synced
via PowerSync. The ~200 doc difference is from global config, user settings, and
user meta documents in separate fixed streams not counted in the per-user query.

## Results: Full Concurrency Curve

### Same dataset, same users, same hardware

Both engines tested against the same 589K docs, same 120 CHW users (~15K docs each),
on the same machine. Sentinel and couch2pg stopped for both.

### Initial Sync: CouchDB get-ids vs PowerSync full data delivery

| Concurrency | CouchDB get-ids (ID list only) | PowerSync initial sync (full ~15K docs) |
|-------------|-------------------------------|----------------------------------------|
| **10** | **10.8s** (4.5-14.4s) | **4.7s** (2.0-9.1s) |

PowerSync delivers the **complete dataset** (~15K docs into local SQLite) faster than
CouchDB can compute the **list of document IDs**. CouchDB's user would still need to
download the actual documents via `_bulk_get` after the 10.8s.

### Incremental Sync: Per-change round-trip at all concurrency levels

| Concurrency | CouchDB get-ids | PowerSync Incremental | Ratio | CouchDB Errors | PS Errors |
|-------------|----------------|----------------------|-------|----------------|-----------|
| **10** | **10.8s** (4.5-14.4s) | **335ms** (52ms-2.4s) | **32x** | 0/120 | 0/1200 |
| **20** | **22.5s** (6.2-28.9s) | **773ms** (102ms-4.3s) | **29x** | 0/120 | 0/1200 |
| **30** | **30.0s** (6.2-39.2s) | **1.0s** (0.1-3.8s) | **29x** | 0/120 | 0/1200 |
| **40** | **38.3s** (10.2-53.0s) | **1.5s** (0.1-5.3s) | **26x** | 0/120 | 0/1200 |
| **50** | **52.4s** (9.6-1m 7s) | **1.8s** (0.1-7.3s) | **30x** | 0/120 | 0/1200 |

**PowerSync is 26-32x faster across all concurrency levels with zero failures
in 6,000 total iterations. Zero errors on both sides.**

Note the comparison is asymmetric and favors CouchDB:
- CouchDB's 10.8s measures **only the ID list** (`get-ids`). The actual document
  download via `_bulk_get` would add additional time on top to complete the sync.
- PowerSync's 335ms measures the **complete round trip** — from PostgreSQL INSERT
  to the document appearing in local SQLite, including WAL propagation, bucket
  evaluation, WebSocket streaming, and local write. There is no additional step.

### What each measurement includes

- **CouchDB get-ids**: Full authorization context recomputation → Nouveau index
  query with all subject keys → filter by sensitivity and purge → return doc ID list.

- **PowerSync initial sync**: Connect WebSocket → compute bucket membership → stream
  all ~15K docs → write to local SQLite. Complete user data delivery.

- **PowerSync incremental**: Write test document to PostgreSQL → BEFORE trigger sets
  `parent_id` and `resolved_subject_place_id` → WAL entry → PowerSync service evaluates
  bucket membership → WebSocket push → PowerSync SDK writes to local SQLite → benchmark
  detects doc.

### Percentile Detail

| Concurrency | CouchDB P50 | CouchDB P95 | PS Incremental P50 | PS Incremental P95 |
|-------------|------------|------------|--------|--------|
| 10 | 11.8s | 14.4s | 304ms | 680ms |
| 20 | 25.3s | 28.9s | 607ms | 1,911ms |
| 30 | 35.3s | 39.2s | 842ms | 2,363ms |
| 40 | 47.0s | 52.5s | 1,226ms | 3,344ms |
| 50 | 59.8s | 1m 6s | 1,567ms | 3,720ms |

### Degradation from Baseline (concurrency 10)

| Concurrency | CouchDB | PowerSync | CHT Team Reference |
|-------------|---------|-----------|-------------------|
| 10 | 1.00x | 1.00x | 1.00x |
| 20 | 2.08x | 2.31x | 2.13x |
| 30 | 2.77x | 2.99x | 3.17x |
| 40 | 3.54x | 4.48x | 4.29x |
| 50 | 4.85x | 5.37x | 4.94x |

All three degrade at nearly identical rates — both engines and the CHT team's
results all reach ~5x at concurrency 50. The degradation curves are remarkably
similar because the bottleneck in all cases is concurrent access to a shared
resource (Nouveau index for CouchDB, WAL pipeline for PowerSync). The critical
difference is the baseline: CouchDB starts at 10.8s, PowerSync starts at 335ms.

### CHT Team Reference Data

From [medic/cht-core#10262 (comment)](https://github.com/medic/cht-core/issues/10262#issuecomment-3337084204),
measured on EC2 c5.2xlarge with 3M docs and 140 users (~20K docs each):

| Concurrency | CHT Team (Nouveau) | Our CouchDB | Our PowerSync (incremental) |
|-------------|-------------------|-------------|----------------------------|
| 10 | 1m 17s | 10.8s | 335ms |
| 20 | 2m 44s | 22.5s | 773ms |
| 30 | 4m 04s | 30.0s | 1.0s |
| 40 | 5m 30s | 38.3s | 1.5s |
| 50 | 6m 20s | 52.4s | 1.8s |

Our CouchDB results are ~4-7x faster than the CHT team's due to faster hardware (24 vs
8 cores) and fewer docs (589K vs 3M). On our hardware, PowerSync at concurrency 50
completes in 1.8s compared to CouchDB's 52.4s — a 30x difference on the same dataset.
At concurrency 10, CouchDB completes in 10.8s vs PowerSync's 335ms — a 32x gap.

## Why PowerSync Eliminates the Filtered Replication Problem

The core issue identified in [#10262](https://github.com/medic/cht-core/issues/10262)
is that `get-ids` must re-compute the full authorization context on **every sync
cycle** (approximately every 5 minutes for every connected CHW). At 100 concurrent
CHWs, that's 20 `get-ids` calls per minute, each taking 10-52 seconds under load.

PowerSync's architecture eliminates this entirely:

| | CouchDB (current) | PowerSync |
|--|-------------------|-----------|
| Initial user sync | get-ids 10.8s (IDs only) + bulk_get (data) | 4.7s (full data delivered) |
| Every subsequent sync | Re-runs get-ids: 10.8s | WAL push: 335ms |
| Per-request cost | O(subject_keys x index_size) — 10-52s | O(changes_since_last_sync) — sub-second |
| Concurrency impact | All users contend for same Nouveau index | Independent WebSocket streams |
| At 10 concurrent | 10.8s avg | 335ms avg |
| At 50 concurrent | 52.4s avg | 1.8s avg |
| Errors at scale | 0 (CHW users) | 0 |

After initial sync, PowerSync clients receive changes via WebSocket push. There is
no periodic polling, no index query, no authorization re-computation. The "filtered
replication problem" does not exist in PowerSync's architecture because bucket
membership is evaluated once when data enters the system, not on every client sync.

## Methodology Notes

### Test scripts
- CouchDB get-ids: `tests/scalability/run-scaled-getids-benchmark.sh`
- PowerSync incremental: `tests/scalability/run-scaled-powersync-benchmark.sh`
- Workers: `tests/scalability/workers/getids-worker.js`, `workers/powersync-worker.mjs`
- Data generation: `tests/scalability/generate-real-world-data/` with scaled `size-config.json`
- Facility refresh: `tests/scalability/powersync-benchmark/refresh-facilities-parallel.cjs`

### PowerSync configuration
- Single container, `NODE_OPTIONS=--max-old-space-size=16384`
- Separate bucket storage database (`powersync_storage`)
- Sync Streams limits: `max_parameter_query_results: 20000`, `max_buckets_per_connection: 20000`
- Sentinel and couch2pg stopped during benchmarks

### CouchDB configuration
- Standard CHT 5.x with Nouveau enabled
- Sentinel stopped during benchmark
- Manager/national_admin users excluded (only `district_admin` CHW users tested)

### PowerSync incremental sync used `DIRECT_PG=1`
Test documents were written directly to PostgreSQL (bypassing the CHT API write
handler) because the write handler returned 403 for `district_admin` role users.
This measures the pure sync pipeline: PG write → WAL → PowerSync service → WebSocket
→ local SQLite. The CouchDB get-ids benchmark also bypasses Sentinel processing,
making this a fair comparison of the sync layer only.

### Sampling
- CouchDB: 120 users cycled through at each concurrency level, 1 get-ids call per user
- PowerSync initial sync: 120 users, each performs `waitForFirstSync()` downloading ~15K docs
- PowerSync incremental: 120 users, 10 iterations per user (1,200 total per level)

### Raw data
- CouchDB results: `benchmark_results_scaled/getids-{10,20,30,40,50}.jsonl`
- PowerSync results: `benchmark_results_scaled/powersync-scaled-{10,20,30,40,50}.jsonl`
  (includes both `type: "initial_sync"` and incremental entries)
