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

# Peer observer for peer_getids — picks the last CHW so it's outside the
# write cohort at every concurrency level (max 50 < total 120). This CHW
# calls get-ids during the burst to measure service-side contention.
# Supervisors were rejected as observers during development because their
# role (in scaled-data) has report_depth=0, so they never see CHW reports
# regardless of hierarchy. See check-supervisor-coverage.js for evidence
# and visibility-worker.js peer_getids mode docs for rationale.
OBSERVER_NAME_VAL="${CHW_NAMES[$((TOTAL_CHW - 1))]}"
OBSERVER_PASS_VAL="${CHW_PASSWORDS[$((TOTAL_CHW - 1))]}"

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
# Three phases per level:
#   1. Write burst    — N workers POST in parallel, with ID_TAG embedded in
#                       every doc ID so the peer probe can isolate this level
#   2. Peer get-ids   — runs CONCURRENTLY with phase 1; an observer CHW calls
#                       GET /api/v1/replication/get-ids in a loop, filters for
#                       IDs containing ID_TAG, records per-call latencies.
#                       Terminates when all expected docs visible OR timeout.
#   3. Backend probe  — once writes complete, admin _bulk_get (CouchDB) or
#                       direct libpq (Postgres). Backend-landed correctness.
run_level() {
  local scenario=$1
  local concurrency=$2
  local outfile="${RESULTS_DIR}/write-${scenario}-${concurrency}.jsonl"
  local logfile="${LOG_DIR}/write-${scenario}-${concurrency}.log"
  local doc_ids_file="${RESULTS_DIR}/doc-ids-${scenario}-${concurrency}.txt"
  local summary_file="${RESULTS_DIR}/write-${scenario}-${concurrency}.json"
  local peer_out="${RESULTS_DIR}/peer-${scenario}-${concurrency}.jsonl"

  local worker
  local visibility_mode
  case "$scenario" in
    couchdb)  worker="write-path-worker.js";      visibility_mode=couchdb_bulkget ;;
    postgres) worker="write-powersync-worker.js"; visibility_mode=pg_query ;;
  esac

  # ID_TAG — embedded in every written doc ID so peer_getids can filter the
  # observer's get-ids response down to just THIS level's writes. Using the
  # scenario + level + nanosecond timestamp keeps levels distinct from each
  # other and across re-runs. Length is bounded by design so doc IDs stay
  # sane-looking in forensic output.
  local id_tag="L${concurrency}-${scenario:0:2}-$(date +%N | head -c 6)"
  local expected_count=$(( concurrency * BURST_SIZE ))

  echo "--- scenario=$scenario, concurrency=$concurrency (id_tag=$id_tag) ---"
  > "$outfile"; > "$logfile"; > "$doc_ids_file"; > "$peer_out"

  local start_time
  start_time=$(date +%s)

  # --- Phase 2: launch peer_getids probe FIRST (in background) so the first
  # get-ids call starts before the writes. Observer sees the burst accumulate.
  VISIBILITY_MODE=peer_getids \
  OBSERVER_NAME="$OBSERVER_NAME_VAL" \
  OBSERVER_PASS="$OBSERVER_PASS_VAL" \
  API_URL="$API_URL" \
  ID_TAG="$id_tag" \
  EXPECTED_COUNT="$expected_count" \
  TIMEOUT_MS="${PEER_TIMEOUT_MS:-180000}" \
    "$NODE_BIN" "$WORKERS_DIR/visibility-worker.js" > "$peer_out" 2>> "$logfile" &
  local peer_pid=$!

  # --- Phase 1: launch $concurrency write workers, one per CHW (cycled).
  local active_pids=()
  for (( t=0; t<concurrency; t++ )); do
    local idx=$(( t % TOTAL_CHW ))
    THREAD_ID="$t" \
    USER_NAME="${CHW_NAMES[$idx]}" \
    USER_PASS="${CHW_PASSWORDS[$idx]}" \
    CONTACT_ID="${CHW_CONTACTS[$idx]}" \
    API_URL="$API_URL" \
    BURST_SIZE="$BURST_SIZE" \
    ID_TAG="$id_tag" \
      "$NODE_BIN" "$WORKERS_DIR/$worker" >> "$outfile" 2>> "$logfile" &
    active_pids+=($!)
  done

  local failed=0
  for pid in "${active_pids[@]}"; do
    if ! wait "$pid"; then failed=$((failed + 1)); fi
  done

  local write_duration=$(( $(date +%s) - start_time ))

  # Accumulate successful doc_ids for the backend probe.
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

  # Let the peer probe finish — either it already saw all (bails early) or
  # hits its own TIMEOUT_MS. Writes are done, so no more docs are landing.
  wait "$peer_pid" 2>/dev/null || true
  echo "  peer observer:       $(cat "$peer_out")"

  # --- Phase 3: backend-landed probe (correctness — did writes persist?).
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
  echo "  backend probe (${visibility_mode}): $(cat "$vis_out")"

  # Aggregate into a single summary JSON with both probes.
  "$NODE_BIN" -e "
    const fs = require('fs');
    const readJsonl = (p) => { const s = fs.readFileSync(p,'utf8').trim(); return s ? s.split('\n').filter(Boolean).map(l=>JSON.parse(l)) : []; };
    const readJsonSingle = (p) => { const s = fs.readFileSync(p,'utf8').trim(); return s ? JSON.parse(s) : null; };
    const writes = readJsonl('$outfile');
    const backend = readJsonSingle('$vis_out');
    const peer = readJsonSingle('$peer_out');
    const ok = writes.filter(w => w.status === 'ok');
    const batches = writes.map(w => w.batch_ms).filter(Number.isFinite).sort((a,b)=>a-b);
    const perDocAll = writes.flatMap(w => w.per_doc_ms || []).filter(Number.isFinite).sort((a,b)=>a-b);
    const pct = (arr, p) => arr.length ? arr[Math.min(arr.length-1, Math.floor(arr.length*p))] : null;
    const totalDocs = writes.reduce((s, w) => s + (w.docs_written || 0), 0);
    const summary = {
      scenario: '$scenario',
      concurrency: $concurrency,
      burst_size: $BURST_SIZE,
      id_tag: '$id_tag',
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
      backend_probe: backend,
      backend_probe_wall_s: $vis_duration,
      peer_probe: peer,
      failures_per_worker: writes.map(w => w.failures || 0),
      error_summary: Array.from(new Set(writes.flatMap(w => w.errors || []))).slice(0,5),
    };
    fs.writeFileSync('$summary_file', JSON.stringify(summary, null, 2));
    console.log('  batch p50=' + summary.batch_ms.p50 + 'ms, p95=' + summary.batch_ms.p95 + 'ms, p99=' + summary.batch_ms.p99 + 'ms');
    console.log('  throughput: ' + summary.throughput_docs_per_s + ' docs/s');
    if (backend) console.log('  backend: ' + backend.visible_count + '/' + backend.total_ids + ' visible, all=' + backend.all_ms + 'ms');
    if (peer) {
      const cm = peer.call_ms || {};
      console.log('  peer:    ' + peer.visible_count + '/' + peer.expected_count + ' visible via get-ids, ' + peer.call_count + ' calls, p50=' + cm.p50 + 'ms, p95=' + cm.p95 + 'ms, first=' + peer.first_ms + 'ms, all=' + peer.all_ms + 'ms');
    }
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
echo "Backend probe:   $ADMIN_NAME (admin, skips offline filter)"
echo "Peer observer:   $OBSERVER_NAME_VAL (CHW, runs get-ids during burst)"
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
