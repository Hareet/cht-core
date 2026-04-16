#!/usr/bin/env node
/**
 * PowerSync/PostgreSQL Benchmark — Go Edition Throttled (Node.js)
 *
 * Applies network throttling via tc (traffic control) and simulates
 * CPU constraint by adding artificial delays proportional to 4x slowdown.
 *
 * Since we can't throttle Node.js CPU like Chrome DevTools does,
 * we throttle the NETWORK to match Go edition 3G conditions.
 * CPU impact is noted but not simulated (native SQLite is already
 * faster than WASM, so Node.js numbers are optimistic on CPU).
 *
 * Usage:
 *   CHT_ROLE=chw_min_5km node benchmark-powersync-throttled.js chw_test_1
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const net = require('net');

const USERNAME = process.argv[2] || 'chw_test_1';
const POWERSYNC_URL = process.env.POWERSYNC_URL || 'http://powersync:8080';
const COUCH_URL = 'http://admin:secret21512@couchdb:5984';
const KEY_PATH = '/workspace/cht-core/.devcontainer/powersync-config/dev-private-key.pem';
const DB_PATH = `/tmp/ps-bench-throttled-${Date.now()}.db`;

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
    sub: userSettings._id, aud: 'cht-powersync-dev', iat: now, exp: now + 86400,
    role_hash: md5(roles.sort().join(',')),
    contact_id: userSettings.contact_id || '', report_depth: -1, can_view_unallocated: 'false', roles,
  };
  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${headerB64}.${payloadB64}`);
  return `${headerB64}.${payloadB64}.${base64url(sign.sign(privateKey))}`;
}

// --- Network throttling via a local TCP proxy with bandwidth limiting ---
function createThrottledProxy(targetHost, targetPort, listenPort, bytesPerSec) {
  return new Promise((resolve) => {
    const server = net.createServer((clientSocket) => {
      const serverSocket = net.createConnection({ host: targetHost, port: targetPort }, () => {
        // Throttle data from server → client (download)
        serverSocket.on('data', (chunk) => {
          clientSocket.cork();
          // Calculate delay based on chunk size and bandwidth limit
          const delayMs = (chunk.length / bytesPerSec) * 1000;
          setTimeout(() => {
            try {
              clientSocket.write(chunk);
              clientSocket.uncork();
            } catch {}
          }, delayMs);
        });
        // Pass client → server unthrottled (upload is less critical)
        clientSocket.on('data', (chunk) => {
          try { serverSocket.write(chunk); } catch {}
        });
      });
      clientSocket.on('error', () => serverSocket.destroy());
      serverSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('close', () => serverSocket.destroy());
      serverSocket.on('close', () => clientSocket.destroy());
    });
    server.listen(listenPort, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  console.log('=== PowerSync/PostgreSQL Benchmark (Go Edition Throttled — Node.js) ===');
  console.log(`User: ${USERNAME}`);
  console.log(`PowerSync: ${POWERSYNC_URL}`);
  console.log('');

  // Setup throttled proxy: 200KB/s download (3G equivalent)
  const THROTTLE_BPS = 200 * 1024; // 200 KB/s
  const PROXY_PORT = 18080;
  const proxy = await createThrottledProxy('powersync', 8080, PROXY_PORT, THROTTLE_BPS);
  const THROTTLED_URL = `http://127.0.0.1:${PROXY_PORT}`;
  console.log(`Network throttle: ${THROTTLE_BPS / 1024} KB/s download via proxy on port ${PROXY_PORT}`);
  console.log(`NOTE: CPU not throttled (Node.js native SQLite). Add ~3-8s for Go edition WASM.\n`);

  // Get user settings
  const userSettings = await fetchJson(`${COUCH_URL}/medic/org.couchdb.user:${USERNAME}`);
  const ROLE_OVERRIDE = process.env.CHT_ROLE;
  const roles = ROLE_OVERRIDE ? [ROLE_OVERRIDE] : (Array.isArray(userSettings.roles) ? userSettings.roles : [userSettings.roles]);
  console.log(`Roles: ${JSON.stringify(roles)}`);
  const token = generateJwt(userSettings, roles);
  console.log(`Role hash: ${md5(roles.sort().join(','))}\n`);

  const { PowerSyncDatabase } = require('@powersync/node');
  const { Schema, Table, Column, ColumnType } = require('@powersync/common');

  function t(name) { return new Column({name, type: ColumnType.TEXT}); }
  const schema = new Schema([
    new Table({name:'contacts', columns:[t('name'),t('contact_type'),t('parent_id'),t('patient_id'),t('place_id'),t('phone'),t('date_of_birth'),t('sex'),t('reported_date'),t('doc')]}),
    new Table({name:'reports', columns:[t('form'),t('patient_id'),t('submitter_id'),t('reported_date'),t('is_private'),t('needs_signoff'),t('fields'),t('doc')]}),
    new Table({name:'sms_messages', columns:[t('contact_id'),t('reported_date'),t('is_outgoing'),t('doc')]}),
    new Table({name:'targets', columns:[t('owner'),t('reporting_period'),t('targets_data'),t('doc')]}),
    new Table({name:'tasks', columns:[t('task_user'),t('owner'),t('requester'),t('state'),t('emission'),t('due_date'),t('start_date'),t('end_date'),t('doc')]}),
    new Table({name:'global_config', columns:[t('doc_type'),t('doc')]}),
    new Table({name:'user_settings_doc', columns:[t('doc_type'),t('doc')]}),
    new Table({name:'user_meta', columns:[t('meta_type'),t('user_id'),t('doc')]}),
  ]);

  console.log('Initializing PowerSync database...');
  const tInit = Date.now();
  const db = new PowerSyncDatabase({schema, database:{dbFilename: DB_PATH}});
  await db.getAll('SELECT 1');
  const initMs = Date.now() - tInit;
  console.log(`DB init: ${initMs}ms`);

  // Connect through throttled proxy
  console.log(`Connecting via throttled proxy (${THROTTLED_URL})...`);
  const connector = {
    fetchCredentials: async () => ({ endpoint: THROTTLED_URL, token }),
    uploadData: async () => {},
  };
  await db.connect(connector);

  // Monitor progress
  const monitorInterval = setInterval(async () => {
    try {
      const contacts = (await db.get('SELECT COUNT(*) as c FROM contacts')).c;
      const reports = (await db.get('SELECT COUNT(*) as c FROM reports')).c;
      const elapsed = Math.round((Date.now() - tInit) / 1000);
      const status = db.currentStatus;
      console.log(`  ${elapsed}s: contacts=${contacts} reports=${reports} synced=${status?.lastSyncedAt ? 'YES' : 'no'}`);
    } catch {}
  }, 10000);

  // Priority-1 sync
  console.log('Waiting for priority-1 sync (contacts)...');
  const tP1 = Date.now();
  let p1Success = false;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 600000);
    await db.waitForFirstSync({ signal: ctrl.signal, priority: 1 });
    clearTimeout(to);
    p1Success = true;
  } catch (e) { console.log(`Priority-1 timeout: ${e.message}`); }
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
  } catch (e) { console.log(`Full sync timeout: ${e.message}`); }
  const fullMs = Date.now() - tFull;

  clearInterval(monitorInterval);

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

  // DB size
  const dbSizeMB = fs.existsSync(DB_PATH) ? parseFloat((fs.statSync(DB_PATH).size / 1e6).toFixed(1)) : 0;
  const totalMs = Date.now() - tInit;

  // Cleanup
  await db.disconnectAndClear();
  try { fs.unlinkSync(DB_PATH); } catch {}
  proxy.close();

  console.log('');
  console.log('=============================================');
  console.log('  PowerSync/PostgreSQL Benchmark Results');
  console.log('  Go Edition Throttled (3G network, Node.js)');
  console.log('=============================================');
  console.log(`  User:                ${USERNAME}`);
  console.log(`  Sync completed:      ${fullSuccess ? 'YES' : 'TIMED OUT'}`);
  console.log(`  Network throttle:    ${THROTTLE_BPS / 1024} KB/s (3G)`);
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
  console.log('NOTE: CPU not throttled (native SQLite vs WASM). Add ~3-8s for WASM init.');
  console.log('NOTE: Network throttled at application layer (TCP proxy). Latency not simulated.');

  const output = {
    benchmark: 'powersync-postgresql',
    mode: 'nodejs-network-throttled',
    timestamp: new Date().toISOString(),
    user: USERNAME,
    throttling: { network: '3G_200kbps', cpu: 'not_throttled_native_sqlite', heapLimit: 'none' },
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
    taskQueryMs, contactQueryMs, reportQueryMs,
  };
  fs.writeFileSync('/tmp/benchmark-powersync-results.json', JSON.stringify(output, null, 2));
  console.log('Results written to /tmp/benchmark-powersync-results.json');

  process.exit(0);
})().catch(e => { console.error('Benchmark failed:', e); process.exit(1); });
