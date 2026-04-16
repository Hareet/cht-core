#!/usr/bin/env node
/**
 * PowerSync/PostgreSQL Standalone Benchmark — Go Edition Throttled
 *
 * Runs PowerSync directly in a browser page (no Angular app), measuring
 * sync performance against the same dataset the PouchDB benchmark used.
 *
 * Creates a minimal HTML page, bundles @powersync/web via esbuild,
 * serves it locally, and runs Puppeteer with Go edition throttling.
 *
 * Prerequisites:
 *   - PowerSync service running at powersync:8080
 *   - npm install puppeteer esbuild @powersync/web (in /tmp)
 *   - Dev private key at /workspace/cht-core/.devcontainer/powersync-config/dev-private-key.pem
 *
 * Usage:
 *   node benchmark-powersync-standalone.js [username]
 *   node benchmark-powersync-standalone.js chw_test_1
 */

const puppeteer = require('puppeteer');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const USERNAME = process.argv[2] || 'chw_test_1';
const POWERSYNC_URL = 'http://powersync:8080';
const COUCH_URL = 'http://admin:secret21512@couchdb:5984';
const KEY_PATH = '/workspace/cht-core/.devcontainer/powersync-config/dev-private-key.pem';

// --- Step 1: Get user info from CouchDB and generate JWT ---

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const opts = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {},
    };
    if (parsedUrl.username) {
      opts.headers['Authorization'] = 'Basic ' + Buffer.from(`${parsedUrl.username}:${parsedUrl.password}`).toString('base64');
    }
    http.get(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

function generateJwt(userSettings, overrideRoles) {
  const privateKey = fs.readFileSync(KEY_PATH, 'utf8');
  const roles = overrideRoles || (Array.isArray(userSettings.roles) ? userSettings.roles : [userSettings.roles].filter(Boolean));
  const header = { alg: 'RS256', typ: 'JWT', kid: 'cht-dev-key-1' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userSettings._id,
    aud: 'cht-powersync-dev',
    iat: now,
    exp: now + 3600 * 24,
    role_hash: md5(roles.sort().join(',')),
    contact_id: userSettings.contact_id || '',
    report_depth: userSettings.replication_depth || -1,
    can_view_unallocated: 'false',
    roles: roles,
  };

  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${headerB64}.${payloadB64}`);
  const signature = base64url(sign.sign(privateKey));
  return `${headerB64}.${payloadB64}.${signature}`;
}

// --- Step 2: Bundle the benchmark page ---

function createBenchmarkEntry(token, powerSyncUrl) {
  return `
import { PowerSyncDatabase, WASQLiteOpenFactory, WASQLiteVFS, Schema, Table, Column, ColumnType } from '@powersync/web';

function t(name) { return new Column({ name, type: ColumnType.TEXT }); }

const CHTSchema = new Schema([
  new Table({ name: 'contacts', columns: [
    t('name'), t('contact_type'), t('parent_id'), t('patient_id'),
    t('place_id'), t('phone'), t('date_of_birth'), t('sex'),
    t('reported_date'), t('doc'),
  ]}),
  new Table({ name: 'reports', columns: [
    t('form'), t('patient_id'), t('submitter_id'), t('reported_date'),
    t('is_private'), t('needs_signoff'), t('fields'), t('doc'),
  ]}),
  new Table({ name: 'sms_messages', columns: [
    t('contact_id'), t('reported_date'), t('is_outgoing'), t('doc'),
  ]}),
  new Table({ name: 'targets', columns: [
    t('owner'), t('reporting_period'), t('targets_data'), t('doc'),
  ]}),
  new Table({ name: 'tasks', columns: [
    t('task_user'), t('owner'), t('requester'), t('state'),
    t('emission'), t('due_date'), t('start_date'), t('end_date'), t('doc'),
  ]}),
  new Table({ name: 'global_config', columns: [
    t('doc_type'), t('doc'),
  ]}),
  new Table({ name: 'user_settings_doc', columns: [
    t('doc_type'), t('doc'),
  ]}),
  new Table({ name: 'user_meta', columns: [
    t('meta_type'), t('user_id'), t('doc'),
  ]}),
]);

const TOKEN = ${JSON.stringify(token)};
const PS_URL = ${JSON.stringify(powerSyncUrl)};

window.runPowerSyncBenchmark = async function() {
  const results = { metrics: {} };
  const m = results.metrics;

  console.log('[bench] Starting benchmark...');

  // Storage before
  const estBefore = await navigator.storage.estimate().catch(() => ({}));
  m.storageBefore = parseFloat(((estBefore.usage || 0) / 1e6).toFixed(1));
  m.storageQuota = parseInt(((estBefore.quota || 0) / 1e6).toFixed(0));
  console.log('[bench] Storage before:', m.storageBefore, 'MB');

  // OPFS detection
  let opfsAvailable = false;
  try {
    await navigator.storage.getDirectory();
    opfsAvailable = true;
  } catch (e) {
    console.log('[bench] OPFS not available:', e.message);
  }
  m.opfsAvailable = opfsAvailable;
  // Force IDBBatchAtomicVFS — OPFS + useWebWorker:false hangs in headless Chrome
  const vfs = WASQLiteVFS.IDBBatchAtomicVFS;
  m.vfs = 'IndexedDB (forced for headless benchmark)';
  console.log('[bench] VFS: IDBBatchAtomicVFS (forced). OPFS detected:', opfsAvailable);

  // 1. WASM init
  console.log('[bench] Initializing PowerSync database...');
  const initStart = performance.now();
  let db;
  try {
    db = new PowerSyncDatabase({
      schema: CHTSchema,
      database: new WASQLiteOpenFactory({
        dbFilename: 'cht-bench-standalone.db',
        vfs: vfs,
      }),
      flags: { useWebWorker: true, enableMultiTabs: false },
    });
    console.log('[bench] PowerSyncDatabase created, running test query...');
    await db.getAll('SELECT 1');
    console.log('[bench] WASM init complete');
  } catch (e) {
    console.error('[bench] WASM init FAILED:', e.message, e.stack);
    m.wasmInitError = e.message;
    return results;
  }
  const initEnd = performance.now();
  m.wasmInitMs = Math.round(initEnd - initStart);
  console.log('[bench] WASM init:', m.wasmInitMs, 'ms');

  // 2. Connect with static token
  console.log('[bench] Connecting to PowerSync at', PS_URL);
  try {
    db.connect({
      fetchCredentials: async () => {
        console.log('[bench] fetchCredentials called');
        return {
          endpoint: PS_URL,
          token: TOKEN,
        };
      },
      uploadData: async (database) => {
        // No uploads during benchmark
      },
    });
    console.log('[bench] connect() called (fire-and-forget)');
  } catch (e) {
    console.error('[bench] connect() FAILED:', e.message);
    return results;
  }

  // 3. Priority-1 sync (contacts)
  console.log('[bench] Waiting for priority-1 sync...');
  const p1Start = performance.now();
  let p1Success = false;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 120000);
    await db.waitForFirstSync({ signal: ctrl.signal, priority: 1 });
    clearTimeout(to);
    p1Success = true;
  } catch {}
  const p1End = performance.now();
  m.priority1SyncMs = Math.round(p1End - p1Start);
  m.priority1Success = p1Success;

  // Count after p1
  try { m.contactsAfterP1 = (await db.get('SELECT COUNT(*) as c FROM contacts')).c; } catch { m.contactsAfterP1 = 0; }

  // 4. Full sync
  const fullStart = performance.now();
  let fullSuccess = false;
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 600000);
    await db.waitForFirstSync({ signal: ctrl.signal });
    clearTimeout(to);
    fullSuccess = true;
  } catch {}
  const fullEnd = performance.now();
  m.fullSyncMs = Math.round(fullEnd - fullStart);
  m.fullSyncSuccess = fullSuccess;

  // 5. Row counts
  try { m.contactCount = (await db.get('SELECT COUNT(*) as c FROM contacts')).c; } catch { m.contactCount = 0; }
  try { m.reportCount = (await db.get('SELECT COUNT(*) as c FROM reports')).c; } catch { m.reportCount = 0; }
  try { m.taskCount = (await db.get('SELECT COUNT(*) as c FROM tasks')).c; } catch { m.taskCount = 0; }
  try { m.globalConfigCount = (await db.get('SELECT COUNT(*) as c FROM global_config')).c; } catch { m.globalConfigCount = 0; }

  // 6. Storage after
  const estAfter = await navigator.storage.estimate().catch(() => ({}));
  m.storageAfter = parseFloat(((estAfter.usage || 0) / 1e6).toFixed(1));
  m.dbSizeDelta = parseFloat((m.storageAfter - m.storageBefore).toFixed(1));

  // 7. Query benchmarks
  const q1Start = performance.now();
  await db.getAll("SELECT id, state, owner, due_date FROM tasks WHERE state = 'Ready' ORDER BY due_date LIMIT 100");
  m.taskQueryMs = Math.round(performance.now() - q1Start);

  const q2Start = performance.now();
  await db.getAll("SELECT id, name, contact_type, parent_id FROM contacts LIMIT 200");
  m.contactQueryMs = Math.round(performance.now() - q2Start);

  const q3Start = performance.now();
  await db.getAll("SELECT id, form, reported_date FROM reports ORDER BY reported_date DESC LIMIT 100");
  m.reportQueryMs = Math.round(performance.now() - q3Start);

  // Cleanup
  await db.disconnectAndClear();

  return results;
};

document.getElementById('status').textContent = 'Ready. Running benchmark...';
`;
}

const BENCHMARK_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>PowerSync Benchmark</title></head>
<body>
<h3>PowerSync Standalone Benchmark</h3>
<p id="status">Loading...</p>
<script type="module" src="/benchmark-bundle.js"></script>
</body></html>`;

// --- Step 3: Build, serve, and run ---

(async () => {
  console.log('=== PowerSync/PostgreSQL Standalone Benchmark (Go Edition Throttled) ===');
  console.log(`User: ${USERNAME}`);
  console.log('');

  // Get user settings from CouchDB
  console.log('Fetching user settings from CouchDB...');
  const userSettings = await fetchJson(`${COUCH_URL}/medic/org.couchdb.user:${USERNAME}`);

  // CouchDB _users doc may have generic "user" role, but the actual CHT role
  // is in the PostgreSQL user_settings table (populated by config-loader).
  // Allow override via env var or CLI arg format: username:role
  const ROLE_OVERRIDE = process.env.CHT_ROLE || null;
  let roles;
  if (ROLE_OVERRIDE) {
    roles = [ROLE_OVERRIDE];
  } else {
    roles = Array.isArray(userSettings.roles) ? userSettings.roles : [userSettings.roles].filter(Boolean);
    // Filter out the generic CouchDB "user" role if a CHT-specific role exists
    if (roles.length === 1 && roles[0] === 'user') {
      console.log('  WARNING: CouchDB only has generic "user" role.');
      console.log('  Set CHT_ROLE env var to the actual role (e.g., CHT_ROLE=chw_min_5km)');
    }
  }
  console.log(`  Roles: ${JSON.stringify(roles)}`);
  console.log(`  Contact ID: ${userSettings.contact_id}`);
  console.log(`  Facility ID: ${userSettings.facility_id}`);

  // Generate JWT
  console.log('Generating JWT...');
  const token = generateJwt(userSettings, roles);
  console.log(`  Token generated (${token.length} chars)`);
  const roleHash = md5(roles.sort().join(','));
  console.log(`  Role hash: ${roleHash} (from roles: ${JSON.stringify(roles)})`);

  // Write entry point
  console.log('Building benchmark bundle...');
  const entryPath = '/tmp/ps-bench-entry.mjs';
  fs.writeFileSync(entryPath, createBenchmarkEntry(token, POWERSYNC_URL));

  // Bundle with esbuild
  try {
    execSync(
      `npx esbuild ${entryPath} --bundle --format=esm --outfile=/tmp/ps-bench-serve/benchmark-bundle.js --platform=browser --target=chrome122 --minify 2>&1`,
      { stdio: 'pipe' }
    );
  } catch (e) {
    console.error('esbuild failed:', e.stdout?.toString(), e.stderr?.toString());
    process.exit(1);
  }

  // Write HTML
  fs.mkdirSync('/tmp/ps-bench-serve', { recursive: true });
  fs.writeFileSync('/tmp/ps-bench-serve/index.html', BENCHMARK_HTML);
  console.log('Bundle built.');

  // Copy WASM and worker files from node_modules into serve dir
  const psWebDist = '/tmp/node_modules/@powersync/web/dist';
  const wasmDir = '/tmp/node_modules/@journeyapps/wa-sqlite/dist';

  // Copy all .js and .wasm files PowerSync needs
  for (const searchDir of [psWebDist, wasmDir]) {
    if (fs.existsSync(searchDir)) {
      const copyFiles = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const srcPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            copyFiles(srcPath, prefix + '/' + entry.name);
          } else if (entry.name.match(/\.(wasm|js|mjs)$/)) {
            const destDir = path.join('/tmp/ps-bench-serve', prefix);
            fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(srcPath, path.join(destDir, entry.name));
          }
        }
      };
      copyFiles(searchDir, '');
    }
  }

  // Also check for worker files in common locations
  const workerPaths = [
    '/tmp/node_modules/@powersync/web/dist',
    '/tmp/node_modules/@powersync/common/dist',
    '/tmp/node_modules/@journeyapps/wa-sqlite/dist',
  ];
  for (const wp of workerPaths) {
    if (fs.existsSync(wp)) {
      for (const f of fs.readdirSync(wp)) {
        if (f.match(/\.(wasm|js|mjs|worker)/) && !fs.existsSync(path.join('/tmp/ps-bench-serve', f))) {
          fs.copyFileSync(path.join(wp, f), path.join('/tmp/ps-bench-serve', f));
        }
      }
    }
  }

  // Copy PowerSync worker files (requested at root path by the SDK)
  const psWorkerFiles = [
    '/tmp/node_modules/@powersync/web/lib/src/worker/db/WASQLiteDB.worker.js',
    '/tmp/node_modules/@powersync/web/lib/src/worker/sync/SharedSyncImplementation.worker.js',
  ];
  for (const wf of psWorkerFiles) {
    if (fs.existsSync(wf)) {
      fs.copyFileSync(wf, path.join('/tmp/ps-bench-serve', path.basename(wf)));
    }
  }

  console.log('Serve dir contents:', fs.readdirSync('/tmp/ps-bench-serve').join(', '));

  // Start local HTTP server
  const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.wasm': 'application/wasm',
    '.css': 'text/css',
  };

  const server = http.createServer((req, res) => {
    let filePath = req.url.split('?')[0]; // strip query string
    if (filePath === '/') filePath = '/index.html';
    const fullPath = path.join('/tmp/ps-bench-serve', filePath);
    const ext = path.extname(fullPath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // COOP/COEP headers needed for SharedArrayBuffer (OPFS)
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
      const content = fs.readFileSync(fullPath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    } catch {
      // Log 404s so we can debug missing files
      console.log(`  [404] ${req.url}`);
      res.writeHead(404);
      res.end('Not found');
    }
  });

  await new Promise(resolve => server.listen(9876, resolve));
  console.log('Serving benchmark at http://localhost:9876\n');

  // Launch Puppeteer
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--js-flags=--max-old-space-size=512',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--ignore-certificate-errors',
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Linux; Android 10; TECNO BC2c Build/QP1A.190711.020) '
    + 'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.90 '
    + 'Mobile Safari/537.36'
  );
  await page.setViewport({ width: 720, height: 1600, deviceScaleFactor: 2, isMobile: true });

  const client = await page.target().createCDPSession();
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: 200 * 1024,
    uploadThroughput: 96 * 1024,
    latency: 300,
  });
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  console.log('Throttling: CPU 4x, Network 3G, V8 heap 512MB');

  page.on('console', msg => {
    const text = msg.text();
    if (!text.includes('DevTools')) {
      console.log(`  [page] ${text}`);
    }
  });
  page.on('pageerror', err => console.log(`  [error] ${err.message}`));
  page.on('requestfailed', req => {
    const url = req.url();
    if (!url.includes('favicon')) {
      console.log(`  [req-fail] ${req.method()} ${url} ${req.failure()?.errorText || ''}`);
    }
  });

  // Navigate and run
  console.log('Loading benchmark page...');
  const tStart = Date.now();
  await page.goto('http://localhost:9876', { waitUntil: 'networkidle2', timeout: 30000 });

  // Wait for module to load
  await new Promise(r => setTimeout(r, 3000));

  console.log('Running PowerSync benchmark...\n');

  // Poll for completion with progress
  const benchPromise = page.evaluate(() => window.runPowerSyncBenchmark());

  // Monitor storage while benchmark runs
  const monitorInterval = setInterval(async () => {
    try {
      const storage = await page.evaluate(async () => {
        const est = await navigator.storage.estimate().catch(() => ({}));
        return parseFloat(((est.usage || 0) / 1e6).toFixed(1));
      });
      const elapsed = Math.round((Date.now() - tStart) / 1000);
      console.log(`  ${elapsed}s: ${storage}MB`);
    } catch {}
  }, 10000);

  const results = await benchPromise;
  clearInterval(monitorInterval);

  const tEnd = Date.now();
  const totalMs = tEnd - tStart;

  const metrics = await page.metrics();
  const jsHeapMB = parseFloat((metrics.JSHeapUsedSize / 1e6).toFixed(1));
  const jsHeapTotalMB = parseFloat((metrics.JSHeapTotalSize / 1e6).toFixed(1));

  const m = results.metrics;

  // --- Print results in same format as PouchDB benchmark ---
  console.log('');
  console.log('=============================================');
  console.log('  PowerSync/PostgreSQL Benchmark Results');
  console.log('  Go Edition: CPU 4x, 3G, 512MB heap');
  console.log('=============================================');
  console.log(`  User:                ${USERNAME}`);
  console.log(`  Sync completed:      ${m.fullSyncSuccess ? 'YES' : 'TIMED OUT'}`);
  console.log(`  VFS:                 ${m.vfs}`);
  console.log(`  WASM init:           ${m.wasmInitMs}ms`);
  console.log(`  Priority-1 sync:     ${m.priority1SyncMs}ms (${m.priority1Success ? 'OK' : 'TIMEOUT'})`);
  console.log(`  Full sync:           ${m.fullSyncMs}ms (${(m.fullSyncMs/1000).toFixed(0)}s)`);
  console.log(`  Total time:          ${totalMs}ms (${(totalMs/1000).toFixed(0)}s)`);
  console.log(`  Contacts after p1:   ${m.contactsAfterP1}`);
  console.log(`  Contacts total:      ${m.contactCount}`);
  console.log(`  Reports:             ${m.reportCount}`);
  console.log(`  Tasks:               ${m.taskCount}`);
  console.log(`  Global config:       ${m.globalConfigCount}`);
  console.log(`  Local DB size:       ${m.dbSizeDelta}MB (delta)`);
  console.log(`  Storage after:       ${m.storageAfter}MB`);
  console.log(`  Storage quota:       ${m.storageQuota}MB`);
  console.log(`  JS heap used:        ${jsHeapMB}MB`);
  console.log(`  JS heap total:       ${jsHeapTotalMB}MB`);
  console.log(`  Task list query:     ${m.taskQueryMs}ms`);
  console.log(`  Contact query:       ${m.contactQueryMs}ms`);
  console.log(`  Report query:        ${m.reportQueryMs}ms`);
  console.log('=============================================');

  // Write results in comparable format
  const output = {
    benchmark: 'powersync-postgresql',
    mode: 'standalone',
    timestamp: new Date().toISOString(),
    user: USERNAME,
    throttling: { cpu: '4x', network: '3G_200kbps', heapLimit: '512MB' },
    syncCompleted: m.fullSyncSuccess,
    vfs: m.vfs,
    wasmInitMs: m.wasmInitMs,
    priority1SyncMs: m.priority1SyncMs,
    priority1Success: m.priority1Success,
    fullSyncMs: m.fullSyncMs,
    totalMs: totalMs,
    contactsAfterP1: m.contactsAfterP1,
    contactCount: m.contactCount,
    reportCount: m.reportCount,
    taskCount: m.taskCount,
    globalConfigCount: m.globalConfigCount,
    localDbSizeMB: m.dbSizeDelta,
    storageAfterMB: m.storageAfter,
    storageQuotaMB: m.storageQuota,
    jsHeapUsedMB: jsHeapMB,
    jsHeapTotalMB: jsHeapTotalMB,
    taskQueryMs: m.taskQueryMs,
    contactQueryMs: m.contactQueryMs,
    reportQueryMs: m.reportQueryMs,
  };

  const outPath = '/tmp/benchmark-powersync-results.json';
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nResults written to ${outPath}`);

  await browser.close();
  server.close();
})().catch(e => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});
