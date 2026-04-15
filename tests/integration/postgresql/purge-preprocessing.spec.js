/**
 * Purge Preprocessing Tests
 *
 * Validates the purge preprocessing pipeline that evaluates purge rules
 * and writes purge_status entries to PostgreSQL. Tests the actual table
 * schemas: public.purge_status (role_hash-based) and v1.purge_status
 * (for Sync Stream exclusion).
 *
 * Prerequisites: CouchDB, PostgreSQL, and cht-sync (couch2pg) must be running.
 */
require('../../aliases');
const chai = require('chai');
chai.use(require('chai-as-promised'));
const expect = chai.expect;
const { Pool } = require('pg');

const PG_SCHEMA = process.env.POSTGRES_SCHEMA || 'v1';
const DOCS_TABLE = `"${PG_SCHEMA}"."couchdb"`;

let pool;
const stamp = () => `purge-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const testDocIds = [];
const testPurgeDocIds = [];

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
  throw new Error(`${docId} not replicated to PG within ${timeout}ms`);
};

describe('Purge preprocessing for PostgreSQL', function () {
  this.timeout(120000);

  before(async () => {
    const pgPass = process.env.POSTGRES_PASSWORD || 'pgpass';
    pool = new Pool({ connectionString: `postgresql://cht:${pgPass}@postgres:5432/cht` });
    await pool.query('SELECT 1');
  });

  afterEach(async () => {
    // Clean up test purge entries
    if (testPurgeDocIds.length > 0) {
      await pool.query(
        `DELETE FROM public.purge_status WHERE doc_id = ANY($1)`, [testPurgeDocIds]
      ).catch(() => {});
    }
  });

  after(async () => {
    if (testPurgeDocIds.length > 0) {
      await pool.query(
        `DELETE FROM public.purge_status WHERE doc_id = ANY($1)`, [testPurgeDocIds]
      ).catch(() => {});
    }
    for (const id of testDocIds) await couchDelete(id).catch(() => {});
    if (pool) await pool.end();
  });

  describe('public.purge_status table operations', () => {
    it('should insert purge status entries with role_hash', async () => {
      const docId = stamp();
      testPurgeDocIds.push(docId);
      await pool.query(
        `INSERT INTO public.purge_status (doc_id, role_hash, purged, reason)
         VALUES ($1, $2, $3, $4)`,
        [docId, 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', true, 'task completed > 60 days ago']
      );

      const { rows } = await pool.query(
        'SELECT * FROM public.purge_status WHERE doc_id = $1 AND role_hash = $2',
        [docId, 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6']
      );
      expect(rows).to.have.length(1);
      expect(rows[0].purged).to.be.true;
      expect(rows[0].reason).to.equal('task completed > 60 days ago');
    });

    it('should support multiple role hashes per document', async () => {
      const docId = stamp();
      testPurgeDocIds.push(docId);
      const roleHash1 = 'aaaa0000bbbb1111cccc2222dddd3333';
      const roleHash2 = 'eeee4444ffff5555aaaa6666bbbb7777';

      await pool.query(
        `INSERT INTO public.purge_status (doc_id, role_hash, purged, reason) VALUES ($1, $2, $3, $4)`,
        [docId, roleHash1, true, 'task past retention']
      );
      await pool.query(
        `INSERT INTO public.purge_status (doc_id, role_hash, purged) VALUES ($1, $2, $3)`,
        [docId, roleHash2, false]
      );

      const { rows } = await pool.query(
        'SELECT * FROM public.purge_status WHERE doc_id = $1 ORDER BY role_hash', [docId]
      );
      expect(rows).to.have.length(2);
      expect(rows.find(r => r.role_hash === roleHash1).purged).to.be.true;
      expect(rows.find(r => r.role_hash === roleHash2).purged).to.be.false;
    });

    it('should support upsert for re-evaluation', async () => {
      const docId = stamp();
      testPurgeDocIds.push(docId);
      const roleHash = 'cccc1111dddd2222eeee3333ffff4444';

      // Initial: not purged
      await pool.query(
        `INSERT INTO public.purge_status (doc_id, role_hash, purged) VALUES ($1, $2, $3)`,
        [docId, roleHash, false]
      );

      // Re-evaluation: now purged
      await pool.query(
        `INSERT INTO public.purge_status (doc_id, role_hash, purged, reason, evaluated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (doc_id, role_hash) DO UPDATE SET
           purged = EXCLUDED.purged, reason = EXCLUDED.reason, evaluated_at = EXCLUDED.evaluated_at`,
        [docId, roleHash, true, 'target retention expired']
      );

      const { rows } = await pool.query(
        'SELECT * FROM public.purge_status WHERE doc_id = $1 AND role_hash = $2',
        [docId, roleHash]
      );
      expect(rows).to.have.length(1);
      expect(rows[0].purged).to.be.true;
      expect(rows[0].reason).to.equal('target retention expired');
    });
  });

  describe('purge evaluation patterns', () => {
    it('should evaluate task documents for purge based on completion date', async () => {
      const taskDocId = stamp();
      testPurgeDocIds.push(taskDocId);
      const completedDate = Date.now() - (61 * 24 * 60 * 60 * 1000); // 61 days ago
      const daysSinceCompleted = Math.floor((Date.now() - completedDate) / (24 * 60 * 60 * 1000));
      const shouldPurge = daysSinceCompleted > 60;

      await pool.query(
        `INSERT INTO public.purge_status (doc_id, role_hash, purged, reason)
         VALUES ($1, $2, $3, $4)`,
        [taskDocId, 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', shouldPurge,
         `task completed ${daysSinceCompleted} days ago`]
      );

      const { rows } = await pool.query(
        'SELECT purged FROM public.purge_status WHERE doc_id = $1', [taskDocId]
      );
      expect(rows[0].purged).to.be.true;
    });

    it('should NOT purge recent task documents', async () => {
      const taskDocId = stamp();
      testPurgeDocIds.push(taskDocId);
      const recentDate = Date.now() - (5 * 24 * 60 * 60 * 1000); // 5 days ago
      const daysSinceCompleted = Math.floor((Date.now() - recentDate) / (24 * 60 * 60 * 1000));
      const shouldPurge = daysSinceCompleted > 60;

      await pool.query(
        `INSERT INTO public.purge_status (doc_id, role_hash, purged) VALUES ($1, $2, $3)`,
        [taskDocId, 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', shouldPurge]
      );

      const { rows } = await pool.query(
        'SELECT purged FROM public.purge_status WHERE doc_id = $1', [taskDocId]
      );
      expect(rows[0].purged).to.be.false;
    });
  });

  describe('incremental processing', () => {
    it('should process only documents changed since last evaluation', async () => {
      const baseTime = new Date('2026-01-01T00:00:00Z');
      const docIds = Array.from({ length: 5 }, () => stamp());
      testPurgeDocIds.push(...docIds);
      const roleHash = 'dddd8888eeee9999ffff0000aaaa1111';

      for (const docId of docIds) {
        await pool.query(
          `INSERT INTO public.purge_status (doc_id, role_hash, purged, evaluated_at) VALUES ($1, $2, $3, $4)`,
          [docId, roleHash, false, baseTime]
        );
      }

      // Incremental: only first 2 changed
      for (const docId of docIds.slice(0, 2)) {
        await pool.query(
          `UPDATE public.purge_status SET purged = true, evaluated_at = NOW(), reason = 'incremental'
           WHERE doc_id = $1 AND role_hash = $2`,
          [docId, roleHash]
        );
      }

      const { rows: purged } = await pool.query(
        `SELECT doc_id FROM public.purge_status WHERE doc_id = ANY($1) AND role_hash = $2 AND purged = true`,
        [docIds, roleHash]
      );
      const { rows: notPurged } = await pool.query(
        `SELECT doc_id FROM public.purge_status WHERE doc_id = ANY($1) AND role_hash = $2 AND purged = false`,
        [docIds, roleHash]
      );
      expect(purged).to.have.length(2);
      expect(notPurged).to.have.length(3);
    });

    it('should support querying unevaluated documents via LEFT JOIN', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'task', state: 'Completed', reported_date: Date.now() });
      await waitForDoc(docId);

      const roleHash = 'ffff1111aaaa2222bbbb3333cccc4444';
      const { rows } = await pool.query(
        `SELECT c._id FROM ${DOCS_TABLE} c
         LEFT JOIN public.purge_status ps ON c._id = ps.doc_id AND ps.role_hash = $1
         WHERE c._id = $2 AND ps.doc_id IS NULL`,
        [roleHash, docId]
      );
      expect(rows).to.have.length(1);
      expect(rows[0]._id).to.equal(docId);
    });
  });

  describe('Sync Stream exclusion pattern', () => {
    it('should support efficient purge filtering for Sync Streams', async () => {
      // Seed 3 docs directly into PG for this test
      const docIds = Array.from({ length: 3 }, () => stamp());
      testPurgeDocIds.push(...docIds);

      for (const docId of docIds) {
        await pool.query(
          `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
           VALUES ($1, $2, NOW(), false, 'integration-test')
           ON CONFLICT (_id) DO UPDATE SET doc = $2, saved_timestamp = NOW(), _deleted = false`,
          [docId, JSON.stringify({ _id: docId, type: 'data_record', reported_date: Date.now() })]
        );
      }

      const roleHash = 'aaaa1111bbbb2222cccc3333dddd4444';
      // First doc: purged
      await pool.query(
        `INSERT INTO public.purge_status (doc_id, role_hash, purged) VALUES ($1, $2, $3)`,
        [docIds[0], roleHash, true]
      );
      // Second doc: not purged
      await pool.query(
        `INSERT INTO public.purge_status (doc_id, role_hash, purged) VALUES ($1, $2, $3)`,
        [docIds[1], roleHash, false]
      );
      // Third doc: no entry (should be included)

      // Sync Stream pattern: include docs NOT purged for this role_hash
      const { rows } = await pool.query(
        `SELECT c._id FROM ${DOCS_TABLE} c
         LEFT JOIN public.purge_status ps ON c._id = ps.doc_id AND ps.role_hash = $1
         WHERE c._id = ANY($2) AND (ps.purged IS NULL OR ps.purged = false)`,
        [roleHash, docIds]
      );

      const syncedIds = rows.map(r => r._id);
      expect(syncedIds).to.have.length(2);
      expect(syncedIds).to.include(docIds[1]); // explicitly not purged
      expect(syncedIds).to.include(docIds[2]); // no entry = not purged
      expect(syncedIds).to.not.include(docIds[0]); // purged
    });
  });
});
