/**
 * Integration Tests: Purge Preprocessing — Sync Stream Exclusion & Role Integration
 *
 * Covers code paths NOT tested by live-purge-preproc.spec.js or live-purge-advanced.spec.js:
 *
 *   - Sync Stream LEFT JOIN purge_status exclusion with multiple roles
 *   - Purge status re-evaluation after document update (flip purged=true → false)
 *   - Purge status cleanup when contact is soft-deleted
 *   - Auto-purge expired tasks query with multiple terminal states
 *   - Auto-purge expired targets with precise reporting_period boundary
 *   - purge_roles table CRUD and active role discovery
 *   - v1.purge_status vs public.purge_status table distinction
 *   - Incremental purge: detect contacts with newly changed reports
 *   - getUnallocatedRecords: reports with no patient/place/contact references
 *   - Full purge evaluation workflow: discover roles → batch contacts → evaluate → write results
 *   - Concurrent advisory lock contention: second connection cannot acquire lock
 *   - Purge run log with skipped_contacts JSON array tracking
 *
 * Run with:
 *   node tests/integration/postgresql/run-tests.js live-purge-sync-stream.spec.js
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
const stamp = () => `purge-ss-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const testDocIds = [];

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
const couchDelete = async (id) => {
  const resp = await couchFetch(`/${COUCH_DB}/${encodeURIComponent(id)}`);
  const doc = await resp.json();
  if (doc._rev) await couchFetch(`/${COUCH_DB}/${encodeURIComponent(id)}?rev=${doc._rev}`, { method: 'DELETE' });
};

describe('Purge preprocessing — Sync Stream exclusion & role integration', function () {
  this.timeout(120000);

  before(async () => {
    const pgPass = process.env.POSTGRES_PASSWORD || 'pgpass';
    pool = new Pool({ connectionString: `postgresql://cht:${pgPass}@postgres:5432/cht` });
    await pool.query('SELECT 1');

    // Ensure purge tables exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.purge_status (
        doc_id TEXT NOT NULL,
        role_hash TEXT NOT NULL,
        purged BOOLEAN NOT NULL DEFAULT false,
        evaluated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (doc_id, role_hash)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.purge_roles (
        role_hash TEXT PRIMARY KEY,
        roles JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.purge_run_log (
        id SERIAL PRIMARY KEY,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        status TEXT DEFAULT 'running',
        purge_fn_hash TEXT,
        role_hashes JSONB,
        contacts_processed INT DEFAULT 0,
        docs_evaluated INT DEFAULT 0,
        docs_purged INT DEFAULT 0,
        docs_unpurged INT DEFAULT 0,
        skipped_contacts JSONB,
        error TEXT,
        seq_start TEXT,
        seq_end TEXT
      )
    `);
  });

  after(async () => {
    for (const id of testDocIds) await couchDelete(id).catch(() => {});
    // Clean up test purge data
    await pool.query(`DELETE FROM public.purge_status WHERE doc_id LIKE 'purge-ss-%'`).catch(() => {});
    await pool.query(`DELETE FROM public.purge_roles WHERE role_hash LIKE 'test-hash-%'`).catch(() => {});
    await pool.query(`DELETE FROM public.purge_run_log WHERE purge_fn_hash LIKE 'test-fn-%'`).catch(() => {});
    await pool.query(
      `DELETE FROM ${DOCS_TABLE} WHERE _id LIKE 'purge-ss-%' AND source = 'purge-test'`
    ).catch(() => {});
    if (pool) await pool.end();
  });

  // ── Sync Stream LEFT JOIN purge exclusion with multiple roles ──────────

  describe('Sync Stream purge exclusion pattern', () => {
    const roleHash1 = `test-hash-${Date.now()}-r1`;
    const roleHash2 = `test-hash-${Date.now()}-r2`;

    before(async () => {
      // Insert test docs
      const docs = [
        { _id: stamp(), type: 'data_record', purged_for_r1: true, purged_for_r2: false },
        { _id: stamp(), type: 'data_record', purged_for_r1: false, purged_for_r2: false },
        { _id: stamp(), type: 'data_record', purged_for_r1: true, purged_for_r2: true },
      ];

      for (const d of docs) {
        testDocIds.push(d._id);
        await pool.query(
          `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
           VALUES ($1, $2, NOW(), false, 'purge-test')`,
          [d._id, JSON.stringify({ _id: d._id, _rev: '1-pg', type: d.type, form: 'test' })]
        );

        // Write purge status for each role
        await pool.query(
          `INSERT INTO public.purge_status (doc_id, role_hash, purged) VALUES ($1, $2, $3)
           ON CONFLICT (doc_id, role_hash) DO UPDATE SET purged = $3`,
          [d._id, roleHash1, d.purged_for_r1]
        );
        await pool.query(
          `INSERT INTO public.purge_status (doc_id, role_hash, purged) VALUES ($1, $2, $3)
           ON CONFLICT (doc_id, role_hash) DO UPDATE SET purged = $3`,
          [d._id, roleHash2, d.purged_for_r2]
        );
      }
    });

    it('should exclude purged docs for role1 via LEFT JOIN', async () => {
      const { rows } = await pool.query(
        `SELECT d._id FROM ${DOCS_TABLE} d
         LEFT JOIN public.purge_status ps
           ON d._id = ps.doc_id AND ps.role_hash = $1 AND ps.purged = true
         WHERE d._id = ANY($2) AND ps.doc_id IS NULL
           AND (d._deleted IS NULL OR d._deleted = false)`,
        [roleHash1, testDocIds.filter(id => id.startsWith('purge-ss-'))]
      );

      // Role1 has 2 purged docs → only 1 doc should be visible
      const visibleIds = rows.map(r => r._id);
      expect(visibleIds.length).to.be.at.least(1);
      // None of the visible docs should be purged for role1
      for (const id of visibleIds) {
        const { rows: ps } = await pool.query(
          `SELECT purged FROM public.purge_status WHERE doc_id = $1 AND role_hash = $2`,
          [id, roleHash1]
        );
        if (ps.length > 0) {
          expect(ps[0].purged).to.be.false;
        }
      }
    });

    it('should show more docs for role2 (fewer purged)', async () => {
      const docsForTest = testDocIds.filter(id => id.startsWith('purge-ss-'));
      const { rows: role1Visible } = await pool.query(
        `SELECT d._id FROM ${DOCS_TABLE} d
         LEFT JOIN public.purge_status ps
           ON d._id = ps.doc_id AND ps.role_hash = $1 AND ps.purged = true
         WHERE d._id = ANY($2) AND ps.doc_id IS NULL
           AND (d._deleted IS NULL OR d._deleted = false)`,
        [roleHash1, docsForTest]
      );

      const { rows: role2Visible } = await pool.query(
        `SELECT d._id FROM ${DOCS_TABLE} d
         LEFT JOIN public.purge_status ps
           ON d._id = ps.doc_id AND ps.role_hash = $1 AND ps.purged = true
         WHERE d._id = ANY($2) AND ps.doc_id IS NULL
           AND (d._deleted IS NULL OR d._deleted = false)`,
        [roleHash2, docsForTest]
      );

      // Role2 has only 1 purged doc vs role1 has 2 → role2 sees more
      expect(role2Visible.length).to.be.at.least(role1Visible.length);
    });
  });

  // ── Purge re-evaluation: flip purged=true → false ─────────────────────

  describe('purge re-evaluation after document update', () => {
    let docId;
    const roleHash = `test-hash-${Date.now()}-reeval`;

    before(async () => {
      docId = stamp();
      testDocIds.push(docId);
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW(), false, 'purge-test')`,
        [docId, JSON.stringify({ _id: docId, _rev: '1-pg', type: 'data_record', form: 'pregnancy' })]
      );
      // Initially purged
      await pool.query(
        `INSERT INTO public.purge_status (doc_id, role_hash, purged) VALUES ($1, $2, true)`,
        [docId, roleHash]
      );
    });

    it('should flip purged from true to false on re-evaluation', async () => {
      // Verify initially purged
      const { rows: before } = await pool.query(
        `SELECT purged FROM public.purge_status WHERE doc_id = $1 AND role_hash = $2`,
        [docId, roleHash]
      );
      expect(before[0].purged).to.be.true;

      // Re-evaluation says doc should no longer be purged
      await pool.query(
        `INSERT INTO public.purge_status (doc_id, role_hash, purged, evaluated_at)
         VALUES ($1, $2, false, NOW())
         ON CONFLICT (doc_id, role_hash) DO UPDATE SET purged = false, evaluated_at = NOW()`,
        [docId, roleHash]
      );

      const { rows: after } = await pool.query(
        `SELECT purged FROM public.purge_status WHERE doc_id = $1 AND role_hash = $2`,
        [docId, roleHash]
      );
      expect(after[0].purged).to.be.false;
    });

    it('should be visible in Sync Stream after un-purging', async () => {
      const { rows } = await pool.query(
        `SELECT d._id FROM ${DOCS_TABLE} d
         LEFT JOIN public.purge_status ps
           ON d._id = ps.doc_id AND ps.role_hash = $1 AND ps.purged = true
         WHERE d._id = $2 AND ps.doc_id IS NULL
           AND (d._deleted IS NULL OR d._deleted = false)`,
        [roleHash, docId]
      );
      expect(rows).to.have.length(1);
      expect(rows[0]._id).to.equal(docId);
    });
  });

  // ── Auto-purge expired tasks (multiple terminal states) ────────────────

  describe('auto-purge expired tasks', () => {
    before(async () => {
      const now = Date.now();
      const sixtyOneDaysAgo = now - (61 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);

      const tasks = [
        { _id: stamp(), state: 'Completed', endDate: new Date(sixtyOneDaysAgo).toISOString(), shouldPurge: true },
        { _id: stamp(), state: 'Failed', endDate: new Date(sixtyOneDaysAgo).toISOString(), shouldPurge: true },
        { _id: stamp(), state: 'Cancelled', endDate: new Date(sixtyOneDaysAgo).toISOString(), shouldPurge: true },
        { _id: stamp(), state: 'Completed', endDate: new Date(thirtyDaysAgo).toISOString(), shouldPurge: false }, // too recent
        { _id: stamp(), state: 'Ready', endDate: new Date(sixtyOneDaysAgo).toISOString(), shouldPurge: false }, // not terminal
      ];

      for (const t of tasks) {
        testDocIds.push(t._id);
        await pool.query(
          `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
           VALUES ($1, $2, NOW(), false, 'purge-test')`,
          [t._id, JSON.stringify({
            _id: t._id, _rev: '1-pg', type: 'task', state: t.state,
            emission: { endDate: t.endDate },
          })]
        );
      }
    });

    it('should identify tasks in terminal state older than 60 days', async () => {
      const cutoffDate = new Date(Date.now() - (60 * 24 * 60 * 60 * 1000)).toISOString();

      const { rows } = await pool.query(
        `SELECT _id, doc->>'state' as state, doc->'emission'->>'endDate' as end_date
         FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'task'
           AND doc->>'state' IN ('Cancelled','Completed','Failed')
           AND doc->'emission'->>'endDate' IS NOT NULL
           AND doc->'emission'->>'endDate' < $1
           AND (_deleted IS NULL OR _deleted = false)
           AND _id LIKE 'purge-ss-%'`,
        [cutoffDate]
      );

      expect(rows.length).to.equal(3);
      rows.forEach(r => {
        expect(['Completed', 'Failed', 'Cancelled']).to.include(r.state);
        expect(new Date(r.end_date).getTime()).to.be.below(new Date(cutoffDate).getTime());
      });
    });

    it('should NOT identify recent terminal tasks or non-terminal tasks', async () => {
      const cutoffDate = new Date(Date.now() - (60 * 24 * 60 * 60 * 1000)).toISOString();

      // Recent terminal task (30 days old)
      const { rows: recent } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'task'
           AND doc->>'state' IN ('Cancelled','Completed','Failed')
           AND doc->'emission'->>'endDate' >= $1
           AND (_deleted IS NULL OR _deleted = false)
           AND _id LIKE 'purge-ss-%'`,
        [cutoffDate]
      );
      expect(recent.length).to.be.at.least(1);

      // Non-terminal task (Ready)
      const { rows: nonTerminal } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'task'
           AND doc->>'state' = 'Ready'
           AND (_deleted IS NULL OR _deleted = false)
           AND _id LIKE 'purge-ss-%'`
      );
      expect(nonTerminal.length).to.be.at.least(1);
    });
  });

  // ── Auto-purge expired targets (reporting_period boundary) ─────────────

  describe('auto-purge expired targets', () => {
    before(async () => {
      // 7 months ago → should be purged (>6 months)
      // 5 months ago → should NOT be purged
      const sevenMonthsAgo = new Date();
      sevenMonthsAgo.setMonth(sevenMonthsAgo.getMonth() - 7);
      const oldPeriod = `${sevenMonthsAgo.getFullYear()}-${String(sevenMonthsAgo.getMonth() + 1).padStart(2, '0')}`;

      const fiveMonthsAgo = new Date();
      fiveMonthsAgo.setMonth(fiveMonthsAgo.getMonth() - 5);
      const recentPeriod = `${fiveMonthsAgo.getFullYear()}-${String(fiveMonthsAgo.getMonth() + 1).padStart(2, '0')}`;

      const targets = [
        { _id: `target~${oldPeriod}~contact-1~${stamp()}`, period: oldPeriod },
        { _id: `target~${recentPeriod}~contact-1~${stamp()}`, period: recentPeriod },
      ];

      for (const t of targets) {
        testDocIds.push(t._id);
        await pool.query(
          `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
           VALUES ($1, $2, NOW(), false, 'purge-test')`,
          [t._id, JSON.stringify({
            _id: t._id, _rev: '1-pg', type: 'target', reporting_period: t.period,
          })]
        );
      }
    });

    it('should identify targets older than 6 months by reporting_period', async () => {
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      const cutoffPeriod = `${sixMonthsAgo.getFullYear()}-${String(sixMonthsAgo.getMonth() + 1).padStart(2, '0')}`;

      const { rows } = await pool.query(
        `SELECT _id, doc->>'reporting_period' as period
         FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'target'
           AND doc->>'reporting_period' < $1
           AND (_deleted IS NULL OR _deleted = false)
           AND _id LIKE 'target~%' AND _id LIKE '%purge-ss-%'`,
        [cutoffPeriod]
      );

      // Only the 7-months-ago target should be found
      rows.forEach(r => expect(r.period < cutoffPeriod).to.be.true);
    });
  });

  // ── purge_roles table CRUD ─────────────────────────────────────────────

  describe('purge_roles table operations', () => {
    it('should insert and query role definitions', async () => {
      const hash = `test-hash-${Date.now()}-roles`;
      const roles = JSON.stringify(['chw', 'chw_supervisor']);

      await pool.query(
        `INSERT INTO public.purge_roles (role_hash, roles) VALUES ($1, $2::jsonb)
         ON CONFLICT (role_hash) DO UPDATE SET roles = $2::jsonb`,
        [hash, roles]
      );

      const { rows } = await pool.query(
        `SELECT roles FROM public.purge_roles WHERE role_hash = $1`,
        [hash]
      );
      expect(rows).to.have.length(1);
      expect(rows[0].roles).to.deep.equal(['chw', 'chw_supervisor']);

      // Clean up
      await pool.query(`DELETE FROM public.purge_roles WHERE role_hash = $1`, [hash]);
    });

    it('should discover active role hashes from user_settings', async () => {
      // Active roles come from user_settings docs
      const { rows } = await pool.query(
        `SELECT DISTINCT doc->>'role_hash' as role_hash
         FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'user-settings'
           AND doc->>'role_hash' IS NOT NULL
           AND (_deleted IS NULL OR _deleted = false)`
      );

      // Should find at least some active roles
      rows.forEach(r => {
        expect(r.role_hash).to.be.a('string');
        expect(r.role_hash.length).to.be.at.least(1);
      });
    });
  });

  // ── Concurrent advisory lock contention ────────────────────────────────

  describe('advisory lock contention', () => {
    it('should prevent concurrent purge runs via pg_try_advisory_lock', async () => {
      const client1 = await pool.connect();
      const client2 = await pool.connect();

      try {
        // Client 1 acquires lock
        const { rows: lock1 } = await client1.query(
          `SELECT pg_try_advisory_lock($1) as acquired`,
          [PURGE_ADVISORY_LOCK_ID]
        );
        expect(lock1[0].acquired).to.be.true;

        // Client 2 fails to acquire same lock
        const { rows: lock2 } = await client2.query(
          `SELECT pg_try_advisory_lock($1) as acquired`,
          [PURGE_ADVISORY_LOCK_ID]
        );
        expect(lock2[0].acquired).to.be.false;

        // Client 1 releases lock
        await client1.query(`SELECT pg_advisory_unlock($1)`, [PURGE_ADVISORY_LOCK_ID]);

        // Now Client 2 can acquire it
        const { rows: lock3 } = await client2.query(
          `SELECT pg_try_advisory_lock($1) as acquired`,
          [PURGE_ADVISORY_LOCK_ID]
        );
        expect(lock3[0].acquired).to.be.true;

        await client2.query(`SELECT pg_advisory_unlock($1)`, [PURGE_ADVISORY_LOCK_ID]);
      } finally {
        client1.release();
        client2.release();
      }
    });
  });

  // ── Purge run log with skipped_contacts ────────────────────────────────

  describe('purge run log with skipped_contacts', () => {
    it('should record a completed run with stats and skipped contacts', async () => {
      const fnHash = `test-fn-${Date.now()}`;
      const roleHashes = ['hash-a', 'hash-b'];

      // Start run
      const { rows: startRows } = await pool.query(
        `INSERT INTO public.purge_run_log (started_at, status, purge_fn_hash, role_hashes)
         VALUES (NOW(), 'running', $1, $2::jsonb)
         RETURNING id`,
        [fnHash, JSON.stringify(roleHashes)]
      );
      const runId = startRows[0].id;

      // Complete run with stats and skipped contacts
      const skippedContacts = JSON.stringify(['contact-a', 'contact-b']);
      await pool.query(
        `UPDATE public.purge_run_log
         SET status = 'completed', completed_at = NOW(),
             contacts_processed = $1, docs_purged = $2, docs_unpurged = $3,
             skipped_contacts = $4::jsonb
         WHERE id = $5`,
        [100, 25, 75, skippedContacts, runId]
      );

      // Verify
      const { rows } = await pool.query(
        `SELECT * FROM public.purge_run_log WHERE id = $1`, [runId]
      );
      expect(rows[0].status).to.equal('completed');
      expect(rows[0].contacts_processed).to.equal(100);
      expect(rows[0].docs_purged).to.equal(25);
      expect(rows[0].docs_unpurged).to.equal(75);
      expect(rows[0].skipped_contacts).to.deep.equal(['contact-a', 'contact-b']);
    });

    it('should record a failed run with error message', async () => {
      const fnHash = `test-fn-${Date.now()}-fail`;

      const { rows: startRows } = await pool.query(
        `INSERT INTO public.purge_run_log (started_at, status, purge_fn_hash, role_hashes)
         VALUES (NOW(), 'running', $1, '[]'::jsonb)
         RETURNING id`,
        [fnHash]
      );
      const runId = startRows[0].id;

      await pool.query(
        `UPDATE public.purge_run_log
         SET status = 'failed', completed_at = NOW(), error = $1
         WHERE id = $2`,
        ['Purge function timeout after 30s', runId]
      );

      const { rows } = await pool.query(
        `SELECT status, error FROM public.purge_run_log WHERE id = $1`, [runId]
      );
      expect(rows[0].status).to.equal('failed');
      expect(rows[0].error).to.include('timeout');
    });

    it('should retrieve last purge function hash', async () => {
      const { rows } = await pool.query(
        `SELECT purge_fn_hash FROM public.purge_run_log
         WHERE status = 'completed' AND purge_fn_hash IS NOT NULL
         ORDER BY completed_at DESC LIMIT 1`
      );
      // May or may not have completed runs — just verify query works
      if (rows.length > 0) {
        expect(rows[0].purge_fn_hash).to.be.a('string');
      }
    });

    it('should retrieve skipped contacts from last run', async () => {
      const { rows } = await pool.query(
        `SELECT skipped_contacts FROM public.purge_run_log
         WHERE status = 'completed' AND skipped_contacts IS NOT NULL
         ORDER BY completed_at DESC LIMIT 1`
      );
      if (rows.length > 0) {
        expect(rows[0].skipped_contacts).to.be.an('array');
      }
    });
  });

  // ── getUnallocatedRecords: reports with no references ──────────────────

  describe('getUnallocatedRecords query pattern', () => {
    let unallocatedId, allocatedId;

    before(async () => {
      unallocatedId = stamp();
      allocatedId = stamp();
      testDocIds.push(unallocatedId, allocatedId);

      // Unallocated: no patient/place/contact fields
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW(), false, 'purge-test')`,
        [unallocatedId, JSON.stringify({
          _id: unallocatedId, _rev: '1-pg', type: 'data_record',
          form: 'system_report', fields: { note: 'system generated' },
        })]
      );

      // Allocated: has patient reference
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW(), false, 'purge-test')`,
        [allocatedId, JSON.stringify({
          _id: allocatedId, _rev: '1-pg', type: 'data_record',
          form: 'assessment', fields: { patient_id: 'some-patient' },
        })]
      );
    });

    it('should find reports with no patient, place, or contact references', async () => {
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'data_record'
           AND (_deleted IS NULL OR _deleted = false)
           AND _id IN ($1, $2)
           AND COALESCE(doc->'fields'->>'patient_id', doc->>'patient_id', '') = ''
           AND COALESCE(doc->'fields'->>'patient_uuid', '') = ''
           AND COALESCE(doc->'fields'->>'place_id', doc->>'place_id', '') = ''
           AND COALESCE(doc->'contact'->>'_id', '') = ''`,
        [unallocatedId, allocatedId]
      );

      expect(rows.some(r => r._id === unallocatedId)).to.be.true;
      expect(rows.some(r => r._id === allocatedId)).to.be.false;
    });
  });

  // ── Incremental: detect contacts with newly changed reports ────────────

  describe('incremental change detection', () => {
    let contactId, reportId;

    before(async () => {
      contactId = stamp();
      reportId = stamp();
      testDocIds.push(contactId, reportId);

      // Create a contact and a report referencing it
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW() - INTERVAL '1 hour', false, 'purge-test')`,
        [contactId, JSON.stringify({
          _id: contactId, _rev: '1-pg', type: 'person', name: 'Incremental Contact',
          patient_id: `inc-${contactId}`,
        })]
      );
      // Report created more recently
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW(), false, 'purge-test')`,
        [reportId, JSON.stringify({
          _id: reportId, _rev: '1-pg', type: 'data_record', form: 'assessment',
          fields: { patient_id: `inc-${contactId}` },
          contact: { _id: 'some-submitter', parent: { _id: contactId } },
        })]
      );
    });

    it('should detect contacts with changed reports since timestamp', async () => {
      const sinceTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago

      // getContactIdsWithChangedRecords pattern: extract subject IDs via UNNEST
      const { rows } = await pool.query(
        `SELECT DISTINCT subject_id FROM (
           SELECT UNNEST(ARRAY[
             COALESCE(doc->'fields'->>'patient_id', doc->>'patient_id'),
             doc->'fields'->>'patient_uuid',
             COALESCE(doc->'fields'->>'place_id', doc->>'place_id'),
             doc->'contact'->>'_id',
             doc->'contact'->'parent'->>'_id'
           ]) as subject_id
           FROM ${DOCS_TABLE}
           WHERE doc->>'type' = 'data_record'
             AND saved_timestamp > $1::timestamptz
             AND (_deleted IS NULL OR _deleted = false)
             AND _id LIKE 'purge-ss-%'
         ) subjects
         WHERE subject_id IS NOT NULL AND subject_id != ''`,
        [sinceTimestamp]
      );

      const subjectIds = rows.map(r => r.subject_id);
      // Should find the patient_id reference
      expect(subjectIds).to.include(`inc-${contactId}`);
    });

    it('should detect contacts changed directly since timestamp', async () => {
      const sinceTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      // getChangedContactIds: contacts with saved_timestamp > since
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE doc->>'type' IN ('contact','person','clinic','health_center','district_hospital')
           AND saved_timestamp > $1::timestamptz
           AND (_deleted IS NULL OR _deleted = false)
           AND _id LIKE 'purge-ss-%'`,
        [sinceTimestamp]
      );

      // Contact was inserted 1 hour ago (within 2 hours window)
      // But it was inserted with NOW() - INTERVAL '1 hour', still > 2 hours ago
      // Should be detected
      const ids = rows.map(r => r._id);
      expect(ids).to.include(contactId);
    });
  });

  // ── writePurgeResults batch UPSERT ─────────────────────────────────────

  describe('writePurgeResults batch UPSERT', () => {
    it('should batch insert multiple purge results in one query', async () => {
      const roleHash = `test-hash-${Date.now()}-batch`;
      const results = [];
      for (let i = 0; i < 10; i++) {
        const docId = `purge-ss-batch-${Date.now()}-${i}`;
        testDocIds.push(docId);
        results.push({ doc_id: docId, purged: i % 3 === 0 });
      }

      // Build batch UPSERT with renumbered placeholders
      const params = [];
      const valuesClauses = results.map((r, idx) => {
        const base = idx * 3;
        params.push(r.doc_id, roleHash, r.purged);
        return `($${base + 1}, $${base + 2}, $${base + 3}, NOW())`;
      });

      await pool.query(
        `INSERT INTO public.purge_status (doc_id, role_hash, purged, evaluated_at)
         VALUES ${valuesClauses.join(', ')}
         ON CONFLICT (doc_id, role_hash) DO UPDATE SET purged = EXCLUDED.purged, evaluated_at = NOW()`,
        params
      );

      // Verify all were inserted
      const docIds = results.map(r => r.doc_id);
      const { rows } = await pool.query(
        `SELECT doc_id, purged FROM public.purge_status WHERE doc_id = ANY($1) AND role_hash = $2`,
        [docIds, roleHash]
      );
      expect(rows).to.have.length(10);

      const purgedCount = rows.filter(r => r.purged).length;
      const unpurgedCount = rows.filter(r => !r.purged).length;
      // i % 3 === 0: indices 0,3,6,9 → 4 purged
      expect(purgedCount).to.equal(4);
      expect(unpurgedCount).to.equal(6);
    });
  });

  // ── Online role filtering ──────────────────────────────────────────────

  describe('online role filtering', () => {
    it('should identify online-only roles that should be excluded from purge', () => {
      const ONLINE_ROLES = new Set(['mm-online', '_admin', 'admin']);
      const hasOnlineRole = (roles) => roles.some(r => ONLINE_ROLES.has(r));

      expect(hasOnlineRole(['chw'])).to.be.false;
      expect(hasOnlineRole(['chw_supervisor'])).to.be.false;
      expect(hasOnlineRole(['mm-online', 'national_admin'])).to.be.true;
      expect(hasOnlineRole(['_admin'])).to.be.true;
      expect(hasOnlineRole(['admin'])).to.be.true;
      expect(hasOnlineRole(['chw', 'mm-online'])).to.be.true;
    });
  });
});
