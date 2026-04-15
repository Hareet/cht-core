/**
 * CouchDB incremental round-trip benchmark (raw _changes).
 *
 * Measures how long it takes for a document written to CouchDB
 * to appear in the _changes feed.
 *
 * Pipeline: PUT doc -> CouchDB B-tree -> _changes sequence update
 *
 * This measures CouchDB's raw write-to-sequence latency, bypassing
 * the CHT authorization layer. Compare with round-trip-api.js for
 * the realistic user-facing path.
 */
const { performance } = require('perf_hooks');
const crypto = require('crypto');
const request = require('@medic/couch-request');
const utils = require('./utils');

const config = require('../config.json');

const ITERATIONS = 10;
const TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 50;

const adminDb = process.env.COUCH_URL || config.couch_url || 'http://admin:secret21512@localhost:5984/medic';

async function getCurrentSeq() {
  const res = await request.get({
    url: `${adminDb}/_changes`,
    qs: { limit: 0, since: 'now' },
  });
  return res.last_seq;
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

  await request.put({
    url: `${adminDb}/${docId}`,
    body: doc,
  });
}

async function waitForDocInChanges(docId, sinceSeq, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out waiting for doc ${docId} in _changes after ${timeoutMs}ms`));
    }, timeoutMs);

    let currentSeq = sinceSeq;

    const interval = setInterval(async () => {
      try {
        const res = await request.get({
          url: `${adminDb}/_changes`,
          qs: { since: currentSeq, limit: 100 },
        });

        const found = res.results.find(r => r.id === docId);
        if (found) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
          return;
        }

        if (res.last_seq) {
          currentSeq = res.last_seq;
        }
      } catch (e) {
        // Transient error, retry on next poll
      }
    }, POLL_INTERVAL_MS);
  });
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
  const username = config.users[0].name;
  const { facilityId, contactId } = await getUserInfo(username);

  console.log(`CouchDB _changes round-trip: user=${username}, facility=${facilityId}`);

  const results = [];
  const durations = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const docId = `roundtrip-test-${crypto.randomUUID()}`;
    const seq = await getCurrentSeq();

    const start = performance.now();
    await writeDoc(docId, facilityId, contactId);
    await waitForDocInChanges(docId, seq, TIMEOUT_MS);
    const duration = Math.round(performance.now() - start);

    durations.push(duration);
    results.push({ scenario: { iteration: i + 1 }, duration });

    await deleteDoc(docId);
  }

  durations.sort((a, b) => a - b);
  results.push({ scenario: { iteration: 'min' }, duration: durations[0] });
  results.push({ scenario: { iteration: 'max' }, duration: durations[durations.length - 1] });
  results.push({ scenario: { iteration: 'mean' }, duration: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) });
  results.push({ scenario: { iteration: 'p95' }, duration: durations[Math.floor(durations.length * 0.95)] });

  return results;
};
