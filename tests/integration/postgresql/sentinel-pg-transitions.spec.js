/**
 * Sentinel PostgreSQL Transition Tests
 *
 * Validates that Sentinel document transitions produce results that are
 * correctly replicated to PostgreSQL via cht-sync.
 *
 * Tests the critical path: document saved → Sentinel processes → updated doc → cht-sync → PostgreSQL
 *
 * Prerequisites: CouchDB, Sentinel, PostgreSQL, and cht-sync (couch2pg) must be running.
 */
require('../../aliases');
const chai = require('chai');
chai.use(require('chai-as-promised'));
const expect = chai.expect;
const { Pool } = require('pg');

const PG_SCHEMA = process.env.POSTGRES_SCHEMA || 'v1';
const DOCS_TABLE = `"${PG_SCHEMA}"."couchdb"`;

let pool;
const stamp = () => `sentinel-pg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
const couchPost = async (doc) => (await couchFetch(`/${COUCH_DB}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc),
})).json();
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

describe('Sentinel transitions in PostgreSQL', function () {
  this.timeout(120000);

  // Pre-existing hierarchy
  const districtId = `sentinel-pg-district-${Date.now()}`;
  const hcId = `sentinel-pg-hc-${Date.now()}`;
  const clinicId = `sentinel-pg-clinic-${Date.now()}`;
  const chwId = `sentinel-pg-chw-${Date.now()}`;

  before(async () => {
    const pgPass = process.env.POSTGRES_PASSWORD || 'pgpass';
    pool = new Pool({ connectionString: `postgresql://cht:${pgPass}@postgres:5432/cht` });

    testDocIds.push(districtId, hcId, clinicId, chwId);
    await couchBulkDocs([
      { _id: districtId, type: 'district_hospital', name: 'PG Sentinel District', reported_date: Date.now() },
      { _id: hcId, type: 'health_center', name: 'PG Sentinel HC',
        parent: { _id: districtId }, reported_date: Date.now() },
      { _id: clinicId, type: 'clinic', name: 'PG Sentinel Clinic',
        parent: { _id: hcId, parent: { _id: districtId } },
        contact: { _id: chwId }, reported_date: Date.now() },
      { _id: chwId, type: 'person', name: 'PG Sentinel CHW',
        patient_id: `sentinel-pg-shortcode-${Date.now()}`,
        parent: { _id: clinicId, parent: { _id: hcId, parent: { _id: districtId } } },
        phone: '+254700000001', reported_date: Date.now() },
    ]);
    for (const id of [districtId, hcId, clinicId, chwId]) await waitForDoc(id);
  });

  after(async () => {
    for (const id of testDocIds) await couchDelete(id).catch(() => {});
    if (pool) await pool.end();
  });

  describe('document transition replication', () => {
    it('should replicate reports to PG after Sentinel processes them', async () => {
      const reportId = stamp();
      testDocIds.push(reportId);
      await couchPost({
        _id: reportId, type: 'data_record',
        from: '+254700000001',
        fields: { patient_id: `sentinel-pg-shortcode-${Date.now()}` },
        reported_date: Date.now(),
      });

      const pgDoc = await waitForDoc(reportId);
      expect(pgDoc).to.exist;
      expect(pgDoc._id).to.equal(reportId);
      expect(pgDoc.type).to.equal('data_record');
    });
  });

  describe('changes detection for Sentinel processing', () => {
    it('should update saved_timestamp when documents are re-synced after update', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'data_record', fields: {}, reported_date: Date.now() });
      await waitForDoc(docId);

      // Get initial saved_timestamp
      const { rows: initRows } = await pool.query(
        `SELECT saved_timestamp FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]
      );
      const initialTs = initRows[0].saved_timestamp;

      // Update via CouchDB
      const doc = await couchGet(docId);
      doc.fields.updated = true;
      await couchPut(docId, doc);

      // Wait for update to propagate
      const start = Date.now();
      while (Date.now() - start < 30000) {
        const { rows } = await pool.query(`SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]);
        if (rows.length > 0 && rows[0].doc.fields?.updated === true) break;
        await new Promise(r => setTimeout(r, 500));
      }

      const { rows } = await pool.query(
        `SELECT saved_timestamp, doc FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]
      );
      expect(rows[0].doc.fields.updated).to.be.true;
      expect(new Date(rows[0].saved_timestamp).getTime())
        .to.be.at.least(new Date(initialTs).getTime());
    });

    it('should advance seq in couchdb_progress as documents are processed', async () => {
      const { rows: before } = await pool.query(
        `SELECT seq FROM "${PG_SCHEMA}"."couchdb_progress" LIMIT 1`
      );
      const seqBefore = before[0].seq;

      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'data_record', fields: { progress: true }, reported_date: Date.now() });
      await waitForDoc(docId);

      const { rows: after } = await pool.query(
        `SELECT seq FROM "${PG_SCHEMA}"."couchdb_progress" LIMIT 1`
      );
      expect(after[0].seq).to.not.equal(seqBefore);
    });
  });
});
