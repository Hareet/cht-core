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
const TIMEOUT_MS = 30000;

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

async function writeDocToPostgres(docId, facilityId) {
  const pool = pgPool();
  try {
    const doc = {
      _id: docId,
      type: 'data_record',
      form: 'roundtrip_test',
      patient_id: facilityId,
      reported_date: Date.now(),
      contact: { _id: facilityId },
      fields: { test: true, timestamp: Date.now() },
    };

    await pool.query(
      `INSERT INTO v1.couchdb (_id, doc, _deleted)
       VALUES ($1, $2::jsonb, false)
       ON CONFLICT (_id) DO UPDATE SET doc = $2::jsonb`,
      [docId, JSON.stringify(doc)]
    );
  } finally {
    await pool.end();
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

  const pool = pgPool();
  let facilityId;
  try {
    const result = await pool.query(
      'SELECT facility_id FROM v1.user_settings WHERE username = $1',
      [username]
    );
    facilityId = result.rows[0]?.facility_id;
    if (!facilityId) {
      throw new Error(`No facility_id for user ${username}`);
    }
  } finally {
    await pool.end();
  }

  console.log(`Setting up synced observer for user: ${username}`);
  const { db: observerDb, dbPath } = await createSyncedDb(username, 'observer');

  const results = [];
  const durations = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const docId = `roundtrip-test-${crypto.randomUUID()}`;

    const start = performance.now();
    await writeDocToPostgres(docId, facilityId);
    await waitForDoc(observerDb, docId, TIMEOUT_MS);
    const duration = Math.round(performance.now() - start);

    durations.push(duration);
    results.push({ scenario: { iteration: i + 1 }, duration });

    await cleanupDoc(docId);
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
