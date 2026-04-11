/**
 * Integration Tests: Sentinel db-postgresql.js PouchDB-Compatible API
 *
 * Tests the PostgreSQL adapter for Sentinel (sentinel/src/db-postgresql.js)
 * which provides a PouchDB-compatible API surface against PostgreSQL tables.
 *
 * Code paths tested:
 *   - .get(id) — fetch by ID, 404 for missing, 404 for deleted
 *   - .put(doc) — insert/update with rev generation, soft delete
 *   - .post(doc) — insert with auto-generated ID
 *   - .remove(doc) — mark _deleted=true
 *   - .allDocs({keys}) — fetch by key array, with/without include_docs
 *   - .allDocs({startkey, endkey}) — range query with ordering
 *   - .bulkDocs(docs) — transactional batch insert/update
 *   - .query('medic-client/doc_by_type') — type-based view query
 *   - .query('medic-client/contacts_by_phone') — phone lookup
 *   - .query('medic-client/contacts_by_reference') — shortcode/external ID resolution
 *   - .query('medic/contacts_by_depth') — recursive CTE tree walk
 *   - .query('medic/docs_by_shortcode') — shortcode-based ID lookup
 *   - .query('medic/tasks_in_terminal_state') — expired task query
 *   - .query('medic/reports_by_form_and_parent') — report aggregation with _stats reduce
 *   - Sentinel table (sentinel.docs) — auto-creation and CRUD
 *   - Users DB (user-settings docs) — allDocs and get
 *   - .info() — basic database stats
 *
 * These tests run directly against PostgreSQL, testing the SQL queries that
 * db-postgresql.js would execute, without needing the full CHT API stack.
 *
 * Run with:
 *   node tests/integration/postgresql/run-tests.js live-sentinel-db.spec.js
 */
require('../../aliases');
const chai = require('chai');
chai.use(require('chai-as-promised'));
const expect = chai.expect;
const { Pool } = require('pg');

const PG_SCHEMA = process.env.POSTGRES_SCHEMA || 'v1';
const PG_TABLE = process.env.POSTGRES_TABLE || 'couchdb';
const DOCS_TABLE = `"${PG_SCHEMA}"."${PG_TABLE}"`;
const SENTINEL_TABLE = '"sentinel"."docs"';

let pool;
const stamp = () => `sent-db-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

// CouchDB helpers for seeding v1.couchdb with real data
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
const sentinelDocIds = [];

// Helper: generateRev matching db-postgresql.js
const generateRev = (currentRev) => {
  const revNum = currentRev ? parseInt(currentRev.split('-')[0], 10) + 1 : 1;
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${revNum}-pg${suffix}`;
};

describe('Sentinel db-postgresql.js — PouchDB-compatible API', function () {
  this.timeout(120000);

  before(async () => {
    const pgPass = process.env.POSTGRES_PASSWORD || 'pgpass';
    pool = new Pool({ connectionString: `postgresql://cht:${pgPass}@postgres:5432/cht` });
    await pool.query('SELECT 1');
  });

  after(async () => {
    for (const id of testDocIds) await couchDelete(id).catch(() => {});
    // Clean up sentinel docs
    for (const id of sentinelDocIds) {
      await pool.query(`DELETE FROM ${SENTINEL_TABLE} WHERE _id = $1`, [id]).catch(() => {});
    }
    // Clean up any directly inserted v1.couchdb docs
    await pool.query(
      `DELETE FROM ${DOCS_TABLE} WHERE _id LIKE 'sent-db-%' AND source = 'sentinel'`
    ).catch(() => {});
    if (pool) await pool.end();
  });

  // ── .get(id) pattern ────────────────────────────────────────────────

  describe('.get(id) pattern', () => {
    it('should fetch a document by ID from v1.couchdb', async () => {
      const id = stamp();
      testDocIds.push(id);
      await couchPost({ _id: id, type: 'person', name: 'Get Test', reported_date: Date.now() });
      await waitForDoc(id);

      const { rows } = await pool.query(
        `SELECT _id, doc, _deleted, saved_timestamp FROM ${DOCS_TABLE} WHERE _id = $1`,
        [id]
      );
      expect(rows).to.have.length(1);
      expect(rows[0]._deleted).to.not.equal(true);
      expect(rows[0].doc.name).to.equal('Get Test');
    });

    it('should return 404-like for missing document', async () => {
      const { rows } = await pool.query(
        `SELECT _id, doc, _deleted FROM ${DOCS_TABLE} WHERE _id = $1`,
        ['non-existent-sentinel-doc']
      );
      expect(rows).to.have.length(0);
    });

    it('should treat soft-deleted document as missing', async () => {
      const id = stamp();
      testDocIds.push(id);
      await couchPost({ _id: id, type: 'data_record', fields: {}, reported_date: Date.now() });
      await waitForDoc(id);
      await couchDelete(id);

      // Wait for deletion
      const start = Date.now();
      while (Date.now() - start < 30000) {
        const { rows } = await pool.query(`SELECT _deleted FROM ${DOCS_TABLE} WHERE _id = $1`, [id]);
        if (rows.length > 0 && rows[0]._deleted === true) break;
        await new Promise(r => setTimeout(r, 500));
      }

      const { rows } = await pool.query(
        `SELECT _id, doc, _deleted FROM ${DOCS_TABLE} WHERE _id = $1`,
        [id]
      );
      expect(rows).to.have.length(1);
      expect(rows[0]._deleted).to.be.true;
    });
  });

  // ── .put(doc) pattern ───────────────────────────────────────────────

  describe('.put(doc) pattern', () => {
    it('should insert a new document with generated rev', async () => {
      const id = stamp();
      sentinelDocIds.push(id);
      const rev = generateRev();
      const doc = { _id: id, _rev: rev, type: 'data_record', fields: { sentinel_put: true }, reported_date: Date.now() };

      await pool.query(
        `INSERT INTO ${SENTINEL_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')
         ON CONFLICT (_id) DO UPDATE SET doc = $2, _deleted = false, saved_timestamp = NOW()`,
        [id, JSON.stringify(doc)]
      );

      const { rows } = await pool.query(`SELECT doc FROM ${SENTINEL_TABLE} WHERE _id = $1`, [id]);
      expect(rows).to.have.length(1);
      expect(rows[0].doc._rev).to.match(/^1-pg/);
    });

    it('should update existing document via ON CONFLICT DO UPDATE', async () => {
      const id = stamp();
      sentinelDocIds.push(id);
      const rev1 = generateRev();
      const doc1 = { _id: id, _rev: rev1, type: 'person', name: 'Before', reported_date: Date.now() };

      await pool.query(
        `INSERT INTO ${SENTINEL_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [id, JSON.stringify(doc1)]
      );

      const rev2 = generateRev(rev1);
      const doc2 = { _id: id, _rev: rev2, name: 'After' };

      await pool.query(
        `INSERT INTO ${SENTINEL_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')
         ON CONFLICT (_id) DO UPDATE SET doc = $2, _deleted = false, saved_timestamp = NOW()`,
        [id, JSON.stringify(doc2)]
      );

      const { rows } = await pool.query(`SELECT doc FROM ${SENTINEL_TABLE} WHERE _id = $1`, [id]);
      expect(rows[0].doc.name).to.equal('After');
      expect(rows[0].doc._rev).to.match(/^2-pg/);
    });

    it('should soft-delete via put with _deleted=true', async () => {
      const id = stamp();
      sentinelDocIds.push(id);
      const rev1 = generateRev();
      const doc = { _id: id, _rev: rev1, type: 'person', name: 'To Delete', reported_date: Date.now() };

      await pool.query(
        `INSERT INTO ${SENTINEL_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [id, JSON.stringify(doc)]
      );

      // Soft delete via PUT
      const newRev = generateRev(rev1);
      const deletedDoc = { ...doc, _rev: newRev, _deleted: true };
      await pool.query(
        `UPDATE ${SENTINEL_TABLE} SET _deleted = true, doc = $1, saved_timestamp = NOW() WHERE _id = $2`,
        [JSON.stringify(deletedDoc), id]
      );

      const { rows } = await pool.query(`SELECT _deleted FROM ${SENTINEL_TABLE} WHERE _id = $1`, [id]);
      expect(rows[0]._deleted).to.be.true;
    });
  });

  // ── .post(doc) pattern ──────────────────────────────────────────────

  describe('.post(doc) pattern', () => {
    it('should insert with auto-generated UUID when no _id provided', async () => {
      const id = require('crypto').randomUUID();
      sentinelDocIds.push(id);
      const rev = generateRev();
      const doc = { _id: id, _rev: rev, type: 'data_record', fields: { auto: true }, reported_date: Date.now() };

      await pool.query(
        `INSERT INTO ${SENTINEL_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [id, JSON.stringify(doc)]
      );

      const { rows } = await pool.query(`SELECT doc FROM ${SENTINEL_TABLE} WHERE _id = $1`, [id]);
      expect(rows).to.have.length(1);
      expect(rows[0].doc._id).to.equal(id);
      // UUID format
      expect(id).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  // ── .remove(doc) pattern ────────────────────────────────────────────

  describe('.remove(doc) pattern', () => {
    it('should mark document as deleted', async () => {
      const id = stamp();
      sentinelDocIds.push(id);
      const doc = { _id: id, _rev: generateRev(), type: 'person', reported_date: Date.now() };
      await pool.query(
        `INSERT INTO ${SENTINEL_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [id, JSON.stringify(doc)]
      );

      // Remove
      await pool.query(
        `UPDATE ${SENTINEL_TABLE} SET _deleted = true, saved_timestamp = NOW() WHERE _id = $1`,
        [id]
      );

      const { rows } = await pool.query(`SELECT _deleted FROM ${SENTINEL_TABLE} WHERE _id = $1`, [id]);
      expect(rows[0]._deleted).to.be.true;
    });
  });

  // ── .allDocs({keys}) pattern ────────────────────────────────────────

  describe('.allDocs({keys}) pattern', () => {
    let ids;

    before(async () => {
      ids = [stamp(), stamp(), stamp()];
      testDocIds.push(...ids);
      const docs = ids.map((id, i) => ({
        _id: id, type: 'person', name: `AllDocs Person ${i}`, reported_date: Date.now(),
      }));
      await couchFetch(`/${COUCH_DB}/_bulk_docs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs }),
      });
      for (const id of ids) await waitForDoc(id);
    });

    it('should fetch by key array with include_docs', async () => {
      const { rows } = await pool.query(
        `SELECT _id, doc, _deleted FROM ${DOCS_TABLE} WHERE _id = ANY($1)`,
        [ids]
      );

      // Build PouchDB-compatible response
      const result = ids.map(key => {
        const row = rows.find(r => r._id === key);
        if (!row) return { key, error: 'not_found' };
        if (row._deleted) return { id: key, key, value: { rev: row.doc?._rev, deleted: true } };
        return { id: key, key, value: { rev: row.doc?._rev }, doc: row.doc };
      });

      expect(result).to.have.length(3);
      result.forEach(r => {
        expect(r).to.have.property('doc');
        expect(r.doc.type).to.equal('person');
      });
    });

    it('should return not_found for missing keys', async () => {
      const allKeys = [...ids, 'missing-key-xxx'];
      const { rows } = await pool.query(
        `SELECT _id, doc, _deleted FROM ${DOCS_TABLE} WHERE _id = ANY($1)`,
        [allKeys]
      );

      const result = allKeys.map(key => {
        const row = rows.find(r => r._id === key);
        if (!row) return { key, error: 'not_found' };
        return { id: key, key, value: { rev: row.doc?._rev }, doc: row.doc };
      });

      const missing = result.find(r => r.key === 'missing-key-xxx');
      expect(missing).to.have.property('error', 'not_found');
    });

    it('should fetch without include_docs (just _id and _rev)', async () => {
      const { rows } = await pool.query(
        `SELECT _id, doc, _deleted FROM ${DOCS_TABLE} WHERE _id = ANY($1)`,
        [ids]
      );

      // Without include_docs
      const result = ids.map(key => {
        const row = rows.find(r => r._id === key);
        if (!row) return { key, error: 'not_found' };
        return { id: key, key, value: { rev: row.doc?._rev } };
      });

      result.forEach(r => {
        expect(r).to.not.have.property('doc');
        expect(r.value).to.have.property('rev');
      });
    });
  });

  // ── .allDocs range query ─────────────────────────────────────────────

  describe('.allDocs range query', () => {
    it('should fetch documents in a key range ordered by _id', async () => {
      const { rows } = await pool.query(
        `SELECT _id, doc FROM ${DOCS_TABLE}
         WHERE (_deleted IS NULL OR _deleted = false)
         AND _id >= $1 AND _id <= $2
         ORDER BY _id
         LIMIT $3`,
        ['form:', 'form:\ufff0', 10]
      );
      expect(rows.length).to.be.at.least(1);
      rows.forEach(r => expect(r._id).to.match(/^form:/));
      // Verify ordering
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]._id >= rows[i - 1]._id).to.be.true;
      }
    });

    it('should support descending order', async () => {
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE (_deleted IS NULL OR _deleted = false)
         AND _id >= $1 AND _id <= $2
         ORDER BY _id DESC
         LIMIT $3`,
        ['form:', 'form:\ufff0', 5]
      );
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]._id <= rows[i - 1]._id).to.be.true;
      }
    });
  });

  // ── .bulkDocs(docs) pattern ─────────────────────────────────────────

  describe('.bulkDocs(docs) pattern', () => {
    it('should batch insert/update in a transaction', async () => {
      const ids = [stamp(), stamp(), stamp()];
      sentinelDocIds.push(...ids);
      const docs = ids.map(id => ({
        _id: id, _rev: generateRev(), type: 'data_record', fields: { bulk: true },
        reported_date: Date.now(),
      }));

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const results = [];
        for (const doc of docs) {
          const newRev = generateRev(doc._rev);
          const newDoc = { ...doc, _rev: newRev };
          await client.query(
            `INSERT INTO ${SENTINEL_TABLE} (_id, doc, _deleted, saved_timestamp, source)
             VALUES ($1, $2, false, NOW(), 'sentinel')
             ON CONFLICT (_id) DO UPDATE SET doc = $2, _deleted = false, saved_timestamp = NOW()`,
            [doc._id, JSON.stringify(newDoc)]
          );
          results.push({ ok: true, id: doc._id, rev: newRev });
        }
        await client.query('COMMIT');
        expect(results).to.have.length(3);
        results.forEach(r => expect(r.ok).to.be.true);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Verify all were written
      const { rows } = await pool.query(
        `SELECT _id FROM ${SENTINEL_TABLE} WHERE _id = ANY($1)`,
        [ids]
      );
      expect(rows).to.have.length(3);
    });

    it('should rollback on error (transaction atomicity)', async () => {
      const goodId = stamp();
      sentinelDocIds.push(goodId);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO ${SENTINEL_TABLE} (_id, doc, _deleted, saved_timestamp, source)
           VALUES ($1, $2, false, NOW(), 'sentinel')`,
          [goodId, JSON.stringify({ _id: goodId, _rev: generateRev() })]
        );
        // Force an error by inserting with wrong type
        await client.query('INSERT INTO nonexistent_table VALUES (1)');
        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      // The good doc should NOT have been committed
      const { rows } = await pool.query(
        `SELECT _id FROM ${SENTINEL_TABLE} WHERE _id = $1`, [goodId]
      );
      expect(rows).to.have.length(0);
    });
  });

  // ── .query('medic-client/doc_by_type') pattern ─────────────────────

  describe('view: medic-client/doc_by_type', () => {
    it('should query documents by type', async () => {
      const { rows } = await pool.query(
        `SELECT _id, doc FROM ${DOCS_TABLE}
         WHERE doc->>'type' = $1 AND (_deleted IS NULL OR _deleted = false)`,
        ['person']
      );
      expect(rows.length).to.be.at.least(1);
      rows.forEach(r => expect(r.doc.type).to.equal('person'));
    });
  });

  // ── .query('medic-client/contacts_by_phone') pattern ──────────────

  describe('view: medic-client/contacts_by_phone', () => {
    let phonePersonId;

    before(async () => {
      phonePersonId = stamp();
      testDocIds.push(phonePersonId);
      await couchPost({
        _id: phonePersonId, type: 'person', name: 'Phone Test',
        phone: '+254799887766', reported_date: Date.now(),
      });
      await waitForDoc(phonePersonId);
    });

    it('should find contacts by phone number', async () => {
      const { rows } = await pool.query(
        `SELECT _id, doc FROM ${DOCS_TABLE}
         WHERE doc->>'phone' = $1
           AND doc->>'type' IN ('contact', 'person', 'clinic', 'health_center', 'district_hospital')
           AND (_deleted IS NULL OR _deleted = false)`,
        ['+254799887766']
      );
      expect(rows.map(r => r._id)).to.include(phonePersonId);
    });
  });

  // ── .query('medic-client/contacts_by_reference') pattern ──────────

  describe('view: medic-client/contacts_by_reference', () => {
    let refPersonId;

    before(async () => {
      refPersonId = stamp();
      testDocIds.push(refPersonId);
      await couchPost({
        _id: refPersonId, type: 'person', name: 'Reference Test',
        patient_id: 'ref-sc-99999', reported_date: Date.now(),
      });
      await waitForDoc(refPersonId);
    });

    it('should resolve shortcode references', async () => {
      const shortcodes = ['ref-sc-99999'];
      const { rows } = await pool.query(
        `SELECT _id, doc FROM ${DOCS_TABLE}
         WHERE (doc->>'patient_id' = ANY($1) OR doc->>'place_id' = ANY($1))
           AND doc->>'type' IN ('contact', 'person', 'clinic', 'health_center', 'district_hospital', 'national_office')
           AND (_deleted IS NULL OR _deleted = false)`,
        [shortcodes]
      );
      expect(rows.map(r => r._id)).to.include(refPersonId);
    });
  });

  // ── .query('medic/contacts_by_depth') pattern ─────────────────────

  describe('view: medic/contacts_by_depth', () => {
    let parentId, child1Id, child2Id;

    before(async () => {
      parentId = stamp();
      child1Id = stamp();
      child2Id = stamp();
      testDocIds.push(parentId, child1Id, child2Id);

      await couchFetch(`/${COUCH_DB}/_bulk_docs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs: [
          { _id: parentId, type: 'clinic', name: 'Depth Parent', reported_date: Date.now() },
          { _id: child1Id, type: 'person', name: 'Depth Child 1', parent: { _id: parentId }, reported_date: Date.now() },
          { _id: child2Id, type: 'person', name: 'Depth Child 2', parent: { _id: parentId }, reported_date: Date.now() },
        ] }),
      });
      for (const id of [parentId, child1Id, child2Id]) await waitForDoc(id);
    });

    it('should find descendants via recursive CTE', async () => {
      const { rows } = await pool.query(
        `WITH RECURSIVE tree AS (
           SELECT _id, doc, 0 AS depth FROM ${DOCS_TABLE}
           WHERE doc->'parent'->>'_id' = $1
             AND (_deleted IS NULL OR _deleted = false)
           UNION ALL
           SELECT c._id, c.doc, t.depth + 1
           FROM ${DOCS_TABLE} c JOIN tree t ON c.doc->'parent'->>'_id' = t._id
           WHERE c._deleted IS NULL OR c._deleted = false
         )
         SELECT _id, doc, depth FROM tree ORDER BY depth`,
        [parentId]
      );
      expect(rows.length).to.be.at.least(2);
      const childIds = rows.map(r => r._id);
      expect(childIds).to.include(child1Id);
      expect(childIds).to.include(child2Id);
    });
  });

  // ── .query('medic/docs_by_shortcode') pattern ─────────────────────

  describe('view: medic/docs_by_shortcode', () => {
    it('should find documents by patient_id, place_id, or case_id', async () => {
      const id = stamp();
      testDocIds.push(id);
      await couchPost({ _id: id, type: 'person', name: 'Shortcode Lookup', patient_id: 'sc-lookup-777', reported_date: Date.now() });
      await waitForDoc(id);

      const shortcodes = ['sc-lookup-777'];
      const { rows } = await pool.query(
        `SELECT _id, doc->>'patient_id' as patient_id
         FROM ${DOCS_TABLE}
         WHERE (doc->>'patient_id' = ANY($1) OR doc->>'place_id' = ANY($1) OR doc->>'case_id' = ANY($1))
           AND (_deleted IS NULL OR _deleted = false)`,
        [shortcodes]
      );
      expect(rows.map(r => r._id)).to.include(id);
      expect(rows.find(r => r._id === id).patient_id).to.equal('sc-lookup-777');
    });
  });

  // ── .query('medic/tasks_in_terminal_state') pattern ────────────────

  describe('view: medic/tasks_in_terminal_state', () => {
    it('should find terminal tasks with emission.endDate range', async () => {
      const taskId = stamp();
      testDocIds.push(taskId);
      const endDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days ago

      await couchPost({
        _id: taskId, type: 'task', state: 'Completed',
        emission: { endDate }, reported_date: Date.now(),
      });
      await waitForDoc(taskId);

      const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const { rows } = await pool.query(
        `SELECT _id, doc->'emission'->>'endDate' as end_date FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'task'
           AND doc->>'state' IN ('Cancelled','Completed','Failed')
           AND doc->'emission'->>'endDate' IS NOT NULL
           AND doc->'emission'->>'endDate' <= $1
           AND (_deleted IS NULL OR _deleted = false)
         ORDER BY doc->'emission'->>'endDate'
         LIMIT 100`,
        [cutoff]
      );
      expect(rows.map(r => r._id)).to.include(taskId);
    });
  });

  // ── .query('medic/reports_by_form_and_parent') pattern ─────────────

  describe('view: medic/reports_by_form_and_parent', () => {
    let reportParentId, report1Id, report2Id;

    before(async () => {
      reportParentId = stamp();
      report1Id = stamp();
      report2Id = stamp();
      testDocIds.push(reportParentId, report1Id, report2Id);

      await couchFetch(`/${COUCH_DB}/_bulk_docs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs: [
          { _id: reportParentId, type: 'health_center', name: 'Report Parent HC', reported_date: Date.now() },
          { _id: report1Id, type: 'data_record', form: 'pregnancy',
            contact: { _id: 'chw1', parent: { _id: reportParentId } },
            reported_date: Date.now() - 5000 },
          { _id: report2Id, type: 'data_record', form: 'pregnancy',
            contact: { _id: 'chw1', parent: { _id: reportParentId } },
            reported_date: Date.now() },
        ] }),
      });
      for (const id of [reportParentId, report1Id, report2Id]) await waitForDoc(id);
    });

    it('should aggregate reports by form and parent with _stats reduce', async () => {
      const { rows } = await pool.query(
        `SELECT doc->>'form' as form,
                doc->'contact'->'parent'->>'_id' as parent_id,
                count(*) as count,
                min((doc->>'reported_date')::bigint) as min,
                max((doc->>'reported_date')::bigint) as max
         FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'data_record'
           AND doc->>'form' = $1
           AND doc->'contact'->'parent'->>'_id' = $2
           AND (_deleted IS NULL OR _deleted = false)
         GROUP BY doc->>'form', doc->'contact'->'parent'->>'_id'`,
        ['pregnancy', reportParentId]
      );

      expect(rows).to.have.length(1);
      expect(parseInt(rows[0].count)).to.be.at.least(2);
      expect(parseInt(rows[0].min)).to.be.below(parseInt(rows[0].max));
    });
  });

  // ── Sentinel table (sentinel.docs) ─────────────────────────────────

  describe('sentinel.docs table', () => {
    it('should support full CRUD cycle on sentinel.docs', async () => {
      const id = stamp();
      sentinelDocIds.push(id);
      const rev1 = generateRev();
      const doc = { _id: id, _rev: rev1, type: 'sentinel-info', transitions: { update_clinics: { ok: true } } };

      // Create
      await pool.query(
        `INSERT INTO ${SENTINEL_TABLE} (_id, doc, _deleted, saved_timestamp, source) VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [id, JSON.stringify(doc)]
      );

      // Read
      const { rows: readRows } = await pool.query(`SELECT doc FROM ${SENTINEL_TABLE} WHERE _id = $1`, [id]);
      expect(readRows[0].doc.transitions.update_clinics.ok).to.be.true;

      // Update
      const rev2 = generateRev(rev1);
      const updated = { ...doc, _rev: rev2, transitions: { update_clinics: { ok: true }, accept_patient_reports: { ok: true } } };
      await pool.query(
        `UPDATE ${SENTINEL_TABLE} SET doc = $1, saved_timestamp = NOW() WHERE _id = $2`,
        [JSON.stringify(updated), id]
      );

      const { rows: updatedRows } = await pool.query(`SELECT doc FROM ${SENTINEL_TABLE} WHERE _id = $1`, [id]);
      expect(updatedRows[0].doc.transitions.accept_patient_reports).to.exist;

      // Delete (soft)
      await pool.query(
        `UPDATE ${SENTINEL_TABLE} SET _deleted = true, saved_timestamp = NOW() WHERE _id = $1`,
        [id]
      );

      const { rows: deletedRows } = await pool.query(`SELECT _deleted FROM ${SENTINEL_TABLE} WHERE _id = $1`, [id]);
      expect(deletedRows[0]._deleted).to.be.true;
    });
  });

  // ── Users DB (user-settings) ─────────────────────────────────────

  describe('users DB (user-settings)', () => {
    it('should query user settings from v1.user_settings table', async () => {
      // In this environment, user settings are in a dedicated table
      // rather than as type='user-settings' docs in v1.couchdb
      const { rows } = await pool.query(
        `SELECT user_id, username, roles, facility_id FROM v1.user_settings`
      );
      expect(rows.length).to.be.at.least(1);
      rows.forEach(r => {
        expect(r.user_id).to.be.a('string');
        expect(r.username).to.be.a('string');
        expect(r.roles).to.be.an('array');
      });
    });

    it('should have role_hash for each user for purge integration', async () => {
      const { rows } = await pool.query(
        `SELECT username, role_hash, roles FROM v1.user_settings WHERE role_hash IS NOT NULL`
      );
      expect(rows.length).to.be.at.least(1);
      rows.forEach(r => {
        expect(r.role_hash).to.be.a('string').with.length(32); // MD5 hash
      });
    });
  });

  // ── .info() pattern ──────────────────────────────────────────────────

  describe('.info() pattern', () => {
    it('should return document count', async () => {
      const { rows } = await pool.query(`SELECT count(*) as count FROM ${DOCS_TABLE}`);
      const count = parseInt(rows[0].count, 10);
      expect(count).to.be.at.least(1);
    });
  });
});
