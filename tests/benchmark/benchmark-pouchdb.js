#!/usr/bin/env node
/**
 * PouchDB/CouchDB Benchmark — Go Edition Throttled
 *
 * Usage:
 *   node benchmark-pouchdb.js [username] [password]
 *   node benchmark-pouchdb.js chw_test_1 'Secret1!pass2'
 */

const puppeteer = require('puppeteer');
const fs = require('fs');

const USERNAME = process.argv[2] || 'chw_test_1';
const PASSWORD = process.argv[3] || 'Secret1!pass2';
const CHT_URL = process.env.CHT_URL || 'https://nginx';
const SYNC_TIMEOUT = 600000;

async function handleLoginFlow(page, username, password) {
  await page.type('#user', username);
  await page.type('#password', password);
  await page.click('#login');
  console.log('Login submitted...');
  await new Promise(r => setTimeout(r, 10000));

  // Handle password reset if prompted
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
      console.log('URL after reset:', page.url());
    }
  }

  // Wait for app to load after login/reset
  await new Promise(r => setTimeout(r, 5000));

  // Handle replication warning dialog ("exceeds recommended limit")
  // May appear after login OR after password reset
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
    // Dialog may take time to appear
    await new Promise(r => setTimeout(r, 3000));
  }
}

(async () => {
  console.log('=== PouchDB/CouchDB Benchmark (Go Edition Throttled) ===');
  console.log(`User: ${USERNAME}`);
  console.log(`URL:  ${CHT_URL}`);
  console.log('');

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
  const skipNetwork = process.env.SKIP_NETWORK_THROTTLE === '1';
  const cpuRate = parseInt(process.env.CPU_THROTTLE || '4');
  if (!skipNetwork) {
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: 200 * 1024,
      uploadThroughput: 96 * 1024,
      latency: 300,
    });
  }
  await client.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  console.log(`Throttling: CPU ${cpuRate}x, Network ${skipNetwork ? 'UNTHROTTLED' : '3G (200KB/s)'}, V8 heap 512MB\n`);

  // Collect sync console messages
  page.on('console', msg => {
    const text = msg.text();
    if (text.match(/replicat|sync|fetch|bootstrap/i)) {
      console.log(`  [app] ${text}`);
    }
  });

  // --- Login ---
  console.log('Loading login page...');
  const t0 = Date.now();
  await page.goto(`${CHT_URL}/medic/login`, { waitUntil: 'networkidle2', timeout: 60000 });

  const tLogin = Date.now();
  await handleLoginFlow(page, USERNAME, PASSWORD);

  // Check if we landed on the app
  const appUrl = page.url();
  console.log(`App URL: ${appUrl}`);
  if (appUrl.includes('login') || appUrl.includes('password-reset')) {
    console.error('ERROR: Login failed. Check username/password.');
    await browser.close();
    process.exit(1);
  }

  const tAppLoaded = Date.now();
  console.log(`App loaded: ${tAppLoaded - tLogin}ms after login\n`);

  // --- Monitor sync progress ---
  console.log('Monitoring PouchDB sync...');
  let lastStorageMB = 0;
  let stallCount = 0;
  let syncComplete = false;

  for (let elapsed = 0; elapsed < SYNC_TIMEOUT; elapsed += 10000) {
    await new Promise(r => setTimeout(r, 10000));

    const status = await page.evaluate(async () => {
      const est = await navigator.storage.estimate().catch(() => ({ usage: 0, quota: 0 }));
      const bodyText = document.body?.innerText?.substring(0, 200) || '';
      return {
        storageMB: parseFloat((est.usage / 1e6).toFixed(1)),
        quotaMB: parseInt((est.quota / 1e6).toFixed(0)),
        bodySnippet: bodyText,
      };
    });

    const sec = Math.round(elapsed / 1000);
    const fetchMatch = status.bodySnippet.match(/(\d+)\s+of\s+(\d+)\s+docs/);
    const progress = fetchMatch ? `${fetchMatch[1]}/${fetchMatch[2]} docs` : '';
    console.log(`  ${sec}s: ${status.storageMB}MB ${progress}`);

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

  // --- Final metrics ---
  const finalStorage = await page.evaluate(async () => {
    const est = await navigator.storage.estimate().catch(() => ({ usage: 0, quota: 0 }));
    return { usedMB: parseFloat((est.usage / 1e6).toFixed(1)), quotaMB: parseInt((est.quota / 1e6).toFixed(0)) };
  });

  const metrics = await page.metrics();
  const jsHeapMB = parseFloat((metrics.JSHeapUsedSize / 1e6).toFixed(1));
  const jsHeapTotalMB = parseFloat((metrics.JSHeapTotalSize / 1e6).toFixed(1));

  // --- Print results ---
  console.log('');
  console.log('========================================');
  console.log('  PouchDB/CouchDB Benchmark Results');
  console.log('  Go Edition: CPU 4x, 3G, 512MB heap');
  console.log('========================================');
  console.log(`  User:                ${USERNAME}`);
  console.log(`  Sync completed:      ${syncComplete ? 'YES' : 'TIMED OUT'}`);
  console.log(`  Login → app loaded:  ${tAppLoaded - tLogin}ms`);
  console.log(`  Login → sync done:   ${tSyncEnd - tLogin}ms (${((tSyncEnd - tLogin)/1000).toFixed(0)}s)`);
  console.log(`  IndexedDB size:      ${finalStorage.usedMB}MB`);
  console.log(`  Storage quota:       ${finalStorage.quotaMB}MB`);
  console.log(`  JS heap used:        ${jsHeapMB}MB`);
  console.log(`  JS heap total:       ${jsHeapTotalMB}MB`);
  console.log('========================================');

  const results = {
    benchmark: 'pouchdb-couchdb',
    timestamp: new Date().toISOString(),
    user: USERNAME,
    throttling: { cpu: '4x', network: '3G_200kbps', heapLimit: '512MB' },
    syncCompleted: syncComplete,
    loginToAppLoadedMs: tAppLoaded - tLogin,
    loginToSyncDoneMs: tSyncEnd - tLogin,
    indexedDbSizeMB: finalStorage.usedMB,
    storageQuotaMB: finalStorage.quotaMB,
    jsHeapUsedMB: jsHeapMB,
    jsHeapTotalMB: jsHeapTotalMB,
  };

  const outPath = '/tmp/benchmark-pouchdb-results.json';
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${outPath}`);

  await browser.close();
})().catch(e => {
  console.error('Benchmark failed:', e);
  process.exit(1);
});
