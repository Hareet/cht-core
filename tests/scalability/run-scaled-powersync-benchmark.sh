#!/bin/bash
#
# Scaled PowerSync benchmark — uses the same CHW users as the get-ids benchmark.
#
# Cycles CHW users from users.csv through PowerSync incremental sync,
# matching the get-ids benchmark methodology for direct comparison.
#
# Usage:
#   ./run-scaled-powersync-benchmark.sh          # default: 10
#   ./run-scaled-powersync-benchmark.sh 10 20    # specific levels
#
# Environment:
#   USERS_CSV      Path to users.csv (default: ./users.csv)
#   ITERATIONS     Iterations per user (default: 1)
#   COOLDOWN       Seconds between levels (default: 60)
#   API_URL        CHT API URL (default: http://localhost:5988)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "${SCRIPT_DIR}/.env" ] && source "${SCRIPT_DIR}/.env"

WORKERS_DIR="${SCRIPT_DIR}/workers"
RESULTS_DIR="${SCRIPT_DIR}/benchmark_results_scaled"
LOG_DIR="${RESULTS_DIR}/logs"
API_URL="${API_URL:-http://localhost:5988}"
COOLDOWN="${COOLDOWN:-60}"
ITERATIONS="${ITERATIONS:-1}"
NODE_BIN="${NODE_BIN:-node}"
USERS_CSV="${USERS_CSV:-${SCRIPT_DIR}/users.csv}"
TMPDIR="${TMPDIR:-/dev/shm}"

if [ $# -gt 0 ]; then
  LEVELS=("$@")
else
  LEVELS=(10)
fi

mkdir -p "$RESULTS_DIR" "$LOG_DIR"

# --- Load CHW users from CSV (skip managers/national_admin) ---
declare -a USERNAMES=()
declare -a PASSWORDS=()

if [ -f "$USERS_CSV" ]; then
  while IFS=',' read -r username password roles contact phone place rest; do
    username=$(echo "$username" | tr -d '"')
    password=$(echo "$password" | tr -d '"')
    roles=$(echo "$roles" | tr -d '"')
    [ "$username" = "username" ] && continue
    case "$roles" in
      *national_admin*|*supervisor*) continue ;;
    esac
    USERNAMES+=("$username")
    PASSWORDS+=("$password")
  done < "$USERS_CSV"
else
  echo "ERROR: $USERS_CSV not found"
  exit 1
fi

TOTAL_USERS=${#USERNAMES[@]}

echo "============================================================"
echo "Scaled PowerSync Benchmark"
echo "============================================================"
echo "Methodology: Cycle ALL $TOTAL_USERS CHW users through PowerSync"
echo "  incremental sync at each concurrency level"
echo "Concurrency levels: ${LEVELS[*]}"
echo "Iterations per user: $ITERATIONS"
echo "Results dir: $RESULTS_DIR"
echo "============================================================"
echo ""

# --- Run all users through PowerSync at a given concurrency ---
run_level() {
  local concurrency=$1
  local outfile="${RESULTS_DIR}/powersync-scaled-${concurrency}.jsonl"
  local logfile="${LOG_DIR}/powersync-scaled-${concurrency}.log"

  echo "--- PowerSync @ ${concurrency} concurrent (${TOTAL_USERS} CHW users) ---"
  > "$outfile"
  > "$logfile"

  local start_time=$(date +%s)
  local user_idx=0
  local active_pids=()
  local completed=0
  local failed=0

  while [ $user_idx -lt $TOTAL_USERS ] || [ ${#active_pids[@]} -gt 0 ]; do
    # Launch workers up to concurrency limit
    while [ ${#active_pids[@]} -lt $concurrency ] && [ $user_idx -lt $TOTAL_USERS ]; do
      THREAD_ID=$user_idx \
      USER_NAME="${USERNAMES[$user_idx]}" \
      USER_PASS="${PASSWORDS[$user_idx]}" \
      ITERATIONS="$ITERATIONS" \
      API_URL="$API_URL" \
      TMPDIR="$TMPDIR" \
      POSTGRES_PASSWORD="${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD}" \
        "$NODE_BIN" "$WORKERS_DIR/powersync-worker.mjs" >> "$outfile" 2>> "$logfile" &
      active_pids+=($!)
      user_idx=$((user_idx + 1))
    done

    # Check for finished workers
    local new_pids=()
    for pid in "${active_pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        new_pids+=("$pid")
      else
        wait "$pid" 2>/dev/null || failed=$((failed + 1))
        completed=$((completed + 1))
        # Print progress every 10 users
        if [ $((completed % 10)) -eq 0 ]; then
          local elapsed=$(( $(date +%s) - start_time ))
          echo "  Progress: ${completed}/${TOTAL_USERS} (${elapsed}s)"
        fi
      fi
    done
    active_pids=("${new_pids[@]}")

    if [ ${#active_pids[@]} -ge $concurrency ]; then
      sleep 0.5
    fi
  done

  local end_time=$(date +%s)
  local total_duration=$((end_time - start_time))
  local total_results=$(wc -l < "$outfile")

  echo "  Total duration: ${total_duration}s ($(( total_duration / 60 ))m $(( total_duration % 60 ))s)"
  echo "  Users processed: ${completed}/${TOTAL_USERS}, Failed: ${failed}"

  # Summary
  "$NODE_BIN" -e "
    const fs = require('fs');
    const lines = fs.readFileSync('${outfile}', 'utf8').trim().split('\n').filter(Boolean);
    if (!lines.length || !lines[0]) { console.log('  No results'); process.exit(0); }
    const results = lines.map(l => JSON.parse(l));
    const ok = results.filter(r => r.found !== false);
    const durations = ok.map(r => r.duration).sort((a,b) => a-b);
    const to = results.filter(r => r.found === false).length;
    if (!durations.length) { console.log('  No successful results'); process.exit(0); }
    const avg = Math.round(durations.reduce((a,b) => a+b, 0) / durations.length);
    const fmtTime = (ms) => ms >= 60000 ? Math.floor(ms/60000) + 'm ' + Math.round((ms%60000)/1000) + 's' : (ms/1000).toFixed(1) + 's';
    console.log('  Avg response: ' + fmtTime(avg) + ' | Range: ' + fmtTime(durations[0]) + ' - ' + fmtTime(durations[durations.length-1]) + ' | Timeouts: ' + to);
  "
  echo ""
}

# --- Main ---
for level in "${LEVELS[@]}"; do
  run_level "$level"
  if [ "$level" != "${LEVELS[-1]}" ]; then
    echo "  Cooling down ${COOLDOWN}s..."
    sleep "$COOLDOWN"
  fi
done

# --- Generate comparison report ---
echo "============================================================"
echo "Generating comparison report..."
echo "============================================================"

"$NODE_BIN" -e "
  const fs = require('fs');
  const path = require('path');
  const dir = '${RESULTS_DIR}';

  const data = {};

  // Load get-ids results
  for (const f of fs.readdirSync(dir).filter(f => f.startsWith('getids-') && f.endsWith('.jsonl'))) {
    const threads = parseInt(f.replace('getids-','').replace('.jsonl',''));
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean);
    const results = lines.map(l => JSON.parse(l));
    const ok = results.filter(r => r.status === 'ok');
    const durations = ok.map(r => r.duration).sort((a,b) => a-b);
    if (!durations.length) continue;
    if (!data[threads]) data[threads] = {};
    data[threads].couchdb = {
      avg: Math.round(durations.reduce((a,b) => a+b, 0) / durations.length),
      min: durations[0], max: durations[durations.length - 1],
      count: ok.length, errors: results.length - ok.length,
      avg_docs: Math.round(ok.map(r => r.doc_count).reduce((a,b) => a+b, 0) / ok.length),
    };
  }

  // Load PowerSync scaled results
  for (const f of fs.readdirSync(dir).filter(f => f.startsWith('powersync-scaled-') && f.endsWith('.jsonl'))) {
    const threads = parseInt(f.replace('powersync-scaled-','').replace('.jsonl',''));
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean);
    const results = lines.map(l => JSON.parse(l));
    const ok = results.filter(r => r.found !== false);
    const durations = ok.map(r => r.duration).sort((a,b) => a-b);
    if (!durations.length) continue;
    if (!data[threads]) data[threads] = {};
    data[threads].powersync = {
      avg: Math.round(durations.reduce((a,b) => a+b, 0) / durations.length),
      min: durations[0], max: durations[durations.length - 1],
      count: ok.length, timeouts: results.filter(r => r.found === false).length,
    };
  }

  // CHT team reference
  const chtTeam = {
    10: { avg: 77000, range: '35s - 1m 25s', total: '18m 35s' },
    20: { avg: 164000, range: '1m 10s - 2m 51s', total: '19m 33s' },
    30: { avg: 244000, range: '2m 11s - 4m 20s', total: '19m 46s' },
    40: { avg: 330000, range: '2m 25s - 5m 43s', total: '19m 54s' },
    50: { avg: 380000, range: '2m 30s - 7m 02s', total: '19m 37s' },
  };

  const fmt = (ms) => {
    if (!ms && ms !== 0) return '--';
    if (ms >= 60000) return Math.floor(ms/60000) + 'm ' + Math.round((ms%60000)/1000) + 's';
    return (ms/1000).toFixed(1) + 's';
  };

  let report = '# Production-Scale Benchmark: CouchDB get-ids vs PowerSync Incremental Sync\n\n';
  report += 'Replicating CHT team methodology from medic/cht-core#10262.\n';
  report += 'ALL CHW users (district_admin role, ~15K docs each) cycle through at each concurrency level.\n\n';
  report += '## Setup\n\n';
  report += '| | CHT Team | Our Test |\n';
  report += '|--|----------|----------|\n';
  report += '| Hardware | EC2 c5.2xlarge (8 CPU, 16GB) | Dev laptop (24 CPU, 48GB) |\n';
  report += '| Total docs | 3,000,000 | ~589,000 |\n';
  report += '| Users | 140 (~20K docs each) | 120 CHW (~15K docs each) |\n';
  report += '| CouchDB | CHT 5.x (Nouveau) | Same |\n';
  report += '| PowerSync | N/A | Optimized Sync Streams (~8K buckets/user) |\n\n';

  report += '## Results\n\n';
  report += '| Concurrency | CouchDB get-ids (Ours) | CouchDB get-ids (CHT Team) | PowerSync Incremental | Ratio (CouchDB/PS) |\n';
  report += '|-------------|----------------------|---------------------------|----------------------|--------------------|\n';

  for (const threads of Object.keys(data).sort((a,b) => a-b)) {
    const c = data[threads]?.couchdb;
    const p = data[threads]?.powersync;
    const ref = chtTeam[threads];
    const ratio = (c && p) ? (c.avg / p.avg).toFixed(1) + 'x' : '--';
    report += '| ' + threads;
    report += ' | ' + (c ? fmt(c.avg) + ' (' + fmt(c.min) + '-' + fmt(c.max) + ')' : '--');
    report += ' | ' + (ref ? fmt(ref.avg) + ' (' + ref.range + ')' : '--');
    report += ' | ' + (p ? fmt(p.avg) + ' (' + fmt(p.min) + '-' + fmt(p.max) + ')' : '--');
    report += ' | ' + ratio + ' |\n';
  }

  report += '\n';

  const outPath = path.join(dir, 'scaled-powersync-auto-report.md');
  fs.writeFileSync(outPath, report, 'utf8');
  console.log(report);
  console.log('Report saved to: ' + outPath);
"
