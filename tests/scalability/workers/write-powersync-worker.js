#!/usr/bin/env node
/**
 * write-powersync worker: measures one PowerSync upload batch by one
 * authenticated offline user. Mirrors what the PowerSync SDK's uploadData()
 * callback does from the browser when a CHW has queued form submissions.
 *
 * Sibling to write-path-worker.js — same JSONL-to-stdout contract. Used by
 * the PG+PowerSync scenario of the scalability harness.
 *
 * Why one bulk POST vs N sequential POSTs:
 *   In production, the PowerSync SDK's MAX_BATCH_SIZE=100 groups queued
 *   entries into a single uploadData() call. So a CHW with 10 queued forms
 *   triggers one POST with 10 CrudEntries, not 10 POSTs. We keep that shape
 *   here so the PG-backend numbers reflect the real upload pattern. This
 *   makes per-doc latency less meaningful — compare at the batch level.
 *
 * Server path: POST /api/v1/powersync/upload → processCrudEntry loop →
 *   transformCrudEntry (contact_id → contact UUID) → ctx.bind(Report.v1.create)
 *   → cht-datasource adapter (PG if CHT_DB_BACKEND=postgres, else CouchDB)
 *   → doc lands in target backend with client-minted _id preserved via idHint.
 *
 * Environment:
 *   THREAD_ID   - unique thread identifier (default: 0)
 *   USER_NAME   - CHT username (required, must be offline role with
 *                 `can_create_records` or `can_edit` AND powersync feature
 *                 flag enabled)
 *   USER_PASS   - CHT password (required)
 *   CONTACT_ID  - user's contact UUID (required, used as reports.contact_id)
 *   API_URL     - CHT API URL (default: http://localhost:5988)
 *   BURST_SIZE  - docs per POST (default: 10, max 100 — api enforces)
 *   FORM_ID     - form id (default: anc_followup — MUST be registered in
 *                 app_settings; Report.v1.create validates via getForms()
 *                 and rejects unknown forms with InvalidArgumentError.
 *                 Note: this is why the CouchDB _bulk_docs worker can use
 *                 a synthetic 'benchmark_scale_write' form — that path
 *                 bypasses cht-datasource validation — but the PowerSync
 *                 upload path cannot.)
 *   TIMEOUT_MS  - wall-clock cap per POST (default: 60000)
 *
 * Output: one JSONL line:
 *   {"thread":0,"user":"ac1","docs_written":10,"doc_ids":[...],
 *    "batch_ms":2840,"per_doc_ms":[284,...],  // approximated as batch/N
 *    "failures":0,"errors":[],"status":"ok"}
 */
const { performance } = require('perf_hooks');
const crypto = require('crypto');

const THREAD_ID   = parseInt(process.env.THREAD_ID || '0');
const USER_NAME   = process.env.USER_NAME;
const USER_PASS   = process.env.USER_PASS;
const CONTACT_ID  = process.env.CONTACT_ID;
const API_URL     = process.env.API_URL || 'http://localhost:5988';
const BURST_SIZE  = parseInt(process.env.BURST_SIZE || '10');
const FORM_ID     = process.env.FORM_ID || 'anc_followup';
const TIMEOUT_MS  = parseInt(process.env.TIMEOUT_MS || '60000');

if (!USER_NAME || !USER_PASS || !CONTACT_ID) {
  console.error(`[write-powersync-worker ${THREAD_ID}] USER_NAME, USER_PASS, CONTACT_ID required`);
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${USER_NAME}:${USER_PASS}`).toString('base64');

function makeCrudEntry(threadId, batchTs, i) {
  const id = `bench-scalps-${threadId}-${batchTs}-${i}-${crypto.randomBytes(3).toString('hex')}`;
  return {
    op: 'PUT',
    table: 'reports',
    id,
    opData: {
      form: FORM_ID,
      // The PowerSync schema stores reported_date as ISO string (see
      // webapp/src/ts/services/powersync/powersync-schema.ts); the api's
      // transformCrudEntry passes opData through to Report.v1.create which
      // tolerates either shape, but ISO is the canonical choice.
      reported_date: new Date().toISOString(),
      contact_id: CONTACT_ID,
      // cht-sync's schema types fields as text (JSONB serialized). The
      // real SDK stringifies in webapp code; mirror that here.
      fields: JSON.stringify({ test: true, burst_index: i, thread: threadId }),
    },
  };
}

async function postBatch(entries) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_URL}/api/v1/powersync/upload`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ crud: entries }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `http_${res.status}`, detail: text.substring(0, 200) };
    }
    const body = await res.json();
    return { ok: true, results: body.results || [] };
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, error: 'timeout' };
    return { ok: false, error: `fetch: ${e.message.substring(0, 100)}` };
  } finally {
    clearTimeout(timeout);
  }
}

async function run() {
  const batchTs = Date.now();
  const entries = [];
  for (let i = 0; i < BURST_SIZE; i++) entries.push(makeCrudEntry(THREAD_ID, batchTs, i));
  const expectedIds = entries.map(e => e.id);

  const t0 = performance.now();
  const outcome = await postBatch(entries);
  const batchMs = Math.round(performance.now() - t0);

  let docIds = [];
  let failures = 0;
  const errors = [];

  if (!outcome.ok) {
    failures = BURST_SIZE;
    errors.push(outcome.error + (outcome.detail ? `: ${outcome.detail}` : ''));
  } else {
    for (const r of outcome.results) {
      if (r.ok) {
        docIds.push(r.id);
      } else {
        failures++;
        if (errors.length < 3 && r.error) errors.push(r.error);
      }
    }
    // If the api returned fewer results than expected entries, count the gap
    // as failures so partial responses don't silently inflate success counts.
    if (outcome.results.length < BURST_SIZE) {
      failures += (BURST_SIZE - outcome.results.length);
    }
  }

  const perDocApprox = Math.round(batchMs / BURST_SIZE);
  const perDocMs = Array(BURST_SIZE).fill(perDocApprox);
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
    expected_ids: expectedIds.length,  // orchestrator can compare against this
  }));
}

run().then(() => process.exit(0)).catch(e => {
  console.error(`[write-powersync-worker ${THREAD_ID}] Fatal: ${e.message}`);
  process.exit(1);
});
