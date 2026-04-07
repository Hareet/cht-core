#!/usr/bin/env node
/**
 * Generate a test JWT for PowerSync Sync Streams development.
 *
 * Usage:
 *   node generate-test-token.js <username>
 *
 * Examples:
 *   node generate-test-token.js chw_user
 *   node generate-test-token.js supervisor_user
 *   node generate-test-token.js county_admin
 *
 * The token includes claims that match user_settings rows in PostgreSQL:
 *   sub:          "org.couchdb.user:<username>"
 *   role_hash:    MD5 of sorted roles
 *   contact_id:   user's contact person doc ID
 *   aud:          "cht-powersync-dev"
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Test user configurations (must match setup.sql seed data)
const USERS = {
  chw_user: {
    user_id: 'org.couchdb.user:chw_user',
    contact_id: '3ec4f112db4527a356e1aa8593002fc0',
    roles: ['chw'],
  },
  supervisor_user: {
    user_id: 'org.couchdb.user:supervisor_user',
    contact_id: null,
    roles: ['chw_supervisor'],
  },
  county_admin: {
    user_id: 'org.couchdb.user:county_admin',
    contact_id: null,
    roles: ['national_admin'],
  },
};

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

function base64url(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generateToken(username) {
  const user = USERS[username];
  if (!user) {
    console.error(`Unknown user: ${username}`);
    console.error(`Available users: ${Object.keys(USERS).join(', ')}`);
    process.exit(1);
  }

  const privateKeyPath = path.join(__dirname, 'dev-private-key.pem');
  if (!fs.existsSync(privateKeyPath)) {
    console.error('Private key not found at:', privateKeyPath);
    console.error('Copy /tmp/powersync_dev.pem to', privateKeyPath);
    process.exit(1);
  }

  const privateKey = fs.readFileSync(privateKeyPath, 'utf8');

  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid: 'cht-dev-key-1',
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user.user_id,
    aud: 'cht-powersync-dev',
    iat: now,
    exp: now + 3600 * 24, // 24 hours
    role_hash: md5(user.roles.sort().join(',')),
    contact_id: user.contact_id,
    roles: user.roles,
  };

  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = base64url(sign.sign(privateKey));

  return `${signingInput}.${signature}`;
}

const username = process.argv[2];
if (!username) {
  console.error('Usage: node generate-test-token.js <username>');
  console.error(`Available users: ${Object.keys(USERS).join(', ')}`);
  process.exit(1);
}

const token = generateToken(username);
console.log(token);
