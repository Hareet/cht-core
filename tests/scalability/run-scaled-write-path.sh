#!/bin/bash
#
# Write-Path Scalability Benchmark
#
# Measures server-side write throughput under concurrent load for TWO
# architectures:
#
#   scenario=couchdb   (current production)
#     write-path-worker → POST /medic/_bulk_docs → haproxy → CouchDB
#     visibility-worker → POST /medic/_bulk_get   as supervisor
#
#   scenario=postgres  (migration target)
#     write-powersync-worker → POST /api/v1/powersync/upload
#                            → cht-datasource → PG
#     visibility-worker      → SELECT FROM v1.couchdb (direct libpq)
#
# Sibling to run-scaled-getids-benchmark.sh. Reuses users.csv (131 rows,
# filtered to ~120 district_admin CHWs for write workers, 9 supervisors
# available for visibility).
#
# Usage:
#   ./run-scaled-write-path.sh                      # both scenarios, 1 10 25 50
#   ./run-scaled-write-path.sh --scenario couchdb   # only current architecture
#   ./run-scaled-write-path.sh --scenario postgres  # only migration target
#   ./run-scaled-write-path.sh 10 50                # custom levels (positional)
#
# Environment:
#   API_URL          CHT API URL (default: http://localhost:5988)
#   BURST_SIZE       docs per worker (default: 10)
#   COOLDOWN         seconds between levels (default: 60)
#   USERS_CSV        path to users.csv (default: ./users.csv)
#   BACKEND_FLIP_CMD shell snippet to flip CHT_DB_BACKEND before scenario=postgres
#                    (default: print a reminder and wait for SIGCONT)
#   POSTGRES_HOST    (default: localhost, passed to visibility-worker)
#   POSTGRES_*       standard pg vars for visibility-worker pg_query mode
#
# Pre-requisites:
#   - users.csv populated (see initial-replication.js)
#   - scenario=postgres needs the operator to flip the api's
#     CHT_DB_BACKEND=postgres before that pass starts; the orchestrator
#     will validate via /api/v1/powersync/status and abort on mismatch.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKERS_DIR="${SCRIPT_DIR}/workers"
RESULTS_DIR="${SCRIPT_DIR}/benchmark_results_scaled/write-path"
LOG_DIR="${RESULTS_DIR}/logs"
API_URL="${API_URL:-http://localhost:5988}"
COOLDOWN="${COOLDOWN:-30}"
BURST_SIZE="${BURST_SIZE:-10}"
NODE_BIN="${NODE_BIN:-node}"
USERS_CSV="${USERS_CSV:-${SCRIPT_DIR}/users.csv}"

# --- Arg parsing ---
SCENARIOS=(couchdb postgres)
LEVELS_OVERRIDE=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scenario)
      SCENARIOS=("$2"); shift 2 ;;
    --scenario=*)
      SCENARIOS=("${1#*=}"); shift ;;
    --help|-h)
      sed -n '2,30p' "$0"; exit 0 ;;
    *)
      LEVELS_OVERRIDE+=("$1"); shift ;;
  esac
done

if [[ ${#LEVELS_OVERRIDE[@]} -gt 0 ]]; then
  LEVELS=("${LEVELS_OVERRIDE[@]}")
else
  LEVELS=(1 10 25 50)
fi

mkdir -p "$RESULTS_DIR" "$LOG_DIR"

# --- Load users ---
# Column layout: username, password, roles, contact, phone, place
# Keep only CHW-like users (not national_admin, not supervisor) for write
# workers. Visibility is done with admin creds (see note in visibility-worker.js).
declare -a CHW_NAMES=() CHW_PASSWORDS=() CHW_CONTACTS=()

if [[ ! -f "$USERS_CSV" ]]; then
  echo "ERROR: $USERS_CSV not found"; exit 1
fi

while IFS=',' read -r username password roles contact phone place rest; do
  username=$(echo "$username" | tr -d '"')
  password=$(echo "$password" | tr -d '"')
  roles=$(echo "$roles" | tr -d '"')
  contact=$(echo "$contact" | tr -d '"')
  [[ "$username" == "username" ]] && continue
  case "$roles" in
    *national_admin*|*supervisor*) continue ;;
    *)
      CHW_NAMES+=("$username"); CHW_PASSWORDS+=("$password"); CHW_CONTACTS+=("$contact") ;;
  esac
done < "$USERS_CSV"

TOTAL_CHW=${#CHW_NAMES[@]}

if (( TOTAL_CHW < 10 )); then
  echo "ERROR: Need at least 10 CHW (non-supervisor) users; found $TOTAL_CHW."; exit 1
fi

# Credentials: check per-scenario, not globally — the postgres scenario
# doesn't need couchdb admin and vice versa.
ADMIN_NAME="${COUCHDB_USER:-${ADMIN_NAME:-admin}}"
ADMIN_PASS="${COUCHDB_PASSWORD:-${ADMIN_PASS:-}}"
PG_HOST="${POSTGRES_HOST:-localhost}"
PG_PORT="${POSTGRES_PORT:-5432}"
PG_USER="${POSTGRES_USER:-cht}"
PG_PASS="${POSTGRES_PASSWORD:-pgpass}"
PG_DB="${POSTGRES_DB:-cht}"

require_scenario_creds() {
  local scenario=$1
  case "$scenario" in
    couchdb)
      if [[ -z "$ADMIN_PASS" ]]; then
        echo "ERROR: scenario=couchdb needs COUCHDB_PASSWORD (or ADMIN_PASS) for admin visibility probe."
        return 1
      fi
      ;;
    postgres)
      if [[ -z "$PG_PASS" ]]; then
        echo "ERROR: scenario=postgres needs POSTGRES_PASSWORD for pg_query visibility probe."
        return 1
      fi
      ;;
  esac
}

# --- Pre-flight: backend matches scenario ---
# Uses Basic Auth on the first CHW to hit /api/v1/powersync/status. That
# endpoint returns {powersync_enabled, backend} — we compare backend to the
# scenario and abort on mismatch.
preflight_scenario() {
  local scenario=$1
  local expected_backend
  case "$scenario" in
    couchdb)  expected_backend=couchdb ;;
    postgres) expected_backend=postgres ;;
    *) echo "Unknown scenario: $scenario"; return 1 ;;
  esac

  local auth
  auth=$(printf '%s:%s' "${CHW_NAMES[0]}" "${CHW_PASSWORDS[0]}" | base64 -w0)
  local status
  status=$(curl -sS -H "Authorization: Basic $auth" "$API_URL/api/v1/powersync/status" || true)
  local actual_backend
  actual_backend=$("$NODE_BIN" -e "try { console.log((JSON.parse(process.argv[1]) || {}).backend || '') } catch { console.log('') }" "$status")
  local powersync_enabled
  powersync_enabled=$("$NODE_BIN" -e "try { console.log((JSON.parse(process.argv[1]) || {}).powersync_enabled || false) } catch { console.log('false') }" "$status")

  if [[ -z "$actual_backend" ]]; then
    echo "ERROR: /api/v1/powersync/status returned no backend. Response:"; echo "  $status"
    return 1
  fi
  if [[ "$actual_backend" != "$expected_backend" ]]; then
    echo "ERROR: Scenario '$scenario' expects api backend '$expected_backend', but api reports '$actual_backend'."
    echo ""
    echo "  To flip:"
    echo "    cd .devcontainer"
    echo "    CHT_DB_BACKEND=$expected_backend docker compose -f docker-compose.services.yml up -d --force-recreate api"
    echo ""
    return 1
  fi
  if [[ "$scenario" == "postgres" ]] && [[ "$powersync_enabled" != "true" ]]; then
    echo "WARNING: scenario=postgres needs the powersync feature flag enabled for scaled users."
    echo "  /api/v1/powersync/status reports powersync_enabled=$powersync_enabled for ${CHW_NAMES[0]}."
    echo "  The postgres scenario workers will all get 403 from /api/v1/powersync/upload."
    echo ""
    echo "  Fix: in app_settings, ensure 'powersync.enabled=true' AND either leave 'facilities' empty"
    echo "  OR include facilities that contain the scaled users (they use the legacy 'district_hospital'"
    echo "  subtree; the rollout_percentage must also allow them)."
    echo ""
    echo "  Aborting postgres scenario. Re-run after the flag is on."
    return 1
  fi

  echo "  pre-flight OK: backend=$actual_backend, powersync_enabled=$powersync_enabled"
}

# --- Per-level run for a given scenario ---
# Writes N bursts in parallel, collects JSONL into a per-level file, then
# fires the visibility worker with the accumulated doc_ids.
run_level() {
  local scenario=$1
  local concurrency=$2
  local outfile="${RESULTS_DIR}/write-${scenario}-${concurrency}.jsonl"
  local logfile="${LOG_DIR}/write-${scenario}-${concurrency}.log"
  local doc_ids_file="${RESULTS_DIR}/doc-ids-${scenario}-${concurrency}.txt"
  local summary_file="${RESULTS_DIR}/write-${scenario}-${concurrency}.json"

  local worker
  local visibility_mode
  case "$scenario" in
    couchdb)  worker="write-path-worker.js";      visibility_mode=couchdb_bulkget ;;
    postgres) worker="write-powersync-worker.js"; visibility_mode=pg_query ;;
  esac

  echo "--- scenario=$scenario, concurrency=$concurrency ---"
  > "$outfile"; > "$logfile"; > "$doc_ids_file"

  local start_time
  start_time=$(date +%s)
  local active_pids=()

  # Launch $concurrency workers, one per user, cycling through CHWs.
  for (( t=0; t<concurrency; t++ )); do
    local idx=$(( t % TOTAL_CHW ))
    THREAD_ID="$t" \
    USER_NAME="${CHW_NAMES[$idx]}" \
    USER_PASS="${CHW_PASSWORDS[$idx]}" \
    CONTACT_ID="${CHW_CONTACTS[$idx]}" \
    API_URL="$API_URL" \
    BURST_SIZE="$BURST_SIZE" \
      "$NODE_BIN" "$WORKERS_DIR/$worker" >> "$outfile" 2>> "$logfile" &
    active_pids+=($!)
  done

  # Wait for all workers. If any fail, log but keep collecting.
  local failed=0
  for pid in "${active_pids[@]}"; do
    if ! wait "$pid"; then failed=$((failed + 1)); fi
  done

  local write_duration=$(( $(date +%s) - start_time ))

  # Accumulate doc_ids across all workers (one per line for the visibility worker).
  "$NODE_BIN" -e "
    const fs = require('fs');
    const lines = fs.readFileSync('$outfile', 'utf8').trim().split('\n').filter(Boolean);
    for (const l of lines) {
      try {
        const r = JSON.parse(l);
        if (Array.isArray(r.doc_ids)) for (const id of r.doc_ids) console.log(id);
      } catch {}
    }
  " > "$doc_ids_file"
  local doc_count
  doc_count=$(wc -l < "$doc_ids_file")
  echo "  writes: ${doc_count} docs across ${concurrency} workers in ${write_duration}s (failed workers: ${failed})"

  # Visibility probe.
  local visibility_start=$(date +%s)
  local vis_out="${RESULTS_DIR}/visibility-${scenario}-${concurrency}.jsonl"
  VISIBILITY_MODE="$visibility_mode" \
  DOC_IDS_FILE="$doc_ids_file" \
  ADMIN_NAME="$ADMIN_NAME" \
  ADMIN_PASS="$ADMIN_PASS" \
  API_URL="$API_URL" \
  TIMEOUT_MS="${VISIBILITY_TIMEOUT_MS:-60000}" \
  POSTGRES_HOST="$PG_HOST" \
  POSTGRES_PORT="$PG_PORT" \
  POSTGRES_USER="$PG_USER" \
  POSTGRES_PASSWORD="$PG_PASS" \
  POSTGRES_DB="$PG_DB" \
    "$NODE_BIN" "$WORKERS_DIR/visibility-worker.js" > "$vis_out" 2>> "$logfile" || true
  local vis_duration=$(( $(date +%s) - visibility_start ))
  echo "  visibility probe (${visibility_mode}): $(cat "$vis_out")"

  # Aggregate into a single summary JSON.
  "$NODE_BIN" -e "
    const fs = require('fs');
    const writes = fs.readFileSync('$outfile','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
    const visRaw = fs.readFileSync('$vis_out','utf8').trim();
    const vis = visRaw ? JSON.parse(visRaw) : null;
    const ok = writes.filter(w => w.status === 'ok');
    const batches = writes.map(w => w.batch_ms).filter(Number.isFinite).sort((a,b)=>a-b);
    const perDocAll = writes.flatMap(w => w.per_doc_ms || []).filter(Number.isFinite).sort((a,b)=>a-b);
    const pct = (arr, p) => arr.length ? arr[Math.min(arr.length-1, Math.floor(arr.length*p))] : null;
    const totalDocs = writes.reduce((s, w) => s + (w.docs_written || 0), 0);
    const summary = {
      scenario: '$scenario',
      concurrency: $concurrency,
      burst_size: $BURST_SIZE,
      workers: writes.length,
      ok_workers: ok.length,
      docs_written: totalDocs,
      docs_expected: ${concurrency} * $BURST_SIZE,
      wall_clock_s: $write_duration,
      throughput_docs_per_s: $write_duration > 0 ? Math.round((totalDocs / $write_duration) * 100) / 100 : null,
      batch_ms: {
        p50: pct(batches, 0.5), p95: pct(batches, 0.95), p99: pct(batches, 0.99),
        min: batches[0] || null, max: batches[batches.length-1] || null,
      },
      per_doc_ms: {
        p50: pct(perDocAll, 0.5), p95: pct(perDocAll, 0.95), p99: pct(perDocAll, 0.99),
      },
      visibility: vis,
      visibility_probe_wall_s: $vis_duration,
      failures_per_worker: writes.map(w => w.failures || 0),
      error_summary: Array.from(new Set(writes.flatMap(w => w.errors || []))).slice(0,5),
    };
    fs.writeFileSync('$summary_file', JSON.stringify(summary, null, 2));
    console.log('  batch p50=' + summary.batch_ms.p50 + 'ms, p95=' + summary.batch_ms.p95 + 'ms, p99=' + summary.batch_ms.p99 + 'ms');
    console.log('  throughput: ' + summary.throughput_docs_per_s + ' docs/s');
    if (vis) console.log('  visibility: ' + vis.visible_count + '/' + vis.total_ids + ' visible, first=' + vis.first_ms + 'ms, all=' + vis.all_ms + 'ms');
  "
  echo ""
}

# --- Main ---
echo "============================================================"
echo "Write-Path Scalability Benchmark"
echo "============================================================"
echo "Scenarios:       ${SCENARIOS[*]}"
echo "Concurrency:     ${LEVELS[*]}"
echo "Burst size:      $BURST_SIZE docs/worker"
echo "CHW users:       $TOTAL_CHW (cycling)"
echo "Visibility auth: $ADMIN_NAME (admin, backend-level check)"
echo "API:             $API_URL"
echo "Results dir:     $RESULTS_DIR"
echo "============================================================"
echo ""

for scenario in "${SCENARIOS[@]}"; do
  echo "##############################################"
  echo "# Scenario: $scenario"
  echo "##############################################"
  if ! require_scenario_creds "$scenario"; then
    echo "Skipping scenario $scenario."; echo ""
    continue
  fi
  if ! preflight_scenario "$scenario"; then
    echo "Skipping scenario $scenario."; echo ""
    continue
  fi
  echo ""

  for level in "${LEVELS[@]}"; do
    run_level "$scenario" "$level"
    if [[ "$level" != "${LEVELS[-1]}" ]]; then
      echo "  cooldown ${COOLDOWN}s..."; sleep "$COOLDOWN"
    fi
  done
done

echo "============================================================"
echo "Done. Summaries: $RESULTS_DIR/write-*-<level>.json"
echo "============================================================"
