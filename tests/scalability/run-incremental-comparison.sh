#!/bin/bash
#
# Incremental sync round-trip comparison: CouchDB vs PowerSync
#
# Runs both engines at multiple concurrency levels and generates
# a comparison report.
#
# Usage:
#   ./run-incremental-comparison.sh                    # all levels: 1,5,10,25,50
#   ./run-incremental-comparison.sh 1 5                # specific levels
#   ITERATIONS=20 ./run-incremental-comparison.sh 10   # 20 iterations at concurrency 10
#
# Prerequisites:
#   - CouchDB running (CHT API at localhost:5988, CouchDB at localhost:5984)
#   - PowerSync running (localhost:8080)
#   - PostgreSQL running (localhost:5432)
#   - Test users ac1-ac4 in both CouchDB and PostgreSQL user_settings
#
# Environment:
#   COUCH_URL          CouchDB admin URL (default: http://admin:secret21512@localhost:5984/medic)
#   POWERSYNC_URL      PowerSync URL (default: http://localhost:8080)
#   ITERATIONS         Iterations per thread (default: 10)
#   COOLDOWN           Seconds between concurrency levels (default: 15)
#   TMPDIR             Temp dir for PowerSync SQLite (use /dev/shm for RAM)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="${SCRIPT_DIR}/benchmark_results"
ITERATIONS="${ITERATIONS:-10}"
COOLDOWN="${COOLDOWN:-15}"
POWERSYNC_URL="${POWERSYNC_URL:-http://localhost:8080}"
COUCH_URL="${COUCH_URL:-http://admin:secret21512@localhost:5984/medic}"
NODE_BIN="${NODE_BIN:-node}"

# Concurrency levels from args or default
if [ $# -gt 0 ]; then
  LEVELS=("$@")
else
  LEVELS=(1 5 10 25 50)
fi

mkdir -p "$RESULTS_DIR"

echo "============================================================"
echo "Incremental Sync Round-Trip Comparison"
echo "============================================================"
echo "Concurrency levels: ${LEVELS[*]}"
echo "Iterations per thread: $ITERATIONS"
echo "PowerSync URL: $POWERSYNC_URL"
echo "CouchDB URL: ${COUCH_URL%%@*}@..."
echo "Results dir: $RESULTS_DIR"
echo "Temp dir: ${TMPDIR:-/tmp}"
echo "============================================================"
echo ""

# --- CouchDB round-trip worker ---
# Runs N iterations, outputs one JSON line per iteration to stdout
run_couch_worker() {
  local thread_id=$1
  local user_idx=$((thread_id % 4))
  local users=("ac1" "ac2" "ac3" "ac4")
  local passwords=("Secret_1" "Secret_1" "Secret_1" "Secret_1")
  local username="${users[$user_idx]}"
  local password="${passwords[$user_idx]}"

  COUCH_URL="$COUCH_URL" "$NODE_BIN" -e "
    const request = require('@medic/couch-request');
    const crypto = require('crypto');
    const { performance } = require('perf_hooks');

    const adminDb = process.env.COUCH_URL;
    const apiUrl = '${SCRIPT_DIR}/../config.json' ? require('${SCRIPT_DIR}/config.json').url : 'http://localhost:5988';
    const username = '${username}';
    const password = '${password}';
    const iterations = ${ITERATIONS};
    const threadId = ${thread_id};

    async function run() {
      // Get user info for doc construction
      const userDoc = await request.get({ url: adminDb + '/org.couchdb.user:' + username });
      const facilityId = Array.isArray(userDoc.facility_id) ? userDoc.facility_id[0] : userDoc.facility_id;
      const contactId = userDoc.contact_id;
      const auth = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');

      for (let i = 0; i < iterations; i++) {
        const docId = 'roundtrip-' + threadId + '-' + crypto.randomUUID();
        const doc = {
          _id: docId, type: 'data_record', form: 'roundtrip_test',
          patient_id: facilityId, reported_date: Date.now(),
          contact: { _id: contactId }, fields: { test: true }
        };

        const start = performance.now();

        // Write doc
        await request.put({ url: adminDb + '/' + docId, body: doc });

        // Poll get-ids until doc appears
        let found = false;
        while (performance.now() - start < 30000) {
          try {
            const res = await request.get({
              url: apiUrl + '/api/v1/replication/get-ids',
              headers: { 'Authorization': auth },
            });
            if (res.doc_ids_revs && res.doc_ids_revs.find(r => r.id === docId)) {
              found = true;
              break;
            }
          } catch(e) {}
          await new Promise(r => setTimeout(r, 50));
        }

        const duration = Math.round(performance.now() - start);
        console.log(JSON.stringify({ thread: threadId, iteration: i+1, duration, found, engine: 'couchdb' }));

        // Cleanup
        try {
          const d = await request.get({ url: adminDb + '/' + docId });
          await request.delete({ url: adminDb + '/' + docId, qs: { rev: d._rev } });
        } catch(e) {}
      }
    }
    run().catch(e => { console.error(e.message); process.exit(1); });
  "
}

# --- PowerSync round-trip worker ---
run_powersync_worker() {
  local thread_id=$1

  POWERSYNC_URL="$POWERSYNC_URL" \
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-pgpass}" \
  TMPDIR="${TMPDIR:-/tmp}" \
  "$NODE_BIN" --input-type=module -e "
    import { performance } from 'perf_hooks';
    import crypto from 'crypto';
    import os from 'os';
    import path from 'path';
    import fs from 'fs';
    import pg from 'pg';
    import { PowerSyncDatabase, SyncStreamConnectionMethod, SyncClientImplementation } from '@powersync/node';
    import { ChtPowerSyncSchema } from '${SCRIPT_DIR}/powersync-benchmark/schema.js';
    import { BenchmarkConnector, getUserClaims } from '${SCRIPT_DIR}/powersync-benchmark/connector.js';
    import { createRequire } from 'module';

    const require = createRequire(import.meta.url);
    const config = require('${SCRIPT_DIR}/config.json');

    const threadId = ${thread_id};
    const iterations = ${ITERATIONS};
    const users = config.powersync_users || config.users;
    const user = users[threadId % users.length];

    const pool = new pg.Pool({
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432'),
      user: process.env.POSTGRES_USER || 'cht',
      password: process.env.POSTGRES_PASSWORD || 'pgpass',
      database: process.env.POSTGRES_DB || 'cht',
    });

    async function run() {
      const claims = await getUserClaims(user.name);
      const facilityId = (await pool.query(
        'SELECT facility_id FROM v1.user_settings WHERE username = \$1', [user.name]
      )).rows[0]?.facility_id;

      // Create synced DB
      const dbDir = path.join(os.tmpdir(), 'powersync-bench');
      fs.mkdirSync(dbDir, { recursive: true });
      const dbPath = path.join(dbDir, 'incremental-' + threadId + '.db');
      for (const ext of ['', '-wal', '-shm']) {
        const f = dbPath + ext;
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }

      const connector = new BenchmarkConnector(claims);
      const db = new PowerSyncDatabase({ schema: ChtPowerSyncSchema, database: { dbFilename: dbPath } });
      await db.get('SELECT powersync_rs_version()');
      await db.connect(connector, {
        connectionMethod: SyncStreamConnectionMethod.WEB_SOCKET,
        clientImplementation: SyncClientImplementation.RUST,
      });
      await db.waitForFirstSync();

      for (let i = 0; i < iterations; i++) {
        const docId = 'roundtrip-' + threadId + '-' + crypto.randomUUID();
        const doc = {
          _id: docId, type: 'data_record', form: 'roundtrip_test',
          patient_id: facilityId, reported_date: Date.now(),
          contact: { _id: facilityId }, fields: { test: true, timestamp: Date.now() },
        };

        const start = performance.now();

        await pool.query(
          'INSERT INTO v1.couchdb (_id, doc, _deleted) VALUES (\$1, \$2::jsonb, false) ON CONFLICT (_id) DO UPDATE SET doc = \$2::jsonb',
          [docId, JSON.stringify(doc)]
        );

        // Wait for doc in local SQLite
        let found = false;
        while (performance.now() - start < 30000) {
          try {
            const result = await db.getOptional('SELECT id FROM reports WHERE id = ?', [docId]);
            if (result) { found = true; break; }
          } catch(e) {}
          await new Promise(r => setTimeout(r, 50));
        }

        const duration = Math.round(performance.now() - start);
        console.log(JSON.stringify({ thread: threadId, iteration: i+1, duration, found, engine: 'powersync' }));

        // Cleanup
        await pool.query('DELETE FROM v1.couchdb WHERE _id = \$1', [docId]);
      }

      await db.disconnectAndClear();
      await pool.end();
      for (const ext of ['', '-wal', '-shm']) {
        const f = dbPath + ext;
        if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch(e) {}
      }
    }
    run().catch(e => { console.error(e.message); process.exit(1); });
  "
}

# --- Run a single concurrency level ---
run_level() {
  local threads=$1
  local engine=$2
  local outfile="${RESULTS_DIR}/${engine}-${threads}.jsonl"

  echo "  Running ${engine} with ${threads} concurrent thread(s)..."
  > "$outfile"

  local pids=()
  for ((t=0; t<threads; t++)); do
    if [ "$engine" = "couchdb" ]; then
      run_couch_worker $t >> "$outfile" 2>/dev/null &
    else
      run_powersync_worker $t >> "$outfile" 2>/dev/null &
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
}

# --- Main ---
for level in "${LEVELS[@]}"; do
  echo ""
  echo "--- Concurrency: ${level} ---"

  run_level "$level" "couchdb"
  echo "  Cooling down ${COOLDOWN}s..."
  sleep "$COOLDOWN"

  run_level "$level" "powersync"
  echo "  Cooling down ${COOLDOWN}s..."
  sleep "$COOLDOWN"
done

echo ""
echo "============================================================"
echo "All levels complete. Generating report..."
echo "============================================================"

# Generate summary
"$NODE_BIN" -e "
  const fs = require('fs');
  const path = require('path');
  const dir = '${RESULTS_DIR}';

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort();
  const data = {};

  for (const f of files) {
    const [engine, threads] = f.replace('.jsonl','').split('-');
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean);
    const results = lines.map(l => JSON.parse(l));
    const durations = results.filter(r => r.found !== false).map(r => r.duration).sort((a,b) => a-b);

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

  let report = '# Incremental Sync Round-Trip: CouchDB vs PowerSync\n\n';
  report += 'CouchDB path: PUT doc → GET /api/v1/replication/get-ids (full auth context re-computation)\n';
  report += 'PowerSync path: INSERT into PG → WAL → PowerSync Service → WebSocket → local SQLite\n\n';

  report += '| Concurrency | Engine | Samples | Mean (ms) | P50 (ms) | P95 (ms) | P99 (ms) | Min (ms) | Max (ms) | Timeouts |\n';
  report += '|-------------|--------|---------|-----------|----------|----------|----------|----------|----------|----------|\n';

  for (const threads of Object.keys(data).sort((a,b) => a-b)) {
    for (const engine of ['couchdb', 'powersync']) {
      const d = data[threads]?.[engine];
      if (!d) continue;
      report += '| ' + [threads, engine, d.count, d.mean, d.p50, d.p95, d.p99, d.min, d.max, d.timeouts].join(' | ') + ' |\n';
    }
  }

  report += '\n';

  // Scaling summary
  report += '## Scaling Characteristics\n\n';
  report += '| Concurrency | CouchDB Mean | PowerSync Mean | Ratio (CouchDB/PowerSync) |\n';
  report += '|-------------|-------------|----------------|---------------------------|\n';
  for (const threads of Object.keys(data).sort((a,b) => a-b)) {
    const c = data[threads]?.couchdb?.mean || '—';
    const p = data[threads]?.powersync?.mean || '—';
    const ratio = (c !== '—' && p !== '—') ? (c / p).toFixed(2) + 'x' : '—';
    report += '| ' + [threads, c, p, ratio].join(' | ') + ' |\n';
  }

  const outPath = path.join(dir, 'incremental-comparison.md');
  fs.writeFileSync(outPath, report, 'utf8');
  console.log(report);
  console.log('Report saved to: ' + outPath);
"
