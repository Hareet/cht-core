#!/usr/bin/env node
/**
 * get-ids worker: measures a single GET /api/v1/replication/get-ids call.
 *
 * Replicates the CHT team's benchmark methodology from
 * https://github.com/medic/cht-core/issues/10262#issuecomment-3337084204
 *
 * Each call performs a FULL authorization context recomputation:
 *   - Queries contacts_by_depth view for user's facility subtree
 *   - Queries docs_by_replication_key Nouveau index with all subject IDs
 *   - Filters by purge status, sensitivity, depth
 *   - Returns full list of doc IDs + revisions
 *
 * Environment:
 *   THREAD_ID   - unique thread identifier (default: 0)
 *   USER_NAME   - CouchDB username (required)
 *   USER_PASS   - CouchDB password (required)
 *   API_URL     - CHT API URL (default: http://localhost:5988)
 *   TIMEOUT_MS  - max wait (default: 600000 = 10 minutes)
 *
 * Output: one JSONL line to stdout:
 *   {"thread":0,"user":"ac1","duration":77123,"doc_count":20150,"status":"ok"}
 */
const { performance } = require('perf_hooks');

const THREAD_ID = parseInt(process.env.THREAD_ID || '0');
const USER_NAME = process.env.USER_NAME;
const USER_PASS = process.env.USER_PASS;
const API_URL = process.env.API_URL || 'http://localhost:5988';
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '600000');

if (!USER_NAME || !USER_PASS) {
  console.error(`[getids-worker ${THREAD_ID}] USER_NAME and USER_PASS required`);
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${USER_NAME}:${USER_PASS}`).toString('base64');

async function run() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const start = performance.now();
  let status = 'ok';
  let docCount = 0;

  try {
    const res = await fetch(`${API_URL}/api/v1/replication/get-ids`, {
      headers: { Authorization: auth },
      signal: controller.signal,
    });

    if (!res.ok) {
      status = `http_${res.status}`;
    } else {
      const body = await res.json();
      docCount = body.doc_ids_revs ? body.doc_ids_revs.length : 0;
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      status = 'timeout';
    } else {
      status = `error: ${e.message.substring(0, 100)}`;
    }
  } finally {
    clearTimeout(timeout);
  }

  const duration = Math.round(performance.now() - start);

  console.log(JSON.stringify({
    thread: THREAD_ID,
    user: USER_NAME,
    duration,
    doc_count: docCount,
    status,
  }));
}

run().then(() => process.exit(0)).catch(e => {
  console.error(`[getids-worker ${THREAD_ID}] Fatal: ${e.message}`);
  process.exit(1);
});
