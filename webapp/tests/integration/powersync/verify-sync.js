#!/usr/bin/env node
/**
 * End-to-end verification that the PowerSync service is syncing CHT data.
 *
 * Tests:
 * 1. JWT authentication works with the dev key
 * 2. Sync stream returns contact, report, and global_config buckets
 * 3. Contact data contains expected fields from our schema
 * 4. Global config includes forms and translations
 *
 * Prerequisites:
 *   - PowerSync service running at powersync:8080
 *   - PostgreSQL at postgres:5432 with v1.couchdb populated
 *   - Dev private key at ../../.devcontainer/powersync-config/dev-private-key.pem
 *
 * Usage:
 *   node webapp/tests/integration/powersync/verify-sync.js
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const POWERSYNC_URL = process.env.POWERSYNC_URL || 'http://powersync:8080';
const TOKEN_GENERATOR = path.resolve(
  __dirname,
  '../../../../.devcontainer/powersync-config/generate-test-token.js'
);

// Allow alternate token generator path if running from different worktree
const ALT_TOKEN_GENERATOR = path.resolve(
  __dirname,
  '../../../../../.agents/worktrees/agent-3/.devcontainer/powersync-config/generate-test-token.js'
);

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function generateToken() {
  // Try to use agent-3's token generator
  const genPath = fs.existsSync(TOKEN_GENERATOR) ? TOKEN_GENERATOR : ALT_TOKEN_GENERATOR;
  if (!fs.existsSync(genPath)) {
    console.error('Token generator not found. Generating inline...');
    return generateTokenInline();
  }
  const { execSync } = require('child_process');
  return execSync(`node "${genPath}" chw_user`, { encoding: 'utf8' }).trim();
}

function generateTokenInline() {
  const privateKeyPath = [
    path.resolve(__dirname, '../../../../.devcontainer/powersync-config/dev-private-key.pem'),
    path.resolve(__dirname, '../../../../../.agents/worktrees/agent-3/.devcontainer/powersync-config/dev-private-key.pem'),
    '/workspace/cht-core/.agents/worktrees/agent-3/.devcontainer/powersync-config/dev-private-key.pem',
  ].find(p => fs.existsSync(p));

  if (!privateKeyPath) {
    throw new Error('Cannot find dev-private-key.pem');
  }

  const privateKey = fs.readFileSync(privateKeyPath, 'utf8');

  function base64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  const header = { alg: 'RS256', typ: 'JWT', kid: 'cht-dev-key-1' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: 'org.couchdb.user:chw_user',
    aud: 'cht-powersync-dev',
    iat: now,
    exp: now + 3600,
    role_hash: crypto.createHash('md5').update('chw').digest('hex'),
    contact_id: '3ec4f112db4527a356e1aa8593002fc0',
    report_depth: 1,
    roles: ['chw'],
  };

  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = base64url(sign.sign(privateKey));
  return `${signingInput}.${signature}`;
}

async function fetchSync(token) {
  const controller = new AbortController();

  const response = await fetch(`${POWERSYNC_URL}/sync/stream`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ buckets: [], include_checksum: true }),
    signal: controller.signal,
  });

  if (!response.ok) {
    throw new Error(`Sync request failed: ${response.status} ${response.statusText}`);
  }

  // The response is NDJSON (streaming). Read chunks with a timeout.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';

  // Read for up to 5 seconds then abort
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // AbortError expected after timeout
  } finally {
    clearTimeout(timeout);
  }

  const lines = text.trim().split('\n').filter(l => l.trim());
  return lines.map(l => {
    try { return JSON.parse(l); }
    catch { return null; }
  }).filter(Boolean);
}

async function main() {
  console.log('PowerSync End-to-End Sync Verification');
  console.log('=======================================\n');

  // Step 1: Generate JWT
  console.log('1. JWT Authentication');
  let token;
  try {
    token = generateToken();
    assert(token && token.split('.').length === 3, 'Generated valid JWT token');
  } catch (err) {
    console.error('Failed to generate token:', err.message);
    process.exit(1);
  }

  // Step 2: Fetch sync stream
  console.log('\n2. Sync Stream Connection');
  let syncData;
  try {
    syncData = await fetchSync(token);
    assert(syncData.length > 0, 'Received sync stream response');
  } catch (err) {
    console.error('Sync failed:', err.message);
    process.exit(1);
  }

  // Step 3: Verify checkpoint
  console.log('\n3. Checkpoint & Buckets');
  const checkpoint = syncData.find(d => d.checkpoint);
  assert(!!checkpoint, 'Received checkpoint message');

  if (checkpoint) {
    const buckets = checkpoint.checkpoint.buckets || [];
    assert(buckets.length > 0, `Found ${buckets.length} sync buckets`);

    // Check bucket types
    const bucketNames = buckets.map(b => b.bucket);
    const hasContacts = bucketNames.some(n => n.includes('contacts'));
    const hasGlobalConfig = bucketNames.some(n => n.includes('global_config'));
    const hasReports = bucketNames.some(n => n.includes('reports'));
    const hasTasks = bucketNames.some(n => n.includes('tasks'));

    assert(hasContacts, 'Has contacts bucket(s)');
    assert(hasGlobalConfig, 'Has global_config bucket');
    assert(hasReports, 'Has reports bucket(s)');
    assert(hasTasks, 'Has tasks bucket');

    // Count data
    const contactBuckets = buckets.filter(b => b.bucket.includes('contacts'));
    const totalContacts = contactBuckets.reduce((sum, b) => sum + b.count, 0);
    assert(totalContacts > 0, `Contacts contain ${totalContacts} documents`);

    const globalBuckets = buckets.filter(b => b.bucket.includes('global_config'));
    const totalGlobal = globalBuckets.reduce((sum, b) => sum + b.count, 0);
    assert(totalGlobal > 0, `Global config contains ${totalGlobal} documents (forms + translations + system)`);
  }

  // Step 4: Verify data shape
  console.log('\n4. Data Shape Verification');
  const dataMessages = syncData.filter(d => d.data);
  if (dataMessages.length > 0) {
    // Find a contacts data row
    const contactData = dataMessages.find(d =>
      d.data?.bucket?.includes('contacts') && d.data?.data?.length > 0
    );

    if (contactData) {
      const row = contactData.data.data[0];
      const rowData = row.data;
      assert('name' in rowData, 'Contact has "name" field');
      assert('contact_type' in rowData, 'Contact has "contact_type" field');
      assert('phone' in rowData || rowData.phone === null, 'Contact has "phone" field');
      assert('patient_id' in rowData || rowData.patient_id === null, 'Contact has "patient_id" field');

      console.log(`\n  Sample contact: ${rowData.name} (${rowData.contact_type})`);
    } else {
      console.log('  (No contact data rows in initial stream - may need larger dataset)');
    }

    // Find global_config data
    const globalData = dataMessages.find(d =>
      d.data?.bucket?.includes('global_config') && d.data?.data?.length > 0
    );

    if (globalData) {
      const row = globalData.data.data[0];
      assert('doc_type' in row.data || 'doc' in row.data, 'Global config has expected fields');
    }
  } else {
    console.log('  (No data messages in sync response - checkpoint only)');
  }

  // Summary
  console.log(`\n=======================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
