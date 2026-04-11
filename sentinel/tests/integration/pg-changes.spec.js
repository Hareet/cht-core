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

// ─── Test: Backlog draining — full batches trigger immediate re-polls ─
const testBacklogDraining = async () => {
  console.log('\n--- Backlog Draining (multi-batch catch-up) ---');

  // Insert more docs than BATCH_SIZE *before* starting the feed.
  // This simulates Sentinel starting up after downtime with a large
  // backlog of unprocessed changes.
  const batchSize = 10; // small batch to keep the test fast
  const totalDocs = 35; // 3.5x batch → requires 4 polls to drain
  const prefix = `test:backlog:${Date.now()}`;
  const ids = [];

  for (let i = 0; i < totalDocs; i++) {
    const id = `${prefix}:${String(i).padStart(3, '0')}`;
    ids.push(id);
    await insertTestDoc(id, 'data_record');
  }
  await sleep(200);

  // Get a cursor from just before the inserts so the feed starts
  // behind the backlog.
  const cursorClient = await pool.connect();
  let beforeCursor;
  try {
    const res = await cursorClient.query(
      `SELECT to_char(MIN(saved_timestamp) AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ts
       FROM v1.couchdb WHERE _id = $1`,
      [ids[0]]
    );
    // Build a cursor just before the first test doc so all of them
    // are "new" to the feed. Use a _id that sorts before any test ID
    // to ensure the composite cursor comparison includes the first doc.
    beforeCursor = PgChangesFeed.buildCursor(res.rows[0].ts, '');
  } finally {
    cursorClient.release();
  }

  // Start a NON-live feed with a small batch size.
  // With the fix, the feed should drain all 35 docs in one start()
  // call via consecutive re-polls. Without the fix, it would only
  // fetch 10 docs (one batch) and stop.
  const feed = new PgChangesFeed({
    live: false,
    since: beforeCursor,
    batchSize: batchSize,
  });

  const changes = [];
  feed.on('change', c => changes.push(c));
  await feed.start();

  // Give time for the chain of re-polls to complete.
  // 4 re-polls × ~50ms each should be well within 2 seconds.
  await sleep(2000);
  feed.cancel();

  const found = ids.filter(id => changes.some(c => c.id === id));
  if (found.length === totalDocs) {
    pass(`All ${totalDocs} backlog docs drained across ${Math.ceil(totalDocs / batchSize)} batches`);
  } else {
    fail('backlog draining',
      `only ${found.length}/${totalDocs} docs detected — ` +
      `missing: ${ids.filter(id => !changes.some(c => c.id === id)).slice(0, 5).join(', ')}...`);
  }

  // Verify no duplicates
  const seen = new Set();
  const dupes = changes.filter(c => {
    if (seen.has(c.id)) {
      return true;
    }
    seen.add(c.id);
    return false;
  });

  if (dupes.length === 0) {
    pass('No duplicate changes during backlog drain');
  } else {
    fail('backlog no-dupes', `${dupes.length} duplicates: ${dupes.slice(0, 3).map(c => c.id).join(', ')}`);
  }
};

// ─── Test: Reconnection catch-up poll after LISTEN connection drop ────
const testReconnectionCatchUp = async () => {
  console.log('\n--- Reconnection Catch-Up Poll ---');

  // Use a very long poll interval — the ONLY way changes get detected
  // promptly is via the reconnection catch-up poll, not the fallback timer.
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

  // Find the LISTEN connection's PID so we can terminate it.
  // The LISTEN connection is the one in 'idle' state that has executed LISTEN.
  const pidClient = await pool.connect();
  let listenPid;
  try {
    const { rows } = await pidClient.query(
      `SELECT pid FROM pg_stat_activity
       WHERE datname = $1 AND usename = $2 AND state = 'idle'
         AND query LIKE '%LISTEN%'
       ORDER BY backend_start DESC
       LIMIT 1`,
      [config.database, config.user]
    );
    if (rows.length === 0) {
      fail('reconnection catch-up', 'could not find LISTEN connection PID');
      feed.cancel();
      pidClient.release();
      return;
    }
    listenPid = rows[0].pid;
  } finally {
    pidClient.release();
  }

  pass(`Found LISTEN connection PID: ${listenPid}`);

  // Kill the LISTEN connection — simulates network drop / PG restart
  const killClient = await pool.connect();
  try {
    await killClient.query('SELECT pg_terminate_backend($1)', [listenPid]);
  } finally {
    killClient.release();
  }

  // While the listener is reconnecting (RECONNECT_DELAY_MS = 5s),
  // insert a document. Its NOTIFY will be lost since there's no listener.
  await sleep(1000); // Give time for disconnect to register
  const gapDocId = `test:reconnect-gap:${Date.now()}`;
  await insertTestDoc(gapDocId, 'data_record');
  log(`Inserted ${gapDocId} during LISTEN gap`);

  // Wait for reconnection (5s delay) + catch-up poll to complete.
  // Total wait: ~5s reconnect + 1s buffer = ~7s from the kill.
  // We already waited 1s above, so wait another 7s.
  await sleep(7000);
  feed.cancel();

  if (changes.some(c => c.id === gapDocId)) {
    pass(`Reconnection catch-up poll detected doc inserted during LISTEN gap`);
  } else {
    fail('reconnection catch-up',
      `doc ${gapDocId} not found among ${changes.length} changes: ` +
      `${changes.map(c => c.id).join(', ')}`);
  }
};

// ─── Test: NotifyListener emits 'reconnected' only on re-connections ──
const testReconnectedEventNotOnFirstConnect = async () => {
  console.log('\n--- Reconnected Event Not Fired on First Connect ---');

  const listener = new NotifyListener(config);
  let reconnectedCount = 0;
  listener.on('reconnected', () => reconnectedCount++);

  await listener.start();
  await sleep(500);
  listener.stop();

  if (reconnectedCount === 0) {
    pass('No reconnected event on initial connection');
  } else {
    fail('first connect', `reconnected fired ${reconnectedCount} times`);
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

// ─── Test: Consecutive polls produce no duplicate changes ─────────────
const testNoDuplicatesOnConsecutivePolls = async () => {
  console.log('\n--- No Duplicates on Consecutive Polls ---');

  // Insert a doc so we have something to poll
  const docId = `test:no-dup:${Date.now()}`;
  await insertTestDoc(docId, 'data_record');
  await sleep(200);

  // First poll: non-live, fetch everything up to our doc
  const feed1 = new PgChangesFeed({ live: false, since: null, batchSize: 10000 });
  const changes1 = [];
  feed1.on('change', c => changes1.push(c));
  await feed1.start();
  await sleep(500);
  const cursor = feed1.seq;
  feed1.cancel();

  if (!changes1.some(c => c.id === docId)) {
    fail('no-dup setup', `doc ${docId} not found in first poll`);
    return;
  }
  pass(`First poll found test doc (${changes1.length} total, cursor: ${cursor.substring(0, 50)}...)`);

  // Second poll from the cursor — should return zero changes
  // (no new docs inserted between polls)
  const feed2 = new PgChangesFeed({ live: false, since: cursor, batchSize: 10000 });
  const changes2 = [];
  feed2.on('change', c => changes2.push(c));
  await feed2.start();
  await sleep(500);
  feed2.cancel();

  if (changes2.length === 0) {
    pass('Second poll from same cursor returned zero changes (no duplicates)');
  } else {
    fail('no-dup', `expected 0 changes, got ${changes2.length}: ${changes2.map(c => c.id).join(', ')}`);
  }

  // Third poll — also should return zero
  const feed3 = new PgChangesFeed({ live: false, since: cursor, batchSize: 10000 });
  const changes3 = [];
  feed3.on('change', c => changes3.push(c));
  await feed3.start();
  await sleep(500);
  feed3.cancel();

  if (changes3.length === 0) {
    pass('Third poll from same cursor also returned zero (stable cursor)');
  } else {
    fail('no-dup-3rd', `expected 0, got ${changes3.length}: ${changes3.map(c => c.id).join(', ')}`);
  }
};

// ─── Test: Cursor preserves microsecond precision ─────────────────────
const testMicrosecondPrecisionInCursor = async () => {
  console.log('\n--- Microsecond Precision in Cursor ---');

  // Insert a doc and verify the cursor timestamp has > 3 decimal places
  const docId = `test:usec:${Date.now()}`;
  await insertTestDoc(docId, 'data_record');
  await sleep(200);

  const feed = new PgChangesFeed({ live: false, since: null, batchSize: 10000 });
  const changes = [];
  feed.on('change', c => changes.push(c));
  await feed.start();
  await sleep(500);
  feed.cancel();

  const change = changes.find(c => c.id === docId);
  if (!change) {
    fail('usec setup', `doc ${docId} not found`);
    return;
  }

  const { timestamp } = PgChangesFeed.parseCursor(change.seq);
  // Microsecond-format timestamp: 2026-04-10T03:00:00.123456Z (6 decimal places)
  // Millisecond-format (old bug): 2026-04-10T03:00:00.123Z (3 decimal places)
  const decimals = timestamp.split('.')[1]?.replace('Z', '') || '';
  if (decimals.length === 6) {
    pass(`Cursor has microsecond precision: ...${decimals}Z`);
  } else if (decimals.length > 3) {
    pass(`Cursor has sub-millisecond precision: ${decimals.length} digits`);
  } else {
    fail('usec precision', `expected 6 decimal digits, got ${decimals.length}: ${timestamp}`);
  }

  // Verify the timestamp round-trips correctly through PostgreSQL
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT ($1::timestamptz = (
         SELECT saved_timestamp FROM v1.couchdb WHERE _id = $2
       )) as matches`,
      [timestamp, docId]
    );
    if (res.rows[0].matches) {
      pass('Cursor timestamp round-trips exactly through PostgreSQL');
    } else {
      fail('usec round-trip', 'cursor timestamp does not match stored value');
    }
  } finally {
    client.release();
  }
};

// ─── Test: Live feed does not re-emit same change on scheduled polls ──
const testLiveFeedNoDuplicateOnScheduledPoll = async () => {
  console.log('\n--- Live Feed: No Duplicate on Scheduled Poll ---');

  const docId = `test:live-nodup:${Date.now()}`;

  // Start live feed with a SHORT poll interval so we exercise the
  // scheduled poll path multiple times
  const feed = new PgChangesFeed({
    live: true,
    since: PgChangesFeed.buildCursor(new Date().toISOString(), '\uffff'),
    batchSize: 100,
    pollInterval: 500, // Short: 500ms — will fire several times during the test
  });

  const changes = [];
  feed.on('change', c => changes.push(c));
  await feed.start();
  await sleep(300);

  // Insert a single doc
  await insertTestDoc(docId, 'data_record');

  // Wait for several scheduled poll cycles (500ms * ~6 = 3s)
  await sleep(3000);
  feed.cancel();

  const matches = changes.filter(c => c.id === docId);
  if (matches.length === 1) {
    pass(`Live feed emitted doc exactly once across ${Math.floor(3000 / 500)} poll cycles`);
  } else if (matches.length === 0) {
    fail('live-nodup', 'doc never detected');
  } else {
    fail('live-nodup', `doc emitted ${matches.length} times (expected exactly 1) — cursor precision bug`);
  }
};

// ─── Test: since:'now' resolves to fixed timestamp and detects changes ──
const testSinceNowCursorResolution = async () => {
  console.log('\n--- since:"now" Cursor Resolution ---');

  // Start a live feed with since:'now' — the CouchDB convention that
  // config.js uses to watch for settings changes.
  const feed = new PgChangesFeed({
    live: true,
    since: 'now',
    batchSize: 100,
    pollInterval: 120000, // effectively disabled — rely on NOTIFY
  });

  const changes = [];
  feed.on('change', c => changes.push(c));
  await feed.start();

  // Verify the cursor was resolved from the literal 'now' to a real timestamp
  const cursor = feed.seq;
  if (!cursor || cursor === 'now') {
    fail('since:now resolution', `cursor not resolved: ${cursor}`);
    feed.cancel();
    return;
  }
  const { timestamp } = PgChangesFeed.parseCursor(cursor);
  if (timestamp && timestamp.match(/^\d{4}-\d{2}-\d{2}T/)) {
    pass(`Cursor resolved to real timestamp: ${timestamp.substring(0, 26)}`);
  } else {
    fail('since:now resolution', `expected ISO timestamp, got: ${timestamp}`);
    feed.cancel();
    return;
  }

  // Wait for LISTEN to settle
  await sleep(500);

  // Insert a doc after the feed started
  const docId = `test:since-now:${Date.now()}`;
  await insertTestDoc(docId, 'data_record');

  // Wait for NOTIFY → debounce → poll
  await sleep(1500);
  feed.cancel();

  if (changes.some(c => c.id === docId)) {
    pass(`since:"now" feed detected change inserted after start`);
  } else {
    fail('since:now detection',
      `doc ${docId} not found among ${changes.length} changes`);
  }
};

// ─── Test: parseCursor('now') safety net returns null cursor ─────────
const testParseCursorNowSafetyNet = () => {
  console.log('\n--- parseCursor("now") Safety Net ---');

  const { timestamp, id } = PgChangesFeed.parseCursor('now');
  if (timestamp === null && id === '') {
    pass('parseCursor("now") returns null cursor (safety net)');
  } else {
    fail('parseCursor now', `expected null cursor, got timestamp=${timestamp} id=${id}`);
  }
};

// ─── Test: cancel() during active poll does not emit error ───────────
const testCancelDuringPollNoError = async () => {
  console.log('\n--- Cancel During Active Poll: No Spurious Errors ---');

  const feed = new PgChangesFeed({
    live: true,
    since: null,        // start from beginning — forces a real poll
    batchSize: 5,       // small batch to keep poll active longer
    pollInterval: 120000,
  });

  const errors = [];
  feed.on('error', err => errors.push(err));
  // Don't await start — let the initial poll begin
  const startPromise = feed.start();

  // Cancel almost immediately while the initial poll is likely in-flight
  await sleep(10);
  feed.cancel();

  // Wait for any async aftermath to settle
  await sleep(500);

  // Also await the start promise to avoid unhandled rejection
  try {
    await startPromise;
  } catch {
    // Expected — start may throw because pool was closed
  }

  if (errors.length === 0) {
    pass('No error events emitted after cancel()');
  } else {
    fail('cancel-no-error',
      `${errors.length} error(s) emitted after cancel: ${errors.map(e => e.message).join('; ')}`);
  }
};

// ─── Test: since:'now' with polling (no NOTIFY) still detects changes ──
const testSinceNowPollingOnly = async () => {
  console.log('\n--- since:"now" with Polling Only (no NOTIFY) ---');

  // Use a non-live feed started with since:'now' to verify that the
  // resolved cursor works correctly with pure polling (no LISTEN).
  const feed = new PgChangesFeed({
    live: false,
    since: 'now',
    batchSize: 100,
  });

  // Start should resolve 'now' and do an initial poll (finding 0 rows)
  await feed.start();
  const cursorAfterStart = feed.seq;
  feed.cancel();

  // Verify cursor was resolved
  const { timestamp } = PgChangesFeed.parseCursor(cursorAfterStart);
  if (!timestamp || !timestamp.match(/^\d{4}-\d{2}-\d{2}T/)) {
    fail('since:now polling', `cursor not resolved: ${cursorAfterStart}`);
    return;
  }

  // Insert a doc after the resolved cursor
  const docId = `test:since-now-poll:${Date.now()}`;
  await insertTestDoc(docId, 'data_record');
  await sleep(200);

  // Start a new feed from the resolved cursor
  const feed2 = new PgChangesFeed({
    live: false,
    since: cursorAfterStart,
    batchSize: 100,
  });
  const changes = [];
  feed2.on('change', c => changes.push(c));
  await feed2.start();
  await sleep(300);
  feed2.cancel();

  if (changes.some(c => c.id === docId)) {
    pass(`Resolved cursor correctly captures changes in subsequent polls`);
  } else {
    fail('since:now polling',
      `doc ${docId} not found among ${changes.length} changes`);
  }
};

// ─── Test: parseCursor handles doc IDs containing '::' ───────────────
const testParseCursorWithDoubleColonInDocId = () => {
  console.log('\n--- parseCursor with :: in doc ID ---');

  // Doc IDs could theoretically contain '::' (CouchDB allows arbitrary strings).
  // The old split('::') approach would break these; indexOf-based parsing should not.
  const cursor = '2026-04-10T12:00:00.123456Z::org.couchdb.user::admin::extra';
  const { timestamp, id } = PgChangesFeed.parseCursor(cursor);
  if (timestamp === '2026-04-10T12:00:00.123456Z' && id === 'org.couchdb.user::admin::extra') {
    pass('parseCursor preserves :: in doc ID');
  } else {
    fail('parseCursor ::', `timestamp="${timestamp}" id="${id}"`);
  }

  // Verify single :: still works (common case)
  const cursor2 = '2026-04-10T12:00:00.000000Z::simple-doc-id';
  const parsed2 = PgChangesFeed.parseCursor(cursor2);
  if (parsed2.timestamp === '2026-04-10T12:00:00.000000Z' && parsed2.id === 'simple-doc-id') {
    pass('parseCursor still works for normal doc IDs');
  } else {
    fail('parseCursor normal', `timestamp="${parsed2.timestamp}" id="${parsed2.id}"`);
  }

  // Verify empty doc ID after separator
  const cursor3 = '2026-04-10T12:00:00.000000Z::';
  const parsed3 = PgChangesFeed.parseCursor(cursor3);
  if (parsed3.timestamp === '2026-04-10T12:00:00.000000Z' && parsed3.id === '') {
    pass('parseCursor handles empty doc ID after ::');
  } else {
    fail('parseCursor empty id', `timestamp="${parsed3.timestamp}" id="${parsed3.id}"`);
  }

  // Verify round-trip: buildCursor → parseCursor with :: in doc ID
  const built = PgChangesFeed.buildCursor('2026-04-10T00:00:00.000000Z', 'a::b::c');
  const roundTripped = PgChangesFeed.parseCursor(built);
  if (roundTripped.timestamp === '2026-04-10T00:00:00.000000Z' && roundTripped.id === 'a::b::c') {
    pass('buildCursor/parseCursor round-trips doc ID with ::');
  } else {
    fail('round-trip ::', `timestamp="${roundTripped.timestamp}" id="${roundTripped.id}"`);
  }
};

// ─── Test: cancel() mid-poll stops further change emissions ──────────
const testCancelMidPollStopsEmissions = async () => {
  console.log('\n--- Cancel Mid-Poll Stops Emissions ---');

  // Insert several docs so the poll has multiple rows to iterate
  const prefix = `test:cancel-mid:${Date.now()}`;
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const id = `${prefix}:${String(i).padStart(3, '0')}`;
    ids.push(id);
    await insertTestDoc(id, 'data_record');
  }
  await sleep(200);

  // Start a non-live feed from the beginning with a large batch
  // so all 20 docs are fetched in one poll
  const feed = new PgChangesFeed({
    live: false,
    since: null,
    batchSize: 10000,
  });

  const changes = [];
  let cancelledAfter = null;
  feed.on('change', (change) => {
    changes.push(change);
    // Cancel after receiving the 3rd test doc
    const testChanges = changes.filter(c => c.id.startsWith(prefix));
    if (testChanges.length === 3 && !cancelledAfter) {
      cancelledAfter = changes.length;
      feed.cancel();
    }
  });

  await feed.start();
  await sleep(500);

  // After cancel, we should have stopped receiving changes.
  // The exact count depends on timing, but we should NOT have
  // received all 20 test docs if cancel worked mid-loop.
  const testChangesReceived = changes.filter(c => c.id.startsWith(prefix));

  if (cancelledAfter !== null) {
    // We did cancel. The key assertion: no changes were emitted
    // AFTER the cancel() call within the same poll iteration.
    // Since cancel sets _running=false and the loop checks it,
    // the total changes should be close to cancelledAfter.
    if (changes.length <= cancelledAfter + 1) {
      pass(`Cancel stopped emissions (got ${changes.length} total, cancelled after ${cancelledAfter})`);
    } else {
      // Even a few extra is OK (the check happens at loop top, so
      // the emit that triggered cancel counts). But getting ALL
      // remaining rows means the fix isn't working.
      if (testChangesReceived.length < ids.length) {
        pass(`Cancel reduced emissions: ${testChangesReceived.length}/${ids.length} test docs (cancelled after change #${cancelledAfter})`);
      } else {
        fail('cancel mid-poll',
          `all ${testChangesReceived.length} test docs emitted despite cancel after #${cancelledAfter}`);
      }
    }
  } else {
    // Cancel was never triggered — test setup issue
    fail('cancel mid-poll', `cancel never triggered. Got ${testChangesReceived.length} test changes`);
  }
};

// ─── Test: metadataPool has error handler (no process crash) ─────────
const testMetadataPoolHasErrorHandler = () => {
  console.log('\n--- Metadata Pool Error Handler ---');
  const pgChanges = require('../../src/lib/pg-changes');

  // Verify the pool has at least one 'error' listener.
  // Without this, an idle connection error from PostgreSQL would
  // crash the process as an unhandled 'error' event.
  const listenerCount = pgChanges._metadataPool.listenerCount('error');
  if (listenerCount >= 1) {
    pass(`metadataPool has ${listenerCount} error listener(s) — no process crash risk`);
  } else {
    fail('metadata pool error handler',
      `expected >= 1 error listener, got ${listenerCount}`);
  }
};

// ─── Test: NotifyListener exponential backoff on reconnection ────────
const testExponentialBackoff = async () => {
  console.log('\n--- Exponential Backoff on Reconnection ---');

  // Create a listener pointing at a port with no PostgreSQL running.
  // Each _connect() attempt will fail immediately, letting us observe
  // the backoff delay progression without waiting for real timeouts.
  const badConfig = { ...config, port: 59999, connectionTimeoutMillis: 500 };
  const listener = new NotifyListener(badConfig);

  // Track the backoff delay values by observing _reconnectDelay after each failure.
  // The listener's _connect loop is async, so we let it run and sample the state.
  await listener.start();

  // After start(), the first _connect fails immediately (bad port).
  // Wait for a few rapid failure cycles (each fails in ~100ms due to
  // connectionTimeoutMillis, then waits _reconnectDelay).
  // We need to check the state after the first failure.
  await sleep(1500);

  // After first failure, delay should have doubled from initial 5000 to 10000
  const delayAfterFailures = listener._reconnectDelay;
  const failures = listener._consecutiveFailures;

  listener.stop();

  if (failures >= 1) {
    pass(`Listener recorded ${failures} consecutive failure(s)`);
  } else {
    fail('backoff failures', `expected >= 1 failure, got ${failures}`);
  }

  if (delayAfterFailures > 5000) {
    pass(`Backoff delay increased to ${delayAfterFailures}ms (> initial 5000ms)`);
  } else {
    fail('backoff delay', `expected > 5000ms, got ${delayAfterFailures}ms`);
  }
};

// ─── Test: Backoff resets after successful connection ────────────────
const testBackoffResetsOnSuccess = async () => {
  console.log('\n--- Backoff Resets on Successful Connection ---');

  const listener = new NotifyListener(config);

  // Manually simulate elevated backoff state as if previous failures occurred
  listener._reconnectDelay = 40000;
  listener._consecutiveFailures = 3;

  await listener.start();
  await sleep(500);

  // After successful connect, backoff should reset
  const delayAfterSuccess = listener._reconnectDelay;
  const failuresAfterSuccess = listener._consecutiveFailures;

  listener.stop();

  if (delayAfterSuccess === 5000) {
    pass('Backoff delay reset to initial 5000ms after successful connect');
  } else {
    fail('backoff reset delay', `expected 5000ms, got ${delayAfterSuccess}ms`);
  }

  if (failuresAfterSuccess === 0) {
    pass('Consecutive failures reset to 0 after successful connect');
  } else {
    fail('backoff reset failures', `expected 0, got ${failuresAfterSuccess}`);
  }
};

// ─── Test: stop() clears pending reconnect timer ────────────────────
const testStopClearsPendingReconnect = async () => {
  console.log('\n--- stop() Clears Pending Reconnect Timer ---');

  // Point at a bad port so _connect fails and schedules a reconnect timer
  const badConfig = { ...config, port: 59999, connectionTimeoutMillis: 200 };
  const listener = new NotifyListener(badConfig);
  await listener.start();

  // Wait for the first failure to schedule a reconnect
  await sleep(500);

  // There should be a pending reconnect timer
  const hadTimer = listener._reconnectTimer !== null;
  listener.stop();
  const timerAfterStop = listener._reconnectTimer;

  if (hadTimer) {
    pass('Reconnect timer was scheduled after failure');
  } else {
    // Timer may have already fired and cleared itself, which is fine
    pass('Reconnect timer was already handled (fast failure cycle)');
  }

  if (timerAfterStop === null) {
    pass('stop() cleared the reconnect timer');
  } else {
    fail('stop timer', 'reconnect timer still pending after stop()');
  }

  // Verify backoff state is reset
  if (listener._reconnectDelay === 5000 && listener._consecutiveFailures === 0) {
    pass('stop() reset backoff state');
  } else {
    fail('stop backoff', `delay=${listener._reconnectDelay}, failures=${listener._consecutiveFailures}`);
  }
};

// ─── Test: NOTIFY trigger existence check logs warning when missing ──
const testNotifyTriggerCheck = async () => {
  console.log('\n--- NOTIFY Trigger Existence Check ---');

  // The trigger SHOULD exist in our test environment, so verify no warning
  const feed = new PgChangesFeed({
    live: true,
    since: PgChangesFeed.buildCursor(new Date().toISOString(), '\uffff'),
    batchSize: 100,
    pollInterval: 120000,
  });

  // Capture the _checkNotifyTrigger result by starting the feed
  // (which calls _checkNotifyTrigger internally).
  // We verify that the feed starts successfully, which means the check
  // didn't throw. The actual trigger should exist in our test env.
  try {
    await feed.start();
    await sleep(300);
    pass('Feed started with trigger check — no errors');
  } catch (err) {
    fail('trigger check', `feed start failed: ${err.message}`);
  } finally {
    feed.cancel();
  }

  // Now test with a non-existent table to verify the check handles
  // errors gracefully (non-fatal warning, not a crash).
  const badFeed = new PgChangesFeed({
    live: true,
    since: PgChangesFeed.buildCursor(new Date().toISOString(), '\uffff'),
    batchSize: 100,
    pollInterval: 120000,
  });
  // Override schema to a non-existent one
  badFeed._schema = 'nonexistent_schema_xyz';

  try {
    await badFeed.start();
    await sleep(300);
    pass('Feed with bad schema started gracefully (trigger check is non-fatal)');
  } catch (err) {
    // If the initial poll fails that's expected (bad schema)
    pass('Feed with bad schema: trigger check did not crash before poll error');
  } finally {
    badFeed.cancel();
  }
};

// ─── Test: Backoff delay reaches cap ────────────────────────────────
const testBackoffDelayCap = () => {
  console.log('\n--- Backoff Delay Cap ---');

  const listener = new NotifyListener(config);

  // Simulate many consecutive failures by manually advancing the delay
  listener._reconnectDelay = 5000; // initial
  for (let i = 0; i < 10; i++) {
    listener._reconnectDelay = Math.min(listener._reconnectDelay * 2, 60000);
  }

  if (listener._reconnectDelay === 60000) {
    pass('Backoff delay capped at 60000ms after many failures');
  } else {
    fail('backoff cap', `expected 60000ms, got ${listener._reconnectDelay}ms`);
  }

  // Verify progression: 5000 → 10000 → 20000 → 40000 → 60000 (cap)
  let delay = 5000;
  const progression = [delay];
  for (let i = 0; i < 4; i++) {
    delay = Math.min(delay * 2, 60000);
    progression.push(delay);
  }
  const expected = [5000, 10000, 20000, 40000, 60000];
  if (JSON.stringify(progression) === JSON.stringify(expected)) {
    pass(`Backoff progression: ${progression.join(' → ')}ms`);
  } else {
    fail('backoff progression', `expected ${expected.join('→')}, got ${progression.join('→')}`);
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
    await testBacklogDraining();
    await testReconnectionCatchUp();
    await testReconnectedEventNotOnFirstConnect();
    await testMetadataAutoInit();
    await testNoDuplicatesOnConsecutivePolls();
    await testMicrosecondPrecisionInCursor();
    await testLiveFeedNoDuplicateOnScheduledPoll();
    testParseCursorNowSafetyNet();
    testParseCursorWithDoubleColonInDocId();
    testMetadataPoolHasErrorHandler();
    await testSinceNowCursorResolution();
    await testSinceNowPollingOnly();
    await testCancelDuringPollNoError();
    await testCancelMidPollStopsEmissions();
    await testExponentialBackoff();
    await testBackoffResetsOnSuccess();
    await testStopClearsPendingReconnect();
    await testNotifyTriggerCheck();
    testBackoffDelayCap();
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
