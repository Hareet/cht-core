#!/usr/bin/env node
/**
 * PouchDB Incremental Sync Benchmark
 *
 * 1. Login and wait for initial sync to complete
 * 2. Insert a new doc into CouchDB
 * 3. Wait for PouchDB to detect and sync the new doc
 * 4. Measure end-to-end time
 *
 * The bottleneck: GET /api/v1/replication/get-ids scans ALL docs (~810K)
 * on every sync cycle. This is O(total_database_size).
 *
 * Env vars:
 *   SKIP_NETWORK_THROTTLE=1  Skip 3G throttling
 *   CPU_THROTTLE=4           CPU slowdown factor (default: 4 for Go)
 */

const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');

const USERNAME = process.argv[2] || 'chw_test_1';
const PASSWORD = process.argv[3] || 'Secret1!pass';
const CHT_URL = process.env.CHT_URL || 'https://nginx';
const COUCH_URL = 'http://admin:secret21512@couchdb:5984';
const cpuThrottle = parseInt(process.env.CPU_THROTTLE || '4');
const skipNetwork = process.env.SKIP_NETWORK_THROTTLE === '1';

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

(async () => {
  console.log('=== PouchDB Incremental Sync Benchmark ===');
  console.log(`User: ${USERNAME}`);
  console.log(`Throttling: CPU ${cpuThrottle}x, Network ${skipNetwork ? 'UNTHROTTLED' : '3G'}\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--js-flags=--max-old-space-size=512',
      '--disable-dev-shm-usage', '--disable-gpu', '--ignore-certificate-errors'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Linux; Android 10; TECNO BC2c) Chrome/122.0.6261.90 Mobile Safari/537.36');
  await page.setViewport({ width: 720, height: 1600, deviceScaleFactor: 2, isMobile: true });

  const client = await page.target().createCDPSession();
  if (!skipNetwork) {
    await client.send('Network.emulateNetworkConditions', {
      offline: false, downloadThroughput: 200 * 1024, uploadThroughput: 96 * 1024, latency: 300,
    });
  }
  await client.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });

  // --- Phase 1: Initial sync ---
  console.log('Phase 1: Initial sync...');
  await page.goto(`${CHT_URL}/medic/login`, { waitUntil: 'networkidle2', timeout: 60000 });
  const tLogin = Date.now();
  await handleLoginFlow(page, USERNAME, PASSWORD);

  // Wait for initial sync to stabilize
  let lastStorage = 0;
  let stall = 0;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const storage = await page.evaluate(async () => {
      const est = await navigator.storage.estimate().catch(() => ({}));
      return parseFloat(((est.usage || 0) / 1e6).toFixed(1));
    });
    if (storage === lastStorage && storage > 35) { stall++; if (stall >= 6) break; }
    else { stall = 0; }
    lastStorage = storage;
    const sec = (i + 1) * 5;
    const body = await page.evaluate(() => document.body?.innerText?.substring(0, 100) || '');
    const progress = body.match(/(\d+)\s+of\s+(\d+)\s+docs/) || [];
    console.log(`  ${sec}s: ${storage}MB ${progress[0] || ''}`);
  }
  const initialSyncMs = Date.now() - tLogin;
  console.log(`  Initial sync done: ${Math.round(initialSyncMs / 1000)}s, ${lastStorage}MB\n`);

  // --- Phase 2: Insert a new doc ---
  console.log('Phase 2: Inserting new report into CouchDB...');
  const userSettings = await couchReq('GET', `/medic/org.couchdb.user:${USERNAME}`);
  const facilityId = Array.isArray(userSettings.facility_id) ? userSettings.facility_id[0] : userSettings.facility_id;
  const newDocId = `benchmark-pouchdb-incr-${Date.now()}`;

  const tInsert = Date.now();
  await couchReq('PUT', `/medic/${newDocId}`, JSON.stringify({
    _id: newDocId,
    type: 'data_record',
    form: 'benchmark_pouchdb_test',
    patient_id: '12345',
    reported_date: Date.now(),
    contact: { _id: userSettings.contact_id, parent: { _id: facilityId } },
    fields: { test: true, benchmark: 'pouchdb_incremental' },
  }));
  console.log(`  Inserted: ${newDocId} at T+0ms`);

  // --- Phase 3: Wait for PouchDB to detect the new doc ---
  // PouchDB syncs on an interval (default 5 min, but also triggers on changes subscription)
  // The sync cycle: get-ids → compare → bulk_get → write
  console.log('  Waiting for PouchDB to detect new doc...');
  console.log('  Triggering manual sync cycle (bypassing 5-min interval)');
  console.log(`  Polling PouchDB for doc: ${newDocId}\n`);

  // Force a sync cycle from the page — call the dbSync service
  await page.evaluate(() => {
    try {
      // Try multiple ways to trigger sync
      // 1. Via Angular injector
      const injector = window.document.querySelector('[ng-version]')?.__ngContext__?.[0];
      // 2. Via the global dbSync if exposed
      if (window.dbSync?.sync) { window.dbSync.sync(true); return; }
      // 3. Dispatch a 'online' event which triggers sync
      window.dispatchEvent(new Event('online'));
    } catch {}
  });

  let detected = false;
  let detectedMs = -1;
  for (let sec = 0; sec < 120; sec++) {
    await new Promise(r => setTimeout(r, 1000));
    const elapsed = Date.now() - tInsert;

    // Keep triggering online events to force sync cycles
    if (sec % 10 === 0) {
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
    }

    // Query PouchDB directly from the page context
    const found = await page.evaluate(async (docId, username) => {
      try {
        if (!window.PouchDB) return { found: false, error: 'no PouchDB' };
        // CHT local DB name: medic-user-<username>
        const dbName = 'medic-user-' + username;
        const db = new window.PouchDB(dbName, { skip_setup: true });
        try {
          const doc = await db.get(docId);
          return { found: true, form: doc.form, id: doc._id };
        } catch (e) {
          if (e.status === 404) return { found: false };
          return { found: false, error: e.message };
        }
      } catch (e) {
        return { found: false, error: e.message };
      }
    }, newDocId, USERNAME);

    if (found.found) {
      detectedMs = elapsed;
      detected = true;
      console.log(`  ** Doc found in PouchDB at T+${elapsed}ms (form: ${found.form}) **`);
      break;
    }

    if (sec % 15 === 14) {
      console.log(`  T+${elapsed}ms: not found yet${found.error ? ' (' + found.error + ')' : ''} (waiting for sync cycle...)`);
    }
  }

  if (!detected) {
    console.log('  New doc was NOT detected within 600s.');
    console.log('  PouchDB sync interval may be longer than test window.');
  }

  // --- Also measure raw get-ids cost ---
  console.log('\n  Measuring raw get-ids server cost...');
  const getIdsResults = [];
  for (let i = 0; i < 3; i++) {
    const start = Date.now();
    const userAuth = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
    await new Promise((resolve, reject) => {
      const req = http.request({
        method: 'GET', hostname: 'api', port: 5988, path: '/api/v1/replication/get-ids',
        headers: { 'Authorization': `Basic ${userAuth}` },
      }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d.length)); });
      req.on('error', reject); req.end();
    });
    const elapsed = Date.now() - start;
    getIdsResults.push(elapsed);
    console.log(`  get-ids ${i + 1}: ${elapsed}ms`);
  }
  const avgGetIds = Math.round(getIdsResults.reduce((a, b) => a + b, 0) / getIdsResults.length);

  // Cleanup
  const delDoc = await couchReq('GET', `/medic/${newDocId}`);
  if (delDoc._rev) await couchReq('DELETE', `/medic/${newDocId}?rev=${delDoc._rev}`);
  await browser.close();

  // Results
  console.log('\n========================================');
  console.log('  PouchDB Incremental Sync Results');
  console.log('========================================');
  console.log(`  Initial sync:      ${Math.round(initialSyncMs / 1000)}s`);
  console.log(`  New doc detected:  ${detectedMs > 0 ? detectedMs + 'ms' : 'NOT DETECTED'}`);
  console.log(`  get-ids avg:       ${avgGetIds}ms (server cost per cycle)`);
  console.log(`  Storage:           ${lastStorage}MB`);
  console.log('========================================');

  fs.writeFileSync('/tmp/benchmark-pouchdb-incremental-results.json', JSON.stringify({
    benchmark: 'pouchdb-incremental', timestamp: new Date().toISOString(),
    user: USERNAME, initialSyncMs, newDocDetectedMs: detectedMs,
    getIdsAvgMs: avgGetIds, storageMB: lastStorage,
  }, null, 2));
  console.log('\nResults written to /tmp/benchmark-pouchdb-incremental-results.json');
})().catch(e => { console.error('Failed:', e); process.exit(1); });
