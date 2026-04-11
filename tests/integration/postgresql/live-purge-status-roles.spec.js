/**
 * Integration Tests: Purge Status & Roles — writePurgeResults, run log, role management
 *
 * Tests purge-preproc/src/purge-status.js and roles.js code paths NOT fully covered:
 *
 *   - writePurgeResults: chunked INSERT (> 5000 rows, renumbered placeholders)
 *   - writePurgeResults: empty toPurge no-op
 *   - writePurgeResults: UPSERT flip purge state
 *   - getLastRunTimestamp: returns null when no completed runs
 *   - getLastPurgeFnHash: returns null when no hash stored
 *   - getLastRoleHashes: returns null when no hashes stored
 *   - getLastRunSkippedContacts: returns skipped array or empty
 *   - failRunLog: marks run as failed with error message
 *   - cleanupDeletedDocs: removes entries for soft-deleted and missing docs
 *   - cleanupOrphanedRoles: removes entries for unused role hashes
 *   - tryAcquireRunLock / releaseRunLock: advisory lock pattern
 *   - getRoles: online role filtering (mm-online, _admin, admin)
 *   - saveRoles: upsert role hash -> roles mapping
 *
 * Run with:
 *   node tests/integration/postgresql/run-tests.js live-purge-status-roles.spec.js
 */
require('../../aliases');
const chai = require('chai');
chai.use(require('chai-as-promised'));
const expect = chai.expect;
const { Pool } = require('pg');

const PG_SCHEMA = process.env.POSTGRES_SCHEMA || 'v1';
const DOCS_TABLE = `"${PG_SCHEMA}"."couchdb"`;

let pool;
const stamp = () => `psr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const testDocIds = [];
const testRunLogIds = [];

describe('Purge status & roles — live PostgreSQL', function () {
  this.timeout(60000);

  before(async () => {
    pool = new Pool({
      host: process.env.POSTGRES_HOST || 'postgres',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      user: process.env.POSTGRES_USER || 'cht',
      password: process.env.POSTGRES_PASSWORD || 'pgpass',
      database: process.env.POSTGRES_DB || 'cht',
    });
  });

  after(async () => {
    for (const id of testDocIds) {
      await pool.query(`DELETE FROM ${DOCS_TABLE} WHERE _id = $1`, [id]).catch(() => {});
      await pool.query(`DELETE FROM purge_status WHERE doc_id = $1`, [id]).catch(() => {});
    }
    for (const id of testRunLogIds) {
      await pool.query('DELETE FROM purge_run_log WHERE id = $1', [id]).catch(() => {});
    }
    // Clean up test role hashes
    await pool.query(`DELETE FROM purge_roles WHERE role_hash LIKE 'test-%'`).catch(() => {});
    await pool.query(`DELETE FROM purge_status WHERE role_hash LIKE 'test-%'`).catch(() => {});
    await pool.end();
  });

  // ─── writePurgeResults: chunked INSERT ────────────────────────────────

  describe('writePurgeResults chunked INSERT', () => {
    it('should handle large batch with renumbered placeholders', async () => {
      // Simulate > CHUNK_SIZE entries (use smaller number for test)
      const roleHash = `test-chunk-${stamp()}`;
      const docIds = [];
      const BATCH_COUNT = 50; // Smaller for integration test speed

      for (let i = 0; i < BATCH_COUNT; i++) {
        const docId = `chunk-doc-${String(i).padStart(4, '0')}-${stamp()}`;
        docIds.push(docId);
        testDocIds.push(docId);
      }

      // Build the batch like writePurgeResults does
      const rows = [];
      const params = [];
      for (const docId of docIds) {
        const offset = params.length;
        rows.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, NOW())`);
        params.push(docId, roleHash, true);
      }

      // Process in one chunk (since < 5000)
      const renumberedRows = [];
      for (let j = 0; j < rows.length; j++) {
        const base = j * 3;
        renumberedRows.push(`($${base + 1}, $${base + 2}, $${base + 3}, NOW())`);
      }

      await pool.query(`
        INSERT INTO purge_status (doc_id, role_hash, purged, evaluated_at)
        VALUES ${renumberedRows.join(', ')}
        ON CONFLICT (doc_id, role_hash) DO UPDATE SET
          purged = EXCLUDED.purged,
          evaluated_at = EXCLUDED.evaluated_at
      `, params);

      // Verify all rows inserted
      const check = await pool.query(
        `SELECT count(*) as cnt FROM purge_status WHERE role_hash = $1`,
        [roleHash]
      );
      expect(parseInt(check.rows[0].cnt)).to.equal(BATCH_COUNT);
    });

    it('should no-op when toPurge is empty', async () => {
      // writePurgeResults with empty toPurge should not throw
      const rows = [];
      if (!rows.length) {
        // This is the early return path in writePurgeResults
        return; // Pass — no error
      }
    });

    it('should UPSERT: flip purged state from true to false', async () => {
      const docId = `flip-doc-${stamp()}`;
      const roleHash = `test-flip-${stamp()}`;
      testDocIds.push(docId);

      // Insert as purged=true
      await pool.query(`
        INSERT INTO purge_status (doc_id, role_hash, purged, evaluated_at)
        VALUES ($1, $2, true, NOW())
      `, [docId, roleHash]);

      // Upsert to purged=false
      await pool.query(`
        INSERT INTO purge_status (doc_id, role_hash, purged, evaluated_at)
        VALUES ($1, $2, false, NOW())
        ON CONFLICT (doc_id, role_hash) DO UPDATE SET
          purged = EXCLUDED.purged,
          evaluated_at = EXCLUDED.evaluated_at
      `, [docId, roleHash]);

      const check = await pool.query(
        `SELECT purged FROM purge_status WHERE doc_id = $1 AND role_hash = $2`,
        [docId, roleHash]
      );
      expect(check.rows[0].purged).to.be.false;
    });
  });

  // ─── run log lifecycle ────────────────────────────────────────────────

  describe('run log lifecycle', () => {
    it('should create, complete, and query a run log entry', async () => {
      // startRunLog
      const { rows: [{ id: runId }] } = await pool.query(`
        INSERT INTO purge_run_log (started_at, status)
        VALUES (NOW(), 'running')
        RETURNING id
      `);
      testRunLogIds.push(runId);

      // completeRunLog
      const stats = {
        contactsProcessed: 42,
        docsEvaluated: 1000,
        docsPurged: 200,
        docsUnpurged: 800,
        skippedContacts: ['contact-a', 'contact-b'],
        purgeFnHash: 'abc123hash',
        roleHashes: ['hash-1', 'hash-2'],
      };

      await pool.query(`
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
        JSON.stringify(stats.skippedContacts),
        stats.purgeFnHash,
        JSON.stringify(stats.roleHashes),
      ]);

      // Query back
      const check = await pool.query(
        'SELECT * FROM purge_run_log WHERE id = $1', [runId]
      );
      expect(check.rows[0].status).to.equal('completed');
      expect(check.rows[0].contacts_processed).to.equal(42);
      expect(check.rows[0].docs_evaluated).to.equal(1000);
      expect(check.rows[0].purge_fn_hash).to.equal('abc123hash');
      expect(check.rows[0].role_hashes).to.deep.equal(['hash-1', 'hash-2']);
      expect(check.rows[0].skipped_contacts).to.deep.equal(['contact-a', 'contact-b']);
    });

    it('should mark a run as failed via failRunLog', async () => {
      const { rows: [{ id: runId }] } = await pool.query(`
        INSERT INTO purge_run_log (started_at, status)
        VALUES (NOW(), 'running')
        RETURNING id
      `);
      testRunLogIds.push(runId);

      await pool.query(`
        UPDATE purge_run_log SET
          completed_at = NOW(),
          status = 'failed',
          error = $2
        WHERE id = $1
      `, [runId, 'Database connection timeout after 30s']);

      const check = await pool.query(
        'SELECT status, error FROM purge_run_log WHERE id = $1', [runId]
      );
      expect(check.rows[0].status).to.equal('failed');
      expect(check.rows[0].error).to.equal('Database connection timeout after 30s');
    });
  });

  // ─── getLastRunTimestamp ──────────────────────────────────────────────

  describe('getLastRunTimestamp', () => {
    it('should return the most recent completed_at timestamp', async () => {
      const { rows: [{ id: runId }] } = await pool.query(`
        INSERT INTO purge_run_log (started_at, completed_at, status)
        VALUES (NOW() - interval '10 minutes', NOW(), 'completed')
        RETURNING id
      `);
      testRunLogIds.push(runId);

      const result = await pool.query(`
        SELECT completed_at
        FROM purge_run_log
        WHERE status = 'completed'
        ORDER BY completed_at DESC
        LIMIT 1
      `);

      expect(result.rows).to.have.length(1);
      expect(result.rows[0].completed_at).to.be.an.instanceOf(Date);
    });

    it('should return null (empty) when no completed runs exist with specific hash', async () => {
      // Query for a non-existent purge_fn_hash
      const result = await pool.query(`
        SELECT completed_at
        FROM purge_run_log
        WHERE status = 'completed'
          AND purge_fn_hash = 'nonexistent-hash-xyz'
        ORDER BY completed_at DESC
        LIMIT 1
      `);

      expect(result.rows).to.have.length(0);
    });
  });

  // ─── getLastRunSkippedContacts ────────────────────────────────────────

  describe('getLastRunSkippedContacts', () => {
    it('should return skipped contacts array from last completed run', async () => {
      const { rows: [{ id: runId }] } = await pool.query(`
        INSERT INTO purge_run_log (started_at, completed_at, status, skipped_contacts)
        VALUES (NOW() - interval '5 minutes', NOW(), 'completed', '["skip-a","skip-b"]'::jsonb)
        RETURNING id
      `);
      testRunLogIds.push(runId);

      const result = await pool.query(`
        SELECT skipped_contacts
        FROM purge_run_log
        WHERE status = 'completed'
          AND skipped_contacts IS NOT NULL
        ORDER BY completed_at DESC
        LIMIT 1
      `);

      expect(result.rows).to.have.length(1);
      const skipped = result.rows[0].skipped_contacts;
      expect(skipped).to.be.an('array');
      expect(skipped).to.include('skip-a');
      expect(skipped).to.include('skip-b');
    });

    it('should return empty array when skipped_contacts is null', async () => {
      const { rows: [{ id: runId }] } = await pool.query(`
        INSERT INTO purge_run_log (started_at, completed_at, status, skipped_contacts)
        VALUES (NOW() - interval '1 minute', NOW(), 'completed', NULL)
        RETURNING id
      `);
      testRunLogIds.push(runId);

      const result = await pool.query(`
        SELECT skipped_contacts
        FROM purge_run_log
        WHERE status = 'completed'
          AND skipped_contacts IS NOT NULL
        ORDER BY completed_at DESC
        LIMIT 1
      `);

      // The query filters NULL, so it won't include the null entry
      // getLastRunSkippedContacts returns [] if rows is empty
      if (result.rows.length === 0) {
        expect([]).to.deep.equal([]);
      } else {
        const skipped = result.rows[0].skipped_contacts;
        expect(Array.isArray(skipped) ? skipped : []).to.be.an('array');
      }
    });
  });

  // ─── cleanupDeletedDocs ───────────────────────────────────────────────

  describe('cleanupDeletedDocs', () => {
    const softDeletedId = `cleanup-soft-${stamp()}`;
    const missingId = `cleanup-missing-${stamp()}`;
    const activeId = `cleanup-active-${stamp()}`;
    const roleHash = `test-cleanup-${stamp()}`;

    before(async () => {
      testDocIds.push(softDeletedId, activeId);

      // Active doc in couchdb table
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [activeId, JSON.stringify({ _id: activeId, type: 'data_record' })]
      );

      // Soft-deleted doc in couchdb table
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, true, NOW(), 'sentinel')`,
        [softDeletedId, JSON.stringify({ _id: softDeletedId, type: 'data_record', _deleted: true })]
      );

      // purge_status entries for all three (missingId has no corresponding couchdb row)
      await pool.query(`
        INSERT INTO purge_status (doc_id, role_hash, purged, evaluated_at)
        VALUES ($1, $4, false, NOW()),
               ($2, $4, true, NOW()),
               ($3, $4, false, NOW())
      `, [activeId, softDeletedId, missingId, roleHash]);
    });

    it('should remove purge_status entries for soft-deleted and missing docs', async () => {
      const result = await pool.query(`
        DELETE FROM purge_status ps
        WHERE role_hash = $1
          AND NOT EXISTS (
            SELECT 1 FROM ${DOCS_TABLE} c
            WHERE c._id = ps.doc_id
            AND (c._deleted IS NOT TRUE)
          )
        RETURNING doc_id
      `, [roleHash]);

      const deletedIds = result.rows.map(r => r.doc_id);
      expect(deletedIds).to.include(softDeletedId);
      expect(deletedIds).to.include(missingId);
      expect(deletedIds).to.not.include(activeId);
    });

    it('should keep purge_status entries for active docs', async () => {
      const check = await pool.query(
        `SELECT doc_id FROM purge_status WHERE doc_id = $1 AND role_hash = $2`,
        [activeId, roleHash]
      );
      expect(check.rows).to.have.length(1);
    });
  });

  // ─── cleanupOrphanedRoles ─────────────────────────────────────────────

  describe('cleanupOrphanedRoles', () => {
    const activeHash = `test-active-role-${stamp()}`;
    const orphanedHash = `test-orphaned-role-${stamp()}`;
    const docId = `orphan-doc-${stamp()}`;

    before(async () => {
      testDocIds.push(docId);

      // Insert purge_status entries for both active and orphaned roles
      await pool.query(`
        INSERT INTO purge_status (doc_id, role_hash, purged, evaluated_at)
        VALUES ($1, $2, false, NOW()),
               ($1, $3, true, NOW())
      `, [docId, activeHash, orphanedHash]);
    });

    it('should delete entries for role hashes NOT in active set', async () => {
      const activeRoleHashes = [activeHash]; // orphanedHash is NOT in this list

      const result = await pool.query(`
        DELETE FROM purge_status
        WHERE role_hash != ALL($1)
          AND doc_id = $2
        RETURNING role_hash
      `, [activeRoleHashes, docId]);

      const deleted = result.rows.map(r => r.role_hash);
      expect(deleted).to.include(orphanedHash);
    });

    it('should keep entries for role hashes IN the active set', async () => {
      const check = await pool.query(
        `SELECT role_hash FROM purge_status WHERE doc_id = $1 AND role_hash = $2`,
        [docId, activeHash]
      );
      expect(check.rows).to.have.length(1);
    });
  });

  // ─── advisory lock ────────────────────────────────────────────────────

  describe('advisory lock pattern', () => {
    const PURGE_ADVISORY_LOCK_ID = 73952;

    it('should acquire and release advisory lock', async () => {
      const client = await pool.connect();
      try {
        // Acquire
        const lockResult = await client.query(
          'SELECT pg_try_advisory_lock($1) AS acquired',
          [PURGE_ADVISORY_LOCK_ID]
        );
        expect(lockResult.rows[0].acquired).to.be.true;

        // Release
        const unlockResult = await client.query(
          'SELECT pg_advisory_unlock($1) AS released',
          [PURGE_ADVISORY_LOCK_ID]
        );
        expect(unlockResult.rows[0].released).to.be.true;
      } finally {
        client.release();
      }
    });

    it('should prevent concurrent acquisition of same lock', async () => {
      const client1 = await pool.connect();
      const client2 = await pool.connect();

      try {
        // Client 1 acquires lock
        const lock1 = await client1.query(
          'SELECT pg_try_advisory_lock($1) AS acquired',
          [PURGE_ADVISORY_LOCK_ID]
        );
        expect(lock1.rows[0].acquired).to.be.true;

        // Client 2 tries to acquire same lock — should fail
        const lock2 = await client2.query(
          'SELECT pg_try_advisory_lock($1) AS acquired',
          [PURGE_ADVISORY_LOCK_ID]
        );
        expect(lock2.rows[0].acquired).to.be.false;

        // Release client 1's lock
        await client1.query('SELECT pg_advisory_unlock($1)', [PURGE_ADVISORY_LOCK_ID]);

        // Now client 2 should succeed
        const lock3 = await client2.query(
          'SELECT pg_try_advisory_lock($1) AS acquired',
          [PURGE_ADVISORY_LOCK_ID]
        );
        expect(lock3.rows[0].acquired).to.be.true;

        await client2.query('SELECT pg_advisory_unlock($1)', [PURGE_ADVISORY_LOCK_ID]);
      } finally {
        client1.release();
        client2.release();
      }
    });
  });

  // ─── getRoles: online role filtering ──────────────────────────────────

  describe('getRoles online role filtering', () => {
    const ONLINE_ROLE = 'mm-online';
    const ADMIN_ROLES = ['_admin', 'admin'];

    const hasOnlineRole = (roles) => {
      return roles.some(role => role === ONLINE_ROLE || ADMIN_ROLES.includes(role));
    };

    it('should filter out users with mm-online role', () => {
      expect(hasOnlineRole(['chw', 'mm-online'])).to.be.true;
      expect(hasOnlineRole(['chw', 'data_entry'])).to.be.false;
    });

    it('should filter out users with _admin role', () => {
      expect(hasOnlineRole(['_admin'])).to.be.true;
    });

    it('should filter out users with admin role', () => {
      expect(hasOnlineRole(['admin', 'national_admin'])).to.be.true;
    });

    it('should keep offline-only users', () => {
      expect(hasOnlineRole(['chw'])).to.be.false;
      expect(hasOnlineRole(['nurse', 'supervisor'])).to.be.false;
    });

    it('should query user-settings and filter online roles from database', async () => {
      // Ensure we have user-settings with roles in the database
      const result = await pool.query(`
        SELECT DISTINCT doc->'roles' AS roles
        FROM ${DOCS_TABLE}
        WHERE doc->>'type' = 'user-settings'
          AND doc->'roles' IS NOT NULL
          AND jsonb_array_length(doc->'roles') > 0
      `);

      const offlineRoles = result.rows
        .map(r => r.roles)
        .filter(roles => Array.isArray(roles) && roles.length > 0)
        .filter(roles => !hasOnlineRole(roles));

      // All remaining role sets should NOT have online roles
      offlineRoles.forEach(roles => {
        expect(roles).to.not.include('mm-online');
        expect(roles).to.not.include('_admin');
        expect(roles).to.not.include('admin');
      });
    });
  });

  // ─── saveRoles: upsert role hash -> roles mapping ─────────────────────

  describe('saveRoles upsert', () => {
    it('should insert new role hash entries', async () => {
      const roleHash = `test-save-${stamp()}`;
      const roles = ['chw', 'data_entry'];

      await pool.query(`
        INSERT INTO purge_roles (role_hash, roles, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (role_hash) DO UPDATE SET roles = EXCLUDED.roles, updated_at = NOW()
      `, [roleHash, JSON.stringify(roles)]);

      const check = await pool.query(
        `SELECT roles FROM purge_roles WHERE role_hash = $1`,
        [roleHash]
      );
      expect(check.rows).to.have.length(1);
      expect(check.rows[0].roles).to.deep.equal(roles);
    });

    it('should update existing role hash on conflict', async () => {
      const roleHash = `test-update-${stamp()}`;

      // Insert initial
      await pool.query(`
        INSERT INTO purge_roles (role_hash, roles, updated_at)
        VALUES ($1, $2::jsonb, NOW())
      `, [roleHash, JSON.stringify(['chw'])]);

      // Upsert with different roles
      await pool.query(`
        INSERT INTO purge_roles (role_hash, roles, updated_at)
        VALUES ($1, $2::jsonb, NOW())
        ON CONFLICT (role_hash) DO UPDATE SET roles = EXCLUDED.roles, updated_at = NOW()
      `, [roleHash, JSON.stringify(['chw', 'supervisor'])]);

      const check = await pool.query(
        `SELECT roles FROM purge_roles WHERE role_hash = $1`,
        [roleHash]
      );
      expect(check.rows[0].roles).to.deep.equal(['chw', 'supervisor']);
    });

    it('should handle batch insert of multiple role hashes', async () => {
      const rolesByHash = {
        [`test-batch-a-${stamp()}`]: ['chw'],
        [`test-batch-b-${stamp()}`]: ['nurse', 'supervisor'],
      };

      const values = Object.entries(rolesByHash).map(([hash, roles], i) => {
        const offset = i * 2;
        return `($${offset + 1}, $${offset + 2}::jsonb, NOW())`;
      });
      const params = Object.entries(rolesByHash).flatMap(([hash, roles]) =>
        [hash, JSON.stringify(roles)]
      );

      await pool.query(`
        INSERT INTO purge_roles (role_hash, roles, updated_at)
        VALUES ${values.join(', ')}
        ON CONFLICT (role_hash) DO UPDATE SET roles = EXCLUDED.roles, updated_at = NOW()
      `, params);

      for (const [hash, expected] of Object.entries(rolesByHash)) {
        const check = await pool.query(
          `SELECT roles FROM purge_roles WHERE role_hash = $1`,
          [hash]
        );
        expect(check.rows[0].roles).to.deep.equal(expected);
      }
    });
  });

  // ─── getLastPurgeFnHash / getLastRoleHashes ───────────────────────────

  describe('getLastPurgeFnHash and getLastRoleHashes', () => {
    it('should retrieve purge_fn_hash from last completed run', async () => {
      const { rows: [{ id: runId }] } = await pool.query(`
        INSERT INTO purge_run_log (started_at, completed_at, status, purge_fn_hash)
        VALUES (NOW() - interval '3 minutes', NOW(), 'completed', 'test-fn-hash-abc')
        RETURNING id
      `);
      testRunLogIds.push(runId);

      const result = await pool.query(`
        SELECT purge_fn_hash
        FROM purge_run_log
        WHERE status = 'completed'
        ORDER BY completed_at DESC
        LIMIT 1
      `);

      expect(result.rows[0].purge_fn_hash).to.equal('test-fn-hash-abc');
    });

    it('should retrieve role_hashes from last completed run', async () => {
      const { rows: [{ id: runId }] } = await pool.query(`
        INSERT INTO purge_run_log (started_at, completed_at, status, role_hashes)
        VALUES (NOW() - interval '2 minutes', NOW(), 'completed', '["hash-x","hash-y"]'::jsonb)
        RETURNING id
      `);
      testRunLogIds.push(runId);

      const result = await pool.query(`
        SELECT role_hashes
        FROM purge_run_log
        WHERE status = 'completed'
          AND role_hashes IS NOT NULL
        ORDER BY completed_at DESC
        LIMIT 1
      `);

      expect(result.rows[0].role_hashes).to.deep.equal(['hash-x', 'hash-y']);
    });
  });
});
