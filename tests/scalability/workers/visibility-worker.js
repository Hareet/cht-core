#!/usr/bin/env node
/**
 * visibility worker: after a write burst, measures how long until all
 * written doc IDs are visible to a downstream observer.
 *
 * Three modes — select with VISIBILITY_MODE:
 *
 *   couchdb_bulkget  POST /medic/_bulk_get as an ADMIN user (online role).
 *                    Bypasses the offline _bulk_docs filter — measures
 *                    write-landed-in-backend, not end-user-observable.
 *                    Symmetric with pg_query. Backend correctness check.
 *
 *   pg_query         SELECT count(*) FROM v1.couchdb WHERE _id = ANY($1)
 *                    via direct libpq. Measures write-landed-in-backend —
 *                    no offline filter, no haproxy. PG scenario correctness.
 *
 *   peer_getids      GET /api/v1/replication/get-ids as an OBSERVER CHW
 *                    (offline role that can see the writer cohort's reports).
 *                    Runs the full production sync path — view scan +
 *                    authorization filter + purge filter, O(user's visible
 *                    doc count). Each call can take seconds to minutes under
 *                    load; we loop until expected_count matching IDs appear
 *                    in the response or TIMEOUT_MS elapses. Records per-call
 *                    latencies (p50/p95/p99) + first_ms/all_ms from the
 *                    probe's start. This is the contention story.
 *
 *                    NOTE on observer choice: during development we tested
 *                    supervisors (role `supervisor` in scaled data) and they
 *                    DID NOT see CHW reports at all — `isAllowedDepth` in
 *                    authorization.js short-circuits on report_depth=0 for
 *                    non-submitters. CHWs at this deployment's district level
 *                    (role `district_admin`) see peers' reports across the
 *                    whole district, which is what we want for this probe.
 *                    The orchestrator picks a non-writing CHW from users.csv
 *                    as OBSERVER; we document the supervisor-blindness as a
 *                    deployment-config finding rather than a benchmark bug.
 *
 *                    DOC_IDS_FILE is ignored for peer_getids; we filter the
 *                    get-ids response by ID_TAG (run-unique substring that
 *                    workers embed in doc IDs) and compare the match count
 *                    against EXPECTED_COUNT.
 *
 * Reads DOC_IDS as a file path (env DOC_IDS_FILE, one id per line), not
 * inline — the orchestrator accumulates doc IDs from up to 50 write workers
 * and passes the file path to avoid the command-line length limit.
 *
 * Environment (common):
 *   VISIBILITY_MODE    'couchdb_bulkget' | 'pg_query' | 'peer_getids' (required)
 *   POLL_INTERVAL_MS   ms between polls (default: 250; peer_getids ignores
 *                      — the get-ids call itself paces sampling)
 *   TIMEOUT_MS         max wait (default: 60000 for backend-landed modes,
 *                      180000 for peer_getids since a single call can be
 *                      minutes under load)
 *
 * Environment (couchdb_bulkget / pg_query only):
 *   DOC_IDS_FILE       path to file with one doc id per line (required for
 *                      these modes; peer_getids uses ID_TAG + EXPECTED_COUNT
 *                      instead, since get-ids returns ALL accessible IDs and
 *                      we just count matches)
 *
 * Environment (couchdb_bulkget mode):
 *   ADMIN_NAME    CouchDB/CHT admin username (required — bypasses offline filter)
 *   ADMIN_PASS    password (required)
 *   API_URL       CHT API URL (default: http://localhost:5988)
 *
 * Environment (pg_query mode):
 *   POSTGRES_HOST      (default: localhost)
 *   POSTGRES_PORT      (default: 5432)
 *   POSTGRES_USER      (default: cht)
 *   POSTGRES_PASSWORD  (default: pgpass)
 *   POSTGRES_DB        (default: cht)
 *
 * Environment (peer_getids mode):
 *   OBSERVER_NAME      CHT offline-role username that can see the writer
 *                      cohort's reports (required — typically a non-writing
 *                      district_admin CHW)
 *   OBSERVER_PASS      password (required)
 *   API_URL            CHT API URL (default: http://localhost:5988)
 *   ID_TAG             substring that workers embed in doc IDs so the
 *                      probe can isolate this-run's writes from pre-existing
 *                      data (required)
 *   EXPECTED_COUNT     total docs expected to eventually appear (required;
 *                      usually concurrency * burst_size)
 *
 * Output: one JSONL line. Shape differs per mode:
 *   couchdb_bulkget/pg_query:
 *     {"mode":"...","total_ids":500,"first_ms":142,"all_ms":1204,
 *      "visible_count":500,"status":"ok"}
 *   peer_getids:
 *     {"mode":"peer_getids","observer":"...","expected_count":500,
 *      "visible_count":287,"first_ms":14200,"all_ms":-1,"call_count":4,
 *      "call_ms":{"p50":14450,"p95":15040,"min":13900,"max":15200},
 *      "status":"partial"}
 */
const fs = require('fs');
const { performance } = require('perf_hooks');

const MODE = process.env.VISIBILITY_MODE;
const DOC_IDS_FILE = process.env.DOC_IDS_FILE;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '250');
// peer_getids gets a more generous default because each call can take
// tens of seconds — a 60s budget often won't fit a single poll under load.
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS ||
  (MODE === 'peer_getids' ? '180000' : '60000'));

const VALID_MODES = ['couchdb_bulkget', 'pg_query', 'peer_getids'];
if (!MODE || !VALID_MODES.includes(MODE)) {
  console.error(`[visibility-worker] VISIBILITY_MODE must be one of: ${VALID_MODES.join(', ')}`);
  process.exit(1);
}

// Backend-landed modes drive off a file of doc IDs; peer_getids drives off
// ID_TAG + EXPECTED_COUNT instead.
let docIds = null;
if (MODE !== 'peer_getids') {
  if (!DOC_IDS_FILE || !fs.existsSync(DOC_IDS_FILE)) {
    console.error(`[visibility-worker] DOC_IDS_FILE required and must exist (got: ${DOC_IDS_FILE})`);
    process.exit(1);
  }
  docIds = fs.readFileSync(DOC_IDS_FILE, 'utf8')
    .split('\n').map(l => l.trim()).filter(Boolean);
  if (docIds.length === 0) {
    console.log(JSON.stringify({ mode: MODE, total_ids: 0, visible_count: 0, first_ms: 0, all_ms: 0, status: 'empty' }));
    process.exit(0);
  }
}

async function checkCouchdb() {
  const ADMIN_NAME = process.env.ADMIN_NAME;
  const ADMIN_PASS = process.env.ADMIN_PASS;
  const API_URL = process.env.API_URL || 'http://localhost:5988';
  if (!ADMIN_NAME || !ADMIN_PASS) {
    throw new Error('ADMIN_NAME and ADMIN_PASS required for couchdb_bulkget mode');
  }
  const auth = 'Basic ' + Buffer.from(`${ADMIN_NAME}:${ADMIN_PASS}`).toString('base64');

  return async () => {
    const res = await fetch(`${API_URL}/medic/_bulk_get`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ docs: docIds.map(id => ({ id })) }),
    });
    if (!res.ok) {
      return { visible: 0, error: `http_${res.status}` };
    }
    const body = await res.json();
    // CouchDB _bulk_get response: { results: [ { id, docs: [ {ok: doc} | {error: {...}} ] } ] }
    // CHT's offline filter stubs forbidden docs identically to not-found ones;
    // both surface here as `{error: ...}` entries, and we only count `ok` hits.
    const results = (body.results || []);
    let visible = 0;
    for (const r of results) {
      if (r.docs && r.docs.some(d => d.ok)) visible++;
    }
    return { visible };
  };
}

async function checkPostgres() {
  let pg;
  try {
    // Scalability dir has no pg dep by default. Try workers-local first, then
    // common spots. Install once: `cd tests/scalability/workers && npm install pg@^8`.
    pg = require('pg');
  } catch {
    // Fall back to api/node_modules/pg (always present since the api uses it).
    // Node's module resolver won't walk sideways, so address it explicitly.
    try {
      pg = require('/workspace/cht-core/api/node_modules/pg');
    } catch {
      throw new Error(
        "pg module not found. Install with: cd tests/scalability/workers && npm install pg@^8 --no-save"
      );
    }
  }
  const pool = new pg.Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    user: process.env.POSTGRES_USER || 'cht',
    password: process.env.POSTGRES_PASSWORD || 'pgpass',
    database: process.env.POSTGRES_DB || 'cht',
    max: 2,
  });

  return async () => {
    try {
      // cht-sync's PG schema: v1.couchdb has `_id` as primary key (not
      // `doc_id`). PowerSync-upload writes land here via the cht-datasource
      // PG adapter, same table same PK column.
      const r = await pool.query(
        'SELECT count(*)::int AS c FROM v1.couchdb WHERE _id = ANY($1)',
        [docIds]
      );
      return { visible: r.rows[0].c };
    } catch (e) {
      return { visible: 0, error: e.message.substring(0, 100) };
    }
  };
  // Pool stays open for the duration; process.exit cleans it up.
}

async function checkPeerGetids() {
  const OBSERVER_NAME = process.env.OBSERVER_NAME;
  const OBSERVER_PASS = process.env.OBSERVER_PASS;
  const API_URL = process.env.API_URL || 'http://localhost:5988';
  const ID_TAG = process.env.ID_TAG;
  if (!OBSERVER_NAME || !OBSERVER_PASS) {
    throw new Error('OBSERVER_NAME and OBSERVER_PASS required for peer_getids mode');
  }
  if (!ID_TAG) {
    throw new Error('ID_TAG required for peer_getids mode (substring to filter get-ids response by)');
  }
  const auth = 'Basic ' + Buffer.from(`${OBSERVER_NAME}:${OBSERVER_PASS}`).toString('base64');

  return async () => {
    // No per-call abort — get-ids under load really can take minutes, and
    // we want the real number. TIMEOUT_MS at the run-level governs.
    const t0 = performance.now();
    try {
      const res = await fetch(`${API_URL}/api/v1/replication/get-ids`, {
        headers: { Authorization: auth, Accept: 'application/json' },
      });
      const callMs = Math.round(performance.now() - t0);
      if (!res.ok) return { visible: 0, callMs, error: `http_${res.status}` };
      const body = await res.json();
      const ids = (body.doc_ids_revs || []).map(row => Array.isArray(row) ? row[0] : row);
      // doc_ids_revs is `[[id, rev], ...]`; in rare older responses just ids.
      const visible = ids.filter(id => typeof id === 'string' && id.includes(ID_TAG)).length;
      return { visible, callMs, totalSeen: ids.length };
    } catch (e) {
      return { visible: 0, callMs: Math.round(performance.now() - t0), error: e.message.substring(0, 100) };
    }
  };
}

function pct(arr, p) { return arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null; }

async function run() {
  let checker;
  if (MODE === 'couchdb_bulkget') checker = await checkCouchdb();
  else if (MODE === 'pg_query') checker = await checkPostgres();
  else if (MODE === 'peer_getids') checker = await checkPeerGetids();

  const expectedCount = MODE === 'peer_getids'
    ? parseInt(process.env.EXPECTED_COUNT || '0')
    : docIds.length;

  if (MODE === 'peer_getids' && !expectedCount) {
    console.error('[visibility-worker] EXPECTED_COUNT required for peer_getids (typically concurrency * burst_size)');
    process.exit(1);
  }

  const start = performance.now();
  const deadline = start + TIMEOUT_MS;
  const callLatencies = [];
  let firstMs = -1;
  let allMs = -1;
  let lastVisible = 0;
  let lastTotalSeen = 0;
  let lastError = null;
  let callCount = 0;

  while (performance.now() < deadline) {
    const { visible, error, callMs, totalSeen } = await checker();
    callCount++;
    if (Number.isFinite(callMs)) callLatencies.push(callMs);
    if (totalSeen !== undefined) lastTotalSeen = totalSeen;
    if (error) lastError = error;
    const elapsed = Math.round(performance.now() - start);
    if (visible > 0 && firstMs === -1) firstMs = elapsed;
    if (visible >= expectedCount) {
      allMs = elapsed;
      lastVisible = visible;
      break;
    }
    lastVisible = visible;
    // peer_getids: no sleep — the get-ids call itself paces us (and it's
    // expensive). Backend-landed modes: standard poll interval.
    if (MODE !== 'peer_getids') {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  const status = allMs > -1 ? 'ok' : (firstMs > -1 ? 'partial' : 'none_visible');

  const base = {
    mode: MODE,
    visible_count: lastVisible,
    first_ms: firstMs,
    all_ms: allMs,
    error: lastError,
    status,
  };

  if (MODE === 'peer_getids') {
    const sortedLat = [...callLatencies].sort((a, b) => a - b);
    console.log(JSON.stringify({
      ...base,
      observer: process.env.OBSERVER_NAME,
      expected_count: expectedCount,
      total_seen_last: lastTotalSeen,  // supervisor's full accessible-id count, last sample
      call_count: callCount,
      call_ms: {
        p50: pct(sortedLat, 0.5),
        p95: pct(sortedLat, 0.95),
        p99: pct(sortedLat, 0.99),
        min: sortedLat[0] || null,
        max: sortedLat[sortedLat.length - 1] || null,
      },
    }));
  } else {
    console.log(JSON.stringify({ ...base, total_ids: expectedCount }));
  }
}

run().then(() => process.exit(0)).catch(e => {
  console.error(`[visibility-worker] Fatal: ${e.message}`);
  process.exit(1);
});
