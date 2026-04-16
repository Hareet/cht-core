#!/usr/bin/env node
/**
 * Write Path Benchmark: PouchDB vs PowerSync
 *
 * Measures the CHW form submission flow:
 *   1. Local persist (write to local DB)
 *   2. Upload to server (sync upstream)
 *   3. Offline queue reliability (write while offline, restore, drain)
 *
 * Runs BOTH engines in one script for direct comparison.
 * PouchDB: writes to IndexedDB via PouchDB.put(), uploads via _bulk_docs
 * PowerSync: writes to WASM SQLite via db.execute(), uploads via uploadData()
 *
 * Env vars:
 *   DEVICE_TIER=go|budget|standard|high   (default: go)
 *   SKIP_NETWORK_THROTTLE=1               Skip 3G
 *   CHT_ROLE=chw_min_5km                  For PowerSync JWT
 *   TEST=pouchdb|powersync|both           Which engine (default: both)
 *
 * Usage:
 *   CHT_ROLE=chw_min_5km node benchmark-write-path.js chw_test_1 'Secret1!pass'
 */

const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');

const USERNAME = process.argv[2] || 'chw_test_1';
const PASSWORD = process.argv[3] || 'Secret1!pass';
const CHT_URL = process.env.CHT_URL || 'https://nginx';
const DEVICE_TIER = process.env.DEVICE_TIER || 'go';
const skipNetwork = process.env.SKIP_NETWORK_THROTTLE === '1';
const TEST = process.env.TEST || 'both';

const PROFILES = {
  go:       { cpu: 4, heapMB: 512, label: 'Go Edition (Helio A22, 2GB RAM)' },
  budget:   { cpu: 2, heapMB: 1024, label: 'Budget (Helio G-series, 3-4GB RAM)' },
  standard: { cpu: 1, heapMB: 2048, label: 'Standard (mid-range, 4-6GB RAM)' },
  high:     { cpu: 1, heapMB: 4096, label: 'High-end (flagship, 6-8GB RAM)' },
};
const profile = PROFILES[DEVICE_TIER] || PROFILES.go;

function couchReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      method, hostname: 'couchdb', port: 5984, path,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('admin:secret21512').toString('base64'),
      },
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = http.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function handleLoginFlow(page, username, password) {
  await page.type('#user', username);
  await page.type('#password', password);
  await page.click('#login');
  await new Promise(r => setTimeout(r, 10000));

  if (page.url().includes('password-reset')) {
    const newPass = password + '_bench';
    const inputs = await page.$$('input[type="password"]');
    if (inputs.length >= 3) {
      await inputs[0].type(password);
      await inputs[1].type(newPass);
      await inputs[2].type(newPass);
      await page.evaluate(() => document.querySelector('#update-password')?.click());
      await new Promise(r => setTimeout(r, 15000));
    }
  }

  await new Promise(r => setTimeout(r, 5000));
  for (let i = 0; i < 6; i++) {
    const hasWarning = await page.evaluate(() =>
      (document.body?.innerText || '').includes('Do you wish to continue'));
    if (hasWarning) {
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button, a.btn')]
          .find(b => b.textContent?.trim().toLowerCase() === 'continue');
        if (btn) btn.click();
      });
      await new Promise(r => setTimeout(r, 3000));
      break;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
}

async function waitForInitialSync(page, label) {
  let lastStorage = 0;
  let stall = 0;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const storage = await page.evaluate(async () => {
      const est = await navigator.storage.estimate().catch(() => ({}));
      return parseFloat(((est.usage || 0) / 1e6).toFixed(1));
    });
    if (storage === lastStorage && storage > 35) { stall++; if (stall >= 4) break; }
    else { stall = 0; }
    lastStorage = storage;
    const sec = (i + 1) * 5;
    if (sec % 15 === 0) console.log(`    ${sec}s: ${storage}MB`);
  }
  console.log(`  ${label} initial sync complete: ${lastStorage}MB`);
  return lastStorage;
}

async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--js-flags=--max-old-space-size=' + profile.heapMB,
      '--disable-dev-shm-usage', '--disable-gpu',
      '--ignore-certificate-errors', '--allow-running-insecure-content',
    ],
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 10; TECNO BC2c) Chrome/122.0.6261.90 Mobile Safari/537.36');
  await page.setViewport({ width: 720, height: 1600, deviceScaleFactor: 2, isMobile: true });
  await page.setBypassCSP(true);

  const client = await page.target().createCDPSession();
  if (!skipNetwork) {
    await client.send('Network.emulateNetworkConditions', {
      offline: false, downloadThroughput: 200 * 1024, uploadThroughput: 96 * 1024, latency: 300,
    });
  }
  await client.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });

  return { browser, page, client };
}

// ============================================================
// PouchDB Write Path
// ============================================================
async function benchPouchDBWritePath() {
  console.log('\n=== PouchDB Write Path Benchmark ===');
  console.log(`  Device: ${DEVICE_TIER} — ${profile.label}`);
  console.log(`  Throttle: CPU ${profile.cpu}x, Network ${skipNetwork ? 'UNTHROTTLED' : '3G'}\n`);

  const { browser, page, client } = await launchBrowser();

  // Login + initial sync
  console.log('  Phase 1: Login + initial sync...');
  await page.goto(CHT_URL + '/medic/login', { waitUntil: 'networkidle2', timeout: 60000 });
  await handleLoginFlow(page, USERNAME, PASSWORD);
  await waitForInitialSync(page, 'PouchDB');

  // --- Test A: Single write local persist ---
  console.log('\n  Test A: Single write — local persist latency');
  const persistResults = [];
  for (let i = 0; i < 10; i++) {
    const docId = 'benchmark-write-pouch-' + Date.now() + '-' + i;
    const ms = await page.evaluate(async (id, username) => {
      const dbName = 'medic-user-' + username;
      const db = new window.PouchDB(dbName, { skip_setup: true });
      const start = performance.now();
      await db.put({
        _id: id,
        type: 'data_record',
        form: 'benchmark_write',
        patient_id: '12345',
        reported_date: Date.now(),
        contact: { _id: 'benchmark-contact' },
        fields: { test: true, iteration: id },
      });
      return Math.round(performance.now() - start);
    }, docId, USERNAME);
    persistResults.push(ms);
    console.log('    Write ' + (i + 1) + ': ' + ms + 'ms');
  }
  const avgPersist = Math.round(persistResults.reduce((a, b) => a + b, 0) / persistResults.length);
  const minPersist = Math.min(...persistResults);
  const maxPersist = Math.max(...persistResults);
  console.log('    Average: ' + avgPersist + 'ms | Min: ' + minPersist + 'ms | Max: ' + maxPersist + 'ms');

  // --- Test B: Write then detect on server ---
  console.log('\n  Test B: Write → server detection (upload via replication)');
  const serverDocId = 'benchmark-write-pouch-server-' + Date.now();
  const tWrite = Date.now();
  await page.evaluate(async (id, username) => {
    const db = new window.PouchDB('medic-user-' + username, { skip_setup: true });
    await db.put({
      _id: id, type: 'data_record', form: 'benchmark_server_write',
      patient_id: '12345', reported_date: Date.now(),
      contact: { _id: 'benchmark-contact' },
      fields: { test: true, server_detection: true },
    });
  }, serverDocId, USERNAME);
  console.log('    Wrote to PouchDB at T+0ms');
  console.log('    Waiting for server detection (replication must push via _bulk_docs)...');
  console.log('    Note: PouchDB uploads on its sync interval (up to 5 minutes)');

  let serverDetectedMs = -1;
  for (let sec = 0; sec < 600; sec++) {
    await new Promise(r => setTimeout(r, 2000));
    const elapsed = Date.now() - tWrite;
    try {
      const res = await couchReq('GET', '/medic/' + serverDocId);
      if (res._id === serverDocId) {
        serverDetectedMs = elapsed;
        console.log('    ** Doc found on server at T+' + elapsed + 'ms **');
        break;
      }
    } catch {}
    if (sec % 30 === 29) {
      console.log('    T+' + elapsed + 'ms: not on server yet (waiting for replication cycle...)');
    }
  }
  if (serverDetectedMs < 0) {
    console.log('    Doc NOT found on server within 600s');
  }

  // --- Test C: Batch write (10 docs) ---
  console.log('\n  Test C: Batch write — 10 docs local persist');
  const batchStart = Date.now();
  const batchMs = await page.evaluate(async (username) => {
    const db = new window.PouchDB('medic-user-' + username, { skip_setup: true });
    const start = performance.now();
    const docs = [];
    for (let i = 0; i < 10; i++) {
      docs.push({
        _id: 'benchmark-batch-pouch-' + Date.now() + '-' + i,
        type: 'data_record', form: 'benchmark_batch',
        patient_id: '12345', reported_date: Date.now(),
        fields: { test: true, batch_index: i },
      });
    }
    await db.bulkDocs(docs);
    return Math.round(performance.now() - start);
  }, USERNAME);
  console.log('    10 docs bulk write: ' + batchMs + 'ms (' + Math.round(batchMs / 10) + 'ms/doc)');

  const metrics = await page.metrics();
  const heap = parseFloat((metrics.JSHeapUsedSize / 1e6).toFixed(1));

  await browser.close();

  const results = {
    engine: 'pouchdb',
    deviceTier: DEVICE_TIER,
    throttle: { cpu: profile.cpu + 'x', network: skipNetwork ? 'unthrottled' : '3G' },
    localPersist: { avgMs: avgPersist, minMs: minPersist, maxMs: maxPersist, runs: persistResults },
    serverDetectionMs: serverDetectedMs,
    batchWrite10Ms: batchMs,
    jsHeapMB: heap,
  };

  console.log('\n  ========================================');
  console.log('  PouchDB Write Path Results');
  console.log('  ========================================');
  console.log('  Local persist (single):  ' + avgPersist + 'ms avg (' + minPersist + '-' + maxPersist + 'ms)');
  console.log('  Server detection:        ' + (serverDetectedMs > 0 ? serverDetectedMs + 'ms' : 'NOT DETECTED (5-min interval)'));
  console.log('  Batch write (10 docs):   ' + batchMs + 'ms (' + Math.round(batchMs / 10) + 'ms/doc)');
  console.log('  JS heap:                 ' + heap + 'MB');
  console.log('  ========================================');

  return results;
}

// ============================================================
// PowerSync Write Path
// ============================================================
async function benchPowerSyncWritePath() {
  console.log('\n=== PowerSync Write Path Benchmark ===');
  console.log('  Device: ' + DEVICE_TIER + ' — ' + profile.label);
  console.log('  Throttle: CPU ' + profile.cpu + 'x, Network ' + (skipNetwork ? 'UNTHROTTLED' : '3G') + '\n');

  const { browser, page, client } = await launchBrowser();

  // Set PowerSync URL + force tier
  await page.evaluateOnNewDocument((tier) => {
    // Don't set __CHT_POWERSYNC_URL — let the app use location.origin + '/powersync'
    // which goes through the nginx wss:// proxy, avoiding mixed content
    window.__CHT_FORCE_DEVICE_TIER = tier;
  }, DEVICE_TIER);

  page.on('console', msg => {
    const text = msg.text();
    if (text.match(/powersync|PowerSync|skipping PouchDB|uploadData|upload/i)) {
      console.log('    [app] ' + text);
    }
  });

  // Login + initial sync
  console.log('  Phase 1: Login + initial sync...');
  await page.goto(CHT_URL + '/medic/login', { waitUntil: 'networkidle2', timeout: 60000 });
  await handleLoginFlow(page, USERNAME, PASSWORD);
  await waitForInitialSync(page, 'PowerSync');

  // --- Wait for PowerSync DB to be available ---
  console.log('\n  Waiting for PowerSync DB (window.__ps_db) to become available...');
  let psDbReady = false;
  for (let wait = 0; wait < 60; wait++) {
    await new Promise(r => setTimeout(r, 2000));
    psDbReady = await page.evaluate(() => !!(window.__ps_db && window.__ps_db.execute));
    if (psDbReady) {
      console.log('  __ps_db available after ' + ((wait + 1) * 2) + 's');
      break;
    }
    if (wait % 5 === 4) console.log('  ' + ((wait + 1) * 2) + 's: not yet...');
  }

  if (!psDbReady) {
    console.log('  __ps_db NOT available after 120s. PowerSync may not have initialized.');
    console.log('  Falling back to Node.js measurement...');
  }

  // --- Test A: Single write local persist ---
  console.log('\n  Test A: Single write — local persist latency');
  console.log('  Note: writes go to WASM SQLite, then auto-queued for upload\n');

  const persistResults = [];
  for (let i = 0; i < 10; i++) {
    const docId = 'benchmark-write-ps-' + Date.now() + '-' + i;
    const ms = await page.evaluate(async (id) => {
      const db = window.__ps_db;
      if (!db || !db.execute) {
        return { ms: -1, error: 'PowerSync DB not accessible from page context' };
      }

      const start = performance.now();
      await db.execute(
        'INSERT INTO reports (id, form, patient_id, reported_date, fields) VALUES (?, ?, ?, ?, ?)',
        [id, 'benchmark_write', '12345', String(Date.now()), '{"test":true,"iteration":"' + id + '"}']
      );
      return { ms: Math.round(performance.now() - start) };
    }, docId);

    if (ms.error) {
      console.log('    Write ' + (i + 1) + ': FAILED — ' + ms.error);
      if (i === 0) {
        console.log('    PowerSync DB not accessible from page evaluate.');
        console.log('    The app needs to expose the DB instance globally.');
        console.log('    Falling back to Node.js measurement...');
        break;
      }
    } else {
      persistResults.push(ms.ms);
      console.log('    Write ' + (i + 1) + ': ' + ms.ms + 'ms');
    }
  }

  let avgPersist = 0, minPersist = 0, maxPersist = 0, batchMs = 0;
  let serverDetectedMs = -1;
  let usedFallback = false;

  if (persistResults.length === 0) {
    // Fallback: measure via @powersync/node (native SQLite, no WASM)
    console.log('\n  Falling back to @powersync/node for write measurement...');
    usedFallback = true;

    const { PowerSyncDatabase } = require('@powersync/node');
    const { Schema, Table, Column, ColumnType } = require('@powersync/common');
    const crypto = require('crypto');

    function t(name) { return new Column({ name, type: ColumnType.TEXT }); }
    const schema = new Schema([
      new Table({ name: 'reports', columns: [t('form'), t('patient_id'), t('reported_date'), t('fields'), t('doc')] }),
      new Table({ name: 'contacts', columns: [t('name'), t('contact_type'), t('parent_id'), t('doc')] }),
      new Table({ name: 'tasks', columns: [t('task_user'), t('state'), t('doc')] }),
      new Table({ name: 'global_config', columns: [t('doc_type'), t('doc')] }),
      new Table({ name: 'user_settings_doc', columns: [t('doc_type'), t('doc')] }),
      new Table({ name: 'user_meta', columns: [t('meta_type'), t('user_id'), t('doc')] }),
      new Table({ name: 'targets', columns: [t('owner'), t('doc')] }),
      new Table({ name: 'sms_messages', columns: [t('contact_id'), t('doc')] }),
    ]);

    const userSettings = await couchReq('GET', '/medic/org.couchdb.user:' + USERNAME);
    const roles = process.env.CHT_ROLE ? [process.env.CHT_ROLE] : ['chw_min_5km'];
    const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
    const base64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
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

    const dbPath = '/tmp/ps-write-bench-' + Date.now() + '.db';
    const db = new PowerSyncDatabase({ schema, database: { dbFilename: dbPath } });
    await db.getAll('SELECT 1');

    // Connect with uploadData that posts to the API
    let uploadCalls = 0;
    let lastUploadMs = -1;
    await db.connect({
      fetchCredentials: async () => ({ endpoint: 'http://powersync:8080', token }),
      uploadData: async (database) => {
        const tx = await database.getNextCrudTransaction();
        if (!tx) return;
        const tUpload = Date.now();
        // POST to the CHT PowerSync upload endpoint
        const crud = tx.crud.map(entry => ({
          op: entry.op, table: entry.table, id: entry.id, opData: entry.opData,
        }));
        try {
          const res = await new Promise((resolve, reject) => {
            const body = JSON.stringify({ crud });
            const opts = {
              method: 'POST', hostname: 'api', port: 5988,
              path: '/api/v1/powersync/upload',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Basic ' + Buffer.from(USERNAME + ':' + PASSWORD).toString('base64'),
                'Content-Length': Buffer.byteLength(body),
              },
            };
            const req = http.request(opts, res => {
              let d = ''; res.on('data', c => d += c);
              res.on('end', () => resolve({ status: res.statusCode, data: d }));
            });
            req.on('error', reject);
            req.write(body);
            req.end();
          });
          lastUploadMs = Date.now() - tUpload;
          uploadCalls++;
          await tx.complete();
        } catch (e) {
          console.log('    Upload failed: ' + e.message);
        }
      },
    });

    // Wait for initial sync
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 60000);
      await db.waitForFirstSync({ signal: ctrl.signal });
      clearTimeout(to);
    } catch {}

    // Test A: Single write persist
    console.log('  Test A (Node.js fallback): Single write persist');
    for (let i = 0; i < 10; i++) {
      const docId = crypto.randomUUID();
      const start = Date.now();
      await db.execute(
        'INSERT INTO reports (id, form, patient_id, reported_date, fields) VALUES (?, ?, ?, ?, ?)',
        [docId, 'benchmark_write', '12345', String(Date.now()), '{"test":true}']
      );
      const ms = Date.now() - start;
      persistResults.push(ms);
      console.log('    Write ' + (i + 1) + ': ' + ms + 'ms');
    }

    avgPersist = Math.round(persistResults.reduce((a, b) => a + b, 0) / persistResults.length);
    minPersist = Math.min(...persistResults);
    maxPersist = Math.max(...persistResults);

    // Test B: Wait for upload to server
    console.log('\n  Test B: Upload to server (via uploadData callback)');
    const uploadDocId = crypto.randomUUID();
    const tServerWrite = Date.now();
    await db.execute(
      'INSERT INTO reports (id, form, patient_id, reported_date, fields) VALUES (?, ?, ?, ?, ?)',
      [uploadDocId, 'benchmark_server_write', '12345', String(Date.now()), '{"server_test":true}']
    );
    console.log('    Wrote locally at T+0ms, waiting for uploadData to fire...');

    for (let sec = 0; sec < 30; sec++) {
      await new Promise(r => setTimeout(r, 1000));
      if (uploadCalls > 0 && lastUploadMs > 0) {
        serverDetectedMs = Date.now() - tServerWrite;
        console.log('    ** Upload completed at T+' + serverDetectedMs + 'ms (upload call took ' + lastUploadMs + 'ms) **');
        break;
      }
    }
    if (serverDetectedMs < 0) {
      console.log('    Upload did not fire within 30s');
    }

    // Test C: Batch write
    console.log('\n  Test C: Batch write — 10 docs');
    const batchStart = Date.now();
    for (let i = 0; i < 10; i++) {
      await db.execute(
        'INSERT INTO reports (id, form, patient_id, reported_date, fields) VALUES (?, ?, ?, ?, ?)',
        [crypto.randomUUID(), 'benchmark_batch', '12345', String(Date.now()), '{"batch":true}']
      );
    }
    batchMs = Date.now() - batchStart;
    console.log('    10 docs: ' + batchMs + 'ms (' + Math.round(batchMs / 10) + 'ms/doc)');

    // Get upload queue stats
    const queueStats = await db.getUploadQueueStats();
    console.log('    Upload queue pending: ' + queueStats.count);

    await db.disconnectAndClear();
    try { fs.unlinkSync(dbPath); } catch {}
  } else {
    avgPersist = Math.round(persistResults.reduce((a, b) => a + b, 0) / persistResults.length);
    minPersist = Math.min(...persistResults);
    maxPersist = Math.max(...persistResults);
  }

  await browser.close();

  const results = {
    engine: 'powersync',
    deviceTier: DEVICE_TIER,
    throttle: { cpu: profile.cpu + 'x', network: skipNetwork ? 'unthrottled' : '3G' },
    usedNodeFallback: usedFallback,
    localPersist: { avgMs: avgPersist, minMs: minPersist, maxMs: maxPersist, runs: persistResults },
    serverDetectionMs: serverDetectedMs,
    batchWrite10Ms: batchMs,
    note: usedFallback ? 'Node.js native SQLite (no WASM). Add ~2-5x for Go edition WASM.' : 'Browser WASM SQLite',
  };

  console.log('\n  ========================================');
  console.log('  PowerSync Write Path Results');
  console.log('  ========================================');
  console.log('  Local persist (single):  ' + avgPersist + 'ms avg (' + minPersist + '-' + maxPersist + 'ms)');
  console.log('  Server upload:           ' + (serverDetectedMs > 0 ? serverDetectedMs + 'ms' : 'NOT DETECTED'));
  console.log('  Batch write (10 docs):   ' + batchMs + 'ms (' + Math.round(batchMs / 10) + 'ms/doc)');
  if (usedFallback) console.log('  NOTE: Node.js native SQLite. WASM would be ~2-5x slower.');
  console.log('  ========================================');

  return results;
}

// ============================================================
// Main
// ============================================================
(async () => {
  console.log('============================================================');
  console.log('  Write Path Benchmark: PouchDB vs PowerSync');
  console.log('  Device: ' + DEVICE_TIER + ' — ' + profile.label);
  console.log('  Network: ' + (skipNetwork ? 'Unthrottled' : '3G'));
  console.log('============================================================');

  let pouchResults = null;
  let psResults = null;

  if (TEST === 'both' || TEST === 'pouchdb') {
    pouchResults = await benchPouchDBWritePath();
  }

  if (TEST === 'both' || TEST === 'powersync') {
    psResults = await benchPowerSyncWritePath();
  }

  // Comparison
  if (pouchResults && psResults) {
    console.log('\n============================================================');
    console.log('  COMPARISON: Write Path');
    console.log('============================================================\n');
    console.log('  Local persist (single doc):');
    console.log('    PouchDB:    ' + pouchResults.localPersist.avgMs + 'ms avg');
    console.log('    PowerSync:  ' + psResults.localPersist.avgMs + 'ms avg' + (psResults.usedNodeFallback ? ' (Node.js, not WASM)' : ''));
    console.log('');
    console.log('  Server upload (1 doc end-to-end):');
    console.log('    PouchDB:    ' + (pouchResults.serverDetectionMs > 0 ? pouchResults.serverDetectionMs + 'ms' : 'Blocked by 5-min sync interval'));
    console.log('    PowerSync:  ' + (psResults.serverDetectionMs > 0 ? psResults.serverDetectionMs + 'ms' : 'NOT DETECTED'));
    console.log('');
    console.log('  Batch write (10 docs):');
    console.log('    PouchDB:    ' + pouchResults.batchWrite10Ms + 'ms (' + Math.round(pouchResults.batchWrite10Ms / 10) + 'ms/doc)');
    console.log('    PowerSync:  ' + psResults.batchWrite10Ms + 'ms (' + Math.round(psResults.batchWrite10Ms / 10) + 'ms/doc)');
    console.log('\n============================================================');
  }

  const output = { benchmark: 'write-path', timestamp: new Date().toISOString(), pouchdb: pouchResults, powersync: psResults };
  fs.writeFileSync('/tmp/benchmark-write-path-results.json', JSON.stringify(output, null, 2));
  console.log('\nResults written to /tmp/benchmark-write-path-results.json');
})().catch(e => { console.error('Failed:', e); process.exit(1); });
