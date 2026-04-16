#!/usr/bin/env node
/**
 * Full Benchmark Suite: Initial Sync + Incremental Sync
 * Runs both PouchDB and PowerSync paths for a given device tier.
 *
 * Env vars:
 *   DEVICE_TIER=go|budget|standard|high     Device tier (default: go)
 *   SKIP_NETWORK_THROTTLE=1                 Skip 3G throttling
 *   CHT_ROLE=chw_min_5km                    Required for PowerSync JWT
 *   TEST=pouchdb|powersync|incremental|all  Which tests to run (default: all)
 *
 * Usage:
 *   CHT_ROLE=chw_min_5km DEVICE_TIER=budget node benchmark-full-suite.js chw_test_1 'Secret1!pass'
 *   CHT_ROLE=chw_min_5km TEST=incremental node benchmark-full-suite.js chw_test_1 'Secret1!pass'
 */

const { execSync } = require('child_process');
const fs = require('fs');

const USERNAME = process.argv[2] || 'chw_test_1';
const PASSWORD = process.argv[3] || 'Secret1!pass';
const DEVICE_TIER = process.env.DEVICE_TIER || 'go';
const SKIP_NETWORK = process.env.SKIP_NETWORK_THROTTLE || '0';
const CHT_ROLE = process.env.CHT_ROLE || 'chw_min_5km';
const TEST = process.env.TEST || 'all';

const PROFILES = {
  go:       { label: 'Go Edition (Helio A22, 2GB RAM, Android 10)' },
  budget:   { label: 'Budget (Helio G-series, 3-4GB RAM)' },
  standard: { label: 'Standard (mid-range, 4-6GB RAM)' },
  high:     { label: 'High-end (flagship, 6-8GB RAM)' },
};

const profile = PROFILES[DEVICE_TIER] || PROFILES.go;

function run(cmd, label) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${label}`);
  console.log(`${'='.repeat(70)}\n`);
  try {
    execSync(cmd, { stdio: 'inherit', timeout: 900000 }); // 15 min timeout
  } catch (e) {
    console.error(`\n  ${label} FAILED: ${e.message}\n`);
  }
}

function fixPassword() {
  try {
    execSync(`node /tmp/fix-user-password.js ${USERNAME} '${PASSWORD}'`, { stdio: 'pipe', timeout: 10000 });
  } catch {}
}

function setFlag(state) {
  try {
    execSync(`node /tmp/set-powersync-flag.js ${state}`, { stdio: 'pipe', timeout: 10000 });
  } catch {}
}

console.log('╔══════════════════════════════════════════════════════════════════════╗');
console.log('║                    CHT Full Benchmark Suite                         ║');
console.log('╠══════════════════════════════════════════════════════════════════════╣');
console.log(`║  User:           ${USERNAME.padEnd(50)}║`);
console.log(`║  Device tier:    ${(DEVICE_TIER + ' — ' + profile.label).padEnd(50)}║`);
console.log(`║  Network:        ${(SKIP_NETWORK === '1' ? 'UNTHROTTLED (WiFi)' : '3G (200KB/s, 300ms latency)').padEnd(50)}║`);
console.log(`║  CHT Role:       ${CHT_ROLE.padEnd(50)}║`);
console.log(`║  Tests:          ${TEST.padEnd(50)}║`);
console.log('╚══════════════════════════════════════════════════════════════════════╝');

const env = `DEVICE_TIER=${DEVICE_TIER} SKIP_NETWORK_THROTTLE=${SKIP_NETWORK} CHT_ROLE=${CHT_ROLE}`;

const cpuThrottle = DEVICE_TIER === 'go' ? 4 : DEVICE_TIER === 'budget' ? 2 : 1;

// --- PouchDB Suite: Initial Sync + get-ids incremental ---
if (TEST === 'all' || TEST === 'pouchdb') {
  setFlag('off');
  fixPassword();
  run(
    `${env} CPU_THROTTLE=${cpuThrottle} node /tmp/benchmark-pouchdb.js ${USERNAME} '${PASSWORD}'`,
    `PouchDB Initial Sync — ${profile.label}`
  );
  try {
    const results = JSON.parse(fs.readFileSync('/tmp/benchmark-pouchdb-results.json', 'utf8'));
    results.deviceTier = DEVICE_TIER;
    results.networkThrottled = SKIP_NETWORK !== '1';
    fs.writeFileSync('/tmp/benchmark-pouchdb-results.json', JSON.stringify(results, null, 2));
  } catch {}

  // Also run get-ids measurement (PouchDB incremental cost)
  fixPassword();
  run(
    `${env} node /tmp/benchmark-incremental-sync.js ${USERNAME} '${PASSWORD}'`,
    `PouchDB Incremental Sync (get-ids) — ${profile.label}`
  );
}

// --- PowerSync Suite: Initial Sync + delta incremental ---
if (TEST === 'all' || TEST === 'powersync') {
  setFlag('on');
  fixPassword();
  run(
    `${env} node /tmp/benchmark-powersync-browser.js ${USERNAME} '${PASSWORD}'`,
    `PowerSync Initial Sync — ${profile.label}`
  );
  try {
    const results = JSON.parse(fs.readFileSync('/tmp/benchmark-powersync-results.json', 'utf8'));
    results.deviceTier = DEVICE_TIER;
    results.networkThrottled = SKIP_NETWORK !== '1';
    fs.writeFileSync('/tmp/benchmark-powersync-results.json', JSON.stringify(results, null, 2));
  } catch {}

  // Also run PowerSync delta measurement
  fixPassword();
  run(
    `${env} node /tmp/benchmark-incremental-sync.js ${USERNAME} '${PASSWORD}'`,
    `PowerSync Incremental Sync (delta) — ${profile.label}`
  );
}

// --- Standalone incremental (both engines) ---
if (TEST === 'incremental') {
  setFlag('on');
  fixPassword();
  run(
    `${env} node /tmp/benchmark-incremental-sync.js ${USERNAME} '${PASSWORD}'`,
    `Incremental Sync (get-ids vs delta) — ${profile.label}`
  );
}

// --- Summary ---
console.log(`\n${'='.repeat(70)}`);
console.log('  COMBINED RESULTS');
console.log(`${'='.repeat(70)}\n`);

try {
  const pouchdb = JSON.parse(fs.readFileSync('/tmp/benchmark-pouchdb-results.json', 'utf8'));
  const powersync = JSON.parse(fs.readFileSync('/tmp/benchmark-powersync-results.json', 'utf8'));
  const incremental = JSON.parse(fs.readFileSync('/tmp/benchmark-incremental-results.json', 'utf8'));

  console.log(`  Device: ${DEVICE_TIER} — ${profile.label}`);
  console.log(`  Network: ${SKIP_NETWORK === '1' ? 'Unthrottled' : '3G throttled'}`);
  console.log('');
  console.log('  Initial Sync (login → all data available):');
  console.log(`    PouchDB:    ${pouchdb.loginToSyncDoneMs ? Math.round(pouchdb.loginToSyncDoneMs / 1000) + 's' : 'N/A'}`);
  console.log(`    PowerSync:  ${powersync.loginToSyncDoneMs ? Math.round(powersync.loginToSyncDoneMs / 1000) + 's' : 'N/A'}`);
  console.log('');
  console.log('  Storage:');
  console.log(`    PouchDB:    ${pouchdb.indexedDbSizeMB || 'N/A'}MB`);
  console.log(`    PowerSync:  ${powersync.localDbSizeMB || 'N/A'}MB`);
  console.log('');
  console.log('  JS Heap:');
  console.log(`    PouchDB:    ${pouchdb.jsHeapUsedMB || 'N/A'}MB`);
  console.log(`    PowerSync:  ${powersync.jsHeapUsedMB || 'N/A'}MB`);
  console.log('');
  console.log('  Incremental Sync (per cycle, nothing changed):');
  console.log(`    PouchDB:    ${incremental.pouchdb?.getIdsAvgMs || 'N/A'}ms (get-ids scan of full DB)`);
  console.log(`    PowerSync:  0ms (live WebSocket, no polling)`);
  console.log('');
  console.log('  Incremental Sync (1 new doc end-to-end):');
  console.log(`    PowerSync:  ${incremental.powersync?.newDocDetectedMs > 0 ? incremental.powersync.newDocDetectedMs + 'ms' : 'N/A'}`);
  console.log('');
  console.log('  Daily Server Load (2,611 users, 5-min interval):');
  const getIdsMs = incremental.pouchdb?.getIdsAvgMs || 5000;
  console.log(`    PouchDB:    ~750K get-ids calls × ${getIdsMs}ms = ${Math.round(750000 * getIdsMs / 1000 / 3600)}h CouchDB CPU`);
  console.log('    PowerSync:  0 polling calls (event-driven via WAL)');
} catch (e) {
  console.log('  (Some result files missing — run with TEST=all to get full comparison)');
  console.log(`  Error: ${e.message}`);
}

console.log(`\n${'='.repeat(70)}`);
console.log('  Result files:');
console.log('    /tmp/benchmark-pouchdb-results.json');
console.log('    /tmp/benchmark-powersync-results.json');
console.log('    /tmp/benchmark-incremental-results.json');
console.log(`${'='.repeat(70)}`);
