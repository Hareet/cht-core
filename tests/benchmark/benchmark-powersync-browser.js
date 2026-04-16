#!/usr/bin/env node
/**
 * PowerSync/PostgreSQL Browser Benchmark — Go Edition Throttled
 *
 * Runs the CHT webapp with PowerSync feature flag ON through Puppeteer
 * with Go edition throttling (CPU 4x, 3G network, 512MB heap).
 *
 * Prerequisites:
 *   - CHT images rebuilt with PowerSync integration (npm run local-images)
 *   - PowerSync feature flag ON: node /tmp/set-powersync-flag.js on
 *   - User password reset: node /tmp/fix-user-password.js chw_test_1 Secret1!pass
 *
 * Usage:
 *   node benchmark-powersync-browser.js [username] [password]
 */

const puppeteer = require('puppeteer');
const fs = require('fs');

const USERNAME = process.argv[2] || 'chw_test_1';
const PASSWORD = process.argv[3] || 'Secret1!pass';
const CHT_URL = process.env.CHT_URL || 'https://nginx';
const SYNC_TIMEOUT = 600000;

async function handleLoginFlow(page, username, password) {
  await page.type('#user', username);
  await page.type('#password', password);
  await page.click('#login');
  console.log('Login submitted...');
  await new Promise(r => setTimeout(r, 10000));

  if (page.url().includes('password-reset')) {
    console.log('Password reset required, completing...');
    const newPass = password + '_bench';
    const inputs = await page.$$('input[type="password"]');
    if (inputs.length >= 3) {
      await inputs[0].type(password);
      await inputs[1].type(newPass);
      await inputs[2].type(newPass);
      await page.evaluate(() => document.querySelector('#update-password')?.click());
      await new Promise(r => setTimeout(r, 15000));
      console.log(`Password changed to: ${newPass}`);
    }
  }

  await new Promise(r => setTimeout(r, 5000));

  for (let attempt = 0; attempt < 6; attempt++) {
    const hasWarning = await page.evaluate(() => {
      return (document.body?.innerText || '').includes('Do you wish to continue');
    });
    if (hasWarning) {
      console.log('Replication warning detected, clicking Continue...');
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button, a.btn')];
        const btn = btns.find(b => b.textContent?.trim().toLowerCase() === 'continue');
        if (btn) btn.click();
      });
      await new Promise(r => setTimeout(r, 3000));
      break;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
}

(async () => {
  console.log('=== PowerSync/PostgreSQL Browser Benchmark (Go Edition Throttled) ===');
  console.log(`User: ${USERNAME}`);
  console.log(`URL:  ${CHT_URL}`);
  console.log('');

  // Determine tier before launching browser (need heap limit for launch args)
  const forcedTier = process.env.DEVICE_TIER || 'go';
  const PROFILES = {
    go:       { cpu: 4, heapMB: 512, label: 'Go Edition (Helio A22, 2GB RAM)' },
    budget:   { cpu: 2, heapMB: 1024, label: 'Budget (Helio G-series, 3-4GB RAM)' },
    standard: { cpu: 1, heapMB: 2048, label: 'Standard (mid-range, 4-6GB RAM)' },
    high:     { cpu: 1, heapMB: 4096, label: 'High-end (flagship, 6-8GB RAM)' },
  };
  const profile = PROFILES[forcedTier] || PROFILES.go;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--js-flags=--max-old-space-size=${profile.heapMB}`,
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--ignore-certificate-errors',
      '--allow-running-insecure-content',
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
  const skipNetwork = process.env.SKIP_NETWORK_THROTTLE === '1';
  if (!skipNetwork) {
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: 200 * 1024,
      uploadThroughput: 96 * 1024,
      latency: 300,
    });
  }
  await client.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  console.log(`Device tier: ${forcedTier} — ${profile.label}`);
  console.log(`Throttling: CPU ${profile.cpu}x, Network ${skipNetwork ? 'UNTHROTTLED' : '3G (200KB/s)'}, V8 heap ${profile.heapMB}MB\n`);

  // Track PowerSync-related logs
  page.on('console', msg => {
    const text = msg.text();
    if (text.match(/powersync|PowerSync|WASM|wasm|VFS|waitForFirstSync|priority|PouchDB sync DISABLED/i)) {
      console.log(`  [app] ${text}`);
    }
  });

  // Set PowerSync URL and force device tier before page loads
  await page.evaluateOnNewDocument((tier) => {
    window.__CHT_POWERSYNC_URL = 'http://powersync:8080';
    window.__CHT_FORCE_DEVICE_TIER = tier;
  }, forcedTier);

  console.log('Loading login page...');
  await page.goto(`${CHT_URL}/medic/login`, { waitUntil: 'networkidle2', timeout: 60000 });

  const tLogin = Date.now();
  await handleLoginFlow(page, USERNAME, PASSWORD);

  const appUrl = page.url();
  console.log(`App URL: ${appUrl}`);
  if (appUrl.includes('login') || appUrl.includes('password-reset')) {
    console.error('ERROR: Login failed.');
    await browser.close();
    process.exit(1);
  }

  const tAppLoaded = Date.now();
  console.log(`App loaded: ${tAppLoaded - tLogin}ms after login\n`);

  // Check which sync engine is active
  await new Promise(r => setTimeout(r, 5000));
  const syncCheck = await page.evaluate(() => ({
    hasPouchDB: typeof window.PouchDB !== 'undefined',
    bodySnippet: document.body?.innerText?.substring(0, 200) || '',
  }));
  const isPouchDBSyncing = syncCheck.bodySnippet.includes('Fetching info');
  console.log(`PouchDB present: ${syncCheck.hasPouchDB}`);
  console.log(`PouchDB syncing: ${isPouchDBSyncing}`);
  if (isPouchDBSyncing) {
    console.log('WARNING: PouchDB is syncing — feature flag may not have taken effect.');
    console.log('Continuing measurement anyway...\n');
  } else {
    console.log('PouchDB NOT syncing — PowerSync should be active.\n');
  }

  // Monitor sync progress via storage growth
  console.log('Monitoring sync...');
  let lastStorageMB = 0;
  let stallCount = 0;
  let syncComplete = false;
  let firstGrowthTime = null;
  const tSyncStart = Date.now();

  for (let elapsed = 0; elapsed < SYNC_TIMEOUT; elapsed += 10000) {
    await new Promise(r => setTimeout(r, 10000));

    const status = await page.evaluate(async () => {
      const est = await navigator.storage.estimate().catch(() => ({ usage: 0, quota: 0 }));
      const bodyText = document.body?.innerText?.substring(0, 300) || '';
      return {
        storageMB: parseFloat((est.usage / 1e6).toFixed(1)),
        quotaMB: parseInt((est.quota / 1e6).toFixed(0)),
        bodySnippet: bodyText,
      };
    });

    const sec = Math.round(elapsed / 1000);
    const fetchMatch = status.bodySnippet.match(/(\d+)\s+of\s+(\d+)\s+docs/);
    const progress = fetchMatch ? `${fetchMatch[1]}/${fetchMatch[2]} docs` : '';
    const isPDB = status.bodySnippet.includes('Fetching info');

    console.log(`  ${sec}s: ${status.storageMB}MB ${progress} ${isPDB ? '[PouchDB]' : '[PowerSync]'}`);

    if (!firstGrowthTime && status.storageMB > lastStorageMB + 0.5) {
      firstGrowthTime = Date.now() - tSyncStart;
      console.log(`  ** First data arrived at ${Math.round(firstGrowthTime / 1000)}s **`);
    }

    if (status.storageMB === lastStorageMB && status.storageMB > 35) {
      stallCount++;
      if (stallCount >= 6) {
        syncComplete = true;
        console.log('  Sync appears complete (storage stable for 60s)');
        break;
      }
    } else {
      stallCount = 0;
    }
    lastStorageMB = status.storageMB;
  }

  const tSyncEnd = Date.now();

  // Final metrics
  const finalStorage = await page.evaluate(async () => {
    const est = await navigator.storage.estimate().catch(() => ({ usage: 0, quota: 0 }));
    return { usedMB: parseFloat((est.usage / 1e6).toFixed(1)), quotaMB: parseInt((est.quota / 1e6).toFixed(0)) };
  });
  const metrics = await page.metrics();
  const jsHeapMB = parseFloat((metrics.JSHeapUsedSize / 1e6).toFixed(1));
  const jsHeapTotalMB = parseFloat((metrics.JSHeapTotalSize / 1e6).toFixed(1));

  console.log('');
  console.log('=============================================');
  console.log('  PowerSync/PostgreSQL Browser Benchmark');
  console.log(`  ${profile.label}: CPU ${profile.cpu}x, ${skipNetwork ? 'no network throttle' : '3G'}, ${profile.heapMB}MB heap`);
  console.log('=============================================');
  console.log(`  User:                ${USERNAME}`);
  console.log(`  Sync completed:      ${syncComplete ? 'YES' : 'TIMED OUT'}`);
  console.log(`  PouchDB active:      ${isPouchDBSyncing}`);
  console.log(`  Login → app loaded:  ${tAppLoaded - tLogin}ms`);
  console.log(`  First data arrived:  ${firstGrowthTime ? firstGrowthTime + 'ms' : 'not detected'}`);
  console.log(`  Login → sync done:   ${tSyncEnd - tLogin}ms (${((tSyncEnd - tLogin) / 1000).toFixed(0)}s)`);
  console.log(`  Local DB size:       ${finalStorage.usedMB}MB`);
  console.log(`  Storage quota:       ${finalStorage.quotaMB}MB`);
  console.log(`  JS heap used:        ${jsHeapMB}MB`);
  console.log(`  JS heap total:       ${jsHeapTotalMB}MB`);
  console.log('=============================================');

  const output = {
    benchmark: 'powersync-postgresql-browser',
    timestamp: new Date().toISOString(),
    user: USERNAME,
    throttling: { cpu: '4x', network: '3G_200kbps', heapLimit: '512MB' },
    syncCompleted: syncComplete,
    pouchdbActive: isPouchDBSyncing,
    loginToAppLoadedMs: tAppLoaded - tLogin,
    firstDataArrivedMs: firstGrowthTime,
    loginToSyncDoneMs: tSyncEnd - tLogin,
    localDbSizeMB: finalStorage.usedMB,
    storageQuotaMB: finalStorage.quotaMB,
    jsHeapUsedMB: jsHeapMB,
    jsHeapTotalMB: jsHeapTotalMB,
  };
  fs.writeFileSync('/tmp/benchmark-powersync-results.json', JSON.stringify(output, null, 2));
  console.log('\nResults written to /tmp/benchmark-powersync-results.json');

  await browser.close();
})().catch(e => { console.error('Benchmark failed:', e); process.exit(1); });
