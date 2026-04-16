#!/usr/bin/env node
/**
 * Compare PouchDB vs PowerSync benchmark results.
 *
 * Usage:
 *   node compare-results.js [pouchdb-results.json] [powersync-results.json]
 *   node compare-results.js  # defaults to /tmp/benchmark-*-results.json
 */

const fs = require('fs');

const pouchFile = process.argv[2] || '/tmp/benchmark-pouchdb-results.json';
const psFile = process.argv[3] || '/tmp/benchmark-powersync-results.json';

if (!fs.existsSync(pouchFile)) {
  console.error(`PouchDB results not found: ${pouchFile}`);
  console.error('Run benchmark-pouchdb.js first');
  process.exit(1);
}
if (!fs.existsSync(psFile)) {
  console.error(`PowerSync results not found: ${psFile}`);
  console.error('Run benchmark-powersync.js first');
  process.exit(1);
}

const pouch = JSON.parse(fs.readFileSync(pouchFile, 'utf8'));
const ps = JSON.parse(fs.readFileSync(psFile, 'utf8'));

function fmt(ms) {
  if (ms == null) return 'N/A';
  if (ms > 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${ms.toFixed(0)}ms`;
}

function winner(pVal, psVal, lowerIsBetter = true) {
  if (pVal == null || psVal == null) return '';
  if (lowerIsBetter) return pVal < psVal ? '← PouchDB' : pVal > psVal ? 'PowerSync →' : 'TIE';
  return pVal > psVal ? '← PouchDB' : pVal < psVal ? 'PowerSync →' : 'TIE';
}

function pct(pVal, psVal) {
  if (!pVal || !psVal) return '';
  const change = ((psVal - pVal) / pVal * 100).toFixed(0);
  return change > 0 ? `+${change}%` : `${change}%`;
}

// For PowerSync, extract metrics from the nested structure if available
let psMetrics = {};
if (ps.metrics) {
  ps.metrics.forEach(m => { psMetrics[m.name] = m.value; });
}

const pouchSyncMs = pouch.loginToSyncDoneMs;
const psSyncMs = ps.loginToSyncDoneMs || psMetrics.full_sync_ms;
const psP1Ms = ps.priority1ArrivalMs || psMetrics.priority1_sync_ms;
const pouchStorage = pouch.indexedDbSizeMB;
const psStorage = ps.storageSizeMB || psMetrics.db_size_delta_mb;
const pouchHeap = pouch.jsHeapUsedMB;
const psHeap = ps.jsHeapUsedMB || psMetrics.js_heap_used_mb;

console.log('');
console.log('╔══════════════════════════════════════════════════════════════════════╗');
console.log('║           CouchDB/PouchDB vs PostgreSQL/PowerSync                   ║');
console.log('║           Go Edition Throttled (CPU 4x, 3G, 512MB heap)             ║');
console.log('╠══════════════════════════════════════════════════════════════════════╣');
console.log('║                                                                      ║');
console.log(`║  User: ${pouch.user || USERNAME}                                     `);
console.log(`║  PouchDB run:   ${pouch.timestamp}                                   `);
console.log(`║  PowerSync run: ${ps.timestamp}                                      `);
console.log('║                                                                      ║');
console.log('╠════════════════════════╦════════════╦════════════╦════════╦══════════╣');
console.log('║ Metric                 ║  PouchDB   ║ PowerSync  ║ Change ║  Winner  ║');
console.log('╠════════════════════════╬════════════╬════════════╬════════╬══════════╣');

const rows = [
  ['Login → app loaded',  fmt(pouch.loginToAppLoadedMs), fmt(ps.loginToAppLoadedMs), pct(pouch.loginToAppLoadedMs, ps.loginToAppLoadedMs), winner(pouch.loginToAppLoadedMs, ps.loginToAppLoadedMs)],
  ['Priority-1 sync',     'N/A (full only)', fmt(psP1Ms), '', 'PowerSync →'],
  ['Full sync time',      fmt(pouchSyncMs), fmt(psSyncMs), pct(pouchSyncMs, psSyncMs), winner(pouchSyncMs, psSyncMs)],
  ['Local DB size',        `${pouchStorage || '?'}MB`, `${psStorage || '?'}MB`, pct(pouchStorage, psStorage), winner(pouchStorage, psStorage)],
  ['JS heap used',         `${pouchHeap || '?'}MB`, `${psHeap || '?'}MB`, pct(pouchHeap, psHeap), winner(pouchHeap, psHeap)],
  ['Doc count',            String(pouch.docCount || '?'), String(ps.docCount || psMetrics.report_count || '?'), '', ''],
  ['Sync completed',       pouch.syncCompleted ? 'YES' : 'NO', (ps.syncCompleted || psMetrics.full_sync_success) ? 'YES' : 'NO', '', ''],
];

for (const [label, pVal, psVal, change, win] of rows) {
  console.log(`║ ${label.padEnd(22)} ║ ${pVal.padStart(10)} ║ ${psVal.padStart(10)} ║ ${(change||'').padStart(6)} ║ ${(win||'').padStart(8)} ║`);
}

console.log('╚════════════════════════╩════════════╩════════════╩════════╩══════════╝');

// PowerSync-specific metrics if available
if (psMetrics.wasm_init_ms) {
  console.log('');
  console.log('PowerSync-specific metrics:');
  console.log(`  WASM init:              ${fmt(psMetrics.wasm_init_ms)}`);
  console.log(`  VFS:                    ${psMetrics.vfs_selected ? 'OPFS' : 'IndexedDB'}`);
  console.log(`  Contact count (p1):     ${psMetrics.contact_count_after_p1 || 'N/A'}`);
  console.log(`  Report count:           ${psMetrics.report_count || 'N/A'}`);
  console.log(`  Task count:             ${psMetrics.task_count || 'N/A'}`);
  console.log(`  Task list query:        ${fmt(psMetrics.task_list_query_ms)}`);
  console.log(`  Contact query:          ${fmt(psMetrics.contact_by_type_query_ms)}`);
  console.log(`  Reports query:          ${fmt(psMetrics.reports_query_ms)}`);
  console.log(`  Upload queue pending:   ${psMetrics.upload_queue_pending || 0}`);
}

console.log('');

// Save combined comparison
const comparison = { pouch, powersync: ps, psMetrics };
const outPath = '/tmp/benchmark-comparison.json';
fs.writeFileSync(outPath, JSON.stringify(comparison, null, 2));
console.log(`Full comparison written to ${outPath}`);
