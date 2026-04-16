# CHT Benchmark: PouchDB vs PowerSync (Go Edition Throttled)

Compares CouchDB/PouchDB and PostgreSQL/PowerSync sync performance
under Android 10 Go edition constraints.

## How to Run

All commands from the host machine.

### 1. Copy scripts into a container and install puppeteer

```bash
AGENT=cht-agent-7  # or any agent container

docker cp tests/benchmark/benchmark-pouchdb.js $AGENT:/tmp/
docker cp tests/benchmark/benchmark-powersync.js $AGENT:/tmp/
docker cp tests/benchmark/compare-results.js $AGENT:/tmp/

docker exec $AGENT bash -c 'cd /tmp && npm install puppeteer'
```

### 2. Run PouchDB benchmark (feature flag OFF)

```bash
docker exec cht-agent-1 node /tmp/set-powersync-flag.js off
docker exec $AGENT node /tmp/benchmark-pouchdb.js chw_test_1 'Secret1!pass'
```

### 3. Run PowerSync benchmark (feature flag ON)

```bash
docker exec cht-agent-1 node /tmp/set-powersync-flag.js on
docker exec $AGENT node /tmp/benchmark-powersync.js chw_test_1 'Secret1!pass'
```

### 4. Compare results

```bash
docker exec $AGENT node /tmp/compare-results.js
```

### 5. Copy results to host

```bash
docker cp $AGENT:/tmp/benchmark-pouchdb-results.json tests/benchmark/
docker cp $AGENT:/tmp/benchmark-powersync-results.json tests/benchmark/
docker cp $AGENT:/tmp/benchmark-comparison.json tests/benchmark/
```

## Go Edition Throttling Applied

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| CPU | 4x slowdown | Helio A22 vs desktop (Geekbench: ~130 vs ~1500) |
| Network | 3G (200KB/s down, 96KB/s up, 300ms) | CIV rural field conditions |
| V8 heap | 512MB | 2GB device, ~500MB available for WebView |
| Screen | 720x1600 @2x | Tecno Pop 5 Go / Itel A27 |
| User agent | Chrome/122 Android 10 | Pinned WebView on Go edition |
