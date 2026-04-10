'use strict';

const db = require('./db');

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
      skipped_contacts = $6::jsonb
    WHERE id = $1
  `, [
    runId,
    stats.contactsProcessed,
    stats.docsEvaluated,
    stats.docsPurged,
    stats.docsUnpurged,
    JSON.stringify(stats.skippedContacts || []),
  ]);
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
  startRunLog,
  completeRunLog,
  failRunLog,
};
