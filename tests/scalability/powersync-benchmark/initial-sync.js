/**
 * PowerSync initial sync benchmark.
 *
 * Called by JMeter: node powersync-benchmark/initial-sync.js <threadId>
 *
 * Measures the time for a user to complete their first full sync via PowerSync.
 * This is the PowerSync equivalent of initial-replication.js (CouchDB/PouchDB).
 */
import { performance } from 'perf_hooks';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { PowerSyncDatabase, SyncStreamConnectionMethod, SyncClientImplementation } from '@powersync/node';
import { ChtPowerSyncSchema } from './schema.js';
import { BenchmarkConnector, getUserClaims } from './connector.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const config = require('../config.json');

const [,, threadId] = process.argv;
const users = config.powersync_users || config.users;
const user = users[threadId % users.length];

const dbDir = path.join(os.tmpdir(), 'powersync-bench');
const dbPath = path.join(dbDir, `thread-${threadId}.db`);

async function run() {
  fs.mkdirSync(dbDir, { recursive: true });

  // Clean up any leftover db from a previous run
  for (const ext of ['', '-wal', '-shm']) {
    const f = dbPath + ext;
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
    }
  }

  const claims = await getUserClaims(user.name);
  const connector = new BenchmarkConnector(claims);

  const db = new PowerSyncDatabase({
    schema: ChtPowerSyncSchema,
    database: { dbFilename: dbPath },
  });

  // Force database worker initialization (required before connect)
  await db.get('SELECT powersync_rs_version()');

  const start = performance.now();

  await db.connect(connector, {
    connectionMethod: SyncStreamConnectionMethod.WEB_SOCKET,
    clientImplementation: SyncClientImplementation.RUST,
  });

  await db.waitForFirstSync();

  const end = performance.now();
  const durationMs = Math.round(end - start);

  // Report row counts per synced table for verification
  const tables = ['contacts', 'reports', 'tasks', 'targets', 'global_config', 'user_settings_doc', 'user_meta', 'sms_messages'];
  for (const table of tables) {
    try {
      const result = await db.get(`SELECT count(*) as count FROM ${table}`);
      console.log(`${table}: ${result.count} rows`);
    } catch (e) {
      console.log(`${table}: error - ${e.message}`);
    }
  }

  console.log(`sync_duration_ms: ${durationMs}`);

  await db.disconnectAndClear();

  // Clean up temp files
  for (const ext of ['', '-wal', '-shm']) {
    const f = dbPath + ext;
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
    }
  }

  await new Promise(resolve => process.stdout.write('', resolve));
  process.exit(0);
}

run().catch(err => {
  console.error('PowerSync initial sync failed:', err);
  process.exit(1);
});
