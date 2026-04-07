'use strict';

const engine = require('./engine');
const changes = require('./changes');
const db = require('./db');

const INTERVAL_MS = parseInt(process.env.PURGE_INTERVAL_MS || '0', 10);
const USE_LISTEN = process.env.PURGE_USE_LISTEN === 'true';

const runOnce = async () => {
  try {
    console.log(`[${new Date().toISOString()}] Starting purge preprocessing...`);
    await engine.run({ incremental: process.env.PURGE_FULL_RUN !== 'true' });
    console.log(`[${new Date().toISOString()}] Purge preprocessing complete.`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Purge preprocessing failed:`, err);
    process.exitCode = 1;
  }
};

const main = async () => {
  if (USE_LISTEN) {
    // LISTEN/NOTIFY mode: react to changes from the couchdb_changes channel.
    // Runs a full initial pass, then re-evaluates incrementally when changes arrive.
    console.log('Starting in LISTEN/NOTIFY mode');
    await changes.start();

    // Initial full run
    await runOnce();

    // Then check for changes on interval
    const checkInterval = INTERVAL_MS > 0 ? INTERVAL_MS : 60000;
    console.log(`Checking for changes every ${checkInterval / 1000}s`);

    const tick = async () => {
      const changedIds = changes.drain();
      if (changedIds.size > 0) {
        console.log(`${changedIds.size} documents changed since last run`);
        await runOnce();
      }
      setTimeout(tick, checkInterval);
    };
    setTimeout(tick, checkInterval);

  } else if (INTERVAL_MS > 0) {
    // Polling mode: run on a fixed interval using saved_timestamp for incrementals
    console.log(`Running purge preprocessing every ${INTERVAL_MS / 1000}s`);
    const tick = async () => {
      await runOnce();
      setTimeout(tick, INTERVAL_MS);
    };
    await tick();

  } else {
    // One-shot mode: run once and exit
    await runOnce();
    await db.end();
  }
};

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
