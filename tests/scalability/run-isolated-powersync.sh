#!/bin/bash
#
# Isolated PowerSync benchmark (Phase 2 only)
#
# Assumes CouchDB phase already ran. This script:
# 1. Restarts CouchDB + Nouveau clean
# 2. Cleans orphaned test docs
# 3. Starts PostgreSQL + PowerSync
# 4. Waits for everything to be idle
# 5. Runs PowerSync at all concurrency levels
# 6. Restores all services
#
# Run from host (needs docker).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKERS_DIR="${SCRIPT_DIR}/workers"
RESULTS_DIR="${SCRIPT_DIR}/benchmark_results_isolated"
LOG_DIR="${RESULTS_DIR}/logs"
ITERATIONS="${ITERATIONS:-10}"
COOLDOWN="${COOLDOWN:-30}"
API_URL="${API_URL:-http://localhost:5988}"
[ -f "${SCRIPT_DIR}/.env" ] && source "${SCRIPT_DIR}/.env"
COUCH_URL="${COUCH_URL:?Set COUCH_URL e.g. http://admin:pass@localhost:5988/medic}"
TEST_USER_PASS="${TEST_USER_PASS:?Set TEST_USER_PASS}"
NODE_BIN="${NODE_BIN:-node}"
TMPDIR="${TMPDIR:-/dev/shm}"

# Containers
COUCHDB_CONTAINER="${COUCHDB_CONTAINER:-cht-docker-couchdb-1}"
NOUVEAU_CONTAINER="${NOUVEAU_CONTAINER:-cht-docker-nouveau-1}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-cht-postgres}"
POWERSYNC_CONTAINER="${POWERSYNC_CONTAINER:-cht-powersync}"
SENTINEL_CONTAINER="${SENTINEL_CONTAINER:-cht-sentinel}"
COUCH2PG_CONTAINER="${COUCH2PG_CONTAINER:-cht-couch2pg}"
API_CONTAINER="${API_CONTAINER:-cht-api}"
HAPROXY_CONTAINER="${HAPROXY_CONTAINER:-cht-haproxy}"
NGINX_CONTAINER="${NGINX_CONTAINER:-cht-nginx}"

PS_USERS=("ac1" "ac2" "chw_user")
PS_PASSES=("$TEST_USER_PASS" "$TEST_USER_PASS" "$TEST_USER_PASS")

if [ $# -gt 0 ]; then
  LEVELS=("$@")
else
  LEVELS=(1 5 10 25 50)
fi

mkdir -p "$RESULTS_DIR" "$LOG_DIR"

echo "============================================================"
echo "Isolated PowerSync Benchmark"
echo "============================================================"
echo "Concurrency levels: ${LEVELS[*]}"
echo "Iterations per thread: $ITERATIONS"
echo "============================================================"

# --- Step 1: Stop everything ---
echo ""
echo "Step 1: Stopping all services..."
docker stop "$POWERSYNC_CONTAINER" "$POSTGRES_CONTAINER" "$SENTINEL_CONTAINER" \
            "$COUCH2PG_CONTAINER" "$API_CONTAINER" "$NGINX_CONTAINER" 2>/dev/null || true

# --- Step 2: Restart CouchDB clean ---
echo "Step 2: Restarting CouchDB + Nouveau for clean state..."
docker restart "$COUCHDB_CONTAINER" "$NOUVEAU_CONTAINER" "$HAPROXY_CONTAINER" 2>/dev/null || true
echo "  Waiting 15s for CouchDB to come up..."
sleep 15

# --- Step 3: Start API, clean orphans ---
echo "Step 3: Starting API and cleaning orphaned docs..."
docker start "$API_CONTAINER" "$NGINX_CONTAINER" 2>/dev/null || true
sleep 10

# Wait for API
echo -n "  Waiting for API..."
for i in $(seq 1 30); do
  if curl -sf -o /dev/null -u "${PS_USERS[0]}:${TEST_USER_PASS}" "${API_URL}/api/v1/replication/get-ids" 2>/dev/null; then
    echo " ready"
    break
  fi
  echo -n "."
  sleep 2
done

# Clean orphaned docs from CouchDB
"$NODE_BIN" -e '
  const couchUrl = new URL("'"$COUCH_URL"'");
    const auth = "Basic " + Buffer.from(couchUrl.username + ":" + couchUrl.password).toString("base64");
  const base = "http://localhost:5988/medic";
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
    else console.log("  No orphaned docs");
  }
  run().catch(e => console.error("  Cleanup error:", e.message));
' 2>/dev/null || true

# --- Step 4: Wait for CouchDB to be fully idle ---
echo -n "Step 4: Waiting for CouchDB to be idle..."
for i in $(seq 1 24); do
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
  echo -n " rq=${RUN_QUEUE}"
  sleep 5
done

# --- Step 5: Start PostgreSQL + PowerSync ---
echo "Step 5: Starting PostgreSQL + PowerSync..."
docker start "$POSTGRES_CONTAINER" 2>/dev/null || true
echo "  Waiting 10s for PostgreSQL..."
sleep 10
docker start "$POWERSYNC_CONTAINER" 2>/dev/null || true
echo "  Waiting 15s for PowerSync..."
sleep 15

# Verify PowerSync
echo -n "  Waiting for PowerSync..."
for i in $(seq 1 15); do
  if curl -s "http://localhost:8080/api/v1" 2>/dev/null | grep -q "RouteNotFound"; then
    echo " ready"
    break
  fi
  echo -n "."
  sleep 2
done

# Restart API so it picks up the PostgreSQL connection
echo "  Restarting API with PostgreSQL available..."
docker restart "$API_CONTAINER" 2>/dev/null || true
sleep 10
echo -n "  Waiting for API..."
for i in $(seq 1 30); do
  if curl -sf -o /dev/null -u "${PS_USERS[0]}:${TEST_USER_PASS}" "${API_URL}/api/v1/replication/get-ids" 2>/dev/null; then
    echo " ready"
    break
  fi
  echo -n "."
  sleep 2
done

# --- Step 6: Run PowerSync benchmarks ---
echo ""
echo "============================================================"
echo "Running PowerSync benchmarks (CouchDB idle, no Sentinel)"
echo "============================================================"
echo ""

run_ps_level() {
  local threads=$1
  local outfile="${RESULTS_DIR}/powersync-${threads}.jsonl"
  local logfile="${LOG_DIR}/powersync-${threads}.log"

  echo "  Running powersync with ${threads} concurrent thread(s)..."
  > "$outfile"
  > "$logfile"

  local pids=()
  for ((t=0; t<threads; t++)); do
    local idx=$((t % ${#PS_USERS[@]}))
    THREAD_ID=$t \
    USER_NAME="${PS_USERS[$idx]}" \
    USER_PASS="${PS_PASSES[$idx]}" \
    ITERATIONS="$ITERATIONS" \
    API_URL="$API_URL" \
    TMPDIR="$TMPDIR" \
    POSTGRES_PASSWORD="${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}" \
      "$NODE_BIN" "$WORKERS_DIR/powersync-worker.mjs" >> "$outfile" 2>> "$logfile" &
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

for level in "${LEVELS[@]}"; do
  echo "--- PowerSync @ ${level} concurrent ---"
  run_ps_level "$level"
  if [ "$level" != "${LEVELS[-1]}" ]; then
    echo "  Cooling down ${COOLDOWN}s..."
    sleep "$COOLDOWN"
  fi
done

# --- Step 7: Restore services ---
echo ""
echo "============================================================"
echo "Restoring all services..."
echo "============================================================"
docker start "$SENTINEL_CONTAINER" "$COUCH2PG_CONTAINER" 2>/dev/null || true
echo "  Done."

# --- Step 8: Generate combined report ---
echo ""
echo "Generating report..."

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
  report += '- CouchDB phase: CouchDB + API only (PostgreSQL/PowerSync/Sentinel/couch2pg stopped)\n';
  report += '- PowerSync phase: PostgreSQL + PowerSync + API (CouchDB idle, Sentinel/couch2pg stopped)\n\n';
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
