#!/bin/bash
#
# Incremental sync round-trip comparison: CouchDB vs PowerSync
#
# Spawns worker scripts at multiple concurrency levels and generates
# a comparison report with mean, p50, p95, p99 per level.
#
# Usage:
#   ./run-incremental-comparison.sh                    # all levels: 1,5,10,25,50
#   ./run-incremental-comparison.sh 1 5                # specific levels
#   ITERATIONS=20 ./run-incremental-comparison.sh 10   # 20 iterations at concurrency 10
#
# Prerequisites:
#   - CHT API at localhost:5988
#   - PowerSync Service at localhost:8080
#   - PostgreSQL at localhost:5432
#   - Test users (ac1, ac2, chw_user) in both CouchDB and PostgreSQL
#
# Environment:
#   API_URL        CHT API URL (default: http://localhost:5988)
#   COUCH_URL      CouchDB admin URL (required, e.g. http://admin:pass@localhost:5988/medic)
#   ITERATIONS     Iterations per thread (default: 10)
#   COOLDOWN       Seconds between levels (default: 15)
#   TMPDIR         Temp dir for PowerSync SQLite (use /dev/shm for RAM)
#   DIRECT_PG      If "1", PowerSync writes directly to PG (bypasses API)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Source .env if present
[ -f "${SCRIPT_DIR}/.env" ] && source "${SCRIPT_DIR}/.env"

WORKERS_DIR="${SCRIPT_DIR}/workers"
RESULTS_DIR="${SCRIPT_DIR}/benchmark_results"
LOG_DIR="${RESULTS_DIR}/logs"
ITERATIONS="${ITERATIONS:-10}"
COOLDOWN="${COOLDOWN:-15}"
API_URL="${API_URL:-http://localhost:5988}"
COUCH_URL="${COUCH_URL:?Set COUCH_URL e.g. http://admin:pass@localhost:5988/medic}"
NODE_BIN="${NODE_BIN:-node}"
TEST_USER_PASS="${TEST_USER_PASS:?Set TEST_USER_PASS}"

# Users to cycle through (must exist in both CouchDB and PostgreSQL)
COUCH_USERS=("ac1" "ac2" "chw_user")
COUCH_PASSES=("$TEST_USER_PASS" "$TEST_USER_PASS" "$TEST_USER_PASS")
PS_USERS=("ac1" "ac2" "chw_user")
PS_PASSES=("$TEST_USER_PASS" "$TEST_USER_PASS" "$TEST_USER_PASS")

# Concurrency levels from args or default
if [ $# -gt 0 ]; then
  LEVELS=("$@")
else
  LEVELS=(1 5 10 25 50)
fi

mkdir -p "$RESULTS_DIR" "$LOG_DIR"

echo "============================================================"
echo "Incremental Sync Round-Trip Comparison"
echo "============================================================"
echo "Concurrency levels: ${LEVELS[*]}"
echo "Iterations per thread: $ITERATIONS"
echo "API URL: $API_URL"
echo "CouchDB URL: ${COUCH_URL%%@*}@..."
echo "Results dir: $RESULTS_DIR"
echo "Temp dir: ${TMPDIR:-/tmp}"
echo "PowerSync write path: ${DIRECT_PG:+Direct PG}${DIRECT_PG:-API}"
echo "============================================================"
echo ""

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
      TMPDIR="${TMPDIR:-/tmp}" \
      DIRECT_PG="${DIRECT_PG:-}" \
      POSTGRES_PASSWORD="${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}" \
        "$NODE_BIN" "$WORKERS_DIR/powersync-worker.mjs" >> "$outfile" 2>> "$logfile" &
    fi
    pids+=($!)
  done

  # Wait for all workers
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

# --- Clean up orphaned test docs between levels ---
cleanup_orphans() {
  local cleaned
  cleaned=$("$NODE_BIN" -e '
    const couchUrl = new URL("'"$COUCH_URL"'");
    const auth = "Basic " + Buffer.from(couchUrl.username + ":" + couchUrl.password).toString("base64");
    const base = "'"$API_URL"'/medic";
    async function run() {
      // CouchDB cleanup
      const res = await fetch(base + "/_all_docs?startkey=%22roundtrip-%22&endkey=%22roundtrip-z%22", {
        headers: { Authorization: auth }
      });
      const data = await res.json();
      let couchDeleted = 0;
      for (const row of (data.rows || [])) {
        try {
          const r = await fetch(base + "/" + row.id + "?rev=" + row.value.rev, {
            method: "DELETE", headers: { Authorization: auth }
          });
          if (r.ok) couchDeleted++;
        } catch(e) {}
      }
      console.log("couch:" + couchDeleted);
    }
    run().catch(() => console.log("couch:0"));
  ' 2>/dev/null)
  local count="${cleaned#couch:}"
  if [ "${count:-0}" -gt 0 ]; then
    echo "  Cleaned ${count} orphaned CouchDB docs"
  fi
}

# --- Main loop ---
for level in "${LEVELS[@]}"; do
  echo ""
  echo "--- Concurrency: ${level} ---"

  cleanup_orphans
  run_level "$level" "couchdb"
  echo "  Cooling down ${COOLDOWN}s..."
  sleep "$COOLDOWN"

  cleanup_orphans
  run_level "$level" "powersync"

  # Skip cooldown after last level
  if [ "$level" != "${LEVELS[-1]}" ]; then
    echo "  Cooling down ${COOLDOWN}s..."
    sleep "$COOLDOWN"
  fi
done

echo ""
echo "============================================================"
echo "All levels complete. Generating report..."
echo "============================================================"

# Generate summary report
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
    };
  }

  let report = '# Incremental Sync Round-Trip: CouchDB vs PowerSync (Concurrent Load Test)\n\n';
  report += 'CouchDB path: PUT doc to CouchDB -> poll GET /api/v1/replication/get-ids (full auth context re-computation)\n';
  report += 'PowerSync path: POST /api/v1/powersync/upload -> PG -> WAL -> PowerSync Service -> WebSocket -> local SQLite\n\n';
  report += 'Date: ' + new Date().toISOString().split('T')[0] + '\n';
  report += 'Iterations per thread: ${ITERATIONS}\n\n';

  report += '## Per-Level Results\n\n';
  report += '| Concurrency | Engine | Samples | Mean (ms) | P50 (ms) | P95 (ms) | P99 (ms) | Min (ms) | Max (ms) | Timeouts |\n';
  report += '|-------------|--------|---------|-----------|----------|----------|----------|----------|----------|----------|\n';

  for (const threads of Object.keys(data).sort((a,b) => a-b)) {
    for (const engine of ['couchdb', 'powersync']) {
      const d = data[threads]?.[engine];
      if (!d) continue;
      report += '| ' + [threads, engine, d.count, d.mean, d.p50, d.p95, d.p99, d.min, d.max, d.timeouts].join(' | ') + ' |\n';
    }
  }

  report += '\n## Scaling Characteristics\n\n';
  report += '| Concurrency | CouchDB Mean | PowerSync Mean | Ratio (CouchDB / PowerSync) |\n';
  report += '|-------------|-------------|----------------|-----------------------------|\n';
  for (const threads of Object.keys(data).sort((a,b) => a-b)) {
    const c = data[threads]?.couchdb?.mean;
    const p = data[threads]?.powersync?.mean;
    const cStr = c !== undefined ? c + 'ms' : '--';
    const pStr = p !== undefined ? p + 'ms' : '--';
    const ratio = (c !== undefined && p !== undefined) ? (c / p).toFixed(1) + 'x' : '--';
    report += '| ' + [threads, cStr, pStr, ratio].join(' | ') + ' |\n';
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

  const outPath = path.join(dir, 'incremental-comparison.md');
  fs.writeFileSync(outPath, report, 'utf8');
  console.log(report);
  console.log('Report saved to: ' + outPath);
"
