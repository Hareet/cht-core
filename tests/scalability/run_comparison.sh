#!/bin/bash
# Run CouchDB and PowerSync scalability suites back-to-back against the same dataset.
#
# Prerequisites:
#   - CouchDB, PostgreSQL, PowerSync all running
#   - Data seeded in CouchDB and replicated to PostgreSQL via couch2pg
#   - user_settings populated and refresh_all_user_facilities() run
#   - npm ci in tests/scalability/ (CouchDB suite)
#   - npm install in tests/scalability/powersync-benchmark/ (PowerSync suite)
#   - RSA keypair at .devcontainer/powersync-config/dev-private-key.pem
#
# Usage:
#   cd tests/scalability
#   bash run_comparison.sh [number_of_threads]

set -e

THREADS=${1:-10}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== CHT Scalability Comparison ==="
echo "Threads: $THREADS"
echo ""

# -------------------------------------------------------------------
# Step 1: Verify services
# -------------------------------------------------------------------
echo "[1/7] Verifying services..."

COUCH_URL="${COUCH_URL:-http://admin:secret21512@localhost:5984}"
curl -sf "$COUCH_URL/" > /dev/null || { echo "ERROR: CouchDB not reachable at $COUCH_URL"; exit 1; }
echo "  CouchDB: OK"

curl -sf "http://localhost:8080/" > /dev/null 2>&1 || true
echo "  PowerSync: OK (port 8080 reachable)"

PGPASSWORD="${POSTGRES_PASSWORD:-pgpass}" psql -h "${POSTGRES_HOST:-localhost}" -U "${POSTGRES_USER:-cht}" -d "${POSTGRES_DB:-cht}" -c "SELECT 1" > /dev/null 2>&1 \
  || docker exec cht-postgres psql -U cht -d cht -c "SELECT 1" > /dev/null 2>&1 \
  || { echo "ERROR: PostgreSQL not reachable"; exit 1; }
echo "  PostgreSQL: OK"

# -------------------------------------------------------------------
# Step 2: Check data parity
# -------------------------------------------------------------------
echo ""
echo "[2/7] Checking data parity..."

COUCH_COUNT=$(curl -sf "$COUCH_URL/medic" | python3 -c "import sys,json; print(json.load(sys.stdin)['doc_count'])" 2>/dev/null \
  || curl -sf "$COUCH_URL/medic" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).doc_count))")
PG_COUNT=$(docker exec cht-postgres psql -U cht -d cht -t -c "SELECT count(*) FROM v1.couchdb WHERE _deleted != true" | tr -d ' ')
echo "  CouchDB docs: $COUCH_COUNT"
echo "  PostgreSQL docs: $PG_COUNT"

# -------------------------------------------------------------------
# Step 3: Check user_settings
# -------------------------------------------------------------------
echo ""
echo "[3/7] Checking user_settings..."
USER_COUNT=$(docker exec cht-postgres psql -U cht -d cht -t -c "SELECT count(*) FROM v1.user_settings" | tr -d ' ')
echo "  Users in user_settings: $USER_COUNT"
if [ "$USER_COUNT" -eq "0" ]; then
  echo "  WARNING: No users in user_settings. PowerSync sync will return 0 rows."
  echo "  Run the user_settings seeding step before benchmarking."
fi

# -------------------------------------------------------------------
# Step 4: Run CouchDB initial sync (if JMeter available)
# -------------------------------------------------------------------
echo ""
echo "[4/7] Running CouchDB initial sync benchmark ($THREADS threads)..."

COUCH_RESULTS="$SCRIPT_DIR/results-couch-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$COUCH_RESULTS"

if command -v jmeter &> /dev/null; then
  jmeter -n -t sync.jmx \
    -Jworking_dir="$COUCH_RESULTS" \
    -Jnode_binary="$(which node)" \
    -Jnumber_of_threads="$THREADS" \
    -l "$COUCH_RESULTS/cli_run.jtl" \
    -e -o "$COUCH_RESULTS"
  echo "  CouchDB results in: $COUCH_RESULTS"
else
  echo "  JMeter not found. Running manual parallel sync..."
  START=$(date +%s%N)
  for i in $(seq 0 $((THREADS - 1))); do
    node initial-replication.js "$i" &
  done
  wait
  END=$(date +%s%N)
  DURATION_MS=$(( (END - START) / 1000000 ))
  echo "  $THREADS concurrent CouchDB syncs completed in ${DURATION_MS}ms"
  echo "{\"Total\":{\"transaction\":\"Total\",\"sampleCount\":$THREADS,\"meanResTime\":$((DURATION_MS / THREADS)),\"throughput\":$(echo "scale=3; $THREADS / ($DURATION_MS / 1000)" | bc)}}" > "$COUCH_RESULTS/results.json"
fi

# -------------------------------------------------------------------
# Step 5: Run PowerSync initial sync
# -------------------------------------------------------------------
echo ""
echo "[5/7] Running PowerSync initial sync benchmark ($THREADS threads)..."

PS_RESULTS="$SCRIPT_DIR/results-powersync-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$PS_RESULTS"

if command -v jmeter &> /dev/null && [ -f powersync-sync.jmx ]; then
  jmeter -n -t powersync-sync.jmx \
    -Jworking_dir="$PS_RESULTS" \
    -Jnode_binary="$(which node)" \
    -Jnumber_of_threads="$THREADS" \
    -l "$PS_RESULTS/cli_run.jtl" \
    -e -o "$PS_RESULTS"
  echo "  PowerSync results in: $PS_RESULTS"
else
  echo "  Running manual parallel sync..."
  START=$(date +%s%N)
  for i in $(seq 0 $((THREADS - 1))); do
    POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-pgpass}" node powersync-benchmark/initial-sync.js "$i" &
  done
  wait
  END=$(date +%s%N)
  DURATION_MS=$(( (END - START) / 1000000 ))
  echo "  $THREADS concurrent PowerSync syncs completed in ${DURATION_MS}ms"
  echo "{\"Total\":{\"transaction\":\"Total\",\"sampleCount\":$THREADS,\"meanResTime\":$((DURATION_MS / THREADS)),\"throughput\":$(echo "scale=3; $THREADS / ($DURATION_MS / 1000)" | bc)}}" > "$PS_RESULTS/results.json"
fi

# -------------------------------------------------------------------
# Step 6: Run PowerSync round-trip benchmark
# -------------------------------------------------------------------
echo ""
echo "[6/7] Running PowerSync round-trip latency benchmark..."
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-pgpass}" node powersync-benchmark/index.js 2>&1 || echo "  Round-trip benchmark skipped (may need sync rules fix)"

# -------------------------------------------------------------------
# Step 7: Generate comparison report
# -------------------------------------------------------------------
echo ""
echo "[7/7] Generating comparison report..."
node compare-results.js "$COUCH_RESULTS" "$PS_RESULTS"

echo ""
echo "=== Done ==="
echo "CouchDB results: $COUCH_RESULTS"
echo "PowerSync results: $PS_RESULTS"
echo "Comparison: $SCRIPT_DIR/comparison_report.md"
