/**
 * Integration tests for PostgreSQL Changes Detection.
 * Runs against the live PostgreSQL at postgres:5432.
 *
 * Usage: POSTGRES_PASSWORD=pgpass node sentinel/tests/integration/pg-changes.spec.js
 */
const { Client, Pool } = require('pg');
const { PgChangesFeed, NotifyListener } = require('../../src/lib/pg-changes');

const config = {
  host: process.env.POSTGRES_HOST || 'postgres',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  user: process.env.POSTGRES_USER || 'cht',
  password: process.env.POSTGRES_PASSWORD || 'pgpass',
  database: process.env.POSTGRES_DB || 'cht',
};

let pool;
let testDocIds = [];

const log = (msg, ...args) => console.log(`  [test] ${msg}`, ...args);
const pass = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const fail = (name, err) => { console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err}`); process.exitCode = 1; };

const insertTestDoc = async (id, type, deleted = false) => {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO v1.couchdb (_id, saved_timestamp, _deleted, source, doc)
       VALUES ($1, NOW(), $2, 'test', $3::jsonb)
       ON CONFLICT (_id) DO UPDATE SET
         saved_timestamp = NOW(), _deleted = $2, doc = $3::jsonb`,
      [id, deleted, JSON.stringify({ _id: id, type, _rev: '1-test' })]
    );
    testDocIds.push(id);
  } finally {
    client.release();
  }
};

const cleanup = async () => {
  if (testDocIds.length === 0) {
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('DELETE FROM v1.couchdb WHERE _id = ANY($1)', [testDocIds]);
    await client.query('DELETE FROM sentinel.metadata WHERE key LIKE $1', ['test_%']);
    log(`Cleaned up ${testDocIds.length} test docs`);
  } finally {
    client.release();
  }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Test: PgChangesFeed.parseCursor / buildCursor ─────────────────────
const testCursorParsing = () => {
  console.log('\n--- Cursor Parsing ---');

  const { timestamp, id } = PgChangesFeed.parseCursor('0');
  if (timestamp === null && id === '') {
    pass('parseCursor("0") returns null cursor');
  } else {
    fail('parseCursor("0")', `got ${timestamp}, ${id}`);
  }

  const cursor2 = PgChangesFeed.parseCursor('2026-04-07T00:37:31.144Z::some-doc-id');
  if (cursor2.timestamp === '2026-04-07T00:37:31.144Z' && cursor2.id === 'some-doc-id') {
    pass('parseCursor composite cursor');
  } else {
    fail('parseCursor composite', JSON.stringify(cursor2));
  }

  const built = PgChangesFeed.buildCursor('2026-04-07T00:00:00Z', 'doc-123');
  if (built === '2026-04-07T00:00:00Z::doc-123') {
    pass('buildCursor round-trips');
  } else {
    fail('buildCursor', built);
  }
};

// ─── Test: Poll existing data ──────────────────────────────────────────
const testPollExistingData = async () => {
  console.log('\n--- Poll Existing Data ---');

  const feed = new PgChangesFeed({ live: false, since: null, batchSize: 10 });
  const changes = [];

  feed.on('change', (change) => changes.push(change));
  feed.on('error', (err) => fail('poll existing', err.message));

  await feed.start();
  // Non-live feed does one poll on start
  await sleep(500);
  feed.cancel();

  if (changes.length > 0) {
    pass(`Polled ${changes.length} existing changes`);
  } else {
    fail('poll existing', 'no changes returned');
    return;
  }

  // Check change structure
  const first = changes[0];
  if (first.id && first.seq && typeof first.deleted === 'boolean' && first.changes) {
    pass('Change has correct structure: { id, seq, deleted, changes }');
  } else {
    fail('change structure', JSON.stringify(first));
  }

  // Verify design docs are filtered out
  const designDocs = changes.filter(c => c.id.startsWith('_design/'));
  if (designDocs.length === 0) {
    pass('Design docs filtered out');
  } else {
    fail('design doc filter', `${designDocs.length} design docs leaked through`);
  }

  // Verify info docs are filtered out
  const infoDocs = changes.filter(c => c.id.endsWith('-info'));
  if (infoDocs.length === 0) {
    pass('Info docs filtered out');
  } else {
    fail('info doc filter', `${infoDocs.length} info docs leaked through`);
  }
};

// ─── Test: Cursor-based resumption ─────────────────────────────────────
const testCursorResumption = async () => {
  console.log('\n--- Cursor Resumption ---');

  // First pass: get all changes and record last seq
  const feed1 = new PgChangesFeed({ live: false, since: null, batchSize: 5 });
  const changes1 = [];
  feed1.on('change', c => changes1.push(c));
  await feed1.start();
  await sleep(300);
  const lastSeq = feed1.seq;
  feed1.cancel();

  if (!lastSeq || lastSeq === '0') {
    fail('cursor resumption', 'no seq after first poll');
    return;
  }
  pass(`First poll got ${changes1.length} changes, seq: ${lastSeq.substring(0, 40)}...`);

  // Insert a new doc
  const newId = `test:cursor-resume:${Date.now()}`;
  await insertTestDoc(newId, 'data_record');

  // Second pass: resume from lastSeq — should only get the new doc
  const feed2 = new PgChangesFeed({ live: false, since: lastSeq, batchSize: 100 });
  const changes2 = [];
  feed2.on('change', c => changes2.push(c));
  await feed2.start();
  await sleep(300);
  feed2.cancel();

  if (changes2.length >= 1 && changes2.some(c => c.id === newId)) {
    pass(`Resumed feed found new doc (${changes2.length} changes since cursor)`);
  } else {
    fail('cursor resumption', `expected new doc ${newId}, got ${changes2.map(c=>c.id).join(', ')}`);
  }

  // Verify we didn't re-fetch old docs
  const oldDocs = changes2.filter(c => changes1.some(old => old.id === c.id));
  if (oldDocs.length === 0) {
    pass('No duplicate changes from cursor resumption');
  } else {
    fail('no duplicates', `${oldDocs.length} old docs re-fetched`);
  }
};

// ─── Test: LISTEN/NOTIFY real-time detection ───────────────────────────
const testListenNotify = async () => {
  console.log('\n--- LISTEN/NOTIFY Real-time Detection ---');

  const feed = new PgChangesFeed({
    live: true,
    since: PgChangesFeed.buildCursor(new Date().toISOString(), '\uffff'),
    batchSize: 100,
    pollInterval: 60000, // Long poll interval — we want NOTIFY to trigger
  });

  const changes = [];
  feed.on('change', c => changes.push(c));
  await feed.start();

  // Wait for LISTEN to be established
  await sleep(500);

  // Insert a doc — trigger should fire NOTIFY
  const notifyId = `test:notify:${Date.now()}`;
  await insertTestDoc(notifyId, 'data_record');

  // Wait for notification debounce + poll
  await sleep(1000);
  feed.cancel();

  if (changes.some(c => c.id === notifyId)) {
    pass(`LISTEN/NOTIFY detected insert of ${notifyId} in real-time`);
  } else {
    fail('listen/notify', `doc ${notifyId} not detected. Got ${changes.length} changes: ${changes.map(c=>c.id).join(', ')}`);
  }
};

// ─── Test: Deleted document detection ──────────────────────────────────
const testDeletedDetection = async () => {
  console.log('\n--- Deleted Document Detection ---');

  const delId = `test:deleted:${Date.now()}`;
  await insertTestDoc(delId, 'data_record', false);
  await sleep(200);

  // Get cursor after insert
  const feed1 = new PgChangesFeed({ live: false, since: null, batchSize: 1000 });
  const all = [];
  feed1.on('change', c => all.push(c));
  await feed1.start();
  await sleep(300);
  const cursor = feed1.seq;
  feed1.cancel();

  // Mark as deleted
  await insertTestDoc(delId, 'data_record', true);

  // Poll from cursor
  const feed2 = new PgChangesFeed({ live: false, since: cursor, batchSize: 100 });
  const changes = [];
  feed2.on('change', c => changes.push(c));
  await feed2.start();
  await sleep(300);
  feed2.cancel();

  const delChange = changes.find(c => c.id === delId);
  if (delChange && delChange.deleted === true) {
    pass('Deleted document detected with deleted=true');
  } else {
    fail('deleted detection', delChange ? `deleted=${delChange.deleted}` : 'doc not found in changes');
  }
};

// ─── Test: Metadata get/set ────────────────────────────────────────────
const testMetadata = async () => {
  console.log('\n--- Metadata Operations ---');
  const pgChanges = require('../../src/lib/pg-changes');

  // Get non-existent key
  const val1 = await pgChanges.getTransitionSeq();
  if (val1 === '0') {
    pass('getTransitionSeq returns default "0" when no key exists');
  } else {
    fail('metadata default', `expected "0", got "${val1}"`);
  }

  // Set and get
  await pgChanges.setTransitionSeq('test_seq_value_123');
  const val2 = await pgChanges.getTransitionSeq();
  if (val2 === 'test_seq_value_123') {
    pass('setTransitionSeq / getTransitionSeq round-trip');
  } else {
    fail('metadata roundtrip', `expected "test_seq_value_123", got "${val2}"`);
  }

  // Overwrite
  await pgChanges.setTransitionSeq('updated_seq');
  const val3 = await pgChanges.getTransitionSeq();
  if (val3 === 'updated_seq') {
    pass('Metadata overwrite (upsert) works');
  } else {
    fail('metadata overwrite', `expected "updated_seq", got "${val3}"`);
  }

  // Cleanup
  const client = await pool.connect();
  try {
    await client.query("DELETE FROM sentinel.metadata WHERE key = 'transition_seq'");
  } finally {
    client.release();
  }
};

// ─── Test: Pending poll — notifications during active poll are not lost ──
const testPendingPoll = async () => {
  console.log('\n--- Pending Poll (notification during active poll) ---');

  // Start a live feed from "now" with a VERY long scheduled poll interval.
  // This ensures the only way doc B gets detected within 3s is via the
  // _pendingPoll re-poll mechanism, not the scheduled fallback poll.
  const feed = new PgChangesFeed({
    live: true,
    since: PgChangesFeed.buildCursor(new Date().toISOString(), '\uffff'),
    batchSize: 100,
    pollInterval: 120000, // 2 minutes — effectively disabled
  });

  const changes = [];
  feed.on('change', c => changes.push(c));
  await feed.start();
  await sleep(500);

  // Insert doc A — triggers NOTIFY → debounce → poll
  const idA = `test:pending-a:${Date.now()}`;
  await insertTestDoc(idA, 'data_record');

  // Wait just long enough for the debounce to fire and poll to start,
  // then insert doc B while the poll may still be in progress.
  // Even if the poll completes before doc B's insert, the debounce for
  // doc B's NOTIFY will trigger a fresh poll.
  await sleep(150);
  const idB = `test:pending-b:${Date.now()}`;
  await insertTestDoc(idB, 'data_record');

  // Wait for notification + debounce + pending re-poll to complete
  await sleep(2000);
  feed.cancel();

  const foundA = changes.some(c => c.id === idA);
  const foundB = changes.some(c => c.id === idB);

  if (foundA && foundB) {
    pass(`Both docs detected (${changes.length} total changes)`);
  } else {
    fail('pending poll', `foundA=${foundA} foundB=${foundB}, total changes=${changes.length}`);
  }
};

// ─── Test: Rapid-fire inserts all detected via NOTIFY ─────────────────
const testRapidFireNotifications = async () => {
  console.log('\n--- Rapid-Fire Notifications ---');

  const feed = new PgChangesFeed({
    live: true,
    since: PgChangesFeed.buildCursor(new Date().toISOString(), '\uffff'),
    batchSize: 100,
    pollInterval: 120000, // effectively disabled
  });

  const changes = [];
  feed.on('change', c => changes.push(c));
  await feed.start();
  await sleep(500);

  // Insert 5 docs in rapid succession (no sleep between inserts)
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const id = `test:rapid:${i}:${Date.now()}`;
    ids.push(id);
    await insertTestDoc(id, 'data_record');
  }

  // Wait for all notifications to be processed
  await sleep(3000);
  feed.cancel();

  const found = ids.filter(id => changes.some(c => c.id === id));
  if (found.length === 5) {
    pass(`All 5 rapid-fire docs detected`);
  } else {
    fail('rapid-fire', `only ${found.length}/5 detected: missing ${ids.filter(id => !found.includes(id)).join(', ')}`);
  }
};

// ─── Test: Metadata auto-creates sentinel schema and table ────────────
const testMetadataAutoInit = async () => {
  console.log('\n--- Metadata Auto-Initialization ---');
  const pgChanges = require('../../src/lib/pg-changes');

  // Reset the initialization flag to force re-creation
  pgChanges._resetMetadataInit();

  // Verify the table still works after reset (idempotent creation)
  const testKey = `test_auto_init_${Date.now()}`;
  await pgChanges.setTransitionSeq(testKey);
  const val = await pgChanges.getTransitionSeq();
  if (val === testKey) {
    pass('Metadata auto-init is idempotent — works after reset');
  } else {
    fail('metadata auto-init', `expected "${testKey}", got "${val}"`);
  }

  // Clean up
  const client = await pool.connect();
  try {
    await client.query("DELETE FROM sentinel.metadata WHERE key = 'transition_seq'");
  } finally {
    client.release();
  }
};

// ─── Main ──────────────────────────────────────────────────────────────
const run = async () => {
  console.log('PostgreSQL Changes Detection — Integration Tests\n');
  console.log(`Connecting to ${config.host}:${config.port}/${config.database} as ${config.user}`);

  pool = new Pool(config);

  // Verify connection
  try {
    const client = await pool.connect();
    const res = await client.query('SELECT count(*) as c FROM v1.couchdb');
    client.release();
    log(`Connected. ${res.rows[0].c} docs in v1.couchdb\n`);
  } catch (err) {
    console.error('Failed to connect:', err.message);
    process.exit(1);
  }

  try {
    testCursorParsing();
    await testPollExistingData();
    await testCursorResumption();
    await testListenNotify();
    await testDeletedDetection();
    await testMetadata();
    await testPendingPoll();
    await testRapidFireNotifications();
    await testMetadataAutoInit();
  } finally {
    await cleanup();
    await pool.end();
    // Close the metadata pool from pg-changes module
    const pgChanges = require('../../src/lib/pg-changes');
    await pgChanges._metadataPool.end();
  }

  console.log('\n--- Done ---\n');
};

run().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
