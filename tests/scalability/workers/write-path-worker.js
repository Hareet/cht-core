#!/usr/bin/env node
/**
 * write-path worker: measures a burst of individual single-doc _bulk_docs
 * POSTs by one authenticated offline user.
 *
 * Sibling to getids-worker.js — same JSONL-to-stdout contract, runs under the
 * same bash orchestrator (run-scaled-write-path.sh).
 *
 * Why single-doc POSTs instead of one bulk of N:
 *   Real PouchDB live replication pushes one doc per _bulk_docs call during
 *   active form entry. A single bulk-of-10 would measure batch catch-up
 *   latency instead, which is a different distribution. Single-doc keeps the
 *   per-request distribution comparable to production and gives us real
 *   per-doc p50/p95/p99 within a worker.
 *
 * The bench doc shape mirrors the fix landed in
 * tests/benchmark/benchmark-write-path.js (Test B): no top-level patient_id,
 * so the docs_by_replication_key view resolves subject to doc.contact._id —
 * which must be the user's own accessible contact to pass the offline
 * _bulk_docs filter (api/src/services/bulk-docs.js: filterOfflineRequest ->
 * authorization.allowedReport).
 *
 * Environment:
 *   THREAD_ID   - unique thread identifier (default: 0)
 *   USER_NAME   - CHT username (required, must be an offline role)
 *   USER_PASS   - CHT password (required)
 *   CONTACT_ID  - user's contact UUID (required, taken from users.csv `contact`
 *                 column — must be reachable in USER_NAME's subjectIds)
 *   API_URL     - CHT API URL (default: http://localhost:5988)
 *   BURST_SIZE  - docs per worker (default: 10)
 *   TIMEOUT_MS  - wall-clock cap per POST (default: 30000)
 *
 * Output: one JSONL line to stdout:
 *   {"thread":0,"user":"ac1","docs_written":10,"doc_ids":[...],
 *    "per_doc_ms":[142,98,...],"batch_ms":1240,"failures":0,
 *    "errors":[],"status":"ok"}
 */
const { performance } = require('perf_hooks');
const crypto = require('crypto');

const THREAD_ID   = parseInt(process.env.THREAD_ID || '0');
const USER_NAME   = process.env.USER_NAME;
const USER_PASS   = process.env.USER_PASS;
const CONTACT_ID  = process.env.CONTACT_ID;
const API_URL     = process.env.API_URL || 'http://localhost:5988';
const BURST_SIZE  = parseInt(process.env.BURST_SIZE || '10');
const TIMEOUT_MS  = parseInt(process.env.TIMEOUT_MS || '30000');
// Optional: run/level unique substring embedded into every generated doc
// ID. Lets the peer_getids visibility probe isolate this-run's writes from
// ambient bench data left over from prior runs. Empty = legacy format.
const ID_TAG      = process.env.ID_TAG || '';

if (!USER_NAME || !USER_PASS || !CONTACT_ID) {
  console.error(`[write-path-worker ${THREAD_ID}] USER_NAME, USER_PASS, CONTACT_ID required`);
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${USER_NAME}:${USER_PASS}`).toString('base64');

function makeDoc(threadId, batchTs, i) {
  const tag = ID_TAG ? `${ID_TAG}-` : '';
  return {
    _id: `bench-scale-${tag}${threadId}-${batchTs}-${i}-${crypto.randomBytes(3).toString('hex')}`,
    type: 'data_record',
    form: 'benchmark_scale_write',
    reported_date: Date.now(),
    contact: { _id: CONTACT_ID },
    fields: { test: true, burst_index: i, thread: threadId },
  };
}

async function postOne(doc) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_URL}/medic/_bulk_docs`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ docs: [doc] }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `http_${res.status}` };
    }
    const body = await res.json();
    // _bulk_docs returns an array of per-doc outcomes. The offline filter stubs
    // forbidden docs as {id, error: 'forbidden'}. We treat any error on the
    // single doc as failure for this write.
    const entry = Array.isArray(body) ? body[0] : body;
    if (!entry) {
      return { ok: false, error: 'empty_response' };
    }
    if (entry.error) {
      return { ok: false, error: entry.error };
    }
    if (!entry.ok && !entry.rev) {
      return { ok: false, error: 'no_ack' };
    }
    return { ok: true };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, error: 'timeout' };
    return { ok: false, error: `fetch: ${e.message.substring(0, 100)}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function run() {
  const batchStart = performance.now();
  const batchTs = Date.now();
  const docIds = [];
  const perDocMs = [];
  const errors = [];
  let failures = 0;

  for (let i = 0; i < BURST_SIZE; i++) {
    const doc = makeDoc(THREAD_ID, batchTs, i);
    const t0 = performance.now();
    const r = await postOne(doc);
    const dt = Math.round(performance.now() - t0);
    perDocMs.push(dt);
    if (r.ok) {
      docIds.push(doc._id);
    } else {
      failures++;
      if (errors.length < 3) errors.push(r.error);
    }
  }

  const batchMs = Math.round(performance.now() - batchStart);
  const status = failures === 0 ? 'ok' : failures === BURST_SIZE ? 'all_failed' : 'partial';

  console.log(JSON.stringify({
    thread: THREAD_ID,
    user: USER_NAME,
    docs_written: docIds.length,
    doc_ids: docIds,
    per_doc_ms: perDocMs,
    batch_ms: batchMs,
    failures,
    errors,
    status,
  }));
}

run().then(() => process.exit(0)).catch(e => {
  console.error(`[write-path-worker ${THREAD_ID}] Fatal: ${e.message}`);
  process.exit(1);
});
