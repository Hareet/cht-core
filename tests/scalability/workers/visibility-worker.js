#!/usr/bin/env node
/**
 * visibility worker: after a write burst, measures how long until all
 * written doc IDs are visible to a downstream observer.
 *
 * Two modes — select with VISIBILITY_MODE:
 *
 *   couchdb_bulkget  POST /medic/_bulk_get as an ADMIN user (online role).
 *                    Bypasses the offline _bulk_docs filter — measures
 *                    write-landed-in-backend, not end-user-observable. Admin
 *                    auth is chosen over a supervisor for two reasons:
 *                    (a) it matches pg_query semantically (both skip the
 *                    auth filter), so the two scenarios produce apples-to-
 *                    apples numbers, and (b) picking a supervisor that
 *                    actually has hierarchy overlap with a rotating CHW
 *                    cohort requires knowing the place tree, which would
 *                    couple the harness to users.csv's specific scaled-data
 *                    layout. End-user peer-visibility is a separate concern
 *                    and a V2 follow-up.
 *
 *   pg_query         SELECT doc_id FROM v1.couchdb WHERE doc_id = ANY($1)
 *                    via direct libpq. Measures write-landed-in-backend —
 *                    no offline filter, no haproxy. Use for the PG+PowerSync
 *                    scenario.
 *
 * Reads DOC_IDS as a file path (env DOC_IDS_FILE, one id per line), not
 * inline — the orchestrator accumulates doc IDs from up to 50 write workers
 * and passes the file path to avoid the command-line length limit.
 *
 * Environment (common):
 *   VISIBILITY_MODE    'couchdb_bulkget' | 'pg_query' (required)
 *   DOC_IDS_FILE       path to file with one doc id per line (required)
 *   POLL_INTERVAL_MS   ms between polls (default: 250)
 *   TIMEOUT_MS         max wait (default: 60000)
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
 * Output: one JSONL line:
 *   {"mode":"couchdb_bulkget","total_ids":500,"first_ms":142,"all_ms":1204,
 *    "first_visible_at":"...","visible_count":500,"status":"ok"}
 */
const fs = require('fs');
const { performance } = require('perf_hooks');

const MODE = process.env.VISIBILITY_MODE;
const DOC_IDS_FILE = process.env.DOC_IDS_FILE;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '250');
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '60000');

if (!MODE || (MODE !== 'couchdb_bulkget' && MODE !== 'pg_query')) {
  console.error(`[visibility-worker] VISIBILITY_MODE must be 'couchdb_bulkget' or 'pg_query'`);
  process.exit(1);
}
if (!DOC_IDS_FILE || !fs.existsSync(DOC_IDS_FILE)) {
  console.error(`[visibility-worker] DOC_IDS_FILE required and must exist (got: ${DOC_IDS_FILE})`);
  process.exit(1);
}

const docIds = fs.readFileSync(DOC_IDS_FILE, 'utf8')
  .split('\n')
  .map(l => l.trim())
  .filter(Boolean);

if (docIds.length === 0) {
  console.log(JSON.stringify({ mode: MODE, total_ids: 0, visible_count: 0, first_ms: 0, all_ms: 0, status: 'empty' }));
  process.exit(0);
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

async function run() {
  const checker = MODE === 'couchdb_bulkget' ? await checkCouchdb() : await checkPostgres();

  const start = performance.now();
  const deadline = start + TIMEOUT_MS;
  let firstMs = -1;
  let allMs = -1;
  let lastVisible = 0;
  let lastError = null;

  while (performance.now() < deadline) {
    const { visible, error } = await checker();
    if (error) lastError = error;
    const elapsed = Math.round(performance.now() - start);
    if (visible > 0 && firstMs === -1) firstMs = elapsed;
    if (visible >= docIds.length) {
      allMs = elapsed;
      lastVisible = visible;
      break;
    }
    lastVisible = visible;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  const status = allMs > -1 ? 'ok' : (firstMs > -1 ? 'partial' : 'none_visible');
  console.log(JSON.stringify({
    mode: MODE,
    total_ids: docIds.length,
    visible_count: lastVisible,
    first_ms: firstMs,
    all_ms: allMs,
    error: lastError,
    status,
  }));
}

run().then(() => process.exit(0)).catch(e => {
  console.error(`[visibility-worker] Fatal: ${e.message}`);
  process.exit(1);
});
