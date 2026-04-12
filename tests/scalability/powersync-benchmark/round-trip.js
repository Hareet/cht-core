/**
 * Round-trip latency benchmark.
 *
 * Measures how long it takes for a document written to PostgreSQL
 * to appear in a PowerSync client's local SQLite database.
 *
 * Pipeline: INSERT into PostgreSQL -> WAL -> PowerSync Service -> SDK sync -> local SQLite
 *
 * No CouchDB equivalent exists in the existing scalability suite.
 */
import { performance } from 'perf_hooks';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { PowerSyncDatabase, SyncStreamConnectionMethod, SyncClientImplementation } from '@powersync/node';
import { ChtPowerSyncSchema } from './schema.js';
import { BenchmarkConnector, getUserClaims } from './connector.js';
import { createRequire } from 'module';
import pg from 'pg';

const require = createRequire(import.meta.url);
const config = require('../config.json');

const ITERATIONS = 10;
const TIMEOUT_MS = 60000;

function pgPool() {
  return new pg.Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    user: process.env.POSTGRES_USER || 'cht',
    password: process.env.POSTGRES_PASSWORD || 'pgpass',
    database: process.env.POSTGRES_DB || 'cht',
  });
}

async function createSyncedDb(username, label) {
  const dbDir = path.join(os.tmpdir(), 'powersync-bench');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, `roundtrip-${label}.db`);

  for (const ext of ['', '-wal', '-shm']) {
    const f = dbPath + ext;
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
    }
  }

  const claims = await getUserClaims(username);
  const connector = new BenchmarkConnector(claims);

  const db = new PowerSyncDatabase({
    schema: ChtPowerSyncSchema,
    database: { dbFilename: dbPath },
  });

  await db.get('SELECT powersync_rs_version()');

  await db.connect(connector, {
    connectionMethod: SyncStreamConnectionMethod.WEB_SOCKET,
    clientImplementation: SyncClientImplementation.RUST,
  });
  await db.waitForFirstSync();

  return { db, dbPath };
}

// Write via CHT API PowerSync upload endpoint (fair comparison with CouchDB API path)
// Set DIRECT_PG=1 to bypass API and write directly to PostgreSQL (for measuring API overhead)
const USE_API = !process.env.DIRECT_PG;
const apiUrl = config.url || 'http://localhost:5988';

async function writeDoc(docId, facilityId, contactId, userCredentials) {
  // contact field = user's contact_id (so the "own reports" query matches)
  // patient_id = facilityId (so the "subject" query can match via report_subjects)
  const effectiveContact = contactId || facilityId;

  // contact must be an object with _id — Sync Streams query uses doc -> 'contact' ->> '_id'
  const doc = {
    ...(USE_API ? {} : { _id: docId }),
    type: 'data_record',
    form: 'roundtrip_test',
    patient_id: facilityId,
    reported_date: Date.now(),
    contact: { _id: effectiveContact },
    fields: { test: true, timestamp: Date.now() },
  };

  if (USE_API) {
    // Write through CHT API write handler (apples-to-apples with CouchDB API path)
    const auth = 'Basic ' + Buffer.from(`${userCredentials.name}:${userCredentials.pass}`).toString('base64');
    const res = await fetch(`${apiUrl}/api/v1/powersync/upload`, {
      method: 'POST',
      headers: {
        'Authorization': auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        crud: [{
          op: 'PUT',
          table: 'reports',
          id: docId,
          opData: doc,
        }],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Write handler failed: ${res.status} ${text.substring(0, 200)}`);
    }
    const body = await res.json();
    const result = body.results?.[0];
    if (!result?.ok) {
      throw new Error(`Write handler entry failed: ${result?.error || 'unknown'}`);
    }
    // Return the server-generated _id (cht-datasource creates its own UUID)
    return result.id;
  } else {
    // Direct PostgreSQL write (bypasses API — for measuring API overhead)
    const pool = pgPool();
    try {
      await pool.query(
        `INSERT INTO v1.couchdb (_id, doc, _deleted)
         VALUES ($1, $2::jsonb, false)
         ON CONFLICT (_id) DO UPDATE SET doc = $2::jsonb`,
        [docId, JSON.stringify(doc)]
      );
    } finally {
      await pool.end();
    }
    return docId;
  }
}

async function waitForDoc(db, docId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out waiting for doc ${docId} after ${timeoutMs}ms`));
    }, timeoutMs);

    const interval = setInterval(async () => {
      try {
        const result = await db.getOptional(
          'SELECT id FROM reports WHERE id = ?',
          [docId]
        );
        if (result) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve();
        }
      } catch (e) {
        // Table might not exist yet, ignore
      }
    }, 50);
  });
}

async function cleanupDoc(docId) {
  const pool = pgPool();
  try {
    await pool.query('DELETE FROM v1.couchdb WHERE _id = $1', [docId]);
  } finally {
    await pool.end();
  }
}

export default async function testRoundTrip() {
  const username = config.powersync_users?.[0]?.name || config.users[0].name;
  const userCredentials = config.users.find(u => u.name === username) || config.users[0];

  const pool = pgPool();
  let facilityId, contactId;
  try {
    const result = await pool.query(
      'SELECT facility_id, contact_id FROM v1.user_settings WHERE username = $1',
      [username]
    );
    facilityId = result.rows[0]?.facility_id;
    contactId = result.rows[0]?.contact_id;
    if (!facilityId) {
      throw new Error(`No facility_id for user ${username}`);
    }
  } finally {
    await pool.end();
  }

  console.log(`Setting up synced observer for user: ${username}, contact: ${contactId}`);
  console.log(`  Write path: ${USE_API ? 'CHT API (/api/v1/powersync/upload)' : 'Direct PostgreSQL'}`);
  const syncStart = performance.now();
  const { db: observerDb, dbPath } = await createSyncedDb(username, 'observer');
  console.log(`  Initial sync complete in ${Math.round(performance.now() - syncStart)}ms`);

  const results = [];
  const durations = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const docId = `roundtrip-test-${crypto.randomUUID()}`;

    const start = performance.now();
    const actualId = await writeDoc(docId, facilityId, contactId, userCredentials);
    await waitForDoc(observerDb, actualId, TIMEOUT_MS);
    const duration = Math.round(performance.now() - start);

    durations.push(duration);
    results.push({ scenario: { iteration: i + 1 }, duration });

    await cleanupDoc(actualId);
  }

  await observerDb.disconnectAndClear();
  for (const ext of ['', '-wal', '-shm']) {
    const f = dbPath + ext;
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
    }
  }

  durations.sort((a, b) => a - b);
  results.push({ scenario: { iteration: 'min' }, duration: durations[0] });
  results.push({ scenario: { iteration: 'max' }, duration: durations[durations.length - 1] });
  results.push({ scenario: { iteration: 'mean' }, duration: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) });
  results.push({ scenario: { iteration: 'p95' }, duration: durations[Math.floor(durations.length * 0.95)] });

  return results;
}
