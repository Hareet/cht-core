#!/bin/bash
#
# Production-scale get-ids benchmark
#
# Replicates the CHT team's benchmark methodology from
# https://github.com/medic/cht-core/issues/10262#issuecomment-3337084204
#
# Cycles ALL users through GET /api/v1/replication/get-ids at each
# concurrency level. At concurrency 10 with 130 users: 13 batches of 10,
# processing all users. Measures total wall-clock time and per-user response.
#
# Usage:
#   ./run-scaled-getids-benchmark.sh                # default: 10 20 30 40 50
#   ./run-scaled-getids-benchmark.sh 10 20          # specific levels
#
# Prerequisites:
#   - ~589K docs loaded in CouchDB
#   - 130 users created (listed in users.csv)
#
# Environment:
#   API_URL        CHT API URL (default: http://localhost:5988)
#   USERS_CSV      Path to users.csv (default: ./users.csv)
#   COOLDOWN       Seconds between levels (default: 60)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKERS_DIR="${SCRIPT_DIR}/workers"
RESULTS_DIR="${SCRIPT_DIR}/benchmark_results_scaled"
LOG_DIR="${RESULTS_DIR}/logs"
API_URL="${API_URL:-http://localhost:5988}"
COOLDOWN="${COOLDOWN:-60}"
NODE_BIN="${NODE_BIN:-node}"
USERS_CSV="${USERS_CSV:-${SCRIPT_DIR}/users.csv}"

if [ $# -gt 0 ]; then
  LEVELS=("$@")
else
  LEVELS=(10 20 30 40 50)
fi

mkdir -p "$RESULTS_DIR" "$LOG_DIR"

# --- Load users from CSV ---
declare -a USERNAMES=()
declare -a PASSWORDS=()

if [ -f "$USERS_CSV" ]; then
  while IFS=',' read -r username password roles contact phone place rest; do
    username=$(echo "$username" | tr -d '"')
    password=$(echo "$password" | tr -d '"')
    roles=$(echo "$roles" | tr -d '"')
    [ "$username" = "username" ] && continue
    # Skip manager/national_admin users — they see the entire tree and timeout
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
echo "Production-Scale get-ids Benchmark"
echo "============================================================"
echo "Methodology: Cycle ALL $TOTAL_USERS users through get-ids"
echo "  at each concurrency level (matching CHT team's approach)"
echo "Concurrency levels: ${LEVELS[*]}"
echo "API URL: $API_URL"
echo "Results dir: $RESULTS_DIR"
echo "============================================================"
echo ""

if [ "$TOTAL_USERS" -lt 10 ]; then
  echo "ERROR: Need at least 10 users. Found $TOTAL_USERS."
  exit 1
fi

# --- Run all users through get-ids at a given concurrency ---
# Spawns up to $concurrency workers at a time, cycling through all users.
run_level() {
  local concurrency=$1
  local outfile="${RESULTS_DIR}/getids-${concurrency}.jsonl"
  local logfile="${LOG_DIR}/getids-${concurrency}.log"

  echo "--- get-ids @ ${concurrency} concurrent (${TOTAL_USERS} users total) ---"
  > "$outfile"
  > "$logfile"

  local start_time=$(date +%s)
  local user_idx=0
  local active_pids=()
  local completed=0
  local failed=0

  # Feed all users through the concurrency pool
  while [ $user_idx -lt $TOTAL_USERS ] || [ ${#active_pids[@]} -gt 0 ]; do
    # Launch workers up to concurrency limit
    while [ ${#active_pids[@]} -lt $concurrency ] && [ $user_idx -lt $TOTAL_USERS ]; do
      THREAD_ID=$user_idx \
      USER_NAME="${USERNAMES[$user_idx]}" \
      USER_PASS="${PASSWORDS[$user_idx]}" \
      API_URL="$API_URL" \
        "$NODE_BIN" "$WORKERS_DIR/getids-worker.js" >> "$outfile" 2>> "$logfile" &
      active_pids+=($!)
      user_idx=$((user_idx + 1))
    done

    # Wait for any one to finish (poll every 0.5s)
    local new_pids=()
    for pid in "${active_pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        new_pids+=("$pid")
      else
        wait "$pid" 2>/dev/null || failed=$((failed + 1))
        completed=$((completed + 1))
      fi
    done
    active_pids=("${new_pids[@]}")

    # Brief pause to avoid busy loop
    if [ ${#active_pids[@]} -ge $concurrency ]; then
      sleep 0.5
    fi
  done

  local end_time=$(date +%s)
  local total_duration=$((end_time - start_time))
  local total_results=$(wc -l < "$outfile")

  echo "  Total duration: ${total_duration}s ($(( total_duration / 60 ))m $(( total_duration % 60 ))s)"
  echo "  Users processed: ${completed}/${TOTAL_USERS}, Failed: ${failed}"

  # Print summary
  "$NODE_BIN" -e "
    const fs = require('fs');
    const lines = fs.readFileSync('${outfile}', 'utf8').trim().split('\n').filter(Boolean);
    const results = lines.map(l => JSON.parse(l));
    const ok = results.filter(r => r.status === 'ok');
    const durations = ok.map(r => r.duration).sort((a,b) => a-b);
    const docCounts = ok.map(r => r.doc_count);
    if (!durations.length) { console.log('  No successful results'); process.exit(0); }
    const avg = Math.round(durations.reduce((a,b) => a+b, 0) / durations.length);
    const avgDocs = Math.round(docCounts.reduce((a,b) => a+b, 0) / docCounts.length);
    const min = durations[0];
    const max = durations[durations.length - 1];
    const fmtTime = (ms) => ms >= 60000 ? (ms/60000).toFixed(1) + 'm' : (ms/1000).toFixed(1) + 's';
    console.log('  Avg response: ' + fmtTime(avg) + ' | Range: ' + fmtTime(min) + ' - ' + fmtTime(max) + ' | Avg docs/user: ' + avgDocs);
    const errors = results.filter(r => r.status !== 'ok');
    if (errors.length) console.log('  Errors: ' + errors.length);
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

# --- Generate report ---
echo "============================================================"
echo "Generating report..."
echo "============================================================"

"$NODE_BIN" -e "
  const fs = require('fs');
  const path = require('path');
  const dir = '${RESULTS_DIR}';

  const files = fs.readdirSync(dir).filter(f => f.startsWith('getids-') && f.endsWith('.jsonl')).sort();
  const data = {};

  for (const f of files) {
    const threads = parseInt(f.replace('getids-','').replace('.jsonl',''));
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean);
    const results = lines.map(l => JSON.parse(l));
    const ok = results.filter(r => r.status === 'ok');
    const durations = ok.map(r => r.duration).sort((a,b) => a-b);
    if (!durations.length) continue;

    data[threads] = {
      total_users: results.length,
      successful: ok.length,
      errors: results.length - ok.length,
      avg: Math.round(durations.reduce((a,b) => a+b, 0) / durations.length),
      min: durations[0],
      max: durations[durations.length - 1],
      p50: durations[Math.floor(durations.length * 0.5)],
      p95: durations[Math.floor(durations.length * 0.95)],
      avg_docs: Math.round(ok.map(r => r.doc_count).reduce((a,b) => a+b, 0) / ok.length),
    };
  }

  // CHT team reference (EC2 c5.2xlarge, 3M docs, 140 users, ~20K docs each, Nouveau)
  const chtTeam = {
    10: { total: '18m 35s', avg: 77000, range: '35s - 1m 25s' },
    20: { total: '19m 33s', avg: 164000, range: '1m 10s - 2m 51s' },
    30: { total: '19m 46s', avg: 244000, range: '2m 11s - 4m 20s' },
    40: { total: '19m 54s', avg: 330000, range: '2m 25s - 5m 43s' },
    50: { total: '19m 37s', avg: 380000, range: '2m 30s - 7m 02s' },
  };

  const fmtTime = (ms) => {
    if (ms >= 60000) return Math.floor(ms/60000) + 'm ' + Math.round((ms%60000)/1000) + 's';
    return (ms/1000).toFixed(1) + 's';
  };

  let report = '# Production-Scale get-ids Benchmark\\n\\n';
  report += 'Replicating CHT team methodology from medic/cht-core#10262.\\n';
  report += 'ALL users cycle through GET /api/v1/replication/get-ids at each concurrency level.\\n\\n';
  report += '## Setup Comparison\\n\\n';
  report += '| | CHT Team | Our Test |\\n';
  report += '|--|----------|----------|\\n';
  report += '| Hardware | EC2 c5.2xlarge (8 CPU, 16GB) | Dev laptop (24 CPU, 48GB) |\\n';
  report += '| Total docs | 3,000,000 | ~589,000 |\\n';
  report += '| Users | 140 | ${TOTAL_USERS} |\\n';
  report += '| Docs per user | ~20,000 | see results |\\n';
  report += '| CouchDB | CHT 5.x (Nouveau) | Same |\\n\\n';

  report += '## Results\\n\\n';
  report += '| Concurrency | Our Avg Response | Our Range | CHT Team Avg (Nouveau) | CHT Team Range | Our Avg Docs/User |\\n';
  report += '|-------------|-----------------|-----------|------------------------|----------------|-------------------|\\n';

  for (const threads of Object.keys(data).sort((a,b) => a-b)) {
    const d = data[threads];
    const ref = chtTeam[threads];
    report += '| ' + threads;
    report += ' | ' + fmtTime(d.avg);
    report += ' | ' + fmtTime(d.min) + ' - ' + fmtTime(d.max);
    report += ' | ' + (ref ? fmtTime(ref.avg) : '--');
    report += ' | ' + (ref ? ref.range : '--');
    report += ' | ' + d.avg_docs + ' |\\n';
  }

  report += '\\n## Degradation by Concurrency\\n\\n';
  const baselineKey = Object.keys(data).sort((a,b) => a-b)[0];
  const baseline = data[baselineKey]?.avg;
  report += '| Concurrency | Avg Response | vs Baseline | Errors |\\n';
  report += '|-------------|-------------|-------------|--------|\\n';
  for (const threads of Object.keys(data).sort((a,b) => a-b)) {
    const d = data[threads];
    const deg = baseline ? (d.avg / baseline).toFixed(2) + 'x' : '--';
    report += '| ' + threads + ' | ' + fmtTime(d.avg) + ' | ' + deg + ' | ' + d.errors + '/' + d.total_users + ' |\\n';
  }

  const outPath = path.join(dir, 'scaled-getids-report.md');
  fs.writeFileSync(outPath, report, 'utf8');
  console.log(report);
  console.log('Report saved to: ' + outPath);
"
