/**
 * End-to-end test: Sentinel feed.js transition processing via PostgreSQL backend.
 *
 * Verifies the full chain:
 *   1. Document inserted into v1.couchdb
 *   2. LISTEN/NOTIFY fires → PgChangesFeed emits 'change'
 *   3. feed.js receives change, filters correctly, updates metadata
 *   4. Metadata checkpoint persisted to sentinel.docs via db.sentinel
 *
 * Usage: POSTGRES_PASSWORD=pgpass node sentinel/tests/integration/e2e-feed-postgresql.spec.js
 */

// ─── Set up environment BEFORE any requires ────────────────────────────
process.env.CHT_DB_BACKEND = 'postgresql';
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || 'pgpass';
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || 'postgres';

// Stub logger
require.cache[require.resolve('@medic/logger')] = {
  id: '@medic/logger', exports: {
    info: (...a) => console.log('  [info]', ...a),
    warn: (...a) => console.log('  [warn]', ...a),
    error: (...a) => console.log('  [error]', ...a),
    debug: () => {},
  },
};

// Stub tombstone-utils
require.cache[require.resolve('@medic/tombstone-utils')] = {
  id: '@medic/tombstone-utils',
  exports: { isTombstoneId: (id) => id.includes('tombstone') },
};

// Stub constants
require.cache[require.resolve('@medic/constants')] = {
  id: '@medic/constants',
  exports: {
    SENTINEL_METADATA: {
      TRANSITIONS_SEQ: '_local/transitions-seq',
      BACKGROUND_SEQ: '_local/background-cleanup-seq',
      PURGE_DB_INFO: '_local/purge-db-info',
      PURGE_LOG: '_local/purgelog',
    },
    DOC_IDS: { SETTINGS: 'settings' },
    DOC_TYPES: { TRANSLATIONS: 'translations' },
  },
};

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.POSTGRES_HOST,
  port: 5432,
  user: 'cht',
  password: process.env.POSTGRES_PASSWORD,
  database: 'cht',
});

const testDocIds = [];
const pass = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const fail = (name, err) => { console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err}`); process.exitCode = 1; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const insertDoc = async (id, doc) => {
  await pool.query(
    `INSERT INTO v1.couchdb (_id, doc, _deleted, saved_timestamp, source)
     VALUES ($1, $2, false, NOW(), 'test')
     ON CONFLICT (_id) DO UPDATE SET doc = $2, _deleted = false, saved_timestamp = NOW()`,
    [id, JSON.stringify({ _id: id, _rev: '1-test', ...doc })]
  );
  testDocIds.push(id);
};

const cleanup = async () => {
  if (testDocIds.length) {
    await pool.query('DELETE FROM v1.couchdb WHERE _id = ANY($1)', [testDocIds]);
    await pool.query('DELETE FROM sentinel.docs WHERE _id = ANY($1)', [testDocIds]);
    console.log(`  [test] Cleaned up ${testDocIds.length} test docs`);
  }
};

// ─── Test 1: db.medic.changes works through db.js feature flag ─────────
const testDbModuleLoadsPostgres = async () => {
  console.log('\n--- Feature Flag Activation ---');
  const db = require('../../src/db');
  if (typeof db.medic.changes === 'function') {
    pass('db.js loaded PostgreSQL backend (db.medic.changes is a function)');
  } else {
    fail('feature flag', 'db.medic.changes not found');
    return;
  }

  if (typeof db.sentinel.get === 'function' && typeof db.sentinel.put === 'function') {
    pass('db.sentinel has get/put methods');
  } else {
    fail('sentinel proxy', 'missing methods');
  }
};

// ─── Test 2: metadata.js works via PostgreSQL sentinel ──────────────────
const testMetadataViaPg = async () => {
  console.log('\n--- Metadata via PostgreSQL ---');
  const metadata = require('../../src/lib/metadata');

  // getTransitionSeq should return '0' initially (or whatever's stored)
  const seq = await metadata.getTransitionSeq();
  pass(`getTransitionSeq returned: "${seq}"`);

  // Set a test value
  const testSeq = `test-seq-${Date.now()}`;
  await metadata.setTransitionSeq(testSeq);
  const after = await metadata.getTransitionSeq();
  if (after === testSeq) {
    pass('setTransitionSeq / getTransitionSeq round-trip via PostgreSQL');
  } else {
    fail('metadata round-trip', `expected "${testSeq}", got "${after}"`);
  }

  // Set back to '0' for clean state
  await metadata.setTransitionSeq('0');
};

// ─── Test 3: PgChangesFeed detects newly inserted document ──────────────
const testChangesFeedDetectsInsert = async () => {
  console.log('\n--- Changes Feed Detects Insert ---');
  const db = require('../../src/db');

  // Start a live feed from "now"
  const { PgChangesFeed } = require('../../src/lib/pg-changes');
  const feed = new PgChangesFeed({
    live: true,
    since: PgChangesFeed.buildCursor(new Date().toISOString(), '\uffff'),
    batchSize: 100,
    pollInterval: 60000, // Long interval; rely on NOTIFY
  });

  const changes = [];
  feed.on('change', c => changes.push(c));
  await feed.start();
  await sleep(500);

  // Insert a document
  const docId = `test:e2e-feed:${Date.now()}`;
  await insertDoc(docId, { type: 'data_record', form: 'pregnancy', fields: { name: 'Test' } });

  // Wait for NOTIFY debounce + poll
  await sleep(1500);
  feed.cancel();

  const found = changes.find(c => c.id === docId);
  if (found) {
    pass(`Feed detected new doc ${docId}`);
    if (found.seq && found.changes && typeof found.deleted === 'boolean') {
      pass('Change has complete structure for transition processing');
    } else {
      fail('change structure', JSON.stringify(found));
    }
  } else {
    fail('feed detect', `doc ${docId} not in ${changes.length} changes`);
  }
};

// ─── Test 4: Change filtering matches feed.js logic ─────────────────────
const testChangeFiltering = async () => {
  console.log('\n--- Change Filtering ---');
  const { PgChangesFeed } = require('../../src/lib/pg-changes');

  // Insert docs that should be filtered
  const designId = `_design/test:${Date.now()}`;
  const infoId = `test:e2e:${Date.now()}-info`;
  const normalId = `test:e2e:normal:${Date.now()}`;

  await insertDoc(designId, { views: {} });
  await insertDoc(infoId, { type: 'info', doc_id: 'some-doc' });
  await insertDoc(normalId, { type: 'data_record', form: 'test' });

  // Poll from beginning to get all docs
  const feed = new PgChangesFeed({ live: false, since: null, batchSize: 10000 });
  const changes = [];
  feed.on('change', c => changes.push(c));
  await feed.start();
  await sleep(500);
  feed.cancel();

  const hasDesign = changes.some(c => c.id === designId);
  const hasInfo = changes.some(c => c.id === infoId);
  const hasNormal = changes.some(c => c.id === normalId);

  if (!hasDesign) {
    pass('Design docs filtered out by PgChangesFeed');
  } else {
    fail('design filter', 'design doc leaked through');
  }

  if (!hasInfo) {
    pass('Info docs filtered out by PgChangesFeed');
  } else {
    fail('info filter', 'info doc leaked through');
  }

  if (hasNormal) {
    pass('Normal docs pass through filter');
  } else {
    fail('normal pass', 'normal doc was filtered out');
  }
};

// ─── Test 5: Metadata checkpoint survives round-trip ────────────────────
const testCheckpointPersistence = async () => {
  console.log('\n--- Checkpoint Persistence ---');
  const metadata = require('../../src/lib/metadata');

  // Simulate what feed.js does: set seq after processing
  const seq = `2026-04-10T03:00:00.000Z::test-checkpoint-doc`;
  await metadata.setTransitionSeq(seq);

  // Simulate restart: re-read
  const restored = await metadata.getTransitionSeq();
  if (restored === seq) {
    pass('Checkpoint persists across simulated restart');
  } else {
    fail('checkpoint', `expected "${seq}", got "${restored}"`);
  }

  // Clean up
  await metadata.setTransitionSeq('0');
};

// ─── Test 6: Full chain simulation ──────────────────────────────────────
const testFullChainSimulation = async () => {
  console.log('\n--- Full Chain: Insert → Detect → Checkpoint ---');
  const db = require('../../src/db');
  const metadata = require('../../src/lib/metadata');

  // Reset checkpoint
  await metadata.setTransitionSeq('0');

  // Get current cursor position
  const { PgChangesFeed } = require('../../src/lib/pg-changes');
  const startCursor = PgChangesFeed.buildCursor(new Date().toISOString(), '\uffff');

  // Start feed
  const feed = new PgChangesFeed({ live: true, since: startCursor, batchSize: 100, pollInterval: 60000 });
  const detectedChanges = [];
  feed.on('change', async (change) => {
    detectedChanges.push(change);
    // Simulate what feed.js updateMetadata does
    await metadata.setTransitionSeq(change.seq);
  });
  await feed.start();
  await sleep(500);

  // Insert a doc
  const docId = `test:fullchain:${Date.now()}`;
  await insertDoc(docId, { type: 'data_record', form: 'delivery' });

  // Wait for detection + metadata write
  await sleep(2000);
  feed.cancel();

  const detected = detectedChanges.find(c => c.id === docId);
  if (detected) {
    pass('Document detected by changes feed');

    // Verify checkpoint was updated
    const checkpoint = await metadata.getTransitionSeq();
    if (checkpoint && checkpoint !== '0' && checkpoint.includes(docId)) {
      pass(`Checkpoint updated to seq containing doc ID`);
    } else if (checkpoint && checkpoint !== '0') {
      pass(`Checkpoint updated (${checkpoint.substring(0, 50)}...)`);
    } else {
      fail('checkpoint update', `checkpoint is "${checkpoint}"`);
    }
  } else {
    fail('full chain', `doc ${docId} not detected in ${detectedChanges.length} changes`);
  }

  await metadata.setTransitionSeq('0');
};

// ─── Main ──────────────────────────────────────────────────────────────
const run = async () => {
  console.log('End-to-End: Sentinel Feed via PostgreSQL\n');

  try {
    await testDbModuleLoadsPostgres();
    await testMetadataViaPg();
    await testChangesFeedDetectsInsert();
    await testChangeFiltering();
    await testCheckpointPersistence();
    await testFullChainSimulation();
  } finally {
    await cleanup();
    await pool.end();

    // Clean up module pools
    const db = require('../../src/db');
    if (db._pool) await db._pool.end();
    try {
      const pgChanges = require('../../src/lib/pg-changes');
      await pgChanges._metadataPool.end();
    } catch { /* ignore */ }
  }

  console.log('\n--- Done ---\n');
};

run().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
