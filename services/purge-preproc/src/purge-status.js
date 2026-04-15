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
// options.aggressive: boolean — marks entries as aggressive purge
// options.requestedBy: string — user_id who triggered the purge
// options.reason: string — 'storage_budget', 'scheduled', 'retention'
const writePurgeResults = async (toPurge, options = {}) => {
  const aggressive = !!options.aggressive;
  const requestedBy = options.requestedBy || null;
  const reason = options.reason || null;

  const rows = [];
  const params = [];
  const PARAMS_PER_ROW = 6;

  for (const [roleHash, docs] of Object.entries(toPurge)) {
    for (const [docId, purged] of Object.entries(docs)) {
      const offset = params.length;
      rows.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, NOW(), $${offset + 4}, $${offset + 5}, $${offset + 6})`);
      params.push(docId, roleHash, !!purged, aggressive, requestedBy, reason);
    }
  }

  if (!rows.length) {
    return;
  }

  // Process in chunks to avoid exceeding parameter limits
  const CHUNK_SIZE = 5000;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunkRows = rows.slice(i, i + CHUNK_SIZE);
    const startIdx = i * PARAMS_PER_ROW;
    const endIdx = Math.min((i + CHUNK_SIZE) * PARAMS_PER_ROW, params.length);
    const chunkParams = params.slice(startIdx, endIdx);

    // Renumber placeholders for this chunk
    const renumberedRows = [];
    for (let j = 0; j < chunkRows.length; j++) {
      const base = j * PARAMS_PER_ROW;
      renumberedRows.push(`($${base + 1}, $${base + 2}, $${base + 3}, NOW(), $${base + 4}, $${base + 5}, $${base + 6})`);
    }

    await db.query(`
      INSERT INTO purge_status (doc_id, role_hash, purged, evaluated_at, aggressive, requested_by, reason)
      VALUES ${renumberedRows.join(', ')}
      ON CONFLICT (doc_id, role_hash) DO UPDATE SET
        purged = EXCLUDED.purged,
        evaluated_at = EXCLUDED.evaluated_at,
        aggressive = EXCLUDED.aggressive,
        requested_by = EXCLUDED.requested_by,
        reason = EXCLUDED.reason
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

// Get the role hashes from the last completed run.
// Used to detect when offline roles change between runs (new role added, role removed),
// forcing a full re-evaluation so that all contacts get purge_status entries for new roles.
const getLastRoleHashes = async () => {
  const result = await db.query(`
    SELECT role_hashes
    FROM purge_run_log
    WHERE status = 'completed'
      AND role_hashes IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT 1
  `);

  return result.rows.length ? result.rows[0].role_hashes : null;
};

// Remove purge_status entries for role hashes that no longer have any active users.
// When a role combination is removed (all users with that role set are deleted or changed),
// its purge_status entries become orphaned — no Sync Stream query will ever reference them.
// Without cleanup, purge_status grows unboundedly as roles change over time.
const cleanupOrphanedRoles = async (activeRoleHashes) => {
  if (!activeRoleHashes.length) {
    return 0;
  }

  const result = await db.query(`
    DELETE FROM purge_status
    WHERE role_hash != ALL($1)
  `, [activeRoleHashes]);

  const deleted = result.rowCount || 0;
  if (deleted > 0) {
    console.log(`Cleaned up ${deleted} purge_status entries for removed roles`);
  }
  return deleted;
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
      purge_fn_hash = $7,
      role_hashes = $8::jsonb
    WHERE id = $1
  `, [
    runId,
    stats.contactsProcessed,
    stats.docsEvaluated,
    stats.docsPurged,
    stats.docsUnpurged,
    JSON.stringify(stats.skippedContacts || []),
    stats.purgeFnHash || null,
    JSON.stringify(stats.roleHashes || []),
  ]);
};

// Remove purge_status entries for documents that are no longer active in couchdb.
// This handles two cases:
//   1. Soft-deleted docs: _deleted = true in the couchdb table
//   2. Physically removed docs: no row exists in couchdb at all (e.g., CouchDB
//      compaction removed the doc, or a migration script cleaned up the row)
// Without cleanup, purge_status grows unboundedly as docs are deleted over time.
const cleanupDeletedDocs = async () => {
  const tbl = `${db.getSchema()}.couchdb`;

  const result = await db.query(`
    DELETE FROM purge_status ps
    WHERE NOT EXISTS (
      SELECT 1 FROM ${tbl} c
      WHERE c._id = ps.doc_id
      AND (c._deleted IS NOT TRUE)
    )
  `);

  const deleted = result.rowCount || 0;
  if (deleted > 0) {
    console.log(`Cleaned up ${deleted} purge_status entries for deleted/missing documents`);
  }
  return deleted;
};

// Get skipped contact IDs from the last completed run.
// When a contact is skipped due to a transient error (e.g., DB timeout), it won't
// appear in the next incremental run's changed set (its saved_timestamp hasn't changed).
// By including previously-skipped contacts in the incremental set, we ensure they are
// retried rather than permanently left with stale/missing purge decisions.
const getLastRunSkippedContacts = async () => {
  const result = await db.query(`
    SELECT skipped_contacts
    FROM purge_run_log
    WHERE status = 'completed'
      AND skipped_contacts IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT 1
  `);

  if (!result.rows.length) {
    return [];
  }

  const skipped = result.rows[0].skipped_contacts;
  return Array.isArray(skipped) ? skipped : [];
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
  getLastRoleHashes,
  getLastRunSkippedContacts,
  cleanupOrphanedRoles,
  startRunLog,
  completeRunLog,
  failRunLog,
  cleanupDeletedDocs,
  tryAcquireRunLock,
  releaseRunLock,
};
