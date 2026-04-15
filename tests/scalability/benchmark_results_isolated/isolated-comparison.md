# Isolated Container Benchmark: CouchDB vs PowerSync

Each engine runs with exclusive access to system resources.
- CouchDB phase: CouchDB + API only (PostgreSQL/PowerSync/Sentinel/couch2pg stopped)
- PowerSync phase: PostgreSQL + PowerSync + API (CouchDB idle, Sentinel/couch2pg stopped)

Date: 2026-04-12
Iterations per thread: 1

## Results

| Concurrency | Engine | Samples | Mean (ms) | P50 (ms) | P95 (ms) | P99 (ms) | Min (ms) | Max (ms) | Timeouts |
|-------------|--------|---------|-----------|----------|----------|----------|----------|----------|----------|
| 1 | couchdb | 10 | 918 | 910 | 1005 | 1005 | 863 | 1005 | 0/10 |
| 1 | powersync | 10 | 561 | 578 | 679 | 679 | 361 | 679 | 0/10 |
| 5 | couchdb | 50 | 1142 | 1234 | 1520 | 1527 | 640 | 1527 | 0/50 |
| 5 | powersync | 50 | 367 | 419 | 517 | 555 | 65 | 555 | 0/50 |
| 10 | couchdb | 66 | 6042 | 2364 | 22426 | 30323 | 777 | 30323 | 34/100 |
| 10 | powersync | 10 | 819 | 785 | 2457 | 2457 | 247 | 2457 | 0/10 |
| 25 | couchdb | 10 | 29651 | 23130 | 56010 | 56010 | 22930 | 56010 | 240/250 |
| 25 | powersync | 250 | 1397 | 1382 | 2287 | 4789 | 76 | 9122 | 0/250 |
| 50 | powersync | 500 | 2613 | 2524 | 3897 | 7333 | 626 | 15271 | 0/500 |
| 100 | powersync | 902 | 4245 | 3852 | 6704 | 16815 | 933 | 26035 | 68/970 |
| 200 | powersync | 838 | 4414 | 4721 | 6244 | 7373 | 1230 | 15945 | 12/850 |

## Scaling Comparison

| Concurrency | CouchDB Mean | PowerSync Mean | Ratio | CouchDB Timeouts | PS Timeouts |
|-------------|-------------|----------------|-------|-------------------|-------------|
| 1 | 918ms | 561ms | 1.6x | 0/10 | 0/10 |
| 5 | 1142ms | 367ms | 3.1x | 0/50 | 0/50 |
| 10 | 6042ms | 819ms | 7.4x | 34/100 | 0/10 |
| 25 | 29651ms | 1397ms | 21.2x | 240/250 | 0/250 |
| 50 | -- | 2613ms | -- | -- | 0/500 |
| 100 | -- | 4245ms | -- | -- | 68/970 |
| 200 | -- | 4414ms | -- | -- | 12/850 |

## Degradation from Baseline (concurrency=1)

| Concurrency | CouchDB (vs baseline) | PowerSync (vs baseline) |
|-------------|----------------------|-------------------------|
| 1 | 1.00x | 1.00x |
| 5 | 1.24x | 0.65x |
| 10 | 6.58x | 1.46x |
| 25 | 32.30x | 2.49x |
| 50 | -- | 4.66x |
| 100 | -- | 7.57x |
| 200 | -- | 7.87x |
