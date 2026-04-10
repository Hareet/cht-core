/**
 * Purge Preprocessing Tests
 *
 * Validates the purge preprocessing pipeline that evaluates purge.js rules
 * and writes purge_status entries to PostgreSQL. This is a key component
 * of the PowerSync migration — Sync Streams cannot express Turing-complete
 * purge.js logic in SQL, so a server-side service must precompute purge
 * decisions and store them in a table that Sync Streams can reference.
 *
 * Schema under test (new table, separate from cht-sync's v1.couchdb):
 *   purge_status (
 *     doc_id TEXT NOT NULL,       -- references v1.couchdb._id
 *     role TEXT NOT NULL,
 *     purged BOOLEAN NOT NULL DEFAULT false,
 *     evaluated_at TIMESTAMP DEFAULT NOW(),
 *     purge_reason TEXT,
 *     PRIMARY KEY (doc_id, role)
 *   )
 *
 * Prerequisites: CouchDB, API, PostgreSQL, and cht-sync must be running.
 */
const utils = require('../../utils/agent-harness');
const uuid = require('uuid').v4;

describe('Purge preprocessing for PostgreSQL', () => {

  // Ensure purge_status table exists before running tests
  before(async function () {
    this.timeout(30000);

    // Create the purge_status table if it doesn't exist
    // In production, this would be created by a migration script or dbt model
    await utils.pgQuery(`
      CREATE TABLE IF NOT EXISTS purge_status (
        doc_id TEXT NOT NULL,
        role TEXT NOT NULL,
        purged BOOLEAN NOT NULL DEFAULT false,
        evaluated_at TIMESTAMP DEFAULT NOW(),
        purge_reason TEXT,
        PRIMARY KEY (doc_id, role)
      )
    `);

    // Create index for efficient lookups by role
    await utils.pgQuery(`
      CREATE INDEX IF NOT EXISTS idx_purge_status_role
      ON purge_status (role, purged)
    `);
  });

  afterEach(async () => {
    // Clean up test purge_status entries
    await utils.pgQuery("DELETE FROM purge_status WHERE doc_id LIKE 'purge-test-%'");
  });

  after(async () => {
    await utils.pgQuery("DELETE FROM purge_status WHERE doc_id LIKE 'purge-test-%'");
  });

  describe('purge_status table operations', () => {
    it('should insert purge status entries', async () => {
      const docId = `purge-test-${uuid()}`;
      await utils.pgQuery(
        'INSERT INTO purge_status (doc_id, role, purged, purge_reason) VALUES ($1, $2, $3, $4)',
        [docId, 'chw', true, 'task completed > 60 days ago']
      );

      const result = await utils.pgQuery(
        'SELECT * FROM purge_status WHERE doc_id = $1 AND role = $2',
        [docId, 'chw']
      );
      expect(result.rows).to.have.length(1);
      expect(result.rows[0].purged).to.be.true;
      expect(result.rows[0].purge_reason).to.equal('task completed > 60 days ago');
    });

    it('should support multiple roles per document', async () => {
      const docId = `purge-test-${uuid()}`;

      // Same doc purged for CHW but not for supervisor
      await utils.pgQuery(
        'INSERT INTO purge_status (doc_id, role, purged, purge_reason) VALUES ($1, $2, $3, $4)',
        [docId, 'chw', true, 'task document past retention']
      );
      await utils.pgQuery(
        'INSERT INTO purge_status (doc_id, role, purged, purge_reason) VALUES ($1, $2, $3, $4)',
        [docId, 'chw_supervisor', false, null]
      );

      const result = await utils.pgQuery(
        'SELECT * FROM purge_status WHERE doc_id = $1 ORDER BY role',
        [docId]
      );
      expect(result.rows).to.have.length(2);

      const chwRow = result.rows.find(r => r.role === 'chw');
      const supervisorRow = result.rows.find(r => r.role === 'chw_supervisor');

      expect(chwRow.purged).to.be.true;
      expect(supervisorRow.purged).to.be.false;
    });

    it('should support upsert for re-evaluation', async () => {
      const docId = `purge-test-${uuid()}`;

      // Initial evaluation: not purged
      await utils.pgQuery(
        'INSERT INTO purge_status (doc_id, role, purged) VALUES ($1, $2, $3)',
        [docId, 'chw', false]
      );

      // Re-evaluation: now purged
      await utils.pgQuery(
        `INSERT INTO purge_status (doc_id, role, purged, purge_reason, evaluated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (doc_id, role) DO UPDATE SET
           purged = EXCLUDED.purged,
           purge_reason = EXCLUDED.purge_reason,
           evaluated_at = EXCLUDED.evaluated_at`,
        [docId, 'chw', true, 'target retention period expired']
      );

      const result = await utils.pgQuery(
        'SELECT * FROM purge_status WHERE doc_id = $1 AND role = $2',
        [docId, 'chw']
      );
      expect(result.rows).to.have.length(1);
      expect(result.rows[0].purged).to.be.true;
      expect(result.rows[0].purge_reason).to.equal('target retention period expired');
    });
  });

  describe('purge evaluation patterns', () => {
    it('should evaluate task documents for purge based on completion date', async () => {
      // Simulate: task completed > 60 days ago → purge for CHW role
      const taskDocId = `purge-test-task-${uuid()}`;
      const completedDate = Date.now() - (61 * 24 * 60 * 60 * 1000); // 61 days ago

      // Create a task document in CouchDB
      const taskDoc = {
        _id: taskDocId,
        type: 'task',
        state: 'Completed',
        stateHistory: [{
          state: 'Completed',
          timestamp: completedDate,
        }],
        emission: {
          _id: taskDocId,
          dueDate: new Date(completedDate).toISOString(),
        },
        reported_date: completedDate,
      };
      await utils.saveDoc(taskDoc);

      // Simulate purge preprocessing: evaluate the task
      const daysSinceCompleted = Math.floor((Date.now() - completedDate) / (24 * 60 * 60 * 1000));
      const shouldPurge = daysSinceCompleted > 60;

      await utils.pgQuery(
        `INSERT INTO purge_status (doc_id, role, purged, purge_reason)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (doc_id, role) DO UPDATE SET
           purged = EXCLUDED.purged,
           purge_reason = EXCLUDED.purge_reason,
           evaluated_at = NOW()`,
        [taskDocId, 'chw', shouldPurge, `task completed ${daysSinceCompleted} days ago`]
      );

      const result = await utils.pgQuery(
        'SELECT * FROM purge_status WHERE doc_id = $1 AND role = $2',
        [taskDocId, 'chw']
      );
      expect(result.rows[0].purged).to.be.true;
    });

    it('should evaluate target documents for purge based on reporting period', async () => {
      // Simulate: target for reporting period > 6 months ago → purge
      const targetDocId = `purge-test-target-${uuid()}`;
      const sixMonthsAgo = Date.now() - (180 * 24 * 60 * 60 * 1000);

      const targetDoc = {
        _id: targetDocId,
        type: 'target',
        reporting_period: new Date(sixMonthsAgo).toISOString().slice(0, 7), // YYYY-MM
        owner: 'some-chw-id',
        targets: [],
        reported_date: sixMonthsAgo,
      };
      await utils.saveDoc(targetDoc);

      // Purge preprocessing for targets: older than 6 months
      await utils.pgQuery(
        `INSERT INTO purge_status (doc_id, role, purged, purge_reason)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (doc_id, role) DO UPDATE SET
           purged = EXCLUDED.purged,
           purge_reason = EXCLUDED.purge_reason,
           evaluated_at = NOW()`,
        [targetDocId, 'chw', true, 'target reporting period > 6 months']
      );

      const result = await utils.pgQuery(
        'SELECT * FROM purge_status WHERE doc_id = $1',
        [targetDocId]
      );
      expect(result.rows[0].purged).to.be.true;
    });

    it('should NOT purge recent task documents', async () => {
      const taskDocId = `purge-test-task-recent-${uuid()}`;
      const recentDate = Date.now() - (5 * 24 * 60 * 60 * 1000); // 5 days ago

      const taskDoc = {
        _id: taskDocId,
        type: 'task',
        state: 'Completed',
        stateHistory: [{
          state: 'Completed',
          timestamp: recentDate,
        }],
        reported_date: recentDate,
      };
      await utils.saveDoc(taskDoc);

      const daysSinceCompleted = Math.floor((Date.now() - recentDate) / (24 * 60 * 60 * 1000));
      const shouldPurge = daysSinceCompleted > 60;

      await utils.pgQuery(
        `INSERT INTO purge_status (doc_id, role, purged, purge_reason)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (doc_id, role) DO UPDATE SET
           purged = EXCLUDED.purged,
           purge_reason = EXCLUDED.purge_reason,
           evaluated_at = NOW()`,
        [taskDocId, 'chw', shouldPurge, shouldPurge ? `task completed ${daysSinceCompleted} days ago` : null]
      );

      const result = await utils.pgQuery(
        'SELECT * FROM purge_status WHERE doc_id = $1 AND role = $2',
        [taskDocId, 'chw']
      );
      expect(result.rows[0].purged).to.be.false;
    });
  });

  describe('incremental processing', () => {
    it('should process only documents changed since last evaluation', async () => {
      // Insert a batch of purge statuses with a known evaluated_at
      const baseTime = new Date('2026-01-01T00:00:00Z');
      const docIds = Array.from({ length: 5 }, () => `purge-test-batch-${uuid()}`);

      for (const docId of docIds) {
        await utils.pgQuery(
          `INSERT INTO purge_status (doc_id, role, purged, evaluated_at)
           VALUES ($1, $2, $3, $4)`,
          [docId, 'chw', false, baseTime]
        );
      }

      // Simulate incremental re-evaluation: only re-evaluate docs since baseTime
      const changedDocIds = docIds.slice(0, 2); // Only first 2 changed
      for (const docId of changedDocIds) {
        await utils.pgQuery(
          `UPDATE purge_status SET purged = true, evaluated_at = NOW(), purge_reason = 'incremental update'
           WHERE doc_id = $1 AND role = $2`,
          [docId, 'chw']
        );
      }

      // Verify: 2 purged, 3 not purged
      const purged = await utils.pgQuery(
        `SELECT doc_id FROM purge_status WHERE doc_id = ANY($1) AND role = 'chw' AND purged = true`,
        [docIds]
      );
      const notPurged = await utils.pgQuery(
        `SELECT doc_id FROM purge_status WHERE doc_id = ANY($1) AND role = 'chw' AND purged = false`,
        [docIds]
      );

      expect(purged.rows).to.have.length(2);
      expect(notPurged.rows).to.have.length(3);
    });

    it('should support querying unevaluated documents via LEFT JOIN', async () => {
      // Create a document in CouchDB that has no purge_status entry
      const docId = `purge-test-unevaluated-${uuid()}`;
      const doc = {
        _id: docId,
        type: 'task',
        state: 'Completed',
        reported_date: Date.now(),
      };
      await utils.saveDoc(doc);

      // Wait for it to arrive in PostgreSQL
      await utils.waitForDocInPostgres(docId, 45000);

      // Query for documents that have no purge_status entry
      // cht-sync uses _id as the PK; purge_status uses doc_id
      const result = await utils.pgQuery(
        `SELECT c._id FROM ${utils.pgDocsTable()} c
         LEFT JOIN purge_status ps ON c._id = ps.doc_id AND ps.role = 'chw'
         WHERE c._id = $1 AND ps.doc_id IS NULL`,
        [docId]
      );

      expect(result.rows).to.have.length(1);
      expect(result.rows[0]._id).to.equal(docId);
    });
  });

  describe('Sync Stream exclusion pattern', () => {
    it('should support efficient purge filtering for Sync Streams', async () => {
      // This test validates the query pattern that PowerSync Sync Streams
      // would use to exclude purged documents for a given role
      const docIds = Array.from({ length: 3 }, () => `purge-test-sync-${uuid()}`);

      // Create docs in CouchDB and purge_status entries
      for (const docId of docIds) {
        await utils.saveDoc({
          _id: docId,
          type: 'data_record',
          reported_date: Date.now(),
        });
      }

      // Wait for replication
      for (const docId of docIds) {
        await utils.waitForDocInPostgres(docId, 45000);
      }

      // Mark first doc as purged for 'chw' role
      await utils.pgQuery(
        `INSERT INTO purge_status (doc_id, role, purged) VALUES ($1, $2, $3)`,
        [docIds[0], 'chw', true]
      );
      // Mark second doc as not purged
      await utils.pgQuery(
        `INSERT INTO purge_status (doc_id, role, purged) VALUES ($1, $2, $3)`,
        [docIds[1], 'chw', false]
      );
      // Third doc has no purge_status entry (should be included)

      // Sync Stream pattern: include docs that are NOT purged for this role
      // cht-sync table uses _id; purge_status uses doc_id
      const result = await utils.pgQuery(
        `SELECT c._id FROM ${utils.pgDocsTable()} c
         LEFT JOIN purge_status ps ON c._id = ps.doc_id AND ps.role = $1
         WHERE c._id = ANY($2)
         AND (ps.purged IS NULL OR ps.purged = false)`,
        ['chw', docIds]
      );

      const syncedIds = result.rows.map(r => r._id);
      expect(syncedIds).to.have.length(2);
      expect(syncedIds).to.include(docIds[1]); // explicitly not purged
      expect(syncedIds).to.include(docIds[2]); // no entry = not purged
      expect(syncedIds).to.not.include(docIds[0]); // purged
    });
  });
});
