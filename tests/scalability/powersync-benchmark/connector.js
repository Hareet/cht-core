/**
 * PowerSync backend connector for scalability benchmarks.
 *
 * Generates JWTs matching the dev auth config in powersync.yaml.
 * Signs with the RSA private key at the path specified in config.json.
 *
 * uploadData is a no-op for initial sync benchmarks.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import pg from 'pg';

const require = createRequire(import.meta.url);
const config = require('../config.json');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function base64url(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generateToken(userClaims) {
  const keyPath = path.resolve(__dirname, '..', config.powersync_key_path);
  const privateKey = fs.readFileSync(keyPath, 'utf8');

  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid: 'cht-dev-key-1',
  };

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: userClaims.user_id,
    aud: 'cht-powersync-dev',
    iat: now,
    exp: now + 3600,
    role_hash: userClaims.role_hash,
    contact_id: userClaims.contact_id,
    report_depth: userClaims.report_depth,
    roles: userClaims.roles,
  };

  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = base64url(sign.sign(privateKey));

  return `${signingInput}.${signature}`;
}

export class BenchmarkConnector {
  constructor(userClaims) {
    this.userClaims = userClaims;
  }

  async fetchCredentials() {
    const token = generateToken(this.userClaims);
    return {
      endpoint: config.powersync_url,
      token,
      expiresAt: new Date(Date.now() + 3600 * 1000),
    };
  }

  async uploadData(database) {
    const batch = await database.getCrudBatch();
    if (batch) {
      await batch.complete();
    }
  }
}

/**
 * Look up a user's PowerSync claims from the user_settings table in PostgreSQL.
 */
export async function getUserClaims(username) {
  const { Pool } = pg;
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    user: process.env.POSTGRES_USER || 'cht',
    password: process.env.POSTGRES_PASSWORD || 'pgpass',
    database: process.env.POSTGRES_DB || 'cht',
  });

  try {
    const userId = `org.couchdb.user:${username}`;
    const result = await pool.query(
      `SELECT user_id, facility_id, contact_id, roles, role_hash,
              replication_depth, report_depth
       FROM v1.user_settings WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      throw new Error(
        `User '${username}' not found in v1.user_settings. ` +
        'Run the user_settings seeding step (see implementation plan Step 4).'
      );
    }

    const row = result.rows[0];
    return {
      user_id: row.user_id,
      contact_id: row.contact_id,
      roles: row.roles,
      role_hash: row.role_hash,
      report_depth: row.report_depth,
    };
  } finally {
    await pool.end();
  }
}
