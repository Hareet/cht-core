#!/usr/bin/env node
/**
 * bucket-semantics-test.js
 *
 * Connects to PowerSync sync/stream endpoint as bucket_test_user,
 * fetches the checkpoint, and counts buckets per experiment stream.
 *
 * Prerequisites:
 *   1. Run bucket-test-setup.sql to create the test user with 15 facilities
 *   2. Deploy bucket-test-config.yaml as the PowerSync config
 *   3. Restart cht-powersync container
 *
 * Usage:
 *   POWERSYNC_URL=http://localhost:8080 node bucket-semantics-test.js
 *
 * Or from within cht-net:
 *   POWERSYNC_URL=http://powersync:8080 node bucket-semantics-test.js
 */

import { createHash, createSign } from 'crypto';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const POWERSYNC_URL = process.env.POWERSYNC_URL || 'http://localhost:8080';
const EXPECTED_FACILITIES = 15;

const USER_CONFIG = {
  user_id: 'org.couchdb.user:bucket_test_user',
  contact_id: 'bucket-test-contact-1',
  roles: ['chw'],
  report_depth: 1,
};

// --- JWT generation (same pattern as connector.js) ---

function md5(str) {
  return createHash('md5').update(str).digest('hex');
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generateToken() {
  // Try multiple paths for the private key
  const keyPaths = [
    resolve(__dirname, '../../.devcontainer/powersync-config/dev-private-key.pem'),
    resolve(__dirname, '../../../.devcontainer/powersync-config/dev-private-key.pem'),
  ];

  let privateKey;
  for (const p of keyPaths) {
    try {
      privateKey = readFileSync(p, 'utf8');
      break;
    } catch { /* try next */ }
  }
  if (!privateKey) {
    console.error('Private key not found. Tried:', keyPaths);
    process.exit(1);
  }

  const header = { alg: 'RS256', typ: 'JWT', kid: 'cht-dev-key-1' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: USER_CONFIG.user_id,
    aud: 'cht-powersync-dev',
    iat: now,
    exp: now + 3600 * 24,
    role_hash: md5(USER_CONFIG.roles.sort().join(',')),
    contact_id: USER_CONFIG.contact_id,
    report_depth: USER_CONFIG.report_depth,
    can_view_unallocated: 'false',
    roles: USER_CONFIG.roles,
  };

  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sign = createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = base64url(sign.sign(privateKey));
  return `${signingInput}.${signature}`;
}

// --- Sync stream request ---

async function fetchCheckpoint(token) {
  const url = `${POWERSYNC_URL}/sync/stream`;
  const body = JSON.stringify({ buckets: [], include_checksum: true });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.substring(0, 500)}`);
  }

  // Read until first newline (NDJSON — first line is the checkpoint)
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const nlIdx = buffer.indexOf('\n');
    if (nlIdx !== -1) {
      reader.cancel();
      return JSON.parse(buffer.substring(0, nlIdx));
    }
  }

  // No newline found — try parsing the whole buffer
  return JSON.parse(buffer);
}

// --- Analysis ---

function analyzeResults(response) {
  const checkpoint = response.checkpoint;
  if (!checkpoint) {
    console.error('ERROR: No checkpoint in response.');
    console.error(JSON.stringify(response, null, 2).substring(0, 2000));
    process.exit(1);
  }

  const buckets = checkpoint.buckets || [];

  console.log('\n' + '='.repeat(72));
  console.log('POWERSYNC BUCKET SEMANTICS — EMPIRICAL TEST RESULTS');
  console.log('='.repeat(72));
  console.log(`User:               ${USER_CONFIG.user_id}`);
  console.log(`Facilities seeded:  ${EXPECTED_FACILITIES}`);
  console.log(`Total buckets:      ${buckets.length}`);

  // Group buckets by experiment prefix
  const experiments = {
    exp1_direct:       { buckets: [], desc: 'CONTROL: WHERE col = auth.user_id()' },
    exp2_join:         { buckets: [], desc: 'BASELINE: INNER JOIN on auth.user_id()' },
    exp3_subquery:     { buckets: [], desc: 'CRITICAL: IN (SELECT ... WHERE user_id = auth.user_id())' },
    exp4_cte:          { buckets: [], desc: 'Named CTE: WITH ... IN <cte>' },
    exp5_consolidated: { buckets: [], desc: 'CONSOLIDATED: Two queries sharing one CTE' },
  };

  const unmatched = [];
  for (const b of buckets) {
    let matched = false;
    for (const expName of Object.keys(experiments)) {
      if (b.bucket.includes(expName)) {
        experiments[expName].buckets.push(b);
        matched = true;
        break;
      }
    }
    if (!matched) unmatched.push(b);
  }

  // Per-experiment report
  console.log('\n' + '-'.repeat(72));
  console.log('PER-EXPERIMENT BREAKDOWN');
  console.log('-'.repeat(72));

  const results = {};
  for (const [name, exp] of Object.entries(experiments)) {
    const count = exp.buckets.length;
    results[name] = count;

    const totalDocs = exp.buckets.reduce((s, b) => s + (b.count || 0), 0);
    console.log(`\n  ${name}: ${exp.desc}`);
    console.log(`    Buckets: ${count}`);
    console.log(`    Total rows: ${totalDocs}`);

    // Show first 3 bucket names
    for (const b of exp.buckets.slice(0, 3)) {
      console.log(`      ${b.bucket}  (count=${b.count || 0})`);
    }
    if (count > 3) {
      console.log(`      ... and ${count - 3} more`);
    }
  }

  if (unmatched.length > 0) {
    console.log(`\n  UNMATCHED BUCKETS: ${unmatched.length}`);
    for (const b of unmatched.slice(0, 5)) {
      console.log(`    ${b.bucket}`);
    }
  }

  // Decision matrix
  console.log('\n' + '='.repeat(72));
  console.log('VERDICT');
  console.log('='.repeat(72));

  const N = EXPECTED_FACILITIES;
  const e1 = results.exp1_direct;
  const e2 = results.exp2_join;
  const e3 = results.exp3_subquery;
  const e4 = results.exp4_cte;
  const e5 = results.exp5_consolidated;

  console.log(`\n  exp1 (direct auth):     ${e1} bucket(s)  ${e1 === 1 ? '✓ CONFIRMED 1 bucket' : '⚠ UNEXPECTED'}`);
  console.log(`  exp2 (INNER JOIN):      ${e2} bucket(s)  ${e2 === N ? `✓ CONFIRMED N=${N}` : '⚠ CHECK'}`);
  console.log(`  exp3 (inline subquery): ${e3} bucket(s)  ${e3 === 1 ? '★ BREAKTHROUGH — 1 BUCKET!' : e3 === N ? `✗ N=${N} (same as JOIN)` : '⚠ UNEXPECTED'}`);
  console.log(`  exp4 (named CTE):       ${e4} bucket(s)  ${e4 === N ? `✓ N=${N} (CTE = subquery)` : '⚠ CHECK'}`);
  console.log(`  exp5 (consolidated):    ${e5} bucket(s)  ${e5 === N ? `✓ N=${N} — SHARING WORKS!` : e5 === 2 * N ? `✗ 2N=${2*N} — NO SHARING` : '⚠ CHECK'}`);

  console.log('\n  ' + '-'.repeat(68));

  if (e3 === 1) {
    console.log('  RESULT: BEST CASE — Inline subqueries collapse to 1 bucket!');
    console.log('  ACTION: Rewrite all streams to use IN (SELECT ... WHERE user_id = auth.user_id())');
    console.log('  IMPACT: ~9 total buckets per user regardless of facility count. Problem solved.');
  } else if (e3 === N && e5 === N) {
    console.log('  RESULT: PRAGMATIC — Subqueries create N buckets, but CTE sharing works.');
    console.log('  ACTION: Consolidate streams sharing the same CTE into one stream with queries:[]');
    console.log('  IMPACT: Total buckets = N_accessible + N_report + 4 (was 9*N)');
    console.log(`  EXAMPLE: For 1,010 facilities: ~2,500 buckets (fits in 5,000 limit)`);
  } else if (e3 === N && e5 === 2 * N) {
    console.log('  RESULT: WORST CASE — N buckets per pattern, no sharing.');
    console.log('  ACTION: Consider county-scoped PowerSync instances or engage PowerSync team.');
    console.log('  IMPACT: No query-level fix available. Architecture change needed.');
  } else {
    console.log('  RESULT: UNEXPECTED — Manual analysis of bucket names required.');
    console.log('  Check the raw bucket list below and docker logs cht-powersync.');
  }

  console.log('\n' + '='.repeat(72));

  // Raw dump for manual analysis
  console.log('\nRAW BUCKET LIST:');
  for (const b of buckets) {
    console.log(`  ${b.bucket}  count=${b.count || 0}  priority=${b.priority || '?'}`);
  }
  console.log();
}

// --- Main ---

async function main() {
  console.log('PowerSync Bucket Semantics Test');
  console.log('-------------------------------');
  console.log(`Target: ${POWERSYNC_URL}`);
  console.log(`User:   ${USER_CONFIG.user_id}`);
  console.log();

  console.log('Generating JWT...');
  const token = generateToken();

  console.log('Fetching checkpoint from /sync/stream...');
  try {
    const response = await fetchCheckpoint(token);
    analyzeResults(response);
  } catch (err) {
    console.error('\nERROR:', err.message);

    if (err.message.includes('PSYNC_S2305')) {
      console.error('\nPSYNC_S2305 = Too many buckets!');
      console.error('With only 15 facilities this should not happen.');
      console.error('Check: docker logs --tail 50 cht-powersync 2>&1 | grep PSYNC_S2305');
    }
    if (err.message.includes('ECONNREFUSED')) {
      console.error('\nCannot reach PowerSync. Check:');
      console.error('  - docker ps | grep powersync');
      console.error('  - Is POWERSYNC_URL correct? Current:', POWERSYNC_URL);
    }

    process.exit(1);
  }
}

main();
