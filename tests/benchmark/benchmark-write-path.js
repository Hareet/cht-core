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
 * Env vars (benchmark process, set on cht-agent-7):
 *   DEVICE_TIER=go|budget|standard|high   (default: go)
 *   SKIP_NETWORK_THROTTLE=1               Skip 3G
 *   CHT_ROLE=chw_min_5km                  For PowerSync JWT
 *   TEST=pouchdb|powersync|both           Which engine (default: both)
 *   BENCHMARK_TARGET=couchdb|postgres     Which backend to verify against in Test B
 *                                         (default: couchdb). Must match the api's
 *                                         active CHT_DB_BACKEND — mismatch gives false
 *                                         negatives.
 *   BENCH_CONTACT_ID=<uuid>               Override test user's contact UUID
 *   BENCH_FORM=<form-id>                  Override the form id used in INSERTs
 *
 * Operator prerequisite (on cht-api container, set via docker-compose):
 *   CHT_DB_BACKEND=couchdb  # default — cht-datasource writes to CouchDB via PouchDB
 *   CHT_DB_BACKEND=postgres # routes writes through cht-datasource Postgres adapter
 *                           # to v1.couchdb. Requires api restart after the env change.
 *   POSTGRES_URL is populated from the compose file and used when backend=postgres.
 *
 * One-time install on cht-agent-7 (if BENCHMARK_TARGET=postgres):
 *   docker exec cht-agent-7 bash -c 'cd /tmp && npm install pg@^8 --no-save'
 *
 * Usage:
 *   CHT_ROLE=chw_min_5km node benchmark-write-path.js chw_test_1 'Secret1!pass'
 *   BENCHMARK_TARGET=postgres CHT_ROLE=chw_min_5km TEST=powersync \
 *     node benchmark-write-path.js chw_test_1 'Secret1!pass'
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
// Which backend the api is configured to use. Must match cht-api's CHT_DB_BACKEND.
const BENCHMARK_TARGET = (process.env.BENCHMARK_TARGET || 'couchdb').toLowerCase();
// Real contact UUID and form name for cht-datasource validation on the PowerSync
// upload path. `contact` must be a UUID that resolves to an existing contact doc;
// `form` must be in the supported forms list (otherwise Report.v1.create rejects).
const BENCH_CONTACT_ID = process.env.BENCH_CONTACT_ID || '4ebb22c9-0f8c-4775-87da-30454446745d';
const BENCH_FORM = process.env.BENCH_FORM || 'anc_followup';

// pg client is only needed when BENCHMARK_TARGET=postgres. Lazy-loaded so the
// couchdb path doesn't require the package to be installed in /tmp/node_modules.
const pgLib = (() => {
  try { return require('pg'); } catch { return null; }
})();
if (BENCHMARK_TARGET === 'postgres' && !pgLib) {
  console.error(
    "BENCHMARK_TARGET=postgres but 'pg' is not installed in /tmp/node_modules.\n" +
    "Run once: docker exec cht-agent-7 bash -c 'cd /tmp && npm install pg@^8 --no-save'"
  );
  process.exit(1);
}

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

// GET against cht-api. Used for /api/v1/powersync/status pre-flight checks
// (notably to verify the api's CHT_DB_BACKEND matches BENCHMARK_TARGET before
// we burn minutes running a benchmark whose detection would always miss).
function apiReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      method, hostname: 'api', port: 5988, path,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Basic ' + Buffer.from('admin:secret21512').toString('base64'),
      },
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = http.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Abort early if the api's CHT_DB_BACKEND doesn't match BENCHMARK_TARGET.
// Called from benchPowerSyncWritePath — PouchDB's path doesn't route through
// cht-datasource so backend config doesn't affect it.
async function assertBackendMatchesTarget() {
  let apiBackend = null;
  try {
    const resp = await apiReq('GET', '/api/v1/powersync/status');
    apiBackend = resp.body?.backend;
  } catch (e) {
    console.log(`  WARNING: pre-flight /api/v1/powersync/status unreachable (${e.message}) — skipping backend check`);
    return;
  }
  if (!apiBackend) {
    console.log('  WARNING: /api/v1/powersync/status returned no `backend` field — api may be running an older build without the pre-flight extension. Proceeding without check.');
    return;
  }
  if (apiBackend !== BENCHMARK_TARGET) {
    console.error(`\nFATAL: BENCHMARK_TARGET=${BENCHMARK_TARGET} but api is configured for CHT_DB_BACKEND=${apiBackend}.`);
    console.error(`  Writes will land in ${apiBackend}, Test B will poll ${BENCHMARK_TARGET}, detection will always miss.`);
    console.error(`  Flip the api:`);
    console.error(`    cd .devcontainer`);
    console.error(`    CHT_DB_BACKEND=${BENCHMARK_TARGET} docker compose -f docker-compose.services.yml up -d --force-recreate api`);
    console.error(`  Then re-run this benchmark.\n`);
    process.exit(2);
  }
  console.log(`  Pre-flight OK: api CHT_DB_BACKEND=${apiBackend} matches BENCHMARK_TARGET=${BENCHMARK_TARGET}.`);
}

// One-shot query against v1.couchdb (the cht-sync JSONB snapshot that the
// cht-datasource Postgres adapter writes to when CHT_DB_BACKEND=postgres).
// Only used when BENCHMARK_TARGET=postgres.
async function pgReq(sql, params = []) {
  if (!pgLib) {
    throw new Error('pg not installed in /tmp/node_modules');
  }
  const client = new pgLib.Client({
    host: process.env.POSTGRES_HOST || 'postgres',
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || 'cht',
    user: process.env.POSTGRES_USER || 'cht',
    password: process.env.POSTGRES_PASSWORD || 'pgpass',
  });
  await client.connect();
  try {
    const res = await client.query(sql, params);
    return res.rows;
  } finally {
    await client.end();
  }
}

// Poll for a specific benchmark-written doc by its expected _id.
// Agent-1's idHint preservation means the server `_id` equals the client-minted
// id, so we can do a direct primary-key lookup on both backends — indexed,
// sub-millisecond — instead of a Mango $regex / LIKE scan over 800K+
// data_record docs (which was taking >30s on the budget tier and timing out).
async function pollForServerDoc(docId) {
  if (BENCHMARK_TARGET === 'postgres') {
    const rows = await pgReq(
      `SELECT _id FROM v1.couchdb WHERE _id = $1 LIMIT 1`,
      [docId]
    );
    return rows.length > 0 ? rows[0]._id : null;
  }
  // CouchDB: direct doc GET. Returns the doc with { _id, _rev, ... } on 200
  // or { error: 'not_found', reason: 'missing' } on 404.
  const res = await couchReq('GET', '/medic/' + encodeURIComponent(docId));
  return (res && res._id === docId) ? res._id : null;
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

async function waitForInitialSync(page, label, opts = {}) {
  const { waitForPowerSync = false, timeoutMs = 5 * 60_000 } = opts;

  if (waitForPowerSync) {
    // PowerSync path: prefer currentStatus.hasSynced. Storage-stall heuristic
    // false-positives on slow tiers where downloads pause mid-stream (budget
    // tier on 3G: observed stall at 109MB with priority-1 still 22K/24.5K).
    // Graceful fallback: bail if prio_1 is >=95% complete AND stalled for 45s
    // AND storage hasn't grown for 45s. This unblocks budget/go tier runs when
    // the last ~5% of buckets silently hang (separate sync-stream bug to
    // investigate; until then the benchmark still produces numbers).
    const deadline = Date.now() + timeoutMs;
    let lastStorage = 0;
    let lastProgress = 0;
    let stallStart = 0;
    let iter = 0;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 5000));
      const snap = await page.evaluate(async () => {
        const db = window.__ps_db;
        const est = await navigator.storage.estimate().catch(() => ({}));
        const mb = parseFloat(((est.usage || 0) / 1e6).toFixed(1));
        const s = db?.currentStatus;
        const prio1 = s?.dataFlowStatus?.downloadProgress?.prio_1;
        return {
          hasSynced: !!s?.hasSynced,
          storageMB: mb,
          prio1Since: prio1?.since_last ?? 0,
          prio1Target: prio1?.target_count ?? 0,
          prio1Progress: prio1 ? `${prio1.since_last}/${prio1.target_count}` : null,
        };
      });
      if (snap.hasSynced) {
        console.log(`  ${label} initial sync complete (hasSynced=true): ${snap.storageMB}MB`);
        return snap.storageMB;
      }
      // Track progress stall
      const currentProgress = snap.prio1Since + Math.floor(snap.storageMB * 10);
      if (currentProgress === lastProgress) {
        stallStart = stallStart || Date.now();
      } else {
        stallStart = 0;
        lastProgress = currentProgress;
      }
      const stalledFor = stallStart ? Date.now() - stallStart : 0;
      const prioPct = snap.prio1Target > 0 ? (snap.prio1Since / snap.prio1Target) * 100 : 0;
      if (stalledFor >= 45_000 && prioPct >= 95) {
        console.log(
          `  ${label} sync stalled at ${prioPct.toFixed(1)}% of priority-1 (${snap.prio1Progress}) ` +
          `for ${Math.round(stalledFor / 1000)}s — proceeding anyway with ${snap.storageMB}MB. ` +
          `hasSynced is still false; this tier may be impacted by a sync-stream bug.`
        );
        return snap.storageMB;
      }
      lastStorage = snap.storageMB;
      const sec = (++iter) * 5;
      if (sec % 15 === 0) {
        const stallNote = stalledFor > 0 ? ` stalled=${Math.round(stalledFor / 1000)}s` : '';
        console.log(`    ${sec}s: ${snap.storageMB}MB (prio_1=${snap.prio1Progress ?? 'n/a'}${stallNote})`);
      }
    }
    console.log(`  ${label} WARNING: hasSynced never became true within ${timeoutMs / 1000}s — proceeding with ${lastStorage}MB`);
    return lastStorage;
  }

  // PouchDB path: storage-stall heuristic (no hasSynced signal exposed)
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
    protocolTimeout: 120000,
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
  // NB: CHT's default PouchDB sync interval is 5 minutes — waiting for it is
  // impractical in a benchmark. Instead we write, then manually trigger an
  // immediate `db.replicate.to(remote)` scoped to the one doc (`doc_ids: [id]`)
  // to measure the protocol latency fairly against PowerSync's auto-upload.
  //
  // The offline `_bulk_docs` filter resolves a report's subject via the
  // docs_by_replication_key view, which uses this precedence:
  //   doc.patient_id || doc.fields.patient_id || doc.place_id ||
  //   doc.fields.place_id || doc.fields.patient_uuid || doc.contact._id
  // A bogus patient_id (e.g. '12345') wins that chain and makes the subject
  // unreachable in the user's tree → the filter silently returns
  // {error: 'forbidden'} and the doc never reaches CouchDB. We omit patient_id
  // here so the subject falls through to doc.contact._id, which IS accessible.
  console.log('\n  Test B: Write → immediate replicate.to → server detection');
  const serverDocId = 'benchmark-write-pouch-server-' + Date.now();
  const tWrite = Date.now();
  const pushOutcome = await page.evaluate(async (id, username, chtUrl, contactId) => {
    const local = new window.PouchDB('medic-user-' + username, { skip_setup: true });
    await local.put({
      _id: id, type: 'data_record', form: 'benchmark_server_write',
      reported_date: Date.now(),
      contact: { _id: contactId },
      fields: { test: true, server_detection: true },
    });
    const remote = new window.PouchDB(chtUrl + '/medic', { skip_setup: true });
    const start = performance.now();
    const info = await new Promise((resolve, reject) => {
      local.replicate.to(remote, { doc_ids: [id], retry: false })
        .on('complete', resolve)
        .on('error', reject);
    });
    return {
      ms: Math.round(performance.now() - start),
      docs_read: info.docs_read,
      docs_written: info.docs_written,
      doc_write_failures: info.doc_write_failures,
      errors: (info.errors || []).slice(0, 2).map(e => e.message || String(e)),
      status: info.status,
    };
  }, serverDocId, USERNAME, CHT_URL, BENCH_CONTACT_ID);
  const pushMs = pushOutcome.ms;
  console.log(`    Wrote to PouchDB at T+0ms, replicate.to completed in ${pushMs}ms`);
  console.log(`    replicate.to: docs_read=${pushOutcome.docs_read}, docs_written=${pushOutcome.docs_written}, failures=${pushOutcome.doc_write_failures}, status=${pushOutcome.status}`);
  if (pushOutcome.errors.length) {
    console.log('    replicate.to errors:', pushOutcome.errors.join(' | '));
  }

  // Poll server to confirm the doc is there (should be immediate after push).
  let serverDetectedMs = -1;
  const POUCHDB_POLL_TIMEOUT_MS = 30_000;
  const deadlinePouchB = tWrite + POUCHDB_POLL_TIMEOUT_MS;
  while (Date.now() < deadlinePouchB) {
    await new Promise(r => setTimeout(r, 500));
    if (Date.now() >= deadlinePouchB) break;
    const elapsed = Date.now() - tWrite;
    try {
      const res = await couchReq('GET', '/medic/' + serverDocId);
      if (res._id === serverDocId) {
        serverDetectedMs = elapsed;
        console.log('    ** Doc found on server at T+' + elapsed + 'ms **');
        break;
      }
    } catch {}
  }
  if (serverDetectedMs < 0) {
    console.log(`    Doc NOT found on server within ${POUCHDB_POLL_TIMEOUT_MS / 1000}s after replicate.to completed`);
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

  // --- Test D: CHT replication pull roundtrip ---
  // CHT v5 doesn't use PouchDB's native pull — it uses a custom protocol:
  //   GET  /api/v1/replication/get-ids  → server scans docs_by_replication_key view,
  //                                        applies purge.js, returns doc IDs user should have
  //   POST /medic/_bulk_get             → client fetches docs missing locally
  // get-ids is the O(N²) scalability bottleneck that collapses CouchDB at 10+
  // concurrent users. This test measures that specific path in isolation.
  console.log('\n  Test D: CHT replication pull roundtrip (get-ids + _bulk_get)');
  const roundtrip = await page.evaluate(async (username, chtUrl) => {
    const out = { getIdsMs: -1, getIdsCount: -1, bulkGetMs: 0, bulkGetCount: 0, errors: [] };

    // 1. get-ids — the expensive view scan
    const tIds = performance.now();
    let getIdsResp;
    try {
      getIdsResp = await fetch(chtUrl + '/api/v1/replication/get-ids', {
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' },
      });
    } catch (e) {
      out.errors.push('get-ids fetch: ' + e.message);
      return out;
    }
    out.getIdsMs = Math.round(performance.now() - tIds);
    if (!getIdsResp.ok) {
      out.errors.push('get-ids HTTP ' + getIdsResp.status);
      return out;
    }
    const body = await getIdsResp.json().catch(() => null);
    const docIds = Array.isArray(body) ? body : (body?.doc_ids || body?.docIds || []);
    out.getIdsCount = docIds.length;
    if (!docIds.length) {
      return out;
    }

    // 2. Find docs missing locally (client-side diff — not timed)
    const local = new window.PouchDB('medic-user-' + username, { skip_setup: true });
    const localIds = new Set((await local.allDocs({})).rows.map(r => r.id));
    const missing = docIds.filter(id => !localIds.has(id));
    out.missingCount = missing.length;
    if (!missing.length) {
      return out;
    }

    // 3. _bulk_get — fetch missing docs (CHT's offline db-doc handler applies
    //    the audit + filter path per doc)
    const tBulk = performance.now();
    let bulkResp;
    try {
      bulkResp = await fetch(chtUrl + '/medic/_bulk_get', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ docs: missing.map(id => ({ id })) }),
      });
    } catch (e) {
      out.errors.push('bulk_get fetch: ' + e.message);
      return out;
    }
    out.bulkGetMs = Math.round(performance.now() - tBulk);
    if (!bulkResp.ok) {
      out.errors.push('bulk_get HTTP ' + bulkResp.status);
      return out;
    }
    const bulkBody = await bulkResp.json().catch(() => null);
    out.bulkGetCount = (bulkBody?.results || []).length;
    return out;
  }, USERNAME, CHT_URL);

  const roundtripTotalMs = (roundtrip.getIdsMs > 0 ? roundtrip.getIdsMs : 0) + (roundtrip.bulkGetMs || 0);
  console.log(`    GET /api/v1/replication/get-ids: ${roundtrip.getIdsMs}ms (${roundtrip.getIdsCount} IDs)`);
  console.log(`    missing locally: ${roundtrip.missingCount ?? 0}`);
  console.log(`    POST /medic/_bulk_get: ${roundtrip.bulkGetMs}ms (${roundtrip.bulkGetCount} docs)`);
  console.log(`    Roundtrip pull total: ${roundtripTotalMs}ms`);
  if (roundtrip.errors?.length) {
    console.log('    errors:', roundtrip.errors.join(' | '));
  }

  const metrics = await page.metrics();
  const heap = parseFloat((metrics.JSHeapUsedSize / 1e6).toFixed(1));

  await browser.close();

  const results = {
    engine: 'pouchdb',
    deviceTier: DEVICE_TIER,
    throttle: { cpu: profile.cpu + 'x', network: skipNetwork ? 'unthrottled' : '3G' },
    localPersist: { avgMs: avgPersist, minMs: minPersist, maxMs: maxPersist, runs: persistResults },
    replicatePushMs: pushMs,
    serverDetectionMs: serverDetectedMs,
    batchWrite10Ms: batchMs,
    chtReplicationRoundtrip: {
      getIdsMs: roundtrip.getIdsMs,
      getIdsCount: roundtrip.getIdsCount,
      missingCount: roundtrip.missingCount ?? 0,
      bulkGetMs: roundtrip.bulkGetMs,
      bulkGetCount: roundtrip.bulkGetCount,
      totalMs: roundtripTotalMs,
      errors: roundtrip.errors,
    },
    jsHeapMB: heap,
    note: 'serverDetection is measured after a manual db.replicate.to() call. CHT default sync interval is 5 min; this measures the protocol floor. chtReplicationRoundtrip isolates the production get-ids path.',
  };

  console.log('\n  ========================================');
  console.log('  PouchDB Write Path Results');
  console.log('  ========================================');
  console.log('  Local persist (single):  ' + avgPersist + 'ms avg (' + minPersist + '-' + maxPersist + 'ms)');
  console.log('  replicate.to push:       ' + pushMs + 'ms');
  console.log('  Server detection:        ' + (serverDetectedMs > 0 ? serverDetectedMs + 'ms' : 'NOT DETECTED'));
  console.log('  Batch write (10 docs):   ' + batchMs + 'ms (' + Math.round(batchMs / 10) + 'ms/doc)');
  console.log('  CHT pull get-ids:        ' + roundtrip.getIdsMs + 'ms (' + roundtrip.getIdsCount + ' IDs)');
  console.log('  CHT pull _bulk_get:      ' + roundtrip.bulkGetMs + 'ms (' + roundtrip.bulkGetCount + ' docs)');
  console.log('  CHT pull roundtrip:      ' + roundtripTotalMs + 'ms');
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

  // Pre-flight: prevent BENCHMARK_TARGET / CHT_DB_BACKEND mismatch.
  await assertBackendMatchesTarget();

  const { browser, page, client } = await launchBrowser();

  // Set PowerSync URL + force tier.
  // OPFS AccessHandlePoolVFS works when the worker loads from a same-origin HTTPS URL
  // (NOT from Blob URLs, which is why the standalone OPFS test failed).
  // Set __CHT_FORCE_VFS='idb' to test IDBBatchAtomicVFS fallback if needed.
  const forceVfs = process.env.FORCE_VFS || '';
  await page.evaluateOnNewDocument((tier, vfs) => {
    window.__CHT_FORCE_DEVICE_TIER = tier;
    if (vfs) window.__CHT_FORCE_VFS = vfs;
  }, DEVICE_TIER, forceVfs);

  // Capture console output for debugging (filter out noisy change notifications and ngrx)
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('Change notification firing') || text.includes('prev state') ||
        text.includes('next state') || text.includes('action') || text === 'console.groupEnd' ||
        text.startsWith('%c')) return;
    console.log('    [app:' + msg.type() + '] ' + text);
  });

  // Capture page errors
  page.on('pageerror', err => {
    console.log('    [PAGE ERROR] ' + err.message);
  });

  // Capture failed requests (worker files, WASM files)
  page.on('requestfailed', req => {
    console.log('    [REQ FAIL] ' + req.url() + ' — ' + req.failure()?.errorText);
  });

  // Track worker-related requests
  page.on('response', res => {
    const url = res.url();
    if (url.match(/worker|wasm|\.js$/i) && res.status() !== 200) {
      console.log('    [HTTP ' + res.status() + '] ' + url);
    }
    if (url.match(/worker|wasm/i)) {
      console.log('    [LOADED ' + res.status() + '] ' + url);
    }
  });

  // Clear storage + unregister service workers, then navigate
  console.log('  Clearing browser storage + service workers...');
  await page.goto(CHT_URL + '/medic/login', { waitUntil: 'networkidle2', timeout: 60000 });

  // Unregister all service workers so we get fresh code from the server
  await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
  });

  const cdpClear = await page.target().createCDPSession();
  await cdpClear.send('Storage.clearDataForOrigin', {
    origin: CHT_URL,
    storageTypes: 'all',
  });
  await page.reload({ waitUntil: 'networkidle2' });

  // Login + initial sync
  console.log('  Phase 1: Login + initial sync...');
  await handleLoginFlow(page, USERNAME, PASSWORD);
  await waitForInitialSync(page, 'PowerSync', { waitForPowerSync: true });

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
  } else {
    // Diagnostic: check sync connection status (Step 6 from debugging doc)
    const syncStatus = await page.evaluate(() => {
      const db = window.__ps_db;
      if (!db) return { error: 'no __ps_db' };
      const s = db.currentStatus;
      return {
        connected: s?.connected,
        connecting: s?.connecting,
        lastSyncedAt: s?.lastSyncedAt?.toISOString?.() || s?.lastSyncedAt,
        hasSynced: s?.hasSynced,
        dataFlowStatus: s?.dataFlowStatus,
        uploadError: s?.uploadError?.message,
        downloadError: s?.downloadError?.message,
      };
    });
    console.log('  Sync status:', JSON.stringify(syncStatus, null, 2));

    if (!syncStatus.connected && !syncStatus.connecting) {
      console.log('  WARNING: SDK is not connected and not trying to connect.');
      console.log('  This suggests connect() was never called or fetchCredentials failed.');
    }
  }

  // --- Deep diagnostic: inspect DB internals ---
  console.log('\n  Deep diagnostic: inspecting __ps_db internals...');
  const dbInternals = await page.evaluate(() => {
    const db = window.__ps_db;
    if (!db) return { error: 'no __ps_db' };
    const keys = Object.keys(db).filter(k => !k.startsWith('_'));
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(db)).filter(k => k !== 'constructor').slice(0, 20);
    return {
      type: db.constructor?.name,
      keys,
      protoMethods: proto,
      closed: db.closed,
      ready: typeof db.ready,
      isReady: db.isReady,
      // Check if there's an internal database adapter
      hasAdapter: !!db.database,
      adapterType: db.database?.constructor?.name,
      // Check worker handle
      hasOptions: !!db.options,
      flags: db.options?.flags,
    };
  });
  console.log('  DB internals:', JSON.stringify(dbInternals, null, 2));

  // Check if db.ready resolves or hangs
  console.log('\n  Checking if db.ready resolves...');
  const readyResult = await page.evaluate(async () => {
    const db = window.__ps_db;
    if (!db) return { error: 'no db' };
    try {
      await Promise.race([
        db.ready,  // Internal SDK ready promise
        new Promise((_, reject) => setTimeout(() => reject(new Error('db.ready timed out after 10s')), 10000)),
      ]);
      return { ready: true };
    } catch (e) {
      return { error: e.message };
    }
  });
  console.log('  db.ready result:', JSON.stringify(readyResult));

  // --- Diagnostic: verify execute() works at all with a SELECT ---
  console.log('\n  Diagnostic: testing db.execute(SELECT 1)...');
  const selectTest = await page.evaluate(async () => {
    const db = window.__ps_db;
    if (!db || !db.execute) return { error: 'no __ps_db' };
    try {
      const result = await Promise.race([
        db.execute('SELECT 1 as test'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SELECT timed out after 15s')), 15000)),
      ]);
      return { ok: true, rows: result?.rows?._array || result?.rows?.length };
    } catch (e) {
      return { error: e.message, stack: e.stack?.split('\n').slice(0, 3).join(' | ') };
    }
  });
  console.log('  SELECT test:', JSON.stringify(selectTest));

  if (selectTest.error) {
    console.log('  db.execute() is broken — even SELECT fails. OPFS/WASM worker may be deadlocked.');
    console.log('  Checking if getAll works instead...');
    const getAllTest = await page.evaluate(async () => {
      const db = window.__ps_db;
      try {
        const result = await Promise.race([
          db.getAll('SELECT name FROM sqlite_master WHERE type="table" LIMIT 5'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('getAll timed out after 15s')), 15000)),
        ]);
        return { ok: true, tables: result };
      } catch (e) {
        return { error: e.message };
      }
    });
    console.log('  getAll test:', JSON.stringify(getAllTest));
  }

  // --- Test A: Single write local persist ---
  console.log('\n  Test A: Single write — local persist latency');
  console.log('  Note: writes go to WASM SQLite, then auto-queued for upload\n');

  const persistResults = [];
  for (let i = 0; i < 10; i++) {
    const docId = 'benchmark-write-ps-' + Date.now() + '-' + i;
    // Use JS-level timeout to catch hangs — don't let CDP protocol timeout swallow the error
    const ms = await page.evaluate(async (id, form, contactId) => {
      const db = window.__ps_db;
      if (!db || !db.execute) {
        return { ms: -1, error: 'PowerSync DB not accessible from page context' };
      }

      try {
        const start = performance.now();
        await Promise.race([
          db.execute(
            'INSERT INTO reports (id, form, patient_id, reported_date, fields, contact_id) VALUES (?, ?, ?, ?, ?, ?)',
            [id, form, '12345', new Date().toISOString(), '{"test":true,"iteration":"' + id + '"}', contactId]
          ),
          new Promise((_, reject) => setTimeout(() => reject(new Error('INSERT timed out after 30s')), 30000)),
        ]);
        return { ms: Math.round(performance.now() - start) };
      } catch (e) {
        return { ms: -1, error: e.message };
      }
    }, docId, BENCH_FORM, BENCH_CONTACT_ID);

    if (ms.error) {
      console.log('    Write ' + (i + 1) + ': FAILED — ' + ms.error);
      if (i === 0 && ms.error.includes('timed out')) {
        console.log('    db.execute(INSERT) hangs. WASM worker may be blocked on OPFS file handles.');
        console.log('    Falling back to Node.js measurement...');
        break;
      }
      if (i === 0 && ms.error.includes('not accessible')) {
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
        'INSERT INTO reports (id, form, patient_id, reported_date, fields, contact_id) VALUES (?, ?, ?, ?, ?, ?)',
        [docId, BENCH_FORM, '12345', new Date().toISOString(), '{"test":true}', BENCH_CONTACT_ID]
      );
      const ms = Date.now() - start;
      persistResults.push(ms);
      console.log('    Write ' + (i + 1) + ': ' + ms + 'ms');
    }

    avgPersist = Math.round(persistResults.reduce((a, b) => a + b, 0) / persistResults.length);
    minPersist = Math.min(...persistResults);
    maxPersist = Math.max(...persistResults);

    // Test B: Wait for upload to server
    // Two metrics: (1) uploadData fired = HTTP POST completed, (2) doc visible in
    // target backend. pollForServerDoc uses the same marker approach as the
    // browser path, so results are comparable across runs.
    console.log(`\n  Test B: Upload to server (target=${BENCHMARK_TARGET}, via uploadData callback)`);
    const uploadDocId = crypto.randomUUID();
    const nodeServerMarker = 'ps-bench-node-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const tServerWrite = Date.now();
    await db.execute(
      'INSERT INTO reports (id, form, patient_id, reported_date, fields, contact_id) VALUES (?, ?, ?, ?, ?, ?)',
      [uploadDocId, BENCH_FORM, '12345', new Date().toISOString(), JSON.stringify({ server_test: true, marker: nodeServerMarker }), BENCH_CONTACT_ID]
    );
    console.log(`    Wrote locally at T+0ms, waiting for uploadData to fire + ${BENCHMARK_TARGET} persistence...`);

    // Hard 30s wall-clock deadline (matches browser Test B).
    const NODE_TEST_B_TIMEOUT_MS = 30_000;
    const nodeDeadlineB = tServerWrite + NODE_TEST_B_TIMEOUT_MS;
    let nodeIter = 0;
    let uploadFiredMs = -1;
    while (Date.now() < nodeDeadlineB) {
      await new Promise(r => setTimeout(r, 1000));
      if (Date.now() >= nodeDeadlineB) break;
      if (uploadFiredMs < 0 && uploadCalls > 0 && lastUploadMs > 0) {
        uploadFiredMs = Date.now() - tServerWrite;
        console.log(`    ** uploadData fired at T+${uploadFiredMs}ms (HTTP call took ${lastUploadMs}ms) **`);
      }
      if (uploadFiredMs < 0) {
        nodeIter++;
        continue;
      }
      try {
        const foundId = await pollForServerDoc(uploadDocId);
        if (foundId) {
          serverDetectedMs = Date.now() - tServerWrite;
          console.log(`    ** Doc visible in ${BENCHMARK_TARGET} at T+${serverDetectedMs}ms (_id=${foundId}) **`);
          break;
        }
      } catch (e) {
        if (nodeIter === 0) console.log('    detection error:', e.message);
      }
      if (nodeIter > 5 && nodeIter % 5 === 0) {
        console.log(`    T+${Date.now() - tServerWrite}ms: upload fired but doc not yet in ${BENCHMARK_TARGET}...`);
      }
      nodeIter++;
    }
    if (uploadFiredMs < 0) {
      console.log(`    uploadData never fired within ${NODE_TEST_B_TIMEOUT_MS / 1000}s`);
    } else if (serverDetectedMs < 0) {
      console.log(`    Upload fired but doc NOT visible in ${BENCHMARK_TARGET} within ${NODE_TEST_B_TIMEOUT_MS / 1000}s`);
    }

    // Test C: Batch write
    console.log('\n  Test C: Batch write — 10 docs');
    const batchStart = Date.now();
    for (let i = 0; i < 10; i++) {
      await db.execute(
        'INSERT INTO reports (id, form, patient_id, reported_date, fields, contact_id) VALUES (?, ?, ?, ?, ?, ?)',
        [crypto.randomUUID(), BENCH_FORM, '12345', new Date().toISOString(), '{"batch":true}', BENCH_CONTACT_ID]
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

    // --- Test B: Write then detect upload on server ---
    // Detection: direct primary-key GET/SELECT on the client-minted _id.
    // idHint on the cht-datasource create path preserves the UUID end-to-end,
    // so `_id == INSERT id`. Backend-agnostic via pollForServerDoc().
    console.log(`\n  Test B: Write → server upload (target=${BENCHMARK_TARGET}, via PowerSync uploadData)`);
    const serverMarker = 'ps-bench-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const serverDocId = 'benchmark-write-ps-server-' + serverMarker;
    const tWrite = Date.now();
    await page.evaluate(async (id, form, contactId, marker) => {
      await window.__ps_db.execute(
        'INSERT INTO reports (id, form, patient_id, reported_date, fields, contact_id) VALUES (?, ?, ?, ?, ?, ?)',
        [
          id,
          form,
          '12345',
          new Date().toISOString(),
          JSON.stringify({ server_test: true, marker }),
          contactId,
        ]
      );
    }, serverDocId, BENCH_FORM, BENCH_CONTACT_ID, serverMarker);
    console.log(`    Wrote to WASM SQLite at T+0ms, polling ${BENCHMARK_TARGET} for _id=${serverDocId} (timeout 30s)...`);

    // Hard 30s wall-clock deadline. `_find` / PG queries take 1-2s each on the
    // large dataset, so a fixed-iteration loop with sleep+poll can overrun.
    const TEST_B_TIMEOUT_MS = 30_000;
    const deadlineB = tWrite + TEST_B_TIMEOUT_MS;
    let iter = 0;
    while (Date.now() < deadlineB) {
      await new Promise(r => setTimeout(r, 2000));
      if (Date.now() >= deadlineB) break;
      const elapsed = Date.now() - tWrite;
      try {
        const foundId = await pollForServerDoc(serverDocId);
        if (foundId) {
          serverDetectedMs = elapsed;
          console.log(`    ** Doc found in ${BENCHMARK_TARGET} at T+${elapsed}ms (_id=${foundId}) **`);
          break;
        }
      } catch (e) {
        if (iter === 0) console.log('    detection error:', e.message);
      }
      if (iter > 0 && iter % 5 === 0) {
        // Peek at SDK upload queue + dataflow so we can tell "uploads fired,
        // server slow" from "SDK hasn't fired uploadData yet".
        const qDiag = await page.evaluate(async () => {
          const db = window.__ps_db;
          if (!db) return null;
          try {
            const stats = await db.getUploadQueueStats();
            const s = db.currentStatus;
            return {
              pending: stats.count,
              uploading: !!s?.dataFlowStatus?.uploading,
              downloading: !!s?.dataFlowStatus?.downloading,
              uploadError: s?.dataFlowStatus?.uploadError?.message,
            };
          } catch { return null; }
        });
        const diagStr = qDiag
          ? ` queue=${qDiag.pending} up=${qDiag.uploading} down=${qDiag.downloading}${qDiag.uploadError ? ' err=' + qDiag.uploadError : ''}`
          : '';
        console.log(`    T+${elapsed}ms: not on server yet...${diagStr}`);
      }
      iter++;
    }
    if (serverDetectedMs < 0) {
      console.log(`    Doc NOT found in ${BENCHMARK_TARGET} within ${TEST_B_TIMEOUT_MS / 1000}s`);
    }

    // --- Test C: Batch write (10 docs) ---
    console.log('\n  Test C: Batch write — 10 docs local persist');
    batchMs = await page.evaluate(async (form, contactId) => {
      const db = window.__ps_db;
      const start = performance.now();
      for (let i = 0; i < 10; i++) {
        await db.execute(
          'INSERT INTO reports (id, form, patient_id, reported_date, fields, contact_id) VALUES (?, ?, ?, ?, ?, ?)',
          ['benchmark-batch-ps-' + Date.now() + '-' + i, form, '12345', new Date().toISOString(), '{"batch":true,"i":' + i + '}', contactId]
        );
      }
      return Math.round(performance.now() - start);
    }, BENCH_FORM, BENCH_CONTACT_ID);
    console.log('    10 docs: ' + batchMs + 'ms (' + Math.round(batchMs / 10) + 'ms/doc)');

    // Check upload queue
    const queueCount = await page.evaluate(async () => {
      try {
        const stats = await window.__ps_db.getUploadQueueStats();
        return stats.count;
      } catch { return -1; }
    });
    if (queueCount >= 0) console.log('    Upload queue pending: ' + queueCount);
  }

  await browser.close();

  const results = {
    engine: 'powersync',
    backendTarget: BENCHMARK_TARGET,
    deviceTier: DEVICE_TIER,
    throttle: { cpu: profile.cpu + 'x', network: skipNetwork ? 'unthrottled' : '3G' },
    usedNodeFallback: usedFallback,
    localPersist: { avgMs: avgPersist, minMs: minPersist, maxMs: maxPersist, runs: persistResults },
    serverDetectionMs: serverDetectedMs,
    batchWrite10Ms: batchMs,
    note: usedFallback ? 'Node.js native SQLite (no WASM). Add ~2-5x for Go edition WASM.' : 'Browser WASM SQLite',
  };

  console.log('\n  ========================================');
  console.log(`  PowerSync Write Path Results (target=${BENCHMARK_TARGET})`);
  console.log('  ========================================');
  console.log('  Local persist (single):  ' + avgPersist + 'ms avg (' + minPersist + '-' + maxPersist + 'ms)');
  console.log(`  Server upload:           ${serverDetectedMs > 0 ? serverDetectedMs + 'ms' : 'NOT DETECTED'}`);
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
  console.log('  Backend target: ' + BENCHMARK_TARGET +
    (BENCHMARK_TARGET === 'postgres'
      ? ' (requires api CHT_DB_BACKEND=postgres)'
      : ' (cht-datasource → CouchDB)'));
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

  const output = {
    benchmark: 'write-path',
    timestamp: new Date().toISOString(),
    backendTarget: BENCHMARK_TARGET,
    deviceTier: DEVICE_TIER,
    network: skipNetwork ? 'unthrottled' : '3G',
    pouchdb: pouchResults,
    powersync: psResults,
  };
  const netSuffix = skipNetwork ? 'unthrottled' : '3G';
  // Prefer a host-visible path (bind-mounted to the cht-core repo in agent-7)
  // so results can be consumed from the host without docker cp. Falls back to
  // /tmp when running outside the agent container.
  const hostVisibleDir = '/workspace/cht-core/tests/benchmark/results';
  const outDir = fs.existsSync('/workspace/cht-core') ? hostVisibleDir : '/tmp';
  if (outDir !== '/tmp' && !fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const outPath = `${outDir}/benchmark-write-path-results-${BENCHMARK_TARGET}-${DEVICE_TIER}-${netSuffix}.json`;
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nResults written to ${outPath}`);
})().catch(e => { console.error('Failed:', e); process.exit(1); });
