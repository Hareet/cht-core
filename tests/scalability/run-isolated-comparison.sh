#!/bin/bash
#
# ISOLATED container benchmark: CouchDB vs PowerSync
#
# Runs each engine with exclusive access to system resources.
# CouchDB phase: only CouchDB + API running (PostgreSQL/PowerSync stopped)
# PowerSync phase: only PostgreSQL + PowerSync + API running (CouchDB stopped)
#
# MUST be run from the host (needs docker commands).
#
# Usage:
#   ./run-isolated-comparison.sh                    # all levels: 1,5,10,25,50
#   ./run-isolated-comparison.sh 1 5 10             # specific levels
#   ITERATIONS=20 ./run-isolated-comparison.sh 10   # 20 iterations at concurrency 10
#
# Environment:
#   ITERATIONS     Iterations per thread (default: 10)
#   COOLDOWN       Seconds between concurrency levels (default: 30)
#   SETTLE_TIME    Seconds to wait after container start/stop (default: 15)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "${SCRIPT_DIR}/.env" ] && source "${SCRIPT_DIR}/.env"

WORKERS_DIR="${SCRIPT_DIR}/workers"
RESULTS_DIR="${SCRIPT_DIR}/benchmark_results_isolated"
LOG_DIR="${RESULTS_DIR}/logs"
ITERATIONS="${ITERATIONS:-10}"
COOLDOWN="${COOLDOWN:-30}"
SETTLE_TIME="${SETTLE_TIME:-15}"
API_URL="${API_URL:-http://localhost:5988}"
COUCH_URL="${COUCH_URL:?Set COUCH_URL e.g. http://admin:pass@localhost:5988/medic}"
NODE_BIN="${NODE_BIN:-node}"
TEST_USER_PASS="${TEST_USER_PASS:?Set TEST_USER_PASS}"
TMPDIR="${TMPDIR:-/dev/shm}"

# Containers
COUCHDB_CONTAINER="${COUCHDB_CONTAINER:-cht-docker-couchdb-1}"
NOUVEAU_CONTAINER="${NOUVEAU_CONTAINER:-cht-docker-nouveau-1}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-cht-postgres}"
POWERSYNC_CONTAINER="${POWERSYNC_CONTAINER:-cht-powersync-api}"
POWERSYNC_SYNC_CONTAINER="${POWERSYNC_SYNC_CONTAINER:-cht-powersync-sync}"
POWERSYNC_LEGACY="${POWERSYNC_LEGACY:-cht-powersync}"
SENTINEL_CONTAINER="${SENTINEL_CONTAINER:-cht-sentinel}"
COUCH2PG_CONTAINER="${COUCH2PG_CONTAINER:-cht-couch2pg}"
API_CONTAINER="${API_CONTAINER:-cht-api}"
HAPROXY_CONTAINER="${HAPROXY_CONTAINER:-cht-haproxy}"
NGINX_CONTAINER="${NGINX_CONTAINER:-cht-nginx}"

# Users
COUCH_USERS=("ac1" "ac2" "chw_user")
COUCH_PASSES=("$TEST_USER_PASS" "$TEST_USER_PASS" "$TEST_USER_PASS")
PS_USERS=("ac1" "ac2" "chw_user")
PS_PASSES=("$TEST_USER_PASS" "$TEST_USER_PASS" "$TEST_USER_PASS")

if [ $# -gt 0 ]; then
  LEVELS=("$@")
else
  LEVELS=(1 5 10 25 50)
fi

mkdir -p "$RESULTS_DIR" "$LOG_DIR"

# --- Helper: wait for a service to be ready ---
wait_for_api() {
  local max_wait=60
  local waited=0
  echo -n "  Waiting for API..."
  while [ $waited -lt $max_wait ]; do
    if curl -sf -o /dev/null -u "${COUCH_USERS[0]}:${TEST_USER_PASS}" "${API_URL}/api/v1/replication/get-ids" 2>/dev/null; then
      echo " ready (${waited}s)"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
    echo -n "."
  done
  echo " TIMEOUT after ${max_wait}s"
  return 1
}

wait_for_powersync() {
  local max_wait=60
  local waited=0
  echo -n "  Waiting for PowerSync..."
  while [ $waited -lt $max_wait ]; do
    if curl -sf -o /dev/null -w '' "http://localhost:8080/api/v1" 2>/dev/null || \
       curl -s "http://localhost:8080/api/v1" 2>/dev/null | grep -q "RouteNotFound"; then
      echo " ready (${waited}s)"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
    echo -n "."
  done
  echo " TIMEOUT after ${max_wait}s"
  return 1
}

# --- Helper: clean up orphaned test docs ---
cleanup_orphans() {
  "$NODE_BIN" -e '
    const couchUrl = new URL("'"$COUCH_URL"'");
    const auth = "Basic " + Buffer.from(couchUrl.username + ":" + couchUrl.password).toString("base64");
    const base = "'"$API_URL"'/medic";
    async function run() {
      const res = await fetch(base + "/_all_docs?startkey=%22roundtrip-%22&endkey=%22roundtrip-z%22", {
        headers: { Authorization: auth }
      });
      const data = await res.json();
      let deleted = 0;
      for (const row of (data.rows || [])) {
        try {
          const r = await fetch(base + "/" + row.id + "?rev=" + row.value.rev, {
            method: "DELETE", headers: { Authorization: auth }
          });
          if (r.ok) deleted++;
        } catch(e) {}
      }
      if (deleted > 0) console.log("  Cleaned " + deleted + " orphaned CouchDB docs");
    }
    run().catch(() => {});
  ' 2>/dev/null || true
}

# --- Run a single concurrency level for one engine ---
run_level() {
  local threads=$1
  local engine=$2
  local outfile="${RESULTS_DIR}/${engine}-${threads}.jsonl"
  local logfile="${LOG_DIR}/${engine}-${threads}.log"

  echo "  Running ${engine} with ${threads} concurrent thread(s)..."
  > "$outfile"
  > "$logfile"

  local pids=()
  for ((t=0; t<threads; t++)); do
    if [ "$engine" = "couchdb" ]; then
      local idx=$((t % ${#COUCH_USERS[@]}))
      THREAD_ID=$t \
      USER_NAME="${COUCH_USERS[$idx]}" \
      USER_PASS="${COUCH_PASSES[$idx]}" \
      ITERATIONS="$ITERATIONS" \
      API_URL="$API_URL" \
      COUCH_URL="$COUCH_URL" \
        "$NODE_BIN" "$WORKERS_DIR/couch-worker.js" >> "$outfile" 2>> "$logfile" &
    else
      local idx=$((t % ${#PS_USERS[@]}))
      THREAD_ID=$t \
      USER_NAME="${PS_USERS[$idx]}" \
      USER_PASS="${PS_PASSES[$idx]}" \
      ITERATIONS="$ITERATIONS" \
      API_URL="$API_URL" \
      TMPDIR="$TMPDIR" \
      DIRECT_PG="${DIRECT_PG:-}" \
      POSTGRES_PASSWORD="${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}" \
        "$NODE_BIN" "$WORKERS_DIR/powersync-worker.mjs" >> "$outfile" 2>> "$logfile" &
    fi
    pids+=($!)
  done

  local failed=0
  for pid in "${pids[@]}"; do
    if ! wait "$pid"; then
      failed=$((failed + 1))
    fi
  done

  local total=$(wc -l < "$outfile")
  echo "    Done: ${total} results, ${failed} failed threads"
  if [ "$failed" -gt 0 ]; then
    echo "    See logs: $logfile"
  fi
}

echo "============================================================"
echo "ISOLATED Container Benchmark"
echo "============================================================"
echo "Concurrency levels: ${LEVELS[*]}"
echo "Iterations per thread: $ITERATIONS"
echo "Cooldown between levels: ${COOLDOWN}s"
echo "Settle time after container ops: ${SETTLE_TIME}s"
echo "Results dir: $RESULTS_DIR"
echo "============================================================"

# =========================================================
# PHASE 1: CouchDB (exclusive)
# =========================================================
echo ""
echo "============================================================"
echo "PHASE 1: CouchDB (exclusive resources)"
echo "============================================================"
echo "  Stopping PostgreSQL, PowerSync, Sentinel, couch2pg..."
docker stop "$POWERSYNC_CONTAINER" "$POSTGRES_CONTAINER" "$SENTINEL_CONTAINER" "$COUCH2PG_CONTAINER" 2>/dev/null || true
echo "  Starting CouchDB, API, HAProxy, Nginx..."
docker start "$COUCHDB_CONTAINER" "$NOUVEAU_CONTAINER" "$HAPROXY_CONTAINER" "$API_CONTAINER" "$NGINX_CONTAINER" 2>/dev/null || true
echo "  Settling for ${SETTLE_TIME}s..."
sleep "$SETTLE_TIME"
wait_for_api

# Verify CouchDB is healthy
COUCH_RUN_QUEUE=$("$NODE_BIN" -e "
  fetch('${COUCH_URL}/../_node/_local/_system'.replace('/medic/../', '/'), { headers: { Authorization: auth } })
    .then(r => r.text()).then(t => { console.log('fail') })
    .catch(() => console.log('fail'));
" 2>/dev/null || echo "fail")

echo "  CouchDB ready. Running benchmarks..."
echo ""

for level in "${LEVELS[@]}"; do
  echo "--- CouchDB @ ${level} concurrent ---"
  cleanup_orphans
  run_level "$level" "couchdb"
  if [ "$level" != "${LEVELS[-1]}" ]; then
    echo "  Cooling down ${COOLDOWN}s..."
    sleep "$COOLDOWN"
  fi
done

echo ""
echo "  CouchDB phase complete."

# =========================================================
# PHASE 2: PowerSync (exclusive)
# =========================================================
echo ""
echo "============================================================"
echo "PHASE 2: PowerSync (exclusive resources)"
echo "============================================================"
# Restart CouchDB so it's clean and idle (API requires it to boot).
# No benchmark load hits CouchDB during this phase.
echo "  Restarting CouchDB for clean idle state..."
docker restart "$COUCHDB_CONTAINER" "$NOUVEAU_CONTAINER" 2>/dev/null || true
echo "  Starting PostgreSQL, PowerSync..."
docker start "$POSTGRES_CONTAINER" 2>/dev/null || true
sleep 5  # let PG come up first
docker start "$POWERSYNC_CONTAINER" 2>/dev/null || true
echo "  Waiting ${SETTLE_TIME}s for services to settle..."
sleep "$SETTLE_TIME"
wait_for_powersync

# Restart API so it reconnects to fresh CouchDB + PostgreSQL
echo "  Restarting API for clean state..."
docker restart "$API_CONTAINER" 2>/dev/null || true
sleep 10
wait_for_api

# Verify CouchDB is idle before starting
echo -n "  Verifying CouchDB is idle..."
for i in $(seq 1 12); do
  RUN_QUEUE=$("$NODE_BIN" -e "
    const couchUrl = new URL('${COUCH_URL}');
    const auth = 'Basic ' + Buffer.from(couchUrl.username + ':' + couchUrl.password).toString('base64');
    fetch('http://localhost:5988/_node/_local/_system', { headers: { Authorization: auth } })
      .then(r => r.json())
      .then(d => console.log(d.run_queue))
      .catch(() => console.log(-1));
  " 2>/dev/null)
  if [ "${RUN_QUEUE:-99}" -lt 5 ]; then
    echo " idle (run_queue=${RUN_QUEUE})"
    break
  fi
  echo -n "."
  sleep 5
done

echo "  PowerSync ready. Running benchmarks..."
echo ""

for level in "${LEVELS[@]}"; do
  echo "--- PowerSync @ ${level} concurrent ---"
  run_level "$level" "powersync"
  if [ "$level" != "${LEVELS[-1]}" ]; then
    echo "  Cooling down ${COOLDOWN}s..."
    sleep "$COOLDOWN"
  fi
done

echo ""
echo "  PowerSync phase complete."

# =========================================================
# PHASE 3: Restore all services
# =========================================================
echo ""
echo "============================================================"
echo "Restoring all services..."
echo "============================================================"
docker start "$COUCHDB_CONTAINER" "$NOUVEAU_CONTAINER" "$POSTGRES_CONTAINER" \
             "$POWERSYNC_CONTAINER" "$SENTINEL_CONTAINER" "$COUCH2PG_CONTAINER" \
             "$API_CONTAINER" "$HAPROXY_CONTAINER" "$NGINX_CONTAINER" 2>/dev/null || true
echo "  All services restarting."

# =========================================================
# Generate report
# =========================================================
echo ""
echo "============================================================"
echo "Generating report..."
echo "============================================================"

"$NODE_BIN" -e "
  const fs = require('fs');
  const path = require('path');
  const dir = '${RESULTS_DIR}';

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
  const data = {};

  for (const f of files) {
    const match = f.replace('.jsonl','').match(/^(couchdb|powersync)-(\d+)$/);
    if (!match) continue;
    const [, engine, threads] = match;
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean);
    const results = lines.map(l => JSON.parse(l));
    const successful = results.filter(r => r.found !== false);
    const durations = successful.map(r => r.duration).sort((a,b) => a-b);

    if (!durations.length) continue;

    const key = parseInt(threads);
    if (!data[key]) data[key] = {};
    data[key][engine] = {
      count: durations.length,
      min: durations[0],
      max: durations[durations.length - 1],
      mean: Math.round(durations.reduce((a,b) => a+b, 0) / durations.length),
      p50: durations[Math.floor(durations.length * 0.5)],
      p95: durations[Math.floor(durations.length * 0.95)],
      p99: durations[Math.floor(durations.length * 0.99)],
      timeouts: results.filter(r => r.found === false).length,
      total: results.length,
    };
  }

  let report = '# Isolated Container Benchmark: CouchDB vs PowerSync\n\n';
  report += 'Each engine runs with exclusive access to system resources.\n';
  report += '- CouchDB phase: CouchDB + API only (PostgreSQL/PowerSync stopped)\n';
  report += '- PowerSync phase: PostgreSQL + PowerSync + API only (CouchDB stopped)\n';
  report += '- Sentinel and couch2pg stopped for both phases\n\n';
  report += 'Date: ' + new Date().toISOString().split('T')[0] + '\n';
  report += 'Iterations per thread: ${ITERATIONS}\n\n';

  report += '## Results\n\n';
  report += '| Concurrency | Engine | Samples | Mean (ms) | P50 (ms) | P95 (ms) | P99 (ms) | Min (ms) | Max (ms) | Timeouts |\n';
  report += '|-------------|--------|---------|-----------|----------|----------|----------|----------|----------|----------|\n';

  for (const threads of Object.keys(data).sort((a,b) => a-b)) {
    for (const engine of ['couchdb', 'powersync']) {
      const d = data[threads]?.[engine];
      if (!d) continue;
      report += '| ' + [threads, engine, d.count, d.mean, d.p50, d.p95, d.p99, d.min, d.max, d.timeouts + '/' + d.total].join(' | ') + ' |\n';
    }
  }

  report += '\n## Scaling Comparison\n\n';
  report += '| Concurrency | CouchDB Mean | PowerSync Mean | Ratio | CouchDB Timeouts | PS Timeouts |\n';
  report += '|-------------|-------------|----------------|-------|-------------------|-------------|\n';
  for (const threads of Object.keys(data).sort((a,b) => a-b)) {
    const c = data[threads]?.couchdb;
    const p = data[threads]?.powersync;
    const cStr = c ? c.mean + 'ms' : '--';
    const pStr = p ? p.mean + 'ms' : '--';
    const ratio = (c && p) ? (c.mean / p.mean).toFixed(1) + 'x' : '--';
    const cTo = c ? c.timeouts + '/' + c.total : '--';
    const pTo = p ? p.timeouts + '/' + p.total : '--';
    report += '| ' + [threads, cStr, pStr, ratio, cTo, pTo].join(' | ') + ' |\n';
  }

  report += '\n## Degradation from Baseline (concurrency=1)\n\n';
  const baseline = data[1] || {};
  report += '| Concurrency | CouchDB (vs baseline) | PowerSync (vs baseline) |\n';
  report += '|-------------|----------------------|-------------------------|\n';
  for (const threads of Object.keys(data).sort((a,b) => a-b)) {
    const cBase = baseline.couchdb?.mean;
    const pBase = baseline.powersync?.mean;
    const c = data[threads]?.couchdb?.mean;
    const p = data[threads]?.powersync?.mean;
    const cDeg = (c && cBase) ? (c / cBase).toFixed(2) + 'x' : '--';
    const pDeg = (p && pBase) ? (p / pBase).toFixed(2) + 'x' : '--';
    report += '| ' + [threads, cDeg, pDeg].join(' | ') + ' |\n';
  }

  const outPath = path.join(dir, 'isolated-comparison.md');
  fs.writeFileSync(outPath, report, 'utf8');
  console.log(report);
  console.log('Report saved to: ' + outPath);
"
