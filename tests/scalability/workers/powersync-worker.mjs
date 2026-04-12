#!/usr/bin/env node
/**
 * PowerSync concurrent worker for incremental sync benchmark.
 *
 * Mirrors the proven logic from powersync-benchmark/round-trip.js:
 *   POST /api/v1/powersync/upload → PG → WAL → PowerSync → local SQLite
 *
 * Accepts configuration via environment variables:
 *   THREAD_ID          - unique thread identifier (default: 0)
 *   USER_NAME          - PowerSync username (default: ac1)
 *   USER_PASS          - User password for API auth (required)
 *   ITERATIONS         - number of round-trips (default: 10)
 *   API_URL            - CHT API URL (default: http://localhost:5988)
 *   POWERSYNC_URL      - PowerSync service URL (default: http://localhost:8080)
 *   POSTGRES_HOST      - PostgreSQL host (default: localhost)
 *   POSTGRES_PORT      - PostgreSQL port (default: 5432)
 *   POSTGRES_USER      - PostgreSQL user (default: cht)
 *   POSTGRES_PASSWORD  - PostgreSQL password (required)
 *   POSTGRES_DB        - PostgreSQL database (default: cht)
 *   TIMEOUT_MS         - max wait per iteration (default: 30000)
 *   DIRECT_PG          - if "1", bypass API and write directly to PG
 *
 * Outputs one JSONL line per iteration to stdout:
 *   {"thread":0,"iteration":1,"duration":75,"found":true,"engine":"powersync","user":"ac1"}
 */
import { performance } from 'perf_hooks';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import pg from 'pg';
import { PowerSyncDatabase, SyncStreamConnectionMethod, SyncClientImplementation } from '@powersync/node';
import { ChtPowerSyncSchema } from '../powersync-benchmark/schema.js';
import { BenchmarkConnector, getUserClaims } from '../powersync-benchmark/connector.js';
const THREAD_ID = parseInt(process.env.THREAD_ID || '0');
const USER_NAME = process.env.USER_NAME || 'ac1';
const USER_PASS = process.env.USER_PASS;
const ITERATIONS = parseInt(process.env.ITERATIONS || '10');
const API_URL = process.env.API_URL || 'http://localhost:5988';
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || '30000');
const DIRECT_PG = process.env.DIRECT_PG === '1';

const auth = 'Basic ' + Buffer.from(`${USER_NAME}:${USER_PASS}`).toString('base64');

function pgPool() {
  return new pg.Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    user: process.env.POSTGRES_USER || 'cht',
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB || 'cht',
  });
}

async function writeDoc(pool, docId, facilityId, contactId) {
  const effectiveContact = contactId || facilityId;
  const doc = {
    type: 'data_record',
    form: 'roundtrip_test',
    patient_id: facilityId,
    reported_date: Date.now(),
    contact: { _id: effectiveContact },
    fields: { test: true, timestamp: Date.now() },
  };

  if (DIRECT_PG) {
    await pool.query(
      `INSERT INTO v1.couchdb (_id, doc, _deleted)
       VALUES ($1, $2::jsonb, false)
       ON CONFLICT (_id) DO UPDATE SET doc = $2::jsonb`,
      [docId, JSON.stringify(doc)]
    );
    return docId;
  }

  // Write through CHT API write handler (apples-to-apples with CouchDB API path)
  const res = await fetch(`${API_URL}/api/v1/powersync/upload`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      crud: [{ op: 'PUT', table: 'reports', id: docId, opData: doc }],
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
  return result.id;
}

async function waitForDoc(db, docId) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      clearInterval(poller);
      reject(new Error(`Timeout after ${TIMEOUT_MS}ms waiting for ${docId}`));
    }, TIMEOUT_MS);

    const poller = setInterval(async () => {
      try {
        const result = await db.getOptional('SELECT id FROM reports WHERE id = ?', [docId]);
        if (result) {
          clearInterval(poller);
          clearTimeout(deadline);
          resolve();
        }
      } catch (e) {
        // Table might not exist yet
      }
    }, 50);
  });
}

async function run() {
  const pool = pgPool();

  // Get user claims for JWT and facility info
  const claims = await getUserClaims(USER_NAME);
  const facilityResult = await pool.query(
    'SELECT facility_id, contact_id FROM v1.user_settings WHERE username = $1',
    [USER_NAME]
  );
  const facilityId = facilityResult.rows[0]?.facility_id;
  const contactId = facilityResult.rows[0]?.contact_id;
  if (!facilityId) {
    throw new Error(`No facility_id for user ${USER_NAME}`);
  }

  // Create synced PowerSync DB (unique per thread)
  const dbDir = path.join(os.tmpdir(), 'powersync-bench');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, `concurrent-${THREAD_ID}.db`);
  for (const ext of ['', '-wal', '-shm']) {
    const f = dbPath + ext;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

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
  const initialSyncStart = performance.now();
  await db.waitForFirstSync();
  const initialSyncDuration = Math.round(performance.now() - initialSyncStart);
  console.log(JSON.stringify({
    thread: THREAD_ID,
    iteration: 0,
    duration: initialSyncDuration,
    found: true,
    engine: 'powersync',
    user: USER_NAME,
    type: 'initial_sync',
  }));

  // Run iterations
  for (let i = 0; i < ITERATIONS; i++) {
    const docId = `roundtrip-${THREAD_ID}-${crypto.randomUUID()}`;
    const start = performance.now();
    let found = true;

    try {
      const actualId = await writeDoc(pool, docId, facilityId, contactId);
      await waitForDoc(db, actualId);
    } catch (e) {
      found = false;
    }

    const duration = Math.round(performance.now() - start);
    console.log(JSON.stringify({
      thread: THREAD_ID,
      iteration: i + 1,
      duration,
      found,
      engine: 'powersync',
      user: USER_NAME,
    }));

    // Cleanup
    try {
      await pool.query('DELETE FROM v1.couchdb WHERE _id = $1', [docId]);
    } catch (e) {
      // Best effort
    }
  }

  // Cleanup
  await db.disconnectAndClear();
  await pool.end();
  for (const ext of ['', '-wal', '-shm']) {
    const f = dbPath + ext;
    if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
  }
}

run().then(() => {
  process.exit(0);
}).catch(e => {
  console.error(`[powersync-worker ${THREAD_ID}] Fatal: ${e.message}`);
  process.exit(1);
});
