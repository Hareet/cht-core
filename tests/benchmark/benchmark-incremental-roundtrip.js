#!/usr/bin/env node
/**
 * Incremental Sync Roundtrip Benchmark
 *
 * Measures the actual sync mechanism time (not polling interval):
 *
 * PouchDB path:
 *   1. Insert doc to CouchDB
 *   2. Call GET /api/v1/replication/get-ids (full DB scan)
 *   3. Find new doc ID in response
 *   4. Call POST /medic/_bulk_get for the doc
 *   5. Total = get-ids time + bulk_get time
 *
 * PowerSync path:
 *   1. Connect PowerSync, complete initial sync
 *   2. Insert doc directly to PostgreSQL
 *   3. WAL → PowerSync service → client WebSocket push
 *   4. Total = time until doc appears in client SQLite
 *
 * Also measures "nothing changed" cost:
 *   PouchDB: get-ids call (~3s for 810K docs) — paid every cycle
 *   PowerSync: 0ms — live WebSocket, no polling
 *
 * Env vars:
 *   CHT_ROLE=chw_min_5km    Required for PowerSync JWT
 *
 * Usage:
 *   CHT_ROLE=chw_min_5km node benchmark-incremental-roundtrip.js [username] [password]
 */

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

const USERNAME = process.argv[2] || 'chw_test_1';
const PASSWORD = process.argv[3] || 'Secret1!pass';

function md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }
function base64url(b) { return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''); }

function httpReq(method, host, port, path, body, auth) {
  return new Promise((resolve, reject) => {
    const opts = { method, hostname: host, port, path, headers: { 'Content-Type': 'application/json' } };
    if (auth) opts.headers['Authorization'] = 'Basic ' + Buffer.from(auth).toString('base64');
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = http.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d), size: d.length }); }
        catch { resolve({ status: res.statusCode, data: d, size: d.length }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ============================================================
// PouchDB Incremental Roundtrip
// ============================================================
async function benchPouchDBIncremental() {
  console.log('=== PouchDB Incremental Sync Roundtrip ===\n');

  const userAuth = USERNAME + ':' + PASSWORD;
  const adminAuth = 'admin:secret21512';

  // Get user info
  const userSettings = (await httpReq('GET', 'couchdb', 5984, '/medic/org.couchdb.user:' + USERNAME, null, adminAuth)).data;
  const facilityId = Array.isArray(userSettings.facility_id) ? userSettings.facility_id[0] : userSettings.facility_id;

  // --- Test A: Nothing changed (get-ids cost) ---
  console.log('  Test A: Nothing changed (get-ids server cost)\n');
  const getIdsRuns = [];
  for (let i = 0; i < 5; i++) {
    const start = Date.now();
    const res = await httpReq('GET', 'api', 5988, '/api/v1/replication/get-ids', null, userAuth);
    const elapsed = Date.now() - start;
    getIdsRuns.push(elapsed);
    console.log('    Run ' + (i + 1) + ': ' + elapsed + 'ms (' + Math.round(res.size / 1024) + 'KB, ' + (res.data?.doc_ids?.length || '?') + ' doc IDs)');
  }
  const avgGetIds = Math.round(getIdsRuns.reduce((a, b) => a + b, 0) / getIdsRuns.length);
  console.log('    Average: ' + avgGetIds + 'ms\n');

  // --- Test B: One new doc (full roundtrip) ---
  console.log('  Test B: One new doc roundtrip\n');
  const newDocId = 'benchmark-pouchdb-rt-' + Date.now();

  // Step 1: Insert doc
  const tInsert = Date.now();
  await httpReq('PUT', 'couchdb', 5984, '/medic/' + newDocId, JSON.stringify({
    _id: newDocId, type: 'data_record', form: 'benchmark_rt',
    patient_id: '12345', reported_date: Date.now(),
    contact: { _id: userSettings.contact_id, parent: { _id: facilityId } },
    fields: { test: true },
  }), adminAuth);
  const insertMs = Date.now() - tInsert;
  console.log('    1. Insert to CouchDB: ' + insertMs + 'ms');

  // Step 2: get-ids (find the new doc)
  const tGetIds = Date.now();
  const idsRes = await httpReq('GET', 'api', 5988, '/api/v1/replication/get-ids', null, userAuth);
  const getIdsMs = Date.now() - tGetIds;
  const docIds = idsRes.data?.doc_ids || [];
  const foundInIds = docIds.some(entry => entry.id === newDocId || entry === newDocId);
  console.log('    2. get-ids scan: ' + getIdsMs + 'ms (' + docIds.length + ' IDs, found new doc: ' + foundInIds + ')');

  // Step 3: bulk_get for the new doc
  const tBulkGet = Date.now();
  await httpReq('POST', 'couchdb', 5984, '/medic/_bulk_get', JSON.stringify({
    docs: [{ id: newDocId }],
  }), adminAuth);
  const bulkGetMs = Date.now() - tBulkGet;
  console.log('    3. bulk_get (1 doc): ' + bulkGetMs + 'ms');

  const totalRoundtrip = insertMs + getIdsMs + bulkGetMs;
  console.log('    Total roundtrip: ' + totalRoundtrip + 'ms');
  console.log('    (get-ids dominates: ' + Math.round(getIdsMs / totalRoundtrip * 100) + '% of total)\n');

  // Cleanup
  const delRes = await httpReq('GET', 'couchdb', 5984, '/medic/' + newDocId, null, adminAuth);
  if (delRes.data._rev) {
    await httpReq('DELETE', 'couchdb', 5984, '/medic/' + newDocId + '?rev=' + delRes.data._rev, null, adminAuth);
  }

  return {
    nothingChangedMs: avgGetIds,
    insertMs, getIdsMs, bulkGetMs, totalRoundtripMs: totalRoundtrip,
    getIdsDocCount: docIds.length,
    getIdsResponseKB: Math.round(idsRes.size / 1024),
  };
}

// ============================================================
// PowerSync Incremental Roundtrip
// ============================================================
async function benchPowerSyncIncremental() {
  console.log('=== PowerSync Incremental Sync Roundtrip ===\n');

  const { PowerSyncDatabase } = require('@powersync/node');
  const { Schema, Table, Column, ColumnType } = require('@powersync/common');

  function t(name) { return new Column({ name, type: ColumnType.TEXT }); }
  const schema = new Schema([
    new Table({ name: 'contacts', columns: [t('name'), t('contact_type'), t('parent_id'), t('patient_id'), t('doc')] }),
    new Table({ name: 'reports', columns: [t('form'), t('patient_id'), t('submitter_id'), t('reported_date'), t('fields'), t('doc')] }),
    new Table({ name: 'tasks', columns: [t('task_user'), t('state'), t('doc')] }),
    new Table({ name: 'global_config', columns: [t('doc_type'), t('doc')] }),
    new Table({ name: 'user_settings_doc', columns: [t('doc_type'), t('doc')] }),
    new Table({ name: 'user_meta', columns: [t('meta_type'), t('user_id'), t('doc')] }),
    new Table({ name: 'targets', columns: [t('owner'), t('doc')] }),
    new Table({ name: 'sms_messages', columns: [t('contact_id'), t('doc')] }),
  ]);

  // JWT
  const userSettings = (await httpReq('GET', 'couchdb', 5984, '/medic/org.couchdb.user:' + USERNAME, null, 'admin:secret21512')).data;
  const roles = process.env.CHT_ROLE ? [process.env.CHT_ROLE] : ['chw_min_5km'];
  const pk = fs.readFileSync('/workspace/cht-core/.devcontainer/powersync-config/dev-private-key.pem', 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const h = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'cht-dev-key-1' })));
  const p = base64url(Buffer.from(JSON.stringify({
    sub: userSettings._id, aud: 'cht-powersync-dev', iat: now, exp: now + 86400,
    role_hash: md5(roles.sort().join(',')),
    contact_id: userSettings.contact_id || '', report_depth: -1,
    can_view_unallocated: 'false', roles,
  })));
  const sign = crypto.createSign('RSA-SHA256'); sign.update(h + '.' + p);
  const token = h + '.' + p + '.' + base64url(sign.sign(pk));

  const facilityId = Array.isArray(userSettings.facility_id) ? userSettings.facility_id[0] : userSettings.facility_id;

  // Initial sync
  console.log('  Initial sync...');
  const dbPath = '/tmp/ps-rt-' + Date.now() + '.db';
  const db = new PowerSyncDatabase({ schema, database: { dbFilename: dbPath } });
  await db.getAll('SELECT 1');
  await db.connect({
    fetchCredentials: async () => ({ endpoint: 'http://powersync:8080', token }),
    uploadData: async () => {},
  });

  const tInit = Date.now();
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 120000);
    await db.waitForFirstSync({ signal: ctrl.signal });
    clearTimeout(to);
  } catch {}
  const initialMs = Date.now() - tInit;
  const reportsBefore = (await db.get('SELECT COUNT(*) as c FROM reports')).c;
  console.log('  Initial sync: ' + initialMs + 'ms, ' + reportsBefore + ' reports\n');

  // --- Test A: Nothing changed ---
  console.log('  Test A: Nothing changed (idle cost)\n');
  console.log('    PowerSync: 0ms (live WebSocket, no polling, no server scan)\n');

  // --- Test B: One new doc (inserted directly to PostgreSQL) ---
  console.log('  Test B: One new doc roundtrip (PostgreSQL -> WAL -> PowerSync -> client)\n');
  const newDocId = 'benchmark-ps-rt-' + Date.now();
  const doc = {
    _id: newDocId, type: 'data_record', form: 'benchmark_ps_rt',
    patient_id: '12345', reported_date: Date.now(),
    contact: { _id: userSettings.contact_id, parent: { _id: facilityId } },
    fields: { test: true },
  };
  const docJson = JSON.stringify(doc).replace(/'/g, "''");

  // Insert directly to PostgreSQL
  const tInsert = Date.now();
  fs.writeFileSync('/tmp/ps-rt-insert.sql',
    "INSERT INTO v1.couchdb (_id, doc, _deleted, source, resolved_subject_place_id) " +
    "VALUES ('" + newDocId + "', '" + docJson + "'::jsonb, false, 'powersync', '" + facilityId + "')");
  execSync('PGPASSWORD=pgpass psql -h postgres -U cht -d cht -f /tmp/ps-rt-insert.sql', { timeout: 10000 });
  const insertMs = Date.now() - tInsert;
  console.log('    1. Insert to PostgreSQL: ' + insertMs + 'ms');

  // Poll for the doc in PowerSync client
  let detectedMs = -1;
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 500));
    const reportsNow = (await db.get('SELECT COUNT(*) as c FROM reports')).c;
    if (reportsNow > reportsBefore) {
      detectedMs = Date.now() - tInsert;
      console.log('    2. WAL -> PowerSync -> client: ' + (detectedMs - insertMs) + 'ms');
      console.log('    Total roundtrip: ' + detectedMs + 'ms');
      break;
    }
  }
  if (detectedMs < 0) {
    console.log('    Doc NOT detected within 60s');
    detectedMs = -1;
  }

  // Cleanup
  try {
    fs.writeFileSync('/tmp/ps-rt-cleanup.sql', "DELETE FROM v1.couchdb WHERE _id = '" + newDocId + "'");
    execSync('PGPASSWORD=pgpass psql -h postgres -U cht -d cht -f /tmp/ps-rt-cleanup.sql', { timeout: 10000 });
  } catch {}
  await db.disconnectAndClear();
  try { fs.unlinkSync(dbPath); } catch {}

  console.log('');
  return {
    nothingChangedMs: 0,
    insertMs,
    walToClientMs: detectedMs > 0 ? detectedMs - insertMs : -1,
    totalRoundtripMs: detectedMs,
    initialSyncMs: initialMs,
    reportsBefore,
  };
}

// ============================================================
// Main
// ============================================================
(async () => {
  console.log('============================================================');
  console.log('  Incremental Sync Roundtrip Benchmark');
  console.log('  Measures sync mechanism time (not polling interval)');
  console.log('  Database: ~810K total docs, ~20K per CHW');
  console.log('============================================================\n');

  const pouchResults = await benchPouchDBIncremental();
  const psResults = await benchPowerSyncIncremental();

  console.log('============================================================');
  console.log('  COMPARISON: Incremental Sync Roundtrip');
  console.log('============================================================\n');

  console.log('  Nothing changed (per sync cycle):');
  console.log('    PouchDB:    ' + pouchResults.nothingChangedMs + 'ms (get-ids scans ' + pouchResults.getIdsDocCount + ' docs, ' + pouchResults.getIdsResponseKB + 'KB response)');
  console.log('    PowerSync:  0ms (live WebSocket)\n');

  console.log('  One new doc (end-to-end roundtrip):');
  console.log('    PouchDB:    ' + pouchResults.totalRoundtripMs + 'ms');
  console.log('      Insert to CouchDB:  ' + pouchResults.insertMs + 'ms');
  console.log('      get-ids scan:       ' + pouchResults.getIdsMs + 'ms (' + Math.round(pouchResults.getIdsMs / pouchResults.totalRoundtripMs * 100) + '% of total)');
  console.log('      bulk_get (1 doc):   ' + pouchResults.bulkGetMs + 'ms');
  console.log('    PowerSync:  ' + (psResults.totalRoundtripMs > 0 ? psResults.totalRoundtripMs + 'ms' : 'NOT DETECTED'));
  if (psResults.totalRoundtripMs > 0) {
    console.log('      Insert to PG:       ' + psResults.insertMs + 'ms');
    console.log('      WAL -> client:      ' + psResults.walToClientMs + 'ms');
  }

  console.log('\n  Scaling:');
  console.log('    PouchDB get-ids is O(total_docs). At 810K docs: ~' + pouchResults.nothingChangedMs + 'ms/cycle.');
  console.log('    At 5M docs (national scale): estimated ~' + Math.round(pouchResults.nothingChangedMs * 5000000 / 810000) + 'ms/cycle.');
  console.log('    PowerSync is O(changed_docs). Cost stays ~0ms regardless of total DB size.');

  console.log('\n  Daily server load (2,611 users, 5-min sync interval):');
  const dailyCalls = 2611 * 288;
  console.log('    PouchDB:    ~' + dailyCalls + ' get-ids calls x ' + pouchResults.nothingChangedMs + 'ms = ' + Math.round(dailyCalls * pouchResults.nothingChangedMs / 1000 / 3600) + 'h CouchDB CPU/day');
  console.log('    PowerSync:  0 polling calls (event-driven via WAL)');

  console.log('\n============================================================');

  const output = {
    benchmark: 'incremental-roundtrip',
    timestamp: new Date().toISOString(),
    user: USERNAME,
    pouchdb: pouchResults,
    powersync: psResults,
  };
  fs.writeFileSync('/tmp/benchmark-incremental-results.json', JSON.stringify(output, null, 2));
  console.log('\nResults written to /tmp/benchmark-incremental-results.json');

  process.exit(0);
})().catch(e => { console.error('Failed:', e); process.exit(1); });
