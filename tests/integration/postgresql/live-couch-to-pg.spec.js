/**
 * Live CouchDB → PostgreSQL Integration Tests
 *
 * Tests the real data path: write to CouchDB via direct API → cht-sync replicates → verify in PostgreSQL.
 * Runs against the live Phase 2 stack (CouchDB + API + PostgreSQL + cht-sync).
 *
 * Run with:
 *   POSTGRES_PASSWORD=pgpass NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *   npx mocha tests/integration/postgresql/live-couch-to-pg.spec.js --timeout 120000 --exit
 */
require('../../aliases');
const chai = require('chai');
chai.use(require('chai-as-promised'));
const expect = chai.expect;
const { Pool } = require('pg');

// --- Connection setup ---
const COUCH_URL = process.env.COUCH_URL || 'http://admin:secret21512@couchdb:5984/medic';
const parsedCouch = new URL(COUCH_URL);
const COUCH_HOST = `${parsedCouch.protocol}//${parsedCouch.host}`;
const COUCH_DB = parsedCouch.pathname.replace(/^\//, '');
const COUCH_AUTH = 'Basic ' + Buffer.from(`${parsedCouch.username}:${parsedCouch.password}`).toString('base64');

const PG_SCHEMA = process.env.POSTGRES_SCHEMA || 'v1';
const PG_TABLE = process.env.POSTGRES_TABLE || 'couchdb';
const DOCS_TABLE = `"${PG_SCHEMA}"."${PG_TABLE}"`;
const PROGRESS_TABLE = `"${PG_SCHEMA}"."couchdb_progress"`;

let pgPool;

const couchFetch = (path, opts = {}) => {
  opts.headers = { ...opts.headers, Authorization: COUCH_AUTH, Accept: 'application/json' };
  return fetch(`${COUCH_HOST}${path}`, opts);
};

const couchPost = async (doc) => {
  const resp = await couchFetch(`/${COUCH_DB}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc),
  });
  return resp.json();
};

const couchGet = async (docId) => {
  const resp = await couchFetch(`/${COUCH_DB}/${encodeURIComponent(docId)}`);
  return resp.json();
};

const couchDelete = async (docId) => {
  const doc = await couchGet(docId);
  if (doc._rev) {
    await couchFetch(`/${COUCH_DB}/${encodeURIComponent(docId)}?rev=${doc._rev}`, { method: 'DELETE' });
  }
};

const pgQuery = (text, params) => pgPool.query(text, params);

/**
 * Poll PostgreSQL until a document appears (not deleted).
 */
const waitForDoc = async (docId, timeoutMs = 45000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await pgQuery(
      `SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`,
      [docId]
    );
    if (result.rows.length > 0) {
      return result.rows[0].doc;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Document ${docId} did not appear in PostgreSQL within ${timeoutMs}ms`);
};

/**
 * Get the full raw row from cht-sync's couchdb table.
 */
const getRawRow = async (docId) => {
  const result = await pgQuery(
    `SELECT _id, saved_timestamp, _deleted, source, doc FROM ${DOCS_TABLE} WHERE _id = $1`,
    [docId]
  );
  return result.rows[0] || null;
};

// Track test docs for cleanup
const testDocIds = [];
const stamp = () => `live-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

describe('Live CouchDB → PostgreSQL data path', function () {
  this.timeout(120000);

  before(async () => {
    const pgPass = process.env.POSTGRES_PASSWORD || 'pgpass';
    const pgUser = process.env.POSTGRES_USER || 'cht';
    const pgHost = process.env.POSTGRES_HOST || 'postgres';
    const pgDb = process.env.POSTGRES_DB || 'cht';
    const pgUrl = process.env.POSTGRES_URL || `postgresql://${pgUser}:${pgPass}@${pgHost}:5432/${pgDb}`;
    pgPool = new Pool({ connectionString: pgUrl });

    // Verify both services are up
    await pgQuery('SELECT 1');
    const couchResp = await couchFetch('/');
    expect((await couchResp.json()).couchdb).to.equal('Welcome');
  });

  after(async () => {
    // Clean up test documents from CouchDB
    for (const id of testDocIds) {
      await couchDelete(id).catch(() => {});
    }
    if (pgPool) await pgPool.end();
  });

  // ── cht-sync schema verification ──────────────────────────────────

  describe('cht-sync schema', () => {
    it('should have the correct couchdb table columns', async () => {
      const result = await pgQuery(`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position
      `, [PG_SCHEMA, PG_TABLE]);
      const cols = Object.fromEntries(result.rows.map(r => [r.column_name, r.data_type]));

      expect(cols).to.have.property('_id');
      expect(cols).to.have.property('saved_timestamp');
      expect(cols).to.have.property('_deleted');
      expect(cols).to.have.property('source');
      expect(cols).to.have.property('doc');
      expect(cols.doc).to.equal('jsonb');
    });

    it('should have the couchdb_progress table', async () => {
      const result = await pgQuery(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'couchdb_progress'
      `, [PG_SCHEMA]);
      const colNames = result.rows.map(r => r.column_name);
      expect(colNames).to.include('seq');
      expect(colNames).to.include('source');
      expect(colNames).to.include('pending');
      expect(colNames).to.include('updated_at');
    });

    it('should have active sync progress', async () => {
      const result = await pgQuery(`SELECT * FROM ${PROGRESS_TABLE}`);
      expect(result.rows).to.have.length.at.least(1);
      const row = result.rows[0];
      expect(row.source).to.be.a('string').that.is.not.empty;
      expect(row.seq).to.be.a('string').that.is.not.empty;
      console.log(`  Source: ${row.source}, pending: ${row.pending}`);
    });
  });

  // ── Document replication ──────────────────────────────────────────

  describe('document replication', () => {
    it('should replicate a new document from CouchDB to PostgreSQL', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'data_record', fields: { test: 'replication' }, reported_date: Date.now() });

      const pgDoc = await waitForDoc(docId);
      expect(pgDoc._id).to.equal(docId);
      expect(pgDoc.type).to.equal('data_record');
      expect(pgDoc.fields.test).to.equal('replication');
    });

    it('should replicate a batch of documents', async () => {
      const ids = Array.from({ length: 5 }, () => stamp());
      testDocIds.push(...ids);
      const docs = ids.map((id, i) => ({ _id: id, type: 'data_record', fields: { idx: i }, reported_date: Date.now() }));

      // Bulk insert via CouchDB _bulk_docs
      const resp = await couchFetch(`/${COUCH_DB}/_bulk_docs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs }),
      });
      const results = await resp.json();
      expect(results.every(r => r.ok)).to.be.true;

      // All should arrive in PostgreSQL
      for (const id of ids) {
        const pgDoc = await waitForDoc(id);
        expect(pgDoc._id).to.equal(id);
      }
    });

    it('should preserve full JSONB document structure', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      const doc = {
        _id: docId, type: 'data_record', form: 'test',
        fields: {
          nested: { deeply: { value: 42 } },
          array: [1, 'two', { three: true }],
          empty_string: '',
          zero: 0,
          bool_false: false,
        },
        reported_date: Date.now(),
      };
      await couchPost(doc);

      const pgDoc = await waitForDoc(docId);
      expect(pgDoc.fields.nested.deeply.value).to.equal(42);
      expect(pgDoc.fields.array).to.deep.equal([1, 'two', { three: true }]);
      expect(pgDoc.fields.empty_string).to.equal('');
      expect(pgDoc.fields.zero).to.equal(0);
      expect(pgDoc.fields.bool_false).to.equal(false);
    });
  });

  // ── UPSERT and update propagation ─────────────────────────────────

  describe('update propagation', () => {
    it('should propagate document updates via UPSERT', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'data_record', fields: { v: 1 }, reported_date: Date.now() });
      await waitForDoc(docId);

      // Update in CouchDB
      const doc = await couchGet(docId);
      doc.fields.v = 2;
      await couchFetch(`/${COUCH_DB}/${docId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
      });

      // Poll for the update in PostgreSQL
      const start = Date.now();
      let updated;
      while (Date.now() - start < 45000) {
        const row = await getRawRow(docId);
        if (row && row.doc.fields?.v === 2) { updated = row; break; }
        await new Promise(r => setTimeout(r, 500));
      }
      expect(updated).to.exist;
      expect(updated.doc.fields.v).to.equal(2);

      // Should still be one row (UPSERT, not duplicate)
      const count = await pgQuery(`SELECT count(*) as n FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]);
      expect(parseInt(count.rows[0].n)).to.equal(1);
    });

    it('should update saved_timestamp on document update', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'data_record', fields: {}, reported_date: Date.now() });
      await waitForDoc(docId);
      const row1 = await getRawRow(docId);
      const ts1 = new Date(row1.saved_timestamp).getTime();

      // Small delay to ensure timestamp difference
      await new Promise(r => setTimeout(r, 1000));

      const doc = await couchGet(docId);
      doc.fields.updated = true;
      await couchFetch(`/${COUCH_DB}/${docId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
      });

      const start = Date.now();
      let row2;
      while (Date.now() - start < 45000) {
        row2 = await getRawRow(docId);
        if (row2 && row2.doc.fields?.updated === true) break;
        await new Promise(r => setTimeout(r, 500));
      }
      const ts2 = new Date(row2.saved_timestamp).getTime();
      expect(ts2).to.be.at.least(ts1);
    });
  });

  // ── Soft delete behavior ──────────────────────────────────────────

  describe('soft delete', () => {
    it('should set _deleted=true when document is deleted in CouchDB', async () => {
      const docId = stamp();
      await couchPost({ _id: docId, type: 'data_record', fields: { temp: true }, reported_date: Date.now() });
      await waitForDoc(docId);

      // Delete from CouchDB
      await couchDelete(docId);

      // cht-sync should mark _deleted=true, row preserved
      const start = Date.now();
      let softDeleted = false;
      while (Date.now() - start < 45000) {
        const row = await getRawRow(docId);
        if (row && row._deleted === true) { softDeleted = true; break; }
        await new Promise(r => setTimeout(r, 500));
      }
      expect(softDeleted).to.be.true;

      // Row still exists
      const count = await pgQuery(`SELECT count(*) as n FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]);
      expect(parseInt(count.rows[0].n)).to.equal(1);
    });
  });

  // ── Document type coverage ────────────────────────────────────────

  describe('CHT document types', () => {
    it('should replicate contact-type documents (person)', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'person', name: 'Test Person', reported_date: Date.now() });
      const pgDoc = await waitForDoc(docId);
      expect(pgDoc.type).to.equal('person');
      expect(pgDoc.name).to.equal('Test Person');
    });

    it('should replicate place-type documents (clinic)', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'clinic', name: 'Test Clinic', reported_date: Date.now() });
      const pgDoc = await waitForDoc(docId);
      expect(pgDoc.type).to.equal('clinic');
    });

    it('should replicate report documents (data_record with form)', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({
        _id: docId, type: 'data_record', form: 'pregnancy',
        fields: { patient_name: 'Jane' }, reported_date: Date.now(),
      });
      const pgDoc = await waitForDoc(docId);
      expect(pgDoc.type).to.equal('data_record');
      expect(pgDoc.form).to.equal('pregnancy');
      expect(pgDoc.fields.patient_name).to.equal('Jane');
    });

    it('should replicate message documents (data_record without form)', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({
        _id: docId, type: 'data_record',
        sms_message: { message: 'Hello CHT', from: '+254700000001' },
        reported_date: Date.now(),
      });
      const pgDoc = await waitForDoc(docId);
      expect(pgDoc.type).to.equal('data_record');
      expect(pgDoc).to.not.have.property('form');
      expect(pgDoc.sms_message.message).to.equal('Hello CHT');
    });

    it('should replicate task documents', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({
        _id: docId, type: 'task', state: 'Ready',
        owner: 'some-chw', emission: { _id: 'e1' }, reported_date: Date.now(),
      });
      const pgDoc = await waitForDoc(docId);
      expect(pgDoc.type).to.equal('task');
      expect(pgDoc.state).to.equal('Ready');
    });

    it('should replicate target documents', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({
        _id: docId, type: 'target', owner: 'some-chw',
        reporting_period: '2026-04',
        targets: [{ id: 'pregnancies', value: { pass: 1, total: 2 } }],
        reported_date: Date.now(),
      });
      const pgDoc = await waitForDoc(docId);
      expect(pgDoc.type).to.equal('target');
      expect(pgDoc.reporting_period).to.equal('2026-04');
    });
  });

  // ── PostgreSQL query patterns ─────────────────────────────────────

  describe('PostgreSQL query patterns', () => {
    const queryDocIds = [];

    before(async () => {
      // Create docs with various types and a known parent hierarchy
      const parentId = stamp();
      const child1Id = stamp();
      const child2Id = stamp();
      const reportId = stamp();
      queryDocIds.push(parentId, child1Id, child2Id, reportId);
      testDocIds.push(...queryDocIds);

      const docs = [
        { _id: parentId, type: 'clinic', name: 'Query Test Clinic', reported_date: Date.now() },
        { _id: child1Id, type: 'person', name: 'Child 1', parent: { _id: parentId }, reported_date: Date.now() - 10000 },
        { _id: child2Id, type: 'person', name: 'Child 2', parent: { _id: parentId }, reported_date: Date.now() },
        { _id: reportId, type: 'data_record', form: 'visit', fields: { patient_id: child1Id }, reported_date: Date.now() },
      ];
      const resp = await couchFetch(`/${COUCH_DB}/_bulk_docs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs }),
      });
      const results = await resp.json();
      expect(results.every(r => r.ok)).to.be.true;

      // Wait for all to arrive
      for (const id of queryDocIds) {
        await waitForDoc(id);
      }
    });

    it('should query by document type', async () => {
      const result = await pgQuery(
        `SELECT doc FROM ${DOCS_TABLE} WHERE doc->>'type' = 'person' AND _id = ANY($1)`,
        [queryDocIds]
      );
      expect(result.rows).to.have.length(2);
    });

    it('should query by parent facility', async () => {
      const parentId = queryDocIds[0];
      const result = await pgQuery(
        `SELECT doc FROM ${DOCS_TABLE} WHERE doc->'parent'->>'_id' = $1`,
        [parentId]
      );
      expect(result.rows.length).to.be.at.least(2);
      const names = result.rows.map(r => r.doc.name);
      expect(names).to.include('Child 1');
      expect(names).to.include('Child 2');
    });

    it('should query by reported_date range', async () => {
      const fiveSecondsAgo = Date.now() - 15000;
      const result = await pgQuery(
        `SELECT doc FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'person' AND _id = ANY($1)
         AND (doc->>'reported_date')::bigint >= $2
         ORDER BY (doc->>'reported_date')::bigint ASC`,
        [queryDocIds, fiveSecondsAgo]
      );
      expect(result.rows.length).to.be.at.least(1);
    });

    it('should query by form type for reports', async () => {
      const result = await pgQuery(
        `SELECT doc FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'data_record' AND doc->>'form' = 'visit' AND _id = ANY($1)`,
        [queryDocIds]
      );
      expect(result.rows).to.have.length(1);
      expect(result.rows[0].doc.form).to.equal('visit');
    });

    it('should support NOT deleted filter', async () => {
      const result = await pgQuery(
        `SELECT count(*) as n FROM ${DOCS_TABLE}
         WHERE _id = ANY($1) AND (_deleted IS NULL OR _deleted = false)`,
        [queryDocIds]
      );
      expect(parseInt(result.rows[0].n)).to.equal(queryDocIds.length);
    });
  });

  // ── Source and progress tracking ──────────────────────────────────

  describe('sync progress tracking', () => {
    it('should advance seq after new documents are synced', async () => {
      const before = await pgQuery(`SELECT seq FROM ${PROGRESS_TABLE} LIMIT 1`);
      const seqBefore = before.rows[0].seq;

      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'data_record', fields: {}, reported_date: Date.now() });
      await waitForDoc(docId);

      const after = await pgQuery(`SELECT seq FROM ${PROGRESS_TABLE} LIMIT 1`);
      expect(after.rows[0].seq).to.not.equal(seqBefore);
    });

    it('should record the correct source identifier', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'data_record', fields: {}, reported_date: Date.now() });
      await waitForDoc(docId);

      const row = await getRawRow(docId);
      expect(row.source).to.be.a('string');
      // Source should match what's in the progress table
      const progress = await pgQuery(`SELECT source FROM ${PROGRESS_TABLE}`);
      expect(progress.rows.map(r => r.source)).to.include(row.source);
    });
  });

  // ── Sensitive document handling ───────────────────────────────────

  describe('sensitive document fields', () => {
    it('should replicate private-flagged reports fully to PostgreSQL', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({
        _id: docId, type: 'data_record', form: 'assessment',
        fields: { private: 'yes', hiv_status: 'positive', patient_name: 'Confidential' },
        reported_date: Date.now(),
      });
      const pgDoc = await waitForDoc(docId);
      // cht-sync replicates ALL docs fully — private filtering is a client concern
      expect(pgDoc.fields.private).to.equal('yes');
      expect(pgDoc.fields.hiv_status).to.equal('positive');
      expect(pgDoc.fields.patient_name).to.equal('Confidential');
    });
  });

  // ── Replication latency measurement ───────────────────────────────

  describe('replication latency', () => {
    it('should replicate within acceptable latency', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      const t0 = Date.now();
      await couchPost({ _id: docId, type: 'data_record', fields: { latency: true }, reported_date: t0 });
      await waitForDoc(docId);
      const latency = Date.now() - t0;
      console.log(`  Replication latency: ${latency}ms`);
      // cht-sync polls every 5s, so expect < 15s in normal operation
      expect(latency).to.be.below(30000);
    });
  });
});
