#!/usr/bin/env node
/**
 * supervisor coverage pre-flight
 *
 * Tests each supervisor in users.csv against a cohort of CHW contact UUIDs
 * via POST /medic/_bulk_get. Reports which supervisor has the broadest
 * hierarchy overlap with the CHWs we'll write as.
 *
 * Why this exists: during development we discovered that the first
 * supervisor in users.csv (`zacharyscaled-...user1`) could not see the
 * first CHW's (`turnerscaled-...healthcenter0user0`) docs via _bulk_get,
 * even though both sit under `districthospital0` by name. The scaled-data
 * hierarchy's `role=supervisor` doesn't always grant subtree visibility on
 * this deployment — so the peer_getids benchmark needs to pick an actually-
 * working supervisor empirically instead of by convention.
 *
 * Approach:
 *   1. Parse users.csv → supervisors + CHWs (first COHORT_SIZE CHWs).
 *   2. For each supervisor, POST /medic/_bulk_get with the CHWs' contact
 *      UUIDs, count `ok` responses (offline filter permitted the read).
 *   3. Report coverage table to stderr; emit best-supervisor JSON on stdout.
 *
 * Environment:
 *   USERS_CSV      path to users.csv (default: ../users.csv)
 *   API_URL        (default: http://localhost:5988)
 *   COHORT_SIZE    number of CHWs to test against (default: 50 — matches
 *                  max concurrency level)
 *
 * Usage:
 *   node check-supervisor-coverage.js
 *
 * Stdout (one JSON line):
 *   {"username":"...","password":"...","coverage":48,"total":50,"pct":96}
 *
 * Exit codes:
 *   0 — at least one supervisor found (even if partial coverage)
 *   1 — no supervisors loaded, or no supervisor saw any CHW
 */
const fs = require('fs');
const path = require('path');

const USERS_CSV = process.env.USERS_CSV || path.join(__dirname, '..', 'users.csv');
const API_URL = process.env.API_URL || 'http://localhost:5988';
const COHORT_SIZE = parseInt(process.env.COHORT_SIZE || '50');

function parseCSV(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8');
  const rows = raw.split('\n').filter(Boolean);
  const supervisors = [];
  const chws = [];
  for (const row of rows) {
    // CSV layout: "username","password","roles","contact","phone","place"
    const cols = row.split(',').map(c => c.replace(/^"|"$/g, ''));
    if (cols[0] === 'username') continue;
    const [username, password, roles, contact] = cols;
    if (!username || !password || !contact) continue;
    if (roles.includes('national_admin')) continue;
    if (roles.includes('supervisor')) {
      supervisors.push({ username, password });
    } else {
      chws.push({ username, contact });
    }
  }
  return { supervisors, chws };
}

async function coverageFor(supervisor, contacts) {
  const auth = 'Basic ' + Buffer.from(`${supervisor.username}:${supervisor.password}`).toString('base64');
  const body = { docs: contacts.map(c => ({ id: c })) };
  try {
    const res = await fetch(`${API_URL}/medic/_bulk_get`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: 0, error: `http_${res.status}` };
    const parsed = await res.json();
    const results = parsed.results || [];
    let ok = 0;
    for (const r of results) {
      if (r.docs && r.docs.some(d => d.ok)) ok++;
    }
    return { ok };
  } catch (e) {
    return { ok: 0, error: e.message.substring(0, 100) };
  }
}

async function run() {
  const { supervisors, chws } = parseCSV(USERS_CSV);

  if (supervisors.length === 0) {
    process.stderr.write(`No supervisors found in ${USERS_CSV}\n`);
    process.exit(1);
  }

  const contacts = chws.slice(0, COHORT_SIZE).map(c => c.contact);
  process.stderr.write(`Testing ${supervisors.length} supervisors against ${contacts.length} CHW contacts\n`);

  const results = [];
  for (const sup of supervisors) {
    const r = await coverageFor(sup, contacts);
    results.push({ ...sup, ok: r.ok, error: r.error });
    const pct = contacts.length ? ((r.ok / contacts.length) * 100).toFixed(0) : '0';
    const err = r.error ? ` (${r.error})` : '';
    process.stderr.write(`  ${sup.username.padEnd(60)} ${r.ok}/${contacts.length} (${pct}%)${err}\n`);
  }

  results.sort((a, b) => b.ok - a.ok);
  const best = results[0];

  if (best.ok === 0) {
    process.stderr.write('\nERROR: no supervisor can see any CHW contact.\n');
    process.stderr.write('This means the scaled-data supervisor role is not configured with\n');
    process.stderr.write('subtree visibility over the CHWs in users.csv. Fix: either update\n');
    process.stderr.write('app_settings permissions/replication_depth for the supervisor role,\n');
    process.stderr.write('or adjust the scaled-data hierarchy. peer_getids benchmark skipped.\n');
    process.exit(1);
  }

  process.stderr.write(`\n  → best supervisor: ${best.username} (${best.ok}/${contacts.length})\n`);
  console.log(JSON.stringify({
    username: best.username,
    password: best.password,
    coverage: best.ok,
    total: contacts.length,
    pct: Math.round((best.ok / contacts.length) * 100),
  }));
}

run().catch(e => {
  process.stderr.write(`check-supervisor-coverage fatal: ${e.message}\n`);
  process.exit(1);
});
