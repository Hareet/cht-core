/**
 * cht-sync Data Integrity and Edge Case Tests
 *
 * Validates edge cases identified from cht-sync source analysis:
 *
 * 1. Soft delete behavior (_deleted column, NOT row removal)
 * 2. Security detail stripping (user docs)
 * 3. Message documents (data_record without form field — SMS)
 * 4. Sensitive/private document fields (fields.private)
 * 5. couchdb_progress table tracking
 * 6. Source identifier tracking
 * 7. UPSERT conflict resolution (ON CONFLICT (_id) DO UPDATE)
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
const stamp = () => `integrity-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
const waitForDeleted = async (docId, timeout = 30000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const { rows } = await pool.query(`SELECT _deleted FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]);
    if (rows.length > 0 && rows[0]._deleted === true) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${docId} not marked deleted in PG within ${timeout}ms`);
};

describe('cht-sync data integrity and edge cases', function () {
  this.timeout(120000);

  before(async () => {
    const pgPass = process.env.POSTGRES_PASSWORD || 'pgpass';
    pool = new Pool({ connectionString: `postgresql://cht:${pgPass}@postgres:5432/cht` });
    await pool.query('SELECT 1');
  });

  after(async () => {
    for (const id of testDocIds) await couchDelete(id).catch(() => {});
    if (pool) await pool.end();
  });

  describe('soft delete behavior', () => {
    it('should set _deleted=true on row when document is deleted, not remove the row', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'data_record', fields: { test: 'soft-delete' }, reported_date: Date.now() });
      await waitForDoc(docId);

      // Verify initial state
      const { rows: before } = await pool.query(
        `SELECT _deleted FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]
      );
      expect(before[0]._deleted).to.satisfy(v => v === false || v === null);

      // Delete in CouchDB
      await couchDelete(docId);
      await waitForDeleted(docId);

      // Row should still exist with _deleted=true
      const { rows: after } = await pool.query(
        `SELECT _deleted, doc FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]
      );
      expect(after).to.have.length(1);
      expect(after[0]._deleted).to.be.true;
    });
  });

  describe('security detail stripping', () => {
    it('should remove sensitive fields from user documents if synced', async function () {
      // Check if any user docs exist in PG (cht-sync may or may not sync _users DB)
      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE} WHERE _id LIKE 'org.couchdb.user:%' LIMIT 5`
      );
      if (rows.length === 0) {
        console.log('  No user documents in PostgreSQL — _users DB not synced. Skipping.');
        this.skip();
        return;
      }
      for (const row of rows) {
        expect(row.doc).to.not.have.property('password_scheme');
        expect(row.doc).to.not.have.property('derived_key');
        expect(row.doc).to.not.have.property('salt');
      }
    });
  });

  describe('message documents (SMS without form)', () => {
    it('should replicate SMS message documents (data_record without form)', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({
        _id: docId, type: 'data_record',
        // No 'form' field — this is a message (SMS)
        from: '+254700000099',
        sms_message: { from: '+254700000099', message: 'Test SMS for PG sync', sent_timestamp: Date.now() },
        reported_date: Date.now(),
      });

      const pgDoc = await waitForDoc(docId);
      expect(pgDoc.type).to.equal('data_record');
      expect(pgDoc).to.not.have.property('form');
      expect(pgDoc.sms_message.message).to.equal('Test SMS for PG sync');
      expect(pgDoc.from).to.equal('+254700000099');
    });
  });

  describe('sensitive/private document fields', () => {
    it('should replicate reports with private fields intact in PostgreSQL', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({
        _id: docId, type: 'data_record', form: 'pregnancy',
        fields: { patient_name: 'Confidential Patient', private: 'yes', hiv_status: 'positive' },
        reported_date: Date.now(),
      });

      const pgDoc = await waitForDoc(docId);
      // cht-sync replicates ALL documents fully — private filtering is client-side only
      expect(pgDoc.fields.private).to.equal('yes');
      expect(pgDoc.fields.hiv_status).to.equal('positive');
      expect(pgDoc.fields.patient_name).to.equal('Confidential Patient');
    });
  });

  describe('couchdb_progress tracking', () => {
    it('should track sync progress with source, seq, pending, and updated_at', async () => {
      const { rows } = await pool.query(
        `SELECT source, seq, pending, updated_at FROM "${PG_SCHEMA}"."couchdb_progress"`
      );
      expect(rows).to.be.an('array').that.is.not.empty;
      for (const entry of rows) {
        expect(entry).to.have.property('source');
        expect(entry).to.have.property('seq');
        expect(entry).to.have.property('updated_at');
        expect(entry).to.have.property('pending');
      }
    });

    it('should advance seq after new documents are synced', async () => {
      const { rows: before } = await pool.query(
        `SELECT seq FROM "${PG_SCHEMA}"."couchdb_progress" LIMIT 1`
      );
      const seqBefore = before[0].seq;

      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'data_record', fields: {}, reported_date: Date.now() });
      await waitForDoc(docId);

      const { rows: after } = await pool.query(
        `SELECT seq FROM "${PG_SCHEMA}"."couchdb_progress" LIMIT 1`
      );
      expect(after[0].seq).to.not.equal(seqBefore);
    });
  });

  describe('source identifier tracking', () => {
    it('should record the CouchDB source for each document', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'data_record', fields: {}, reported_date: Date.now() });
      await waitForDoc(docId);

      const { rows } = await pool.query(
        `SELECT source FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]
      );
      expect(rows[0].source).to.be.a('string').that.is.not.empty;

      // Source should match couchdb_progress source
      const { rows: progress } = await pool.query(
        `SELECT source FROM "${PG_SCHEMA}"."couchdb_progress"`
      );
      const sources = progress.map(p => p.source);
      expect(sources).to.include(rows[0].source);
    });
  });

  describe('UPSERT conflict resolution', () => {
    it('should update existing documents via ON CONFLICT (_id) DO UPDATE', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'data_record', fields: { version: 1 }, reported_date: Date.now() });
      await waitForDoc(docId);

      const { rows: v1 } = await pool.query(
        `SELECT saved_timestamp, doc FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]
      );
      expect(v1[0].doc.fields.version).to.equal(1);

      // Update via CouchDB
      const saved = await couchGet(docId);
      saved.fields.version = 2;
      await couchPut(docId, saved);

      // Wait for UPSERT
      const start = Date.now();
      while (Date.now() - start < 30000) {
        const { rows } = await pool.query(`SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]);
        if (rows.length > 0 && rows[0].doc.fields?.version === 2) break;
        await new Promise(r => setTimeout(r, 500));
      }

      const { rows: v2 } = await pool.query(
        `SELECT saved_timestamp, doc FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]
      );
      expect(v2[0].doc.fields.version).to.equal(2);

      // Exactly ONE row (UPSERT, not a second INSERT)
      const { rows: count } = await pool.query(
        `SELECT COUNT(*) as cnt FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]
      );
      expect(parseInt(count[0].cnt)).to.equal(1);
    });
  });
});
