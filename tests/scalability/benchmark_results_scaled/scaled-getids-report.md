# Production-Scale get-ids Benchmark

Replicating CHT team methodology from medic/cht-core#10262.
ALL users cycle through GET /api/v1/replication/get-ids at each concurrency level.

## Setup Comparison

| | CHT Team | Our Test |
|--|----------|----------|
| Hardware | EC2 c5.2xlarge (8 CPU, 16GB) | Dev laptop (24 CPU, 48GB) |
| Total docs | 3,000,000 | ~589,000 |
| Users | 140 | 120 |
| Docs per user | ~20,000 | see results |
| CouchDB | CHT 5.x (Nouveau) | Same |

## Results

| Concurrency | Our Avg Response | Our Range | CHT Team Avg (Nouveau) | CHT Team Range | Our Avg Docs/User |
|-------------|-----------------|-----------|------------------------|----------------|-------------------|
| 10 | 10.8s | 4.5s - 14.4s | 1m 17s | 35s - 1m 25s | 14881 |
| 20 | 22.5s | 6.2s - 28.9s | 2m 44s | 1m 10s - 2m 51s | 14881 |
| 30 | 30.0s | 6.2s - 39.2s | 4m 4s | 2m 11s - 4m 20s | 14881 |
| 40 | 38.3s | 10.2s - 53.0s | 5m 30s | 2m 25s - 5m 43s | 14881 |
| 50 | 52.4s | 9.6s - 1m 7s | 6m 20s | 2m 30s - 7m 02s | 14881 |

## Degradation by Concurrency

| Concurrency | Avg Response | vs Baseline | Errors |
|-------------|-------------|-------------|--------|
| 10 | 10.8s | 1.00x | 0/120 |
| 20 | 22.5s | 2.08x | 0/120 |
| 30 | 30.0s | 2.77x | 0/120 |
| 40 | 38.3s | 3.54x | 0/120 |
| 50 | 52.4s | 4.85x | 0/120 |
