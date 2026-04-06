/**
 * cht-datasource PostgreSQL Adapter Integration Tests
 *
 * These tests validate that documents created via the CHT API are:
 * 1. Accessible via the standard cht-datasource remote API
 * 2. Replicated to PostgreSQL via cht-sync
 * 3. Queryable in PostgreSQL by type, facility, and reported_date
 *
 * Prerequisites: CouchDB, API, PostgreSQL, and cht-sync must be running.
 */
const utils = require('../../utils/agent-harness');
const personFactory = require('@factories/cht/contacts/person');
const placeFactory = require('@factories/cht/contacts/place');
const { getRemoteDataContext, Qualifier } = require('@medic/cht-datasource');

describe('cht-datasource PostgreSQL adapter', () => {
  const dataContext = getRemoteDataContext(utils.getOrigin());

  // Test hierarchy: district > health_center > clinic > patients
  const placeMap = placeFactory.generateHierarchy();
  const district = placeMap.get('district_hospital');
  const healthCenter = {
    ...placeMap.get('health_center'),
    parent: { _id: district._id },
  };
  const clinic = {
    ...placeMap.get('clinic'),
    parent: { _id: healthCenter._id, parent: { _id: district._id } },
  };

  const patient1 = personFactory.build({
    name: 'pg-test-patient-1',
    role: 'patient',
    parent: {
      _id: clinic._id,
      parent: { _id: healthCenter._id, parent: { _id: district._id } },
    },
    reported_date: Date.now() - 10000,
  });

  const patient2 = personFactory.build({
    name: 'pg-test-patient-2',
    role: 'patient',
    parent: {
      _id: clinic._id,
      parent: { _id: healthCenter._id, parent: { _id: district._id } },
    },
    reported_date: Date.now(),
  });

  const allDocs = [district, healthCenter, clinic, patient1, patient2];

  before(async () => {
    await utils.saveDocs(allDocs);
  });

  after(async () => {
    await utils.deleteDocs(allDocs.map(d => d._id));
  });

  describe('CRUD operations via remote cht-datasource', () => {
    it('should retrieve a person by UUID', async () => {
      const result = await dataContext.v1.person.get(Qualifier.byUuid(patient1._id));
      expect(result).to.exist;
      expect(result._id).to.equal(patient1._id);
      expect(result.name).to.equal('pg-test-patient-1');
    });

    it('should retrieve a place by UUID', async () => {
      const result = await dataContext.v1.place.get(Qualifier.byUuid(clinic._id));
      expect(result).to.exist;
      expect(result._id).to.equal(clinic._id);
    });

    it('should retrieve a person with lineage', async () => {
      const result = await dataContext.v1.person.getWithLineage(Qualifier.byUuid(patient1._id));
      expect(result).to.exist;
      expect(result._id).to.equal(patient1._id);
      expect(result.parent).to.exist;
      expect(result.parent._id).to.equal(clinic._id);
    });

    it('should page through contacts by type', async () => {
      const qualifier = Qualifier.byContactType('person');
      const page = await dataContext.v1.contact.getUuidsPage(qualifier, undefined, 100);
      expect(page).to.exist;
      expect(page.data).to.be.an('array');
      // Our test patients should be in the results
      const ids = page.data.map(d => d);
      expect(ids).to.include(patient1._id);
      expect(ids).to.include(patient2._id);
    });
  });

  describe('PostgreSQL replication via cht-sync', () => {
    it('should replicate documents to PostgreSQL', async function () {
      this.timeout(60000);
      // Wait for patient1 to appear in PostgreSQL
      const doc = await utils.waitForDocInPostgres(patient1._id, 45000);
      expect(doc).to.exist;
      expect(doc._id).to.equal(patient1._id);
      expect(doc.name).to.equal('pg-test-patient-1');
      expect(doc.type).to.equal('person');
    });

    it('should replicate all test documents', async function () {
      this.timeout(60000);
      // Verify all docs made it to PostgreSQL
      for (const testDoc of allDocs) {
        const pgDoc = await utils.waitForDocInPostgres(testDoc._id, 45000);
        expect(pgDoc).to.exist;
        expect(pgDoc._id).to.equal(testDoc._id);
      }
    });

    it('should preserve document structure in JSONB', async function () {
      this.timeout(60000);
      const pgDoc = await utils.waitForDocInPostgres(patient1._id, 45000);
      // Verify hierarchical parent structure is preserved
      expect(pgDoc.parent).to.exist;
      expect(pgDoc.parent._id).to.equal(clinic._id);
      expect(pgDoc.parent.parent).to.exist;
      expect(pgDoc.parent.parent._id).to.equal(healthCenter._id);
    });
  });

  describe('PostgreSQL queries by type', () => {
    before(async function () {
      this.timeout(60000);
      // Ensure all docs are replicated before running queries
      for (const testDoc of allDocs) {
        await utils.waitForDocInPostgres(testDoc._id, 45000);
      }
    });

    it('should query persons by type', async () => {
      const persons = await utils.getPostgresDocsByType('person');
      expect(persons).to.be.an('array');
      const ids = persons.map(d => d._id);
      expect(ids).to.include(patient1._id);
      expect(ids).to.include(patient2._id);
    });

    it('should query places by type', async () => {
      const clinics = await utils.getPostgresDocsByType('clinic');
      expect(clinics).to.be.an('array');
      const ids = clinics.map(d => d._id);
      expect(ids).to.include(clinic._id);
    });

    it('should query by facility via parent hierarchy', async () => {
      const docs = await utils.getPostgresDocsByFacility(clinic._id);
      expect(docs).to.be.an('array');
      // Patients with parent._id = clinic._id should appear
      const ids = docs.map(d => d._id);
      expect(ids).to.include(patient1._id);
      expect(ids).to.include(patient2._id);
    });
  });

  describe('PostgreSQL queries by reported_date', () => {
    before(async function () {
      this.timeout(60000);
      for (const testDoc of allDocs) {
        await utils.waitForDocInPostgres(testDoc._id, 45000);
      }
    });

    it('should query documents by reported_date range', async () => {
      const tenSecondsAgo = Date.now() - 15000;
      const result = await utils.pgQuery(
        `SELECT doc FROM couchdb
         WHERE doc->>'type' = 'person'
         AND (doc->>'reported_date')::bigint >= $1
         AND doc->>'_id' IN ($2, $3)
         ORDER BY (doc->>'reported_date')::bigint ASC`,
        [tenSecondsAgo, patient1._id, patient2._id]
      );
      expect(result.rows).to.have.length(2);
      expect(result.rows[0].doc._id).to.equal(patient1._id);
      expect(result.rows[1].doc._id).to.equal(patient2._id);
    });

    it('should support date-filtered queries for recent documents', async () => {
      const fiveSecondsAgo = Date.now() - 5000;
      const result = await utils.pgQuery(
        `SELECT doc FROM couchdb
         WHERE doc->>'type' = 'person'
         AND (doc->>'reported_date')::bigint >= $1
         AND doc->>'_id' IN ($2, $3)`,
        [fiveSecondsAgo, patient1._id, patient2._id]
      );
      // patient2 has the more recent reported_date
      const ids = result.rows.map(r => r.doc._id);
      expect(ids).to.include(patient2._id);
    });
  });

  describe('PostgreSQL changes detection', () => {
    it('should detect document updates via saved_timestamp', async function () {
      this.timeout(60000);

      // Record timestamp before update
      const beforeUpdate = new Date().toISOString();

      // Update a document
      const doc = await utils.getDoc(patient1._id);
      doc.name = 'pg-test-patient-1-updated';
      await utils.saveDoc(doc);

      // Wait for the update to propagate to PostgreSQL
      const maxWait = 45000;
      const start = Date.now();
      let found = false;
      while (Date.now() - start < maxWait) {
        const result = await utils.pgQuery(
          `SELECT doc, saved_timestamp FROM couchdb
           WHERE doc_id = $1 AND saved_timestamp > $2`,
          [patient1._id, beforeUpdate]
        );
        if (result.rows.length > 0 && result.rows[0].doc.name === 'pg-test-patient-1-updated') {
          found = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      expect(found).to.be.true;
    });

    it('should track sequence numbers for change detection', async function () {
      this.timeout(30000);
      // The couchdb table tracks seq for each document
      const result = await utils.pgQuery(
        'SELECT seq FROM couchdb WHERE doc_id = $1 LIMIT 1',
        [patient1._id]
      );
      expect(result.rows).to.have.length(1);
      expect(result.rows[0].seq).to.exist;
    });
  });
});
