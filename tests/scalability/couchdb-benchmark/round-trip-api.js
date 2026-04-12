/**
 * CouchDB incremental round-trip benchmark (CHT API path).
 *
 * Measures the REALISTIC user-facing sync path:
 *   PUT doc -> CouchDB -> GET /api/v1/replication/get-ids -> _bulk_get
 *
 * The get-ids endpoint performs a FULL authorization context re-computation
 * on every call: queries contacts_by_depth view, docs_by_replication_key
 * Nouveau index, filters, purge check. This is what every CHT client does
 * on every sync cycle (~every 5 minutes).
 *
 * Under concurrent load, this is where CouchDB should degrade — each call
 * re-computes the full authorization context from scratch.
 */
const { performance } = require('perf_hooks');
const crypto = require('crypto');
const request = require('@medic/couch-request');

const config = require('../config.json');

const ITERATIONS = 10;
const TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 500;  // get-ids takes ~300ms per call, don't stack requests

const adminDb = process.env.COUCH_URL || `http://admin:secret21512@localhost:5988/medic`;
const apiUrl = config.url || 'http://localhost:5988';

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

  await request.put({
    url: `${adminDb}/${docId}`,
    body: doc,
  });
}

async function waitForDocInGetIds(docId, username, password, timeoutMs) {
  const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out waiting for doc ${docId} in get-ids after ${timeoutMs}ms`));
    }, timeoutMs);

    const interval = setInterval(async () => {
      try {
        const res = await request.get({
          url: `${apiUrl}/api/v1/replication/get-ids`,
          headers: { 'Authorization': auth },
        });

        const found = res.doc_ids_revs && res.doc_ids_revs.find(r => r.id === docId);
        if (found) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
          return;
        }
      } catch (e) {
        // Transient error, retry on next poll
      }
    }, POLL_INTERVAL_MS);
  });
}

async function fetchDocViaBulkGet(docId, username, password) {
  const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const start = performance.now();

  await request.post({
    url: `${apiUrl}/medic/_bulk_get`,
    headers: { 'Authorization': auth },
    body: { docs: [{ id: docId }] },
  });

  return Math.round(performance.now() - start);
}

async function deleteDoc(docId) {
  try {
    const doc = await request.get({ url: `${adminDb}/${docId}` });
    await request.delete({ url: `${adminDb}/${docId}`, qs: { rev: doc._rev } });
  } catch (e) {
    // Doc may already be deleted
  }
}

async function getUserInfo(username) {
  const userDoc = await request.get({ url: `${adminDb}/org.couchdb.user:${username}` });
  const facilityId = Array.isArray(userDoc.facility_id) ? userDoc.facility_id[0] : userDoc.facility_id;
  const contactId = userDoc.contact_id;
  return { facilityId, contactId };
}

module.exports = async () => {
  const user = config.users[0];
  const { facilityId, contactId } = await getUserInfo(user.name);

  console.log(`CouchDB API round-trip: user=${user.name}, facility=${facilityId}`);
  console.log(`  This calls GET /api/v1/replication/get-ids (full auth context re-computation)`);

  const results = [];
  const durations = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const docId = `roundtrip-test-${crypto.randomUUID()}`;

    const start = performance.now();

    // Write doc to CouchDB
    await writeDoc(docId, facilityId, contactId);

    // Wait for get-ids to include our doc (the expensive part)
    await waitForDocInGetIds(docId, user.name, user.pass, TIMEOUT_MS);

    // Fetch via _bulk_get (the final step in real sync)
    const bulkGetMs = await fetchDocViaBulkGet(docId, user.name, user.pass);

    const totalDuration = Math.round(performance.now() - start);

    durations.push(totalDuration);
    results.push({
      scenario: { iteration: i + 1, bulk_get_ms: bulkGetMs },
      duration: totalDuration,
    });

    await deleteDoc(docId);
  }

  durations.sort((a, b) => a - b);
  results.push({ scenario: { iteration: 'min' }, duration: durations[0] });
  results.push({ scenario: { iteration: 'max' }, duration: durations[durations.length - 1] });
  results.push({ scenario: { iteration: 'mean' }, duration: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) });
  results.push({ scenario: { iteration: 'p95' }, duration: durations[Math.floor(durations.length * 0.95)] });

  return results;
};
