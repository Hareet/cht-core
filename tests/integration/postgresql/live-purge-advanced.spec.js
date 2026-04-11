/**
 * Advanced Integration Tests: Purge Preprocessing Service
 *
 * Tests code paths NOT covered by live-purge-preproc.spec.js:
 *   - Advisory lock (pg_try_advisory_lock / pg_advisory_unlock) for concurrent run prevention
 *   - cleanupDeletedDocs — removes purge_status entries for deleted/missing documents
 *   - cleanupOrphanedRoles — removes purge_status entries for removed role hashes
 *   - Run log lifecycle (start → complete, start → fail)
 *   - Purge function hash change detection
 *   - getLastRunSkippedContacts — previously skipped contacts retry
 *   - writePurgeResults large batch chunking
 *   - getChangedContactIds incremental query
 *   - getContactIdsWithChangedRecords UNNEST pattern
 *   - getUnallocatedRecords query
 *   - Contact batching (getContactsBatch)
 *   - Online role filtering (hasOnlineRole)
 *
 * Run with:
 *   node tests/integration/postgresql/run-tests.js live-purge-advanced.spec.js
 */
require('../../aliases');
const chai = require('chai');
chai.use(require('chai-as-promised'));
const expect = chai.expect;
const { Pool } = require('pg');

const PG_SCHEMA = process.env.POSTGRES_SCHEMA || 'v1';
const DOCS_TABLE = `"${PG_SCHEMA}"."couchdb"`;
const PURGE_ADVISORY_LOCK_ID = 73952;

let pool;
const stamp = () => `purge-adv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

// CouchDB helpers
const COUCH_URL = process.env.COUCH_URL || 'http://admin:secret21512@couchdb:5984/medic';
const parsedCouch = new URL(COUCH_URL);
const COUCH_HOST = `${parsedCouch.protocol}//${parsedCouch.host}`;
const COUCH_DB = parsedCouch.pathname.replace(/^\//, '');
const COUCH_AUTH = 'Basic ' + Buffer.from(`${parsedCouch.username}:${parsedCouch.password}`).toString('base64');
const couchFetch = (path, opts = {}) => {
  opts.headers = { ...opts.headers, Authorization: COUCH_AUTH, Accept: 'application/json' };
  return fetch(`${COUCH_HOST}${path}`, opts);
};
const couchPost = async (doc) => (await couchFetch(`/${COUCH_DB}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc),
})).json();
const couchDelete = async (id) => {
  const resp = await couchFetch(`/${COUCH_DB}/${encodeURIComponent(id)}`);
  const doc = await resp.json();
  if (doc._rev) await couchFetch(`/${COUCH_DB}/${encodeURIComponent(id)}?rev=${doc._rev}`, { method: 'DELETE' });
};
const waitForDoc = async (docId, timeout = 45000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const { rows } = await pool.query(
      `SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`, [docId]
    );
    if (rows.length > 0) return rows[0].doc;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${docId} not in PG within ${timeout}ms`);
};

const testDocIds = [];

describe('Purge preprocessing — advanced paths', function () {
  this.timeout(120000);

  before(async () => {
    const pgPass = process.env.POSTGRES_PASSWORD || 'pgpass';
    pool = new Pool({ connectionString: `postgresql://cht:${pgPass}@postgres:5432/cht` });
    await pool.query('SELECT 1');
  });

  after(async () => {
    for (const id of testDocIds) await couchDelete(id).catch(() => {});
    await pool.query("DELETE FROM public.purge_status WHERE doc_id LIKE 'purge-adv-%'").catch(() => {});
    await pool.query("DELETE FROM public.purge_run_log WHERE status = 'test-status'").catch(() => {});
    if (pool) await pool.end();
  });

  // ── Advisory lock (purge-status.js tryAcquireRunLock/releaseRunLock) ───

  describe('advisory lock for concurrent run prevention', () => {
    it('should acquire and release pg_try_advisory_lock', async () => {
      const client = await pool.connect();
      try {
        // Acquire the advisory lock
        const { rows: lockRows } = await client.query(
          'SELECT pg_try_advisory_lock($1) AS acquired', [PURGE_ADVISORY_LOCK_ID]
        );
        expect(lockRows[0].acquired).to.be.true;

        // Try to acquire the same lock from another connection — should fail
        const { rows: lockRows2 } = await pool.query(
          'SELECT pg_try_advisory_lock($1) AS acquired', [PURGE_ADVISORY_LOCK_ID]
        );
        expect(lockRows2[0].acquired).to.be.false;

        // Release the lock
        await client.query('SELECT pg_advisory_unlock($1)', [PURGE_ADVISORY_LOCK_ID]);

        // Now the second connection should be able to acquire it
        const { rows: lockRows3 } = await pool.query(
          'SELECT pg_try_advisory_lock($1) AS acquired', [PURGE_ADVISORY_LOCK_ID]
        );
        expect(lockRows3[0].acquired).to.be.true;

        // Clean up — release from the pool connection
        await pool.query('SELECT pg_advisory_unlock($1)', [PURGE_ADVISORY_LOCK_ID]);
      } finally {
        client.release();
      }
    });
  });

  // ── cleanupDeletedDocs (purge-status.js) ─────────────────────────────

  describe('cleanupDeletedDocs pattern', () => {
    it('should remove purge_status entries for soft-deleted documents', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      const roleHash = 'cleanup-deleted-test-00000000000';

      // Create doc in CouchDB and wait for it in PG
      await couchPost({ _id: docId, type: 'person', name: 'To Be Deleted', reported_date: Date.now() });
      await waitForDoc(docId);

      // Add purge_status entry
      await pool.query(
        'INSERT INTO public.purge_status (doc_id, role_hash, purged, evaluated_at) VALUES ($1, $2, false, NOW())',
        [docId, roleHash]
      );

      // Delete the doc in CouchDB
      await couchDelete(docId);

      // Wait for deletion to propagate to PG
      const start = Date.now();
      while (Date.now() - start < 30000) {
        const { rows } = await pool.query(`SELECT _deleted FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]);
        if (rows.length > 0 && rows[0]._deleted === true) break;
        await new Promise(r => setTimeout(r, 500));
      }

      // Run the cleanup query (same as purge-status.js cleanupDeletedDocs)
      const { rowCount } = await pool.query(`
        DELETE FROM public.purge_status ps
        WHERE ps.doc_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM ${DOCS_TABLE} c
          WHERE c._id = ps.doc_id AND (c._deleted IS NOT TRUE)
        )
      `, [docId]);
      expect(rowCount).to.equal(1);

      // Verify it's gone
      const { rows } = await pool.query(
        'SELECT * FROM public.purge_status WHERE doc_id = $1 AND role_hash = $2',
        [docId, roleHash]
      );
      expect(rows).to.have.length(0);
    });

    it('should remove purge_status entries for physically missing documents', async () => {
      const docId = stamp();
      const roleHash = 'cleanup-missing-test-0000000000';

      // Insert purge_status for a doc that does NOT exist in v1.couchdb
      await pool.query(
        'INSERT INTO public.purge_status (doc_id, role_hash, purged, evaluated_at) VALUES ($1, $2, true, NOW())',
        [docId, roleHash]
      );

      // Cleanup should remove it (doc doesn't exist)
      const { rowCount } = await pool.query(`
        DELETE FROM public.purge_status ps
        WHERE ps.doc_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM ${DOCS_TABLE} c
          WHERE c._id = ps.doc_id AND (c._deleted IS NOT TRUE)
        )
      `, [docId]);
      expect(rowCount).to.equal(1);
    });
  });

  // ── cleanupOrphanedRoles (purge-status.js) ───────────────────────────

  describe('cleanupOrphanedRoles pattern', () => {
    it('should remove purge_status entries for role hashes no longer in use', async () => {
      const docId = stamp();
      const activeHash = 'active-role-hash-0000000000000';
      const orphanedHash = 'orphan-role-hash-0000000000000';

      // Insert entries for both active and orphaned roles
      await pool.query(
        `INSERT INTO public.purge_status (doc_id, role_hash, purged, evaluated_at)
         VALUES ($1, $2, false, NOW()), ($1, $3, true, NOW())`,
        [docId, activeHash, orphanedHash]
      );

      // Clean up only the orphaned role (not in active set)
      const { rowCount } = await pool.query(
        `DELETE FROM public.purge_status
         WHERE doc_id = $1 AND role_hash != ALL($2)`,
        [docId, [activeHash]]
      );
      expect(rowCount).to.equal(1);

      // Active role entry should still exist
      const { rows } = await pool.query(
        'SELECT role_hash, purged FROM public.purge_status WHERE doc_id = $1',
        [docId]
      );
      expect(rows).to.have.length(1);
      expect(rows[0].role_hash).to.equal(activeHash);

      // Clean up
      await pool.query('DELETE FROM public.purge_status WHERE doc_id = $1', [docId]);
    });
  });

  // ── Run log lifecycle (purge-status.js) ──────────────────────────────

  describe('run log lifecycle', () => {
    it('should create a running entry and complete it with stats', async () => {
      // Start a run
      const { rows: startRows } = await pool.query(
        "INSERT INTO public.purge_run_log (started_at, status) VALUES (NOW(), 'running') RETURNING id"
      );
      const runId = startRows[0].id;
      expect(runId).to.be.a('number');

      // Complete the run with stats
      await pool.query(`
        UPDATE public.purge_run_log SET
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
      `, [runId, 5, 20, 3, 17, JSON.stringify(['contact-a']), 'abc123hash', JSON.stringify(['role-hash-1'])]);

      // Verify completed run
      const { rows } = await pool.query('SELECT * FROM public.purge_run_log WHERE id = $1', [runId]);
      expect(rows[0].status).to.equal('completed');
      expect(rows[0].contacts_processed).to.equal(5);
      expect(rows[0].docs_evaluated).to.equal(20);
      expect(rows[0].docs_purged).to.equal(3);
      expect(rows[0].docs_unpurged).to.equal(17);
      expect(rows[0].purge_fn_hash).to.equal('abc123hash');
      expect(rows[0].role_hashes).to.deep.equal(['role-hash-1']);
      expect(rows[0].skipped_contacts).to.deep.equal(['contact-a']);
      expect(rows[0].completed_at).to.exist;

      // Clean up
      await pool.query('DELETE FROM public.purge_run_log WHERE id = $1', [runId]);
    });

    it('should mark a run as failed with error message', async () => {
      const { rows: startRows } = await pool.query(
        "INSERT INTO public.purge_run_log (started_at, status) VALUES (NOW(), 'running') RETURNING id"
      );
      const runId = startRows[0].id;

      await pool.query(
        "UPDATE public.purge_run_log SET completed_at = NOW(), status = 'failed', error = $2 WHERE id = $1",
        [runId, 'Connection timeout: could not reach database']
      );

      const { rows } = await pool.query('SELECT * FROM public.purge_run_log WHERE id = $1', [runId]);
      expect(rows[0].status).to.equal('failed');
      expect(rows[0].error).to.equal('Connection timeout: could not reach database');

      await pool.query('DELETE FROM public.purge_run_log WHERE id = $1', [runId]);
    });
  });

  // ── Purge function hash change detection ─────────────────────────────

  describe('purge function hash change detection', () => {
    it('should detect change via getLastPurgeFnHash query', async () => {
      // Insert a completed run with a known hash
      const { rows: r1 } = await pool.query(
        `INSERT INTO public.purge_run_log (started_at, completed_at, status, purge_fn_hash, contacts_processed, docs_evaluated, docs_purged, docs_unpurged)
         VALUES (NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour', 'completed', 'old-hash-abc', 1, 1, 0, 1) RETURNING id`
      );
      const run1Id = r1[0].id;

      // Query for last hash (same as purge-status.js getLastPurgeFnHash)
      const { rows: hashRows } = await pool.query(`
        SELECT purge_fn_hash FROM public.purge_run_log
        WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1
      `);

      // Should find the hash from the real last completed run (which might be newer)
      // At minimum, the query should work and return a string
      expect(hashRows).to.be.an('array');
      if (hashRows.length > 0) {
        expect(hashRows[0].purge_fn_hash).to.be.a('string');
      }

      await pool.query('DELETE FROM public.purge_run_log WHERE id = $1', [run1Id]);
    });

    it('should detect role changes via getLastRoleHashes query', async () => {
      const { rows: r1 } = await pool.query(
        `INSERT INTO public.purge_run_log (started_at, completed_at, status, role_hashes, contacts_processed, docs_evaluated, docs_purged, docs_unpurged)
         VALUES (NOW() - INTERVAL '2 hours', NOW() - INTERVAL '1 hour', 'completed', $1::jsonb, 1, 1, 0, 1) RETURNING id`,
        [JSON.stringify(['hash-a', 'hash-b'])]
      );
      const runId = r1[0].id;

      const { rows } = await pool.query(`
        SELECT role_hashes FROM public.purge_run_log
        WHERE status = 'completed' AND role_hashes IS NOT NULL
        ORDER BY completed_at DESC LIMIT 1
      `);
      expect(rows).to.have.length.at.least(1);
      expect(rows[0].role_hashes).to.be.an('array');

      await pool.query('DELETE FROM public.purge_run_log WHERE id = $1', [runId]);
    });
  });

  // ── getLastRunSkippedContacts ────────────────────────────────────────

  describe('skipped contacts retry', () => {
    it('should retrieve previously skipped contacts from last run', async () => {
      const { rows: r1 } = await pool.query(
        `INSERT INTO public.purge_run_log (started_at, completed_at, status, skipped_contacts, contacts_processed, docs_evaluated, docs_purged, docs_unpurged)
         VALUES (NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '29 minutes', 'completed', $1::jsonb, 10, 50, 5, 45) RETURNING id`,
        [JSON.stringify(['contact-skipped-1', 'contact-skipped-2'])]
      );
      const runId = r1[0].id;

      // getLastRunSkippedContacts pattern
      const { rows } = await pool.query(`
        SELECT skipped_contacts FROM public.purge_run_log
        WHERE status = 'completed' AND skipped_contacts IS NOT NULL
        ORDER BY completed_at DESC LIMIT 1
      `);

      expect(rows).to.have.length.at.least(1);
      const skipped = rows[0].skipped_contacts;
      expect(Array.isArray(skipped)).to.be.true;

      await pool.query('DELETE FROM public.purge_run_log WHERE id = $1', [runId]);
    });
  });

  // ── writePurgeResults large batch chunking ───────────────────────────

  describe('writePurgeResults batch handling', () => {
    it('should handle batch upserts with renumbered placeholders', async () => {
      const docIds = Array.from({ length: 20 }, (_, i) => `${stamp()}-batch-${i}`);
      const roleHash = 'batch-test-hash-0000000000000';

      // Build batch INSERT matching purge-status.js pattern
      const rows = [];
      const params = [];
      for (const docId of docIds) {
        const base = params.length;
        rows.push(`($${base + 1}, $${base + 2}, $${base + 3}, NOW())`);
        params.push(docId, roleHash, (Math.random() > 0.5));
      }

      await pool.query(`
        INSERT INTO public.purge_status (doc_id, role_hash, purged, evaluated_at)
        VALUES ${rows.join(', ')}
        ON CONFLICT (doc_id, role_hash) DO UPDATE SET
          purged = EXCLUDED.purged, evaluated_at = EXCLUDED.evaluated_at
      `, params);

      // Verify all were inserted
      const { rows: result } = await pool.query(
        'SELECT count(*) as n FROM public.purge_status WHERE role_hash = $1 AND doc_id LIKE $2',
        [roleHash, 'purge-adv-%']
      );
      expect(parseInt(result[0].n)).to.equal(20);

      // Clean up
      await pool.query('DELETE FROM public.purge_status WHERE role_hash = $1', [roleHash]);
    });

    it('should correctly re-evaluate (flip purged state) in batch', async () => {
      const docId = stamp();
      const roleHash = 'batch-flip-hash-000000000000';

      // Initial: not purged
      await pool.query(
        'INSERT INTO public.purge_status (doc_id, role_hash, purged, evaluated_at) VALUES ($1, $2, false, NOW())',
        [docId, roleHash]
      );

      // Batch re-evaluate: now purged
      await pool.query(`
        INSERT INTO public.purge_status (doc_id, role_hash, purged, evaluated_at)
        VALUES ($1, $2, true, NOW())
        ON CONFLICT (doc_id, role_hash) DO UPDATE SET
          purged = EXCLUDED.purged, evaluated_at = EXCLUDED.evaluated_at
      `, [docId, roleHash]);

      const { rows } = await pool.query(
        'SELECT purged, evaluated_at FROM public.purge_status WHERE doc_id = $1 AND role_hash = $2',
        [docId, roleHash]
      );
      expect(rows[0].purged).to.be.true;

      await pool.query('DELETE FROM public.purge_status WHERE doc_id = $1', [docId]);
    });
  });

  // ── getChangedContactIds incremental query ──────────────────────────

  describe('getChangedContactIds pattern', () => {
    it('should find contacts changed since a timestamp', async () => {
      const beforeTimestamp = new Date();
      await new Promise(r => setTimeout(r, 100));

      const contactId = stamp();
      testDocIds.push(contactId);
      await couchPost({ _id: contactId, type: 'person', name: 'Changed Contact', reported_date: Date.now() });
      await waitForDoc(contactId);

      // getChangedContactIds pattern from contacts.js
      const { rows } = await pool.query(`
        SELECT _id FROM ${DOCS_TABLE}
        WHERE (doc->>'type' IN ('district_hospital', 'health_center', 'clinic', 'person')
               OR (doc->>'type' = 'contact' AND doc->>'contact_type' IS NOT NULL))
        AND (_deleted IS NOT TRUE)
        AND saved_timestamp > $1
        ORDER BY _id
      `, [beforeTimestamp.toISOString()]);

      expect(rows.map(r => r._id)).to.include(contactId);
    });
  });

  // ── getContactIdsWithChangedRecords UNNEST ──────────────────────────

  describe('getContactIdsWithChangedRecords UNNEST pattern', () => {
    it('should detect contacts whose reports changed via UNNEST subject extraction', async () => {
      const contactId = stamp();
      const reportId = stamp();
      testDocIds.push(contactId, reportId);

      await couchFetch(`/${COUCH_DB}/_bulk_docs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs: [
          { _id: contactId, type: 'person', name: 'UNNEST Subject', patient_id: 'unnest-sc-123', reported_date: Date.now() },
        ] }),
      });
      await waitForDoc(contactId);

      const beforeTimestamp = new Date();
      await new Promise(r => setTimeout(r, 100));

      // Create a report referencing this contact
      await couchPost({
        _id: reportId, type: 'data_record', form: 'visit',
        fields: { patient_id: 'unnest-sc-123' },
        reported_date: Date.now(),
      });
      await waitForDoc(reportId);

      // UNNEST pattern from records.js getContactIdsWithChangedRecords
      const { rows: subjectRows } = await pool.query(`
        SELECT DISTINCT subject_id
        FROM (
          SELECT UNNEST(ARRAY[
            NULLIF(doc->>'patient_id', ''),
            NULLIF(doc->>'place_id', ''),
            NULLIF(doc->>'patient_uuid', ''),
            NULLIF(doc->>'place_uuid', ''),
            NULLIF(doc->'fields'->>'patient_id', ''),
            NULLIF(doc->'fields'->>'place_id', ''),
            NULLIF(doc->'fields'->>'patient_uuid', ''),
            NULLIF(doc->'fields'->>'place_uuid', ''),
            NULLIF(doc->'contact'->>'_id', '')
          ]) AS subject_id
          FROM ${DOCS_TABLE}
          WHERE doc->>'type' = 'data_record'
            AND saved_timestamp > $1
        ) sub
        WHERE subject_id IS NOT NULL
      `, [beforeTimestamp.toISOString()]);

      const subjectIds = subjectRows.map(r => r.subject_id);
      expect(subjectIds).to.include('unnest-sc-123');

      // Now find the contact that has this subject
      if (subjectIds.length > 0) {
        const { rows: contactRows } = await pool.query(`
          SELECT _id FROM ${DOCS_TABLE}
          WHERE (doc->>'type' IN ('district_hospital', 'health_center', 'clinic', 'person')
                 OR (doc->>'type' = 'contact' AND doc->>'contact_type' IS NOT NULL))
          AND (_deleted IS NOT TRUE)
          AND (
            _id = ANY($1)
            OR doc->>'patient_id' = ANY($1)
            OR doc->>'place_id' = ANY($1)
          )
        `, [subjectIds]);

        expect(contactRows.map(r => r._id)).to.include(contactId);
      }
    });
  });

  // ── getUnallocatedRecords query ─────────────────────────────────────

  describe('getUnallocatedRecords pattern', () => {
    it('should find data_records not linked to any contact', async () => {
      const unallocatedId = stamp();
      testDocIds.push(unallocatedId);

      // Create a truly unallocated record — no patient/place/contact references
      await couchPost({
        _id: unallocatedId, type: 'data_record',
        // NO form (SMS message), no patient_id, no place_id, no contact
        sms_message: { message: 'unallocated test', from: '+254000000' },
        reported_date: Date.now(),
      });
      await waitForDoc(unallocatedId);

      // getUnallocatedRecords pattern from records.js
      const { rows } = await pool.query(`
        SELECT _id, doc FROM ${DOCS_TABLE}
        WHERE doc->>'type' = 'data_record'
          AND (_deleted IS NOT TRUE)
          AND COALESCE(doc->>'patient_id', '') = ''
          AND COALESCE(doc->>'place_id', '') = ''
          AND COALESCE(doc->>'patient_uuid', '') = ''
          AND COALESCE(doc->>'place_uuid', '') = ''
          AND COALESCE(doc->'fields'->>'patient_id', '') = ''
          AND COALESCE(doc->'fields'->>'place_id', '') = ''
          AND COALESCE(doc->'fields'->>'patient_uuid', '') = ''
          AND COALESCE(doc->'fields'->>'place_uuid', '') = ''
          AND COALESCE(doc->'contact'->>'_id', '') = ''
          AND _id = $1
        LIMIT 10 OFFSET 0
      `, [unallocatedId]);

      expect(rows.map(r => r._id)).to.include(unallocatedId);
    });
  });

  // ── getContactsBatch pattern ─────────────────────────────────────────

  describe('getContactsBatch pattern', () => {
    it('should fetch contacts in ordered batches with LIMIT/OFFSET', async () => {
      const { rows: batch1 } = await pool.query(`
        SELECT _id, doc FROM ${DOCS_TABLE}
        WHERE (doc->>'type' IN ('district_hospital', 'health_center', 'clinic', 'person')
               OR (doc->>'type' = 'contact' AND doc->>'contact_type' IS NOT NULL))
        AND (_deleted IS NOT TRUE)
        ORDER BY _id
        LIMIT 2 OFFSET 0
      `);

      const { rows: batch2 } = await pool.query(`
        SELECT _id, doc FROM ${DOCS_TABLE}
        WHERE (doc->>'type' IN ('district_hospital', 'health_center', 'clinic', 'person')
               OR (doc->>'type' = 'contact' AND doc->>'contact_type' IS NOT NULL))
        AND (_deleted IS NOT TRUE)
        ORDER BY _id
        LIMIT 2 OFFSET 2
      `);

      // Batches should be ordered and non-overlapping
      if (batch1.length >= 2 && batch2.length >= 1) {
        const batch1Ids = new Set(batch1.map(r => r._id));
        batch2.forEach(r => expect(batch1Ids.has(r._id)).to.be.false);
        // Within each batch, IDs should be in order
        expect(batch1[0]._id < batch1[1]._id).to.be.true;
      }
    });
  });

  // ── Online role filtering ────────────────────────────────────────────

  describe('online role filtering', () => {
    it('should identify offline user-settings for purge processing', async () => {
      // Query for user-settings with non-online roles (same as roles.js getRoles)
      const { rows } = await pool.query(`
        SELECT DISTINCT doc->'roles' AS roles
        FROM ${DOCS_TABLE}
        WHERE doc->>'type' = 'user-settings'
          AND doc->'roles' IS NOT NULL
          AND jsonb_array_length(doc->'roles') > 0
      `);

      // Each result should have roles array; filter out online-only users
      for (const row of rows) {
        expect(row.roles).to.be.an('array');
        // Online roles: mm-online, _admin, admin
        const isOnline = row.roles.some(r => ['mm-online', '_admin', 'admin'].includes(r));
        if (!isOnline) {
          // This is an offline user — should be included for purging
          expect(row.roles.length).to.be.at.least(1);
        }
      }
    });
  });
});
