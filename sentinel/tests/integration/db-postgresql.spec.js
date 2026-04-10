/**
 * Integration tests for db-postgresql.js — the PouchDB-compatible PostgreSQL backend.
 * Runs against live PostgreSQL at postgres:5432.
 *
 * Usage: POSTGRES_PASSWORD=pgpass node sentinel/tests/integration/db-postgresql.spec.js
 */
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || 'pgpass';
process.env.POSTGRES_HOST = process.env.POSTGRES_HOST || 'postgres';

// Stub logger before requiring db module
const logs = [];
require.cache[require.resolve('@medic/logger')] = {
  id: '@medic/logger',
  exports: {
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
    debug: (...args) => {},
  },
};

const db = require('../../src/db-postgresql');
const { Pool } = require('pg');

const directPool = new Pool({
  host: process.env.POSTGRES_HOST,
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  user: process.env.POSTGRES_USER || 'cht',
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB || 'cht',
});

const testDocIds = [];
const log = (msg) => console.log(`  [test] ${msg}`);
const pass = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const fail = (name, err) => { console.log(`  \x1b[31m✗\x1b[0m ${name}: ${err}`); process.exitCode = 1; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const insertDirectly = async (id, doc) => {
  await directPool.query(
    `INSERT INTO v1.couchdb (_id, doc, _deleted, saved_timestamp, source)
     VALUES ($1, $2, false, NOW(), 'test')
     ON CONFLICT (_id) DO UPDATE SET doc = $2, _deleted = false, saved_timestamp = NOW()`,
    [id, JSON.stringify({ _id: id, _rev: '1-test', ...doc })]
  );
  testDocIds.push(id);
};

const cleanup = async () => {
  if (testDocIds.length) {
    await directPool.query('DELETE FROM v1.couchdb WHERE _id = ANY($1)', [testDocIds]);
    await directPool.query('DELETE FROM sentinel.docs WHERE _id = ANY($1)', [testDocIds]);
    log(`Cleaned up ${testDocIds.length} test docs`);
  }
};

// ─── Tests ─────────────────────────────────────────────────────────────

const testMedicGet = async () => {
  console.log('\n--- db.medic.get ---');
  const id = `test:get:${Date.now()}`;
  await insertDirectly(id, { type: 'data_record', form: 'test' });

  const doc = await db.medic.get(id);
  if (doc._id === id && doc.type === 'data_record') {
    pass('get existing doc');
  } else {
    fail('get existing', JSON.stringify(doc));
  }

  try {
    await db.medic.get('nonexistent-doc-id-12345');
    fail('get missing', 'should have thrown');
  } catch (err) {
    if (err.status === 404) {
      pass('get missing doc throws 404');
    } else {
      fail('get missing', err.message);
    }
  }
};

const testMedicPutAndGet = async () => {
  console.log('\n--- db.medic.put ---');
  const id = `test:put:${Date.now()}`;
  testDocIds.push(id);

  const result = await db.medic.put({ _id: id, type: 'data_record', form: 'put-test' });
  if (result.ok && result.id === id && result.rev.includes('-pg')) {
    pass('put returns ok with pg rev');
  } else {
    fail('put result', JSON.stringify(result));
  }

  const doc = await db.medic.get(id);
  if (doc._id === id && doc.form === 'put-test' && doc._rev === result.rev) {
    pass('put doc is retrievable with correct rev');
  } else {
    fail('put retrieve', JSON.stringify(doc));
  }
};

const testMedicAllDocs = async () => {
  console.log('\n--- db.medic.allDocs ---');
  const ids = [`test:alldocs:a:${Date.now()}`, `test:alldocs:b:${Date.now()}`];
  for (const id of ids) {
    await insertDirectly(id, { type: 'data_record' });
  }

  // By keys
  const result = await db.medic.allDocs({ keys: ids, include_docs: true });
  if (result.rows.length === 2 && result.rows.every(r => r.doc)) {
    pass(`allDocs by keys returns ${result.rows.length} docs with include_docs`);
  } else {
    fail('allDocs keys', `got ${result.rows.length} rows`);
  }

  // By keys without include_docs
  const result2 = await db.medic.allDocs({ keys: ids });
  if (result2.rows.length === 2 && result2.rows.every(r => r.value?.rev && !r.doc)) {
    pass('allDocs by keys without include_docs returns revs only');
  } else {
    fail('allDocs no docs', JSON.stringify(result2.rows[0]));
  }

  // Missing key
  const result3 = await db.medic.allDocs({ keys: ['nonexistent-xyz-123'] });
  if (result3.rows[0]?.error === 'not_found') {
    pass('allDocs with missing key returns not_found');
  } else {
    fail('allDocs missing', JSON.stringify(result3.rows[0]));
  }
};

const testMedicBulkDocs = async () => {
  console.log('\n--- db.medic.bulkDocs ---');
  const docs = [
    { _id: `test:bulk:1:${Date.now()}`, type: 'data_record', form: 'bulk' },
    { _id: `test:bulk:2:${Date.now()}`, type: 'data_record', form: 'bulk' },
  ];
  testDocIds.push(...docs.map(d => d._id));

  const results = await db.medic.bulkDocs(docs);
  if (results.length === 2 && results.every(r => r.ok)) {
    pass(`bulkDocs saved ${results.length} docs`);
  } else {
    fail('bulkDocs', JSON.stringify(results));
  }

  // Verify
  const fetched = await db.medic.allDocs({ keys: docs.map(d => d._id), include_docs: true });
  if (fetched.rows.every(r => r.doc?.form === 'bulk')) {
    pass('bulkDocs docs are retrievable');
  } else {
    fail('bulkDocs verify', JSON.stringify(fetched.rows));
  }
};

const testViewDocByType = async () => {
  console.log('\n--- query: medic-client/doc_by_type ---');
  const result = await db.medic.query('medic-client/doc_by_type', {
    key: ['translations'],
    include_docs: true,
  });
  if (result.rows.length > 0 && result.rows[0].doc?.type === 'translations') {
    pass(`doc_by_type found ${result.rows.length} translation docs`);
  } else {
    fail('doc_by_type', `got ${result.rows.length} rows`);
  }
};

const testViewReportsByFormAndParent = async () => {
  console.log('\n--- query: medic/reports_by_form_and_parent ---');
  // Insert test reports
  const parentId = `test:parent:${Date.now()}`;
  await insertDirectly(parentId, { type: 'clinic', name: 'Test Clinic' });
  await insertDirectly(`test:report:1:${Date.now()}`, {
    type: 'data_record', form: 'pregnancy', reported_date: 1000,
    contact: { _id: 'chw-1', parent: { _id: parentId } },
  });
  await insertDirectly(`test:report:2:${Date.now()}`, {
    type: 'data_record', form: 'pregnancy', reported_date: 2000,
    contact: { _id: 'chw-1', parent: { _id: parentId } },
  });

  const result = await db.medic.query('medic/reports_by_form_and_parent', {
    keys: [['pregnancy', parentId]],
    group: true,
  });

  if (result.rows.length === 1 && result.rows[0].value.count === 2 &&
      result.rows[0].value.max === 2000 && result.rows[0].value.min === 1000) {
    pass('reports_by_form_and_parent returns correct _stats');
  } else {
    fail('reports stats', JSON.stringify(result.rows));
  }
};

const testSentinelGetPut = async () => {
  console.log('\n--- db.sentinel get/put ---');
  const id = `test:sentinel:${Date.now()}`;
  testDocIds.push(id);

  await db.sentinel.put({ _id: id, type: 'info', value: 'test-data' });
  const doc = await db.sentinel.get(id);
  if (doc._id === id && doc.value === 'test-data') {
    pass('sentinel put/get round-trip');
  } else {
    fail('sentinel get', JSON.stringify(doc));
  }
};

const testSentinelAllDocs = async () => {
  console.log('\n--- db.sentinel.allDocs ---');
  const ids = [`test:sent:a:${Date.now()}`, `test:sent:b:${Date.now()}`];
  testDocIds.push(...ids);

  for (const id of ids) {
    await db.sentinel.put({ _id: id, type: 'info' });
  }

  const result = await db.sentinel.allDocs({
    startkey: 'test:sent:',
    endkey: 'test:sent:\ufff0',
    include_docs: true,
  });
  if (result.rows.length >= 2) {
    pass(`sentinel allDocs range found ${result.rows.length} docs`);
  } else {
    fail('sentinel allDocs', `got ${result.rows.length}`);
  }
};

const testChanges = async () => {
  console.log('\n--- db.medic.changes ---');
  // Insert a new doc, then check non-live changes picks it up
  const id = `test:changes:${Date.now()}`;
  await insertDirectly(id, { type: 'data_record', form: 'changes-test' });

  const feed = db.medic.changes({ live: false, since: null, limit: 1000 });
  const changes = [];
  feed.on('change', c => changes.push(c));
  await sleep(1500);
  feed.cancel();

  if (changes.some(c => c.id === id)) {
    pass(`changes detected test doc among ${changes.length} changes`);
  } else {
    fail('changes', `test doc ${id} not found in ${changes.length} changes`);
  }
};

const testUsersAllDocs = async () => {
  console.log('\n--- db.users.allDocs ---');
  // Check if there are user-settings docs
  const result = await db.users.allDocs({ include_docs: true });
  // May be 0 in test environment, that's ok
  pass(`users.allDocs returned ${result.rows.length} user-settings docs`);
};

const testQueryMedic = async () => {
  console.log('\n--- queryMedic ---');
  // Test allDocs range via queryMedic
  const result = await db.queryMedic('allDocs', {
    start_key: JSON.stringify('form:'),
    end_key: JSON.stringify('form:\ufff0'),
    limit: 5,
    include_docs: true,
  });
  if (result.rows.length > 0) {
    pass(`queryMedic allDocs range found ${result.rows.length} form docs`);
  } else {
    fail('queryMedic', 'no form docs found');
  }
};

// ─── Main ──────────────────────────────────────────────────────────────

const run = async () => {
  console.log('db-postgresql.js — Integration Tests\n');

  try {
    const client = await directPool.connect();
    const { rows } = await client.query('SELECT count(*) as c FROM v1.couchdb');
    client.release();
    log(`Connected. ${rows[0].c} docs in v1.couchdb\n`);
  } catch (err) {
    console.error('Connection failed:', err.message);
    process.exit(1);
  }

  try {
    await testMedicGet();
    await testMedicPutAndGet();
    await testMedicAllDocs();
    await testMedicBulkDocs();
    await testViewDocByType();
    await testViewReportsByFormAndParent();
    await testSentinelGetPut();
    await testSentinelAllDocs();
    await testChanges();
    await testUsersAllDocs();
    await testQueryMedic();
  } finally {
    await cleanup();
    await directPool.end();
    await db._pool.end();
    // Close pg-changes pool if it was opened
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
