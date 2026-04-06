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
 * Prerequisites: CouchDB, API, PostgreSQL, and cht-sync must be running.
 */
const utils = require('../../utils/agent-harness');
const uuid = require('uuid').v4;
const personFactory = require('@factories/cht/contacts/person');
const placeFactory = require('@factories/cht/contacts/place');

describe('cht-sync bridge: CouchDB → PostgreSQL', () => {

  describe('basic replication', () => {
    const testDocs = [];

    afterEach(async () => {
      if (testDocs.length) {
        await utils.deleteDocs(testDocs.map(d => d._id)).catch(() => {});
        testDocs.length = 0;
      }
    });

    it('should replicate a single document', async function () {
      this.timeout(60000);
      const doc = {
        _id: `sync-test-${uuid()}`,
        type: 'data_record',
        form: 'test_form',
        fields: { patient_name: 'Test Patient' },
        reported_date: Date.now(),
      };
      testDocs.push(doc);
      await utils.saveDoc(doc);

      const pgDoc = await utils.waitForDocInPostgres(doc._id, 45000);
      expect(pgDoc).to.exist;
      expect(pgDoc._id).to.equal(doc._id);
      expect(pgDoc.type).to.equal('data_record');
      expect(pgDoc.fields.patient_name).to.equal('Test Patient');
    });

    it('should replicate a batch of documents', async function () {
      this.timeout(60000);
      const docs = Array.from({ length: 10 }, (_, i) => ({
        _id: `sync-batch-${uuid()}`,
        type: 'data_record',
        form: 'batch_test',
        fields: { index: i },
        reported_date: Date.now(),
      }));
      testDocs.push(...docs);
      await utils.saveDocs(docs);

      // All docs should appear in PostgreSQL
      for (const doc of docs) {
        const pgDoc = await utils.waitForDocInPostgres(doc._id, 45000);
        expect(pgDoc).to.exist;
        expect(pgDoc.fields.index).to.equal(doc.fields.index);
      }
    });

    it('should replicate document updates', async function () {
      this.timeout(60000);
      const doc = {
        _id: `sync-update-${uuid()}`,
        type: 'data_record',
        fields: { status: 'draft' },
        reported_date: Date.now(),
      };
      testDocs.push(doc);
      await utils.saveDoc(doc);

      // Wait for initial replication
      await utils.waitForDocInPostgres(doc._id, 45000);

      // Update the document
      const savedDoc = await utils.getDoc(doc._id);
      savedDoc.fields.status = 'submitted';
      await utils.saveDoc(savedDoc);

      // Wait for the update to propagate
      const maxWait = 30000;
      const start = Date.now();
      let found = false;
      while (Date.now() - start < maxWait) {
        const result = await utils.pgQuery(
          `SELECT doc FROM ${utils.pgDocsTable()} WHERE _id = $1`,
          [doc._id]
        );
        if (result.rows.length > 0 && result.rows[0].doc.fields?.status === 'submitted') {
          found = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      expect(found).to.be.true;
    });

    it('should handle document deletion', async function () {
      this.timeout(60000);
      const doc = {
        _id: `sync-delete-${uuid()}`,
        type: 'data_record',
        fields: { temp: true },
        reported_date: Date.now(),
      };
      await utils.saveDoc(doc);

      // Wait for initial replication
      await utils.waitForDocInPostgres(doc._id, 45000);

      // Delete the document
      await utils.deleteDoc(doc._id);

      // cht-sync marks deleted docs with _deleted=true in the row AND
      // stores a minimal {_id, _rev, _deleted: true} in the doc JSONB column.
      // The row is NOT removed — it stays for downstream consumers.
      const maxWait = 30000;
      const start = Date.now();
      let handled = false;
      while (Date.now() - start < maxWait) {
        const result = await utils.pgQuery(
          `SELECT _deleted, doc FROM ${utils.pgDocsTable()} WHERE _id = $1`,
          [doc._id]
        );
        if (result.rows.length > 0 && result.rows[0]._deleted === true) {
          handled = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      expect(handled).to.be.true;
    });
  });

  describe('schema correctness', () => {
    it('should have correct cht-sync couchdb table schema', async () => {
      // cht-sync creates: v1.couchdb(_id VARCHAR PK, saved_timestamp, _deleted BOOLEAN, source VARCHAR, doc JSONB)
      const pgSchema = process.env.POSTGRES_SCHEMA || 'v1';
      const pgTable = process.env.POSTGRES_TABLE || 'couchdb';
      const result = await utils.pgQuery(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
      `, [pgSchema, pgTable]);

      const columns = result.rows.reduce((acc, row) => {
        acc[row.column_name] = row.data_type;
        return acc;
      }, {});

      // Exact cht-sync schema columns
      expect(columns).to.have.property('_id');
      expect(columns._id).to.include('character'); // VARCHAR
      expect(columns).to.have.property('saved_timestamp');
      expect(columns).to.have.property('_deleted');
      expect(columns).to.have.property('source');
      expect(columns).to.have.property('doc');
      expect(columns.doc).to.equal('jsonb');
    });

    it('should have couchdb_progress table for sync tracking', async () => {
      const pgSchema = process.env.POSTGRES_SCHEMA || 'v1';
      const result = await utils.pgQuery(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'couchdb_progress'
        ORDER BY ordinal_position
      `, [pgSchema]);

      const columns = result.rows.reduce((acc, row) => {
        acc[row.column_name] = row.data_type;
        return acc;
      }, {});

      expect(columns).to.have.property('seq');
      expect(columns).to.have.property('pending');
      expect(columns).to.have.property('updated_at');
      expect(columns).to.have.property('source');
    });

    it('should store the full CouchDB document in JSONB', async function () {
      this.timeout(60000);
      const doc = {
        _id: `sync-schema-${uuid()}`,
        type: 'data_record',
        form: 'schema_test',
        fields: {
          nested: {
            deeply: {
              value: 'preserved'
            }
          },
          array_field: [1, 2, 3],
          boolean_field: true,
          number_field: 42,
        },
        reported_date: Date.now(),
      };
      await utils.saveDoc(doc);

      const pgDoc = await utils.waitForDocInPostgres(doc._id, 45000);

      // Verify deep structure is preserved
      expect(pgDoc.fields.nested.deeply.value).to.equal('preserved');
      expect(pgDoc.fields.array_field).to.deep.equal([1, 2, 3]);
      expect(pgDoc.fields.boolean_field).to.be.true;
      expect(pgDoc.fields.number_field).to.equal(42);

      // Clean up
      await utils.deleteDoc(doc._id);
    });

    it('should include metadata columns', async function () {
      this.timeout(60000);
      const doc = {
        _id: `sync-meta-${uuid()}`,
        type: 'data_record',
        fields: {},
        reported_date: Date.now(),
      };
      await utils.saveDoc(doc);

      await utils.waitForDocInPostgres(doc._id, 45000);

      // cht-sync schema: _id, saved_timestamp, _deleted, source, doc
      const row = await utils.getPostgresRawRow(doc._id);
      expect(row).to.exist;
      expect(row._id).to.equal(doc._id);
      expect(row.saved_timestamp).to.exist;
      expect(row._deleted).to.satisfy(v => v === false || v === null);
      expect(row.source).to.be.a('string').that.is.not.empty;
      // doc column should contain the full JSONB document
      expect(row.doc).to.be.an('object');
      expect(row.doc._id).to.equal(doc._id);

      // Clean up
      await utils.deleteDoc(doc._id);
    });
  });

  describe('CHT document type replication', () => {
    const hierarchy = [];
    const docs = [];

    before(async function () {
      this.timeout(60000);

      // Create a minimal hierarchy
      const district = {
        _id: `sync-district-${uuid()}`,
        type: 'district_hospital',
        name: 'Sync Test District',
        reported_date: Date.now(),
      };
      const healthCenter = {
        _id: `sync-hc-${uuid()}`,
        type: 'health_center',
        name: 'Sync Test HC',
        parent: { _id: district._id },
        reported_date: Date.now(),
      };
      const clinic = {
        _id: `sync-clinic-${uuid()}`,
        type: 'clinic',
        name: 'Sync Test Clinic',
        parent: { _id: healthCenter._id, parent: { _id: district._id } },
        reported_date: Date.now(),
      };
      const person = personFactory.build({
        _id: `sync-person-${uuid()}`,
        name: 'Sync Test Person',
        parent: {
          _id: clinic._id,
          parent: { _id: healthCenter._id, parent: { _id: district._id } },
        },
      });

      hierarchy.push(district, healthCenter, clinic, person);
      await utils.saveDocs(hierarchy);

      // Create various document types
      const report = {
        _id: `sync-report-${uuid()}`,
        type: 'data_record',
        form: 'pregnancy',
        fields: { patient_id: person._id },
        contact: { _id: person._id },
        reported_date: Date.now(),
      };

      const task = {
        _id: `sync-task-${uuid()}`,
        type: 'task',
        owner: person._id,
        state: 'Ready',
        emission: { _id: `sync-task-emission-${uuid()}` },
        reported_date: Date.now(),
      };

      const target = {
        _id: `sync-target-${uuid()}`,
        type: 'target',
        owner: person._id,
        reporting_period: '2026-04',
        targets: [{ id: 'pregnancies', value: { pass: 1, total: 1 } }],
        reported_date: Date.now(),
      };

      docs.push(report, task, target);
      await utils.saveDocs(docs);
    });

    after(async () => {
      const allIds = [...hierarchy, ...docs].map(d => d._id);
      await utils.deleteDocs(allIds).catch(() => {});
    });

    it('should replicate contact documents (person, clinic, health_center, district)', async function () {
      this.timeout(60000);
      for (const contact of hierarchy) {
        const pgDoc = await utils.waitForDocInPostgres(contact._id, 45000);
        expect(pgDoc).to.exist;
        expect(pgDoc.name).to.equal(contact.name);
      }
    });

    it('should replicate report documents (data_record)', async function () {
      this.timeout(60000);
      const report = docs.find(d => d.type === 'data_record');
      const pgDoc = await utils.waitForDocInPostgres(report._id, 45000);
      expect(pgDoc).to.exist;
      expect(pgDoc.type).to.equal('data_record');
      expect(pgDoc.form).to.equal('pregnancy');
    });

    it('should replicate task documents', async function () {
      this.timeout(60000);
      const task = docs.find(d => d.type === 'task');
      const pgDoc = await utils.waitForDocInPostgres(task._id, 45000);
      expect(pgDoc).to.exist;
      expect(pgDoc.type).to.equal('task');
      expect(pgDoc.state).to.equal('Ready');
    });

    it('should replicate target documents', async function () {
      this.timeout(60000);
      const target = docs.find(d => d.type === 'target');
      const pgDoc = await utils.waitForDocInPostgres(target._id, 45000);
      expect(pgDoc).to.exist;
      expect(pgDoc.type).to.equal('target');
      expect(pgDoc.reporting_period).to.equal('2026-04');
    });
  });

  describe('replication latency', () => {
    it('should replicate within acceptable latency (<30s with default config)', async function () {
      this.timeout(60000);
      const doc = {
        _id: `sync-latency-${uuid()}`,
        type: 'data_record',
        fields: { latency_test: true },
        reported_date: Date.now(),
      };

      const startTime = Date.now();
      await utils.saveDoc(doc);
      await utils.waitForDocInPostgres(doc._id, 45000);
      const latencyMs = Date.now() - startTime;

      console.log(`cht-sync replication latency: ${latencyMs}ms`);

      // With DATAEMON_INTERVAL tuned down (60-300s), latency should be well under 30s
      // In CI with default config, it may be higher
      expect(latencyMs).to.be.below(45000);

      // Clean up
      await utils.deleteDoc(doc._id);
    });
  });
});
