#!/usr/bin/env node
/**
 * PowerSync/PostgreSQL Benchmark — Node.js (no browser)
 *
 * Uses @powersync/node with better-sqlite3 to measure sync performance
 * directly. No WASM, no browser, no worker issues.
 *
 * NOTE: This measures PowerSync sync engine performance without WASM overhead.
 * For Go edition WASM overhead, add ~3-8s to the init time.
 *
 * Usage:
 *   CHT_ROLE=chw_min_5km node benchmark-powersync-node.js chw_test_1
 */

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const USERNAME = process.argv[2] || 'chw_test_1';
const POWERSYNC_URL = process.env.POWERSYNC_URL || 'http://powersync:8080';
const COUCH_URL = 'http://admin:secret21512@couchdb:5984';
const KEY_PATH = '/workspace/cht-core/.devcontainer/powersync-config/dev-private-key.pem';
const DB_PATH = `/tmp/ps-bench-${Date.now()}.db`;

function md5(str) { return crypto.createHash('md5').update(str).digest('hex'); }
function base64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''); }

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: {} };
    if (u.username) opts.headers['Authorization'] = 'Basic ' + Buffer.from(`${u.username}:${u.password}`).toString('base64');
    http.get(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
  });
}

function generateJwt(userSettings, roles) {
  const privateKey = fs.readFileSync(KEY_PATH, 'utf8');
  const header = { alg: 'RS256', typ: 'JWT', kid: 'cht-dev-key-1' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userSettings._id,
    aud: 'cht-powersync-dev',
    iat: now,
    exp: now + 86400,
    role_hash: md5(roles.sort().join(',')),
    contact_id: userSettings.contact_id || '',
    report_depth: -1,
    can_view_unallocated: 'false',
    roles,
  };
  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${headerB64}.${payloadB64}`);
  return `${headerB64}.${payloadB64}.${base64url(sign.sign(privateKey))}`;
}

(async () => {
  console.log('=== PowerSync/PostgreSQL Benchmark (Node.js) ===');
  console.log(`User: ${USERNAME}`);
  console.log(`PowerSync: ${POWERSYNC_URL}`);
  console.log('');

  // Get user settings
  const userSettings = await fetchJson(`${COUCH_URL}/medic/org.couchdb.user:${USERNAME}`);
  const ROLE_OVERRIDE = process.env.CHT_ROLE;
  const roles = ROLE_OVERRIDE ? [ROLE_OVERRIDE] : (Array.isArray(userSettings.roles) ? userSettings.roles : [userSettings.roles]);
  console.log(`Roles: ${JSON.stringify(roles)}`);
  console.log(`Contact: ${userSettings.contact_id}`);

  const token = generateJwt(userSettings, roles);
  const roleHash = md5(roles.sort().join(','));
  console.log(`Role hash: ${roleHash}`);
  console.log('');

  // Import PowerSync Node SDK
  const { PowerSyncDatabase } = require('@powersync/node');
  const { Schema, Table, Column, ColumnType } = require('@powersync/common');

  function t(name) { return new Column({ name, type: ColumnType.TEXT }); }

  const schema = new Schema([
    new Table({ name: 'contacts', columns: [t('name'), t('contact_type'), t('parent_id'), t('patient_id'), t('place_id'), t('phone'), t('date_of_birth'), t('sex'), t('reported_date'), t('doc')] }),
    new Table({ name: 'reports', columns: [t('form'), t('patient_id'), t('submitter_id'), t('reported_date'), t('is_private'), t('needs_signoff'), t('fields'), t('doc')] }),
    new Table({ name: 'sms_messages', columns: [t('contact_id'), t('reported_date'), t('is_outgoing'), t('doc')] }),
    new Table({ name: 'targets', columns: [t('owner'), t('reporting_period'), t('targets_data'), t('doc')] }),
    new Table({ name: 'tasks', columns: [t('task_user'), t('owner'), t('requester'), t('state'), t('emission'), t('due_date'), t('start_date'), t('end_date'), t('doc')] }),
    new Table({ name: 'global_config', columns: [t('doc_type'), t('doc')] }),
    new Table({ name: 'user_settings_doc', columns: [t('doc_type'), t('doc')] }),
    new Table({ name: 'user_meta', columns: [t('meta_type'), t('user_id'), t('doc')] }),
  ]);

  // Init with debug logging
  const { LogLevel } = require('@powersync/common');
  console.log('Initializing PowerSync database (debug logging on)...');
  const tInit = Date.now();
  const db = new PowerSyncDatabase({ schema, database: { dbFilename: DB_PATH }, logger: { error: (...a) => console.error('[PS:ERROR]', ...a), warn: (...a) => console.warn('[PS:WARN]', ...a), info: (...a) => console.log('[PS:INFO]', ...a), debug: (...a) => console.log('[PS:DEBUG]', ...a), trace: (...a) => {} } });
  await db.getAll('SELECT 1');
  const initMs = Date.now() - tInit;
  console.log(`DB init: ${initMs}ms`);

  // Connect
  console.log('Connecting to PowerSync...');
  const connector = {
    fetchCredentials: async () => {
      console.log('  [fetchCredentials] returning endpoint:', POWERSYNC_URL);
      return { endpoint: POWERSYNC_URL, token };
    },
    uploadData: async (database) => {
      // No-op for benchmark
    },
  };
  await db.connect(connector);
  console.log('connect() resolved');

  // Monitor sync progress
  const monitorInterval = setInterval(async () => {
    try {
      const status = db.currentStatus;
      const tables = await db.getAll("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
      const counts = {};
      for (const t of tables) {
        try { counts[t.name] = (await db.get(`SELECT COUNT(*) as c FROM "${t.name}"`)).c; } catch {}
      }
      const elapsed = Math.round((Date.now() - tInit) / 1000);
      console.log(`  ${elapsed}s: tables=${JSON.stringify(counts)} connected=${status?.connected} synced=${status?.lastSyncedAt || 'no'}`);
    } catch {}
  }, 15000);

  // Priority-1 sync
  console.log('Waiting for priority-1 sync (contacts)...');
  const tP1 = Date.now();
  let p1Success = false;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 600000); // 10 min for priority-1
    await db.waitForFirstSync({ signal: ctrl.signal, priority: 1 });
    clearTimeout(to);
    p1Success = true;
  } catch (e) {
    console.log(`Priority-1 sync failed/timed out: ${e.message}`);
  }
  const p1Ms = Date.now() - tP1;

  const contactsP1 = (await db.get('SELECT COUNT(*) as c FROM contacts')).c;
  console.log(`Priority-1: ${p1Ms}ms, ${contactsP1} contacts, success: ${p1Success}`);

  // Full sync
  console.log('Waiting for full sync...');
  const tFull = Date.now();
  let fullSuccess = false;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 600000);
    await db.waitForFirstSync({ signal: ctrl.signal });
    clearTimeout(to);
    fullSuccess = true;
  } catch (e) {
    console.log(`Full sync failed/timed out: ${e.message}`);
  }
  const fullMs = Date.now() - tFull;

  // Row counts
  const contacts = (await db.get('SELECT COUNT(*) as c FROM contacts')).c;
  const reports = (await db.get('SELECT COUNT(*) as c FROM reports')).c;
  const tasks = (await db.get('SELECT COUNT(*) as c FROM tasks')).c;
  const globalConfig = (await db.get('SELECT COUNT(*) as c FROM global_config')).c;

  // Query benchmarks
  const tQ1 = Date.now();
  await db.getAll("SELECT id, state, owner, due_date FROM tasks WHERE state = 'Ready' ORDER BY due_date LIMIT 100");
  const taskQueryMs = Date.now() - tQ1;

  const tQ2 = Date.now();
  await db.getAll("SELECT id, name, contact_type, parent_id FROM contacts LIMIT 200");
  const contactQueryMs = Date.now() - tQ2;

  const tQ3 = Date.now();
  await db.getAll("SELECT id, form, reported_date FROM reports ORDER BY reported_date DESC LIMIT 100");
  const reportQueryMs = Date.now() - tQ3;

  // DB file size
  const dbSizeMB = fs.existsSync(DB_PATH) ? parseFloat((fs.statSync(DB_PATH).size / 1e6).toFixed(1)) : 0;

  // Cleanup
  clearInterval(monitorInterval);
  await db.disconnectAndClear();
  try { fs.unlinkSync(DB_PATH); } catch {}

  // Results
  const totalMs = Date.now() - tInit;

  console.log('');
  console.log('=============================================');
  console.log('  PowerSync/PostgreSQL Benchmark Results');
  console.log('  Node.js (native SQLite, no WASM)');
  console.log('=============================================');
  console.log(`  User:                ${USERNAME}`);
  console.log(`  Sync completed:      ${fullSuccess ? 'YES' : 'TIMED OUT'}`);
  console.log(`  DB init:             ${initMs}ms`);
  console.log(`  Priority-1 sync:     ${p1Ms}ms (${p1Success ? 'OK' : 'TIMEOUT'})`);
  console.log(`  Contacts after p1:   ${contactsP1}`);
  console.log(`  Full sync:           ${fullMs}ms (${(fullMs/1000).toFixed(0)}s)`);
  console.log(`  Total time:          ${totalMs}ms (${(totalMs/1000).toFixed(0)}s)`);
  console.log(`  Contacts:            ${contacts}`);
  console.log(`  Reports:             ${reports}`);
  console.log(`  Tasks:               ${tasks}`);
  console.log(`  Global config:       ${globalConfig}`);
  console.log(`  SQLite DB size:      ${dbSizeMB}MB`);
  console.log(`  Task list query:     ${taskQueryMs}ms`);
  console.log(`  Contact query:       ${contactQueryMs}ms`);
  console.log(`  Report query:        ${reportQueryMs}ms`);
  console.log('=============================================');
  console.log('');
  console.log('NOTE: Add ~3-8s to init time for Go edition WASM overhead.');
  console.log('NOTE: No network throttling applied (measures sync engine, not network).');

  const output = {
    benchmark: 'powersync-postgresql',
    mode: 'nodejs-native',
    timestamp: new Date().toISOString(),
    user: USERNAME,
    roles,
    roleHash,
    syncCompleted: fullSuccess,
    dbInitMs: initMs,
    priority1SyncMs: p1Ms,
    priority1Success: p1Success,
    contactsAfterP1: contactsP1,
    fullSyncMs: fullMs,
    totalMs,
    contactCount: contacts,
    reportCount: reports,
    taskCount: tasks,
    globalConfigCount: globalConfig,
    sqliteDbSizeMB: dbSizeMB,
    taskQueryMs,
    contactQueryMs,
    reportQueryMs,
  };

  fs.writeFileSync('/tmp/benchmark-powersync-results.json', JSON.stringify(output, null, 2));
  console.log('Results written to /tmp/benchmark-powersync-results.json');

  process.exit(0);
})().catch(e => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});
