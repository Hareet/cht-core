/**
 * cht-sync Bridge Integration Tests
 *
 * Validates the CouchDB → PostgreSQL data pipeline via cht-sync (couch2pg).
 * This is the migration linchpin — cht-sync's continuous changes feed must
 * replicate documents to PostgreSQL with full fidelity.
 *
 * Tests verify:
 * 1. Documents written to CouchDB appear in PostgreSQL
 * 2. Document updates are propagated
 * 3. Document deletions are handled
 * 4. Schema correctness (JSONB structure, metadata columns)
 * 5. All CHT document types are correctly replicated
 * 6. Latency is within acceptable bounds
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
const stamp = () => `sync-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
const couchPost = async (doc) => {
  const resp = await couchFetch(`/${COUCH_DB}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc),
  });
  return resp.json();
};
const couchBulkDocs = async (docs) => {
  const resp = await couchFetch(`/${COUCH_DB}/_bulk_docs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docs }),
  });
  return resp.json();
};
const couchGet = async (id) => {
  const resp = await couchFetch(`/${COUCH_DB}/${encodeURIComponent(id)}`);
  return resp.json();
};
const couchDelete = async (id) => {
  const doc = await couchGet(id);
  if (doc._rev) {
    await couchFetch(`/${COUCH_DB}/${encodeURIComponent(id)}?rev=${doc._rev}`, { method: 'DELETE' });
  }
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
const waitForDeleted = async (docId, timeout = 30000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const { rows } = await pool.query(`SELECT _deleted FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]);
    if (rows.length > 0 && rows[0]._deleted === true) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${docId} not marked deleted in PG within ${timeout}ms`);
};

describe('cht-sync bridge: CouchDB → PostgreSQL', function () {
  this.timeout(120000);

  before(async () => {
    const pgPass = process.env.POSTGRES_PASSWORD || 'pgpass';
    pool = new Pool({ connectionString: `postgresql://cht:${pgPass}@postgres:5432/cht` });
    await pool.query('SELECT 1');

    // Verify couch2pg is running (progress table is being updated)
    const { rows } = await pool.query(
      `SELECT updated_at FROM "${PG_SCHEMA}"."couchdb_progress" LIMIT 1`
    );
    if (rows.length === 0) {
      throw new Error('cht-sync not running: no entries in couchdb_progress');
    }
    const age = Date.now() - new Date(rows[0].updated_at).getTime();
    if (age > 300000) { // 5 minutes
      console.log(`  WARNING: couchdb_progress last updated ${Math.round(age / 1000)}s ago — couch2pg may be stalled`);
    }
  });

  after(async () => {
    for (const id of testDocIds) await couchDelete(id).catch(() => {});
    if (pool) await pool.end();
  });

  // ── Basic replication ──────────────────────────────────────────────

  describe('basic replication', () => {
    it('should replicate a single document', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'data_record', form: 'test_form',
        fields: { patient_name: 'Test Patient' }, reported_date: Date.now() });

      const pgDoc = await waitForDoc(docId);
      expect(pgDoc._id).to.equal(docId);
      expect(pgDoc.type).to.equal('data_record');
      expect(pgDoc.fields.patient_name).to.equal('Test Patient');
    });

    it('should replicate a batch of documents', async () => {
      const docs = Array.from({ length: 5 }, (_, i) => ({
        _id: stamp(), type: 'data_record', form: 'batch_test',
        fields: { index: i }, reported_date: Date.now(),
      }));
      testDocIds.push(...docs.map(d => d._id));
      await couchBulkDocs(docs);

      for (const doc of docs) {
        const pgDoc = await waitForDoc(doc._id);
        expect(pgDoc.fields.index).to.equal(doc.fields.index);
      }
    });

    it('should replicate document updates', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'data_record', fields: { status: 'draft' }, reported_date: Date.now() });
      await waitForDoc(docId);

      // Update via CouchDB
      const saved = await couchGet(docId);
      saved.fields.status = 'submitted';
      await couchFetch(`/${COUCH_DB}/${encodeURIComponent(docId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(saved),
      });

      // Wait for update to propagate
      const start = Date.now();
      while (Date.now() - start < 30000) {
        const { rows } = await pool.query(`SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]);
        if (rows.length > 0 && rows[0].doc.fields?.status === 'submitted') break;
        await new Promise(r => setTimeout(r, 500));
      }
      const { rows } = await pool.query(`SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]);
      expect(rows[0].doc.fields.status).to.equal('submitted');
    });

    it('should handle document deletion', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'data_record', fields: { temp: true }, reported_date: Date.now() });
      await waitForDoc(docId);

      await couchDelete(docId);
      await waitForDeleted(docId);

      // Verify: row stays with _deleted=true (not physically removed)
      const { rows } = await pool.query(`SELECT _deleted FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]);
      expect(rows).to.have.length(1);
      expect(rows[0]._deleted).to.be.true;
    });
  });

  // ── Schema correctness ──────────────────────────────────────────────

  describe('schema correctness', () => {
    it('should have correct cht-sync couchdb table schema', async () => {
      const result = await pool.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'couchdb'
        ORDER BY ordinal_position
      `, [PG_SCHEMA]);

      const columns = result.rows.reduce((acc, row) => { acc[row.column_name] = row.data_type; return acc; }, {});
      expect(columns).to.have.property('_id');
      expect(columns._id).to.include('character');
      expect(columns).to.have.property('saved_timestamp');
      expect(columns).to.have.property('_deleted');
      expect(columns).to.have.property('source');
      expect(columns).to.have.property('doc');
      expect(columns.doc).to.equal('jsonb');
    });

    it('should have couchdb_progress table for sync tracking', async () => {
      const result = await pool.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'couchdb_progress'
        ORDER BY ordinal_position
      `, [PG_SCHEMA]);

      const columns = result.rows.reduce((acc, row) => { acc[row.column_name] = row.data_type; return acc; }, {});
      expect(columns).to.have.property('seq');
      expect(columns).to.have.property('pending');
      expect(columns).to.have.property('updated_at');
      expect(columns).to.have.property('source');
    });

    it('should store the full CouchDB document in JSONB', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({
        _id: docId, type: 'data_record', form: 'schema_test',
        fields: {
          nested: { deeply: { value: 'preserved' } },
          array_field: [1, 2, 3],
          boolean_field: true,
          number_field: 42,
        },
        reported_date: Date.now(),
      });

      const pgDoc = await waitForDoc(docId);
      expect(pgDoc.fields.nested.deeply.value).to.equal('preserved');
      expect(pgDoc.fields.array_field).to.deep.equal([1, 2, 3]);
      expect(pgDoc.fields.boolean_field).to.be.true;
      expect(pgDoc.fields.number_field).to.equal(42);
    });

    it('should include metadata columns', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'data_record', fields: {}, reported_date: Date.now() });
      await waitForDoc(docId);

      const { rows } = await pool.query(
        `SELECT _id, saved_timestamp, _deleted, source, doc FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]
      );
      expect(rows).to.have.length(1);
      const row = rows[0];
      expect(row._id).to.equal(docId);
      expect(row.saved_timestamp).to.exist;
      expect(row._deleted).to.satisfy(v => v === false || v === null);
      expect(row.source).to.be.a('string').that.is.not.empty;
      expect(row.doc).to.be.an('object');
      expect(row.doc._id).to.equal(docId);
    });
  });

  // ── CHT document type replication ──────────────────────────────────

  describe('CHT document type replication', () => {
    let districtId, hcId, clinicId, personId, reportId, taskId, targetId;

    before(async () => {
      districtId = stamp();
      hcId = stamp();
      clinicId = stamp();
      personId = stamp();
      reportId = stamp();
      taskId = stamp();
      targetId = stamp();
      testDocIds.push(districtId, hcId, clinicId, personId, reportId, taskId, targetId);

      const docs = [
        { _id: districtId, type: 'district_hospital', name: 'Sync District', reported_date: Date.now() },
        { _id: hcId, type: 'health_center', name: 'Sync HC', parent: { _id: districtId }, reported_date: Date.now() },
        { _id: clinicId, type: 'clinic', name: 'Sync Clinic', parent: { _id: hcId }, reported_date: Date.now() },
        { _id: personId, type: 'person', name: 'Sync Person', parent: { _id: clinicId }, reported_date: Date.now() },
        { _id: reportId, type: 'data_record', form: 'pregnancy', fields: { patient_id: personId },
          contact: { _id: personId }, reported_date: Date.now() },
        { _id: taskId, type: 'task', owner: personId, state: 'Ready',
          emission: { _id: `emission-${taskId}` }, reported_date: Date.now() },
        { _id: targetId, type: 'target', owner: personId, reporting_period: '2026-04',
          targets: [{ id: 'pregnancies', value: { pass: 1, total: 1 } }], reported_date: Date.now() },
      ];
      await couchBulkDocs(docs);
      for (const doc of docs) await waitForDoc(doc._id);
    });

    it('should replicate contact documents (person, clinic, health_center, district)', async () => {
      for (const [id, name] of [[districtId, 'Sync District'], [hcId, 'Sync HC'], [clinicId, 'Sync Clinic'], [personId, 'Sync Person']]) {
        const { rows } = await pool.query(`SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [id]);
        expect(rows).to.have.length(1);
        expect(rows[0].doc.name).to.equal(name);
      }
    });

    it('should replicate report documents (data_record)', async () => {
      const { rows } = await pool.query(`SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [reportId]);
      expect(rows).to.have.length(1);
      expect(rows[0].doc.type).to.equal('data_record');
      expect(rows[0].doc.form).to.equal('pregnancy');
    });

    it('should replicate task documents', async () => {
      const { rows } = await pool.query(`SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [taskId]);
      expect(rows).to.have.length(1);
      expect(rows[0].doc.type).to.equal('task');
      expect(rows[0].doc.state).to.equal('Ready');
    });

    it('should replicate target documents', async () => {
      const { rows } = await pool.query(`SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [targetId]);
      expect(rows).to.have.length(1);
      expect(rows[0].doc.type).to.equal('target');
      expect(rows[0].doc.reporting_period).to.equal('2026-04');
    });
  });

  // ── Replication latency ────────────────────────────────────────────

  describe('replication latency', () => {
    it('should replicate within acceptable latency (<30s)', async () => {
      const docId = stamp();
      testDocIds.push(docId);

      const startTime = Date.now();
      await couchPost({ _id: docId, type: 'data_record', fields: { latency_test: true }, reported_date: Date.now() });
      await waitForDoc(docId);
      const latencyMs = Date.now() - startTime;

      console.log(`  cht-sync replication latency: ${latencyMs}ms`);
      expect(latencyMs).to.be.below(30000);
    });
  });

  // ── Sync progress tracking ─────────────────────────────────────────

  describe('sync progress tracking', () => {
    it('should have active sync progress', async () => {
      const { rows } = await pool.query(
        `SELECT source, pending, updated_at FROM "${PG_SCHEMA}"."couchdb_progress"`
      );
      expect(rows).to.have.length.at.least(1);
      expect(rows[0].source).to.be.a('string').that.is.not.empty;
      console.log(`  Source: ${rows[0].source}, pending: ${rows[0].pending}`);
    });

    it('should advance seq after new documents', async () => {
      // Get current seq
      const { rows: before } = await pool.query(
        `SELECT seq FROM "${PG_SCHEMA}"."couchdb_progress" LIMIT 1`
      );
      const seqBefore = before[0].seq;

      // Write a document to CouchDB
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'data_record', fields: {}, reported_date: Date.now() });
      await waitForDoc(docId);

      // Seq should have advanced
      const { rows: after } = await pool.query(
        `SELECT seq FROM "${PG_SCHEMA}"."couchdb_progress" LIMIT 1`
      );
      expect(after[0].seq).to.not.equal(seqBefore);
    });
  });
});
