#!/usr/bin/env node
/**
 * CouchDB concurrent worker for incremental sync benchmark.
 *
 * Mirrors the proven logic from couchdb-benchmark/round-trip-api.js:
 *   PUT doc → CouchDB → poll GET /api/v1/replication/get-ids → found
 *
 * Accepts configuration via environment variables:
 *   THREAD_ID     - unique thread identifier (default: 0)
 *   USER_NAME     - CouchDB username (required)
 *   USER_PASS     - CouchDB password (required)
 *   ITERATIONS    - number of round-trips (default: 10)
 *   API_URL       - CHT API URL (default: http://localhost:5988)
 *   COUCH_URL     - CouchDB admin URL (required, e.g. http://admin:pass@localhost:5988/medic)
 *   POLL_INTERVAL - ms between get-ids polls (default: 500)
 *   TIMEOUT_MS    - max wait per iteration (default: 30000)
 *
 * Outputs one JSONL line per iteration to stdout:
 *   {"thread":0,"iteration":1,"duration":643,"found":true,"engine":"couchdb","user":"ac1"}
 */
const { performance } = require('perf_hooks');
const crypto = require('crypto');
const request = require('@medic/couch-request');

const THREAD_ID = parseInt(process.env.THREAD_ID || '0');
const USER_NAME = process.env.USER_NAME;
const USER_PASS = process.env.USER_PASS;
const ITERATIONS = parseInt(process.env.ITERATIONS || '10');
const API_URL = process.env.API_URL || 'http://localhost:5988';
const COUCH_URL = process.env.COUCH_URL;

if (!USER_NAME || !USER_PASS || !COUCH_URL) {
  console.error(`[couch-worker] Required env vars: USER_NAME, USER_PASS, COUCH_URL`);
  process.exit(1);
}
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '500');
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '30000');

const auth = 'Basic ' + Buffer.from(`${USER_NAME}:${USER_PASS}`).toString('base64');

async function getUserInfo() {
  // User settings docs are in the medic database with id org.couchdb.user:<username>
  const userDoc = await request.get({
    url: `${COUCH_URL}/org.couchdb.user:${USER_NAME}`,
  });
  const facilityId = Array.isArray(userDoc.facility_id) ? userDoc.facility_id[0] : userDoc.facility_id;
  const contactId = userDoc.contact_id;
  return { facilityId, contactId };
}

async function writeDoc(docId, facilityId, contactId) {
  const doc = {
    _id: docId,
    type: 'data_record',
    form: 'roundtrip_test',
    patient_id: facilityId,
    reported_date: Date.now(),
    contact: { _id: contactId },
    fields: { test: true, timestamp: Date.now() },
  };
  await request.put({ url: `${COUCH_URL}/${docId}`, body: doc });
}

async function pollGetIds(docId) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      clearInterval(poller);
      reject(new Error(`Timeout after ${TIMEOUT_MS}ms waiting for ${docId}`));
    }, TIMEOUT_MS);

    const poller = setInterval(async () => {
      try {
        const res = await request.get({
          url: `${API_URL}/api/v1/replication/get-ids`,
          headers: { Authorization: auth },
        });
        if (res.doc_ids_revs && res.doc_ids_revs.find(r => r.id === docId)) {
          clearInterval(poller);
          clearTimeout(deadline);
          resolve();
        }
      } catch (e) {
        // Transient error, retry
      }
    }, POLL_INTERVAL);
  });
}

async function deleteDoc(docId) {
  // Timeout cleanup to avoid hanging when CouchDB is overloaded
  const cleanup = async () => {
    const doc = await request.get({ url: `${COUCH_URL}/${docId}` });
    await request.delete({ url: `${COUCH_URL}/${docId}`, qs: { rev: doc._rev } });
  };
  try {
    await Promise.race([
      cleanup(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('cleanup timeout')), 5000)),
    ]);
  } catch (e) {
    // May already be deleted or CouchDB too loaded — skip
  }
}

async function run() {
  const { facilityId, contactId } = await getUserInfo();

  for (let i = 0; i < ITERATIONS; i++) {
    const docId = `roundtrip-${THREAD_ID}-${crypto.randomUUID()}`;
    const start = performance.now();
    let found = true;

    try {
      await writeDoc(docId, facilityId, contactId);
      await pollGetIds(docId);
    } catch (e) {
      found = false;
    }

    const duration = Math.round(performance.now() - start);
    console.log(JSON.stringify({
      thread: THREAD_ID,
      iteration: i + 1,
      duration,
      found,
      engine: 'couchdb',
      user: USER_NAME,
    }));

    await deleteDoc(docId);
  }
}

run().then(() => {
  process.exit(0);
}).catch(e => {
  console.error(`[couch-worker ${THREAD_ID}] Fatal: ${e.message}`);
  process.exit(1);
});
