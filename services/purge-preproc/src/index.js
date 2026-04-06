'use strict';

const engine = require('./engine');
const db = require('./db');

const INTERVAL_MS = parseInt(process.env.PURGE_INTERVAL_MS || '0', 10);

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
  if (INTERVAL_MS > 0) {
    // Continuous mode: run on an interval
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
