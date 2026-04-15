/**
 * cht-datasource PostgreSQL Adapter Integration Tests
 *
 * Validates that documents created in CouchDB are:
 * 1. Replicated to PostgreSQL via cht-sync
 * 2. Queryable in PostgreSQL by type, facility, and reported_date
 * 3. Correctly structured in JSONB with hierarchy preserved
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
const stamp = () => `ds-pg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
const couchBulkDocs = async (docs) => (await couchFetch(`/${COUCH_DB}/_bulk_docs`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docs }),
})).json();
const couchGet = async (id) => (await couchFetch(`/${COUCH_DB}/${encodeURIComponent(id)}`)).json();
const couchPut = async (id, doc) => (await couchFetch(`/${COUCH_DB}/${encodeURIComponent(id)}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc),
})).json();
const couchDelete = async (id) => {
  const doc = await couchGet(id);
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

describe('cht-datasource PostgreSQL adapter', function () {
  this.timeout(120000);

  // Test hierarchy: district > health_center > clinic > patients
  let districtId, hcId, clinicId, patient1Id, patient2Id;

  before(async () => {
    const pgPass = process.env.POSTGRES_PASSWORD || 'pgpass';
    pool = new Pool({ connectionString: `postgresql://cht:${pgPass}@postgres:5432/cht` });

    districtId = stamp();
    hcId = stamp();
    clinicId = stamp();
    patient1Id = stamp();
    patient2Id = stamp();
    testDocIds.push(districtId, hcId, clinicId, patient1Id, patient2Id);

    const docs = [
      { _id: districtId, type: 'district_hospital', name: 'PG District', reported_date: Date.now() - 20000 },
      { _id: hcId, type: 'health_center', name: 'PG HC', parent: { _id: districtId }, reported_date: Date.now() - 15000 },
      { _id: clinicId, type: 'clinic', name: 'PG Clinic',
        parent: { _id: hcId, parent: { _id: districtId } }, reported_date: Date.now() - 10000 },
      { _id: patient1Id, type: 'person', name: 'pg-test-patient-1', role: 'patient',
        parent: { _id: clinicId, parent: { _id: hcId, parent: { _id: districtId } } },
        reported_date: Date.now() - 10000 },
      { _id: patient2Id, type: 'person', name: 'pg-test-patient-2', role: 'patient',
        parent: { _id: clinicId, parent: { _id: hcId, parent: { _id: districtId } } },
        reported_date: Date.now() },
    ];
    await couchBulkDocs(docs);
    for (const doc of docs) await waitForDoc(doc._id);
  });

  after(async () => {
    for (const id of testDocIds) await couchDelete(id).catch(() => {});
    if (pool) await pool.end();
  });

  describe('PostgreSQL replication via cht-sync', () => {
    it('should replicate documents to PostgreSQL', async () => {
      const { rows } = await pool.query(`SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [patient1Id]);
      expect(rows).to.have.length(1);
      expect(rows[0].doc.name).to.equal('pg-test-patient-1');
      expect(rows[0].doc.type).to.equal('person');
    });

    it('should replicate all test documents', async () => {
      for (const id of testDocIds) {
        const { rows } = await pool.query(`SELECT _id FROM ${DOCS_TABLE} WHERE _id = $1`, [id]);
        expect(rows).to.have.length(1);
      }
    });

    it('should preserve document structure in JSONB', async () => {
      const { rows } = await pool.query(`SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [patient1Id]);
      expect(rows[0].doc.parent).to.exist;
      expect(rows[0].doc.parent._id).to.equal(clinicId);
      expect(rows[0].doc.parent.parent).to.exist;
      expect(rows[0].doc.parent.parent._id).to.equal(hcId);
    });
  });

  describe('PostgreSQL queries by type', () => {
    it('should query persons by type', async () => {
      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE} WHERE doc->>'type' = 'person'
         AND _id = ANY($1) AND (_deleted IS NULL OR _deleted = false)`,
        [[patient1Id, patient2Id]]
      );
      expect(rows).to.have.length(2);
    });

    it('should query places by type', async () => {
      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE} WHERE doc->>'type' = 'clinic'
         AND _id = $1 AND (_deleted IS NULL OR _deleted = false)`,
        [clinicId]
      );
      expect(rows).to.have.length(1);
    });

    it('should query by facility via parent hierarchy', async () => {
      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE}
         WHERE doc->'parent'->>'_id' = $1
         AND (_deleted IS NULL OR _deleted = false)`,
        [clinicId]
      );
      const ids = rows.map(r => r.doc._id);
      expect(ids).to.include(patient1Id);
      expect(ids).to.include(patient2Id);
    });
  });

  describe('PostgreSQL queries by reported_date', () => {
    it('should query documents by reported_date range', async () => {
      const fifteenSecondsAgo = Date.now() - 15000;
      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'person'
         AND (doc->>'reported_date')::bigint >= $1
         AND _id IN ($2, $3)
         ORDER BY (doc->>'reported_date')::bigint ASC`,
        [fifteenSecondsAgo, patient1Id, patient2Id]
      );
      expect(rows).to.have.length(2);
      expect(rows[0].doc._id).to.equal(patient1Id);
      expect(rows[1].doc._id).to.equal(patient2Id);
    });
  });

  describe('PostgreSQL changes detection', () => {
    it('should detect document updates via saved_timestamp', async () => {
      const beforeUpdate = new Date().toISOString();

      // Update via CouchDB
      const doc = await couchGet(patient1Id);
      doc.name = 'pg-test-patient-1-updated';
      await couchPut(patient1Id, doc);

      // Wait for update
      const start = Date.now();
      while (Date.now() - start < 30000) {
        const { rows } = await pool.query(
          `SELECT doc, saved_timestamp FROM ${DOCS_TABLE}
           WHERE _id = $1 AND saved_timestamp > $2`,
          [patient1Id, beforeUpdate]
        );
        if (rows.length > 0 && rows[0].doc.name === 'pg-test-patient-1-updated') break;
        await new Promise(r => setTimeout(r, 500));
      }
      const { rows } = await pool.query(`SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [patient1Id]);
      expect(rows[0].doc.name).to.equal('pg-test-patient-1-updated');
    });

    it('should track sync progress in couchdb_progress table', async () => {
      const { rows } = await pool.query(
        `SELECT source, seq, updated_at FROM "${PG_SCHEMA}"."couchdb_progress"`
      );
      expect(rows).to.be.an('array').that.is.not.empty;
      expect(rows[0].source).to.exist;
      expect(rows[0].seq).to.exist;
      expect(rows[0].updated_at).to.exist;
    });

    it('should have correct raw row metadata', async () => {
      const { rows } = await pool.query(
        `SELECT _id, saved_timestamp, _deleted, source, doc FROM ${DOCS_TABLE} WHERE _id = $1`,
        [patient1Id]
      );
      expect(rows).to.have.length(1);
      const row = rows[0];
      expect(row._id).to.equal(patient1Id);
      expect(row.saved_timestamp).to.exist;
      expect(row._deleted).to.satisfy(v => v === false || v === null);
      expect(row.source).to.be.a('string');
      expect(row.doc._id).to.equal(patient1Id);
    });
  });
});
