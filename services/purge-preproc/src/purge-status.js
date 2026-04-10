'use strict';

const db = require('./db');

// Fixed advisory lock ID for purge preprocessing. Prevents concurrent runs
// from writing conflicting purge_status entries when multiple processes or
// overlapping interval ticks trigger engine.run() simultaneously.
const PURGE_ADVISORY_LOCK_ID = 73952; // arbitrary but stable

// Acquire an advisory lock using a dedicated client connection.
// Returns { acquired: true, client } on success, { acquired: false } if another run holds the lock.
// The caller MUST call releaseRunLock() when done to release the client back to the pool.
const tryAcquireRunLock = async () => {
  const client = await db.getClient();
  try {
    const result = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [PURGE_ADVISORY_LOCK_ID]);
    if (result.rows[0].acquired) {
      return { acquired: true, client };
    }
    client.release();
    return { acquired: false };
  } catch (err) {
    client.release();
    throw err;
  }
};

// Release the advisory lock and return the client to the pool.
// Errors during unlock are logged but not thrown — the run already completed.
const releaseRunLock = async (client) => {
  try {
    await client.query('SELECT pg_advisory_unlock($1)', [PURGE_ADVISORY_LOCK_ID]);
  } catch (err) {
    console.error('Failed to release purge advisory lock:', err.message);
  } finally {
    client.release();
  }
};

// Upsert purge decisions for a batch of (doc_id, role_hash) pairs.
// toPurge is: { [roleHash]: { [docId]: boolean } }
const writePurgeResults = async (toPurge) => {
  const rows = [];
  const params = [];

  for (const [roleHash, docs] of Object.entries(toPurge)) {
    for (const [docId, purged] of Object.entries(docs)) {
      const offset = params.length;
      rows.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, NOW())`);
      params.push(docId, roleHash, !!purged);
    }
  }

  if (!rows.length) {
    return;
  }

  // Process in chunks to avoid exceeding parameter limits
  const CHUNK_SIZE = 5000;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunkRows = rows.slice(i, i + CHUNK_SIZE);
    // Recalculate params for this chunk: each row uses 3 params
    const startIdx = i * 3;
    const endIdx = Math.min((i + CHUNK_SIZE) * 3, params.length);
    const chunkParams = params.slice(startIdx, endIdx);

    // Renumber placeholders for this chunk
    const renumberedRows = [];
    for (let j = 0; j < chunkRows.length; j++) {
      const base = j * 3;
      renumberedRows.push(`($${base + 1}, $${base + 2}, $${base + 3}, NOW())`);
    }

    await db.query(`
      INSERT INTO purge_status (doc_id, role_hash, purged, evaluated_at)
      VALUES ${renumberedRows.join(', ')}
      ON CONFLICT (doc_id, role_hash) DO UPDATE SET
        purged = EXCLUDED.purged,
        evaluated_at = EXCLUDED.evaluated_at
    `, chunkParams);
  }
};

// Get the last purge run timestamp for incremental mode.
const getLastRunTimestamp = async () => {
  const result = await db.query(`
    SELECT completed_at
    FROM purge_run_log
    WHERE status = 'completed'
    ORDER BY completed_at DESC
    LIMIT 1
  `);

  return result.rows.length ? result.rows[0].completed_at : null;
};

// Get the purge function hash from the last completed run.
// Used to detect when purge.js changes between runs, forcing a full re-evaluation.
const getLastPurgeFnHash = async () => {
  const result = await db.query(`
    SELECT purge_fn_hash
    FROM purge_run_log
    WHERE status = 'completed'
    ORDER BY completed_at DESC
    LIMIT 1
  `);

  return result.rows.length ? result.rows[0].purge_fn_hash : null;
};

// Create a new run log entry.
const startRunLog = async () => {
  const result = await db.query(`
    INSERT INTO purge_run_log (started_at, status)
    VALUES (NOW(), 'running')
    RETURNING id
  `);
  return result.rows[0].id;
};

// Complete a run log entry.
const completeRunLog = async (runId, stats) => {
  await db.query(`
    UPDATE purge_run_log SET
      completed_at = NOW(),
      status = 'completed',
      contacts_processed = $2,
      docs_evaluated = $3,
      docs_purged = $4,
      docs_unpurged = $5,
      skipped_contacts = $6::jsonb,
      purge_fn_hash = $7
    WHERE id = $1
  `, [
    runId,
    stats.contactsProcessed,
    stats.docsEvaluated,
    stats.docsPurged,
    stats.docsUnpurged,
    JSON.stringify(stats.skippedContacts || []),
    stats.purgeFnHash || null,
  ]);
};

// Remove purge_status entries for documents that have been deleted from couchdb.
// Deleted docs have _deleted = true in the couchdb table. Their purge_status rows
// become stale since the engine skips deleted docs during evaluation.
// Without cleanup, purge_status grows unboundedly as docs are deleted over time.
const cleanupDeletedDocs = async () => {
  const tbl = `${db.getSchema()}.couchdb`;

  const result = await db.query(`
    DELETE FROM purge_status ps
    WHERE EXISTS (
      SELECT 1 FROM ${tbl} c
      WHERE c._id = ps.doc_id
      AND c._deleted IS TRUE
    )
  `);

  const deleted = result.rowCount || 0;
  if (deleted > 0) {
    console.log(`Cleaned up ${deleted} purge_status entries for deleted documents`);
  }
  return deleted;
};

// Mark a run as failed.
const failRunLog = async (runId, error) => {
  await db.query(`
    UPDATE purge_run_log SET
      completed_at = NOW(),
      status = 'failed',
      error = $2
    WHERE id = $1
  `, [runId, String(error)]);
};

module.exports = {
  writePurgeResults,
  getLastRunTimestamp,
  getLastPurgeFnHash,
  startRunLog,
  completeRunLog,
  failRunLog,
  cleanupDeletedDocs,
  tryAcquireRunLock,
  releaseRunLock,
};
