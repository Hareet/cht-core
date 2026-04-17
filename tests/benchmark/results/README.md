# Write-Path Benchmark Results

Results from `tests/benchmark/benchmark-write-path.js` — measures PouchDB and
PowerSync write paths across device tiers (go / budget / standard / high) and
backends (CouchDB / Postgres via `cht-datasource`).

Each run writes 1 JSON file named
`benchmark-write-path-results-<backend>-<deviceTier>-<network>[-suffix].json`.

## Two detection methodologies captured here

The `serverDetectionMs` metric (how long from client write → doc visible
server-side) depends on how the benchmark's Test B *looks up* the doc it just
wrote. That changed mid-iteration. The suffix tells you which method was used.

### `-scan` files (legacy — pre-iteration-2 detection)

Used before 2026-04-17 T14:00 UTC. At that point:

- cht-datasource on the CouchDB local adapter did **not** yet honour the
  client-minted `_id` (`idHint` was only in the Postgres adapter in the image,
  not yet mounted for both adapters).
- The benchmark embedded a unique `marker` string in the report's `fields`
  JSON and searched for it server-side.
- **CouchDB variants**: Mango `_find` with `fields: {"$regex": "<marker>"}` —
  no index matches this selector, so CouchDB scans every `data_record` doc
  (~800K in the CIV dataset). Takes 2-10+ seconds per probe.
- **Postgres variants**: `SELECT … WHERE doc->>'fields' LIKE '%<marker>%'` on
  `v1.couchdb` — no index on that expression, sequential JSONB scan. Takes
  2-8 seconds per probe.

Consequence: `serverDetectionMs` in these files is the sum of
(actual upload latency) + (full-table scan detection cost), inflated — often
by 2-8 seconds, sometimes much more on throttled tiers where the server is
also serving the client's initial sync bandwidth.

Preserved so we can show "here's what happened when we didn't have primary-key
detection" if anyone asks why we invested in idHint propagation.

### Files without the `-scan` suffix (current — post-fix)

Used from 2026-04-17 T14:00 UTC forward. Requires:

1. `@medic/cht-datasource` built from playtime (agent-1's `idHint` on both
   local and Postgres `createDoc`), bind-mounted into cht-api's
   `/service/shared-libs/cht-datasource/dist/`.
2. `powersync-upload.js` passing the PowerSync `CrudEntry.id` as `idHint`
   into `Report.v1.create`.
3. Benchmark's `pollForServerDoc(docId)` doing a primary-key lookup —
   `GET /medic/<docId>` on CouchDB, `SELECT … WHERE _id = $1` on Postgres.

Consequence: `serverDetectionMs` is the true end-to-end upload latency —
client write → CHT api → cht-datasource.create → storage, + one sub-ms PK
probe. No scan time leaks into the metric.

Also: a **pre-flight check** (`/api/v1/powersync/status` now exposes the
api's `CHT_DB_BACKEND`) asserts `BENCHMARK_TARGET` matches the api's
configured backend and fails the run loudly on mismatch. Prevents the
scenario where writes silently land in Postgres while the benchmark polls
CouchDB (or vice versa).

## Tier matrix snapshot — `-scan` set (legacy numbers)

Captured pre-fix. `serverDetectionMs` inflated; use only for comparison
context, not for roadmap decisions.

| Tier / backend | Local persist avg | Batch 10 docs | serverDetectionMs | Notes |
|----------------|------------------:|--------------:|------------------:|-------|
| Go / CouchDB   | 26ms (12-40) | 170ms (17/doc) | **22,039** | 4× CPU + 3G + scan cost |
| Go / Postgres  | 19ms (9-40)  | 123ms (12/doc) | **8,652**  | 4× CPU + 3G + scan cost |
| Budget / CouchDB | — | — | -1 (not detected) | pre-fix run slot replaced by PouchDB |
| Budget / Postgres | 10ms (9-14) | 56ms (5.6/doc) | **8,099** | 2× CPU + 3G + scan cost |

Matching source files in this directory with the `-scan` suffix.

## Tier matrix snapshot — clean set (indexed detection)

Populated during 2026-04-17 refresh runs. Initial clean data point:

| Tier / backend | Local persist avg | Batch 10 docs | serverDetectionMs | Notes |
|----------------|------------------:|--------------:|------------------:|-------|
| Budget / CouchDB | 13ms (9-24) | 91ms (9/doc) | **4,030** | 2× CPU + 3G, PK lookup |

The rest of the matrix is still to be rerun. Files without `-scan` are the
authoritative numbers for the PouchDB↔PowerSync and CouchDB↔Postgres
comparisons going forward.

## PouchDB results (unaffected by the mango/indexed split)

The PouchDB path uses `db.put` → `db.replicate.to(remote)` → CHT's offline
db-doc handler → CouchDB. Detection is a direct `GET /medic/<_id>` — PouchDB
preserved the client `_id` all along, so the indexed-lookup fix never applied
to it. Any PouchDB-only result (e.g. `…-standard-unthrottled.json` with
`pouchdb: {...}` and `powersync: null`) has valid `serverDetectionMs` numbers
regardless of suffix.

These runs also capture the `chtReplicationRoundtrip` metric from Test D —
`GET /api/v1/replication/get-ids` + `POST /medic/_bulk_get` — which measures
CHT's legacy pull protocol latency (the O(N²) view scan + purge filter that
drives the scalability ceiling).

## Running a new benchmark

Full env reference is in the header comment of `tests/benchmark/benchmark-write-path.js`.
Minimal run (from host, agent-7 is the puppeteer driver):

```bash
docker cp tests/benchmark/benchmark-write-path.js cht-agent-7:/tmp/benchmark-write-path.js
docker exec cht-agent-7 bash -c \
  'TEST=powersync BENCHMARK_TARGET=couchdb CHT_ROLE=chw_min_5km \
   DEVICE_TIER=standard SKIP_NETWORK_THROTTLE=1 \
   node /tmp/benchmark-write-path.js chw_test_1 Secret1!pass'
```

The pre-flight check blocks the run if `BENCHMARK_TARGET` ≠ api's
`CHT_DB_BACKEND`. Flip the api first if you need the other backend:

```bash
cd .devcontainer
# to postgres:
CHT_DB_BACKEND=postgres docker compose -f docker-compose.services.yml up -d --force-recreate api
# back to couchdb (explicit unset defeats any stale shell export):
env -u CHT_DB_BACKEND docker compose -f docker-compose.services.yml up -d --force-recreate api
```

Results land in this directory via the repo-relative bind mount so they're
readable from both host and the benchmark container without `docker cp`.
