/**
 * Sentinel PostgreSQL Transition Tests
 *
 * Validates that Sentinel document transitions (which currently process
 * documents via CouchDB changes feed) produce results that are correctly
 * replicated to PostgreSQL via cht-sync.
 *
 * Tests the critical path: document saved → Sentinel processes → updated doc → cht-sync → PostgreSQL
 *
 * Prerequisites: CouchDB, API, Sentinel, PostgreSQL, and cht-sync must be running.
 */
const utils = require('../../utils/agent-harness');
const sentinelUtils = require('@utils/sentinel');
const uuid = require('uuid').v4;
const { CONTACT_TYPES } = require('@medic/constants');

describe('Sentinel transitions in PostgreSQL', () => {
  const contacts = [
    {
      _id: 'pg-sentinel-district',
      name: 'PG Test District',
      type: 'district_hospital',
      reported_date: Date.now(),
    },
    {
      _id: 'pg-sentinel-health-center',
      name: 'PG Test Health Center',
      type: CONTACT_TYPES.HEALTH_CENTER,
      parent: { _id: 'pg-sentinel-district' },
      reported_date: Date.now(),
    },
    {
      _id: 'pg-sentinel-clinic',
      name: 'PG Test Clinic',
      type: 'clinic',
      parent: {
        _id: 'pg-sentinel-health-center',
        parent: { _id: 'pg-sentinel-district' },
      },
      contact: {
        _id: 'pg-sentinel-chw',
        parent: {
          _id: 'pg-sentinel-clinic',
          parent: {
            _id: 'pg-sentinel-health-center',
            parent: { _id: 'pg-sentinel-district' },
          },
        },
      },
      reported_date: Date.now(),
    },
    {
      _id: 'pg-sentinel-chw',
      name: 'PG Test CHW',
      type: 'person',
      patient_id: 'pg-sentinel-patient-shortcode',
      parent: {
        _id: 'pg-sentinel-clinic',
        parent: {
          _id: 'pg-sentinel-health-center',
          parent: { _id: 'pg-sentinel-district' },
        },
      },
      phone: '+254700000001',
      reported_date: Date.now(),
    },
  ];

  before(async () => {
    await utils.saveDocs(contacts);
  });

  after(async () => {
    await utils.revertDb([], true);
  });

  describe('update_clinics transition', () => {
    it('should process reports and replicate transition results to PostgreSQL', async function () {
      this.timeout(90000);

      // Enable update_clinics transition
      await utils.updateSettings({
        transitions: { update_clinics: true },
      }, { ignoreReload: true });

      // Submit a report from the CHW's phone number
      const reportId = uuid();
      const report = {
        _id: reportId,
        type: 'data_record',
        from: '+254700000001',
        fields: { patient_id: 'pg-sentinel-patient-shortcode' },
        reported_date: Date.now(),
      };

      await utils.saveDoc(report);

      // Wait for Sentinel to process the report
      await sentinelUtils.waitForSentinel(reportId);

      // Verify the transition was applied in CouchDB
      const processedDoc = await utils.getDoc(reportId);
      expect(processedDoc.contact).to.exist;

      // Wait for the processed doc to appear in PostgreSQL
      const pgDoc = await utils.waitForDocInPostgres(reportId, 45000);
      expect(pgDoc).to.exist;
      expect(pgDoc._id).to.equal(reportId);
      expect(pgDoc.type).to.equal('data_record');

      // The Sentinel-processed version should have contact info
      // (cht-sync should pick up the latest revision)
      // Poll until we get the version with contact field
      const maxWait = 30000;
      const start = Date.now();
      let foundProcessed = false;
      while (Date.now() - start < maxWait) {
        const result = await utils.pgQuery(
          'SELECT doc FROM couchdb WHERE doc_id = $1',
          [reportId]
        );
        if (result.rows.length > 0 && result.rows[0].doc.contact) {
          foundProcessed = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      expect(foundProcessed).to.be.true;
    });
  });

  describe('Sentinel info docs in PostgreSQL', () => {
    it('should replicate sentinel info docs to PostgreSQL', async function () {
      this.timeout(90000);

      const reportId = uuid();
      const report = {
        _id: reportId,
        type: 'data_record',
        from: '+254700000001',
        fields: { patient_id: 'pg-sentinel-patient-shortcode' },
        reported_date: Date.now(),
      };

      await utils.saveDoc(report);
      await sentinelUtils.waitForSentinel(reportId);

      // Info docs are stored in medic-sentinel database
      const infoDoc = await sentinelUtils.getInfoDoc(reportId);
      expect(infoDoc).to.exist;
      expect(infoDoc.transitions).to.exist;

      // Verify the main document is in PostgreSQL
      const pgDoc = await utils.waitForDocInPostgres(reportId, 45000);
      expect(pgDoc).to.exist;
    });
  });

  describe('changes detection for Sentinel processing', () => {
    it('should track document sequence numbers for change detection', async function () {
      this.timeout(60000);

      const docId = uuid();
      const doc = {
        _id: docId,
        type: 'data_record',
        from: '+254700000001',
        fields: {},
        reported_date: Date.now(),
      };

      await utils.saveDoc(doc);
      await utils.waitForDocInPostgres(docId, 45000);

      // The couchdb table should have a seq value that can be used for change detection
      const result = await utils.pgQuery(
        'SELECT seq, saved_timestamp FROM couchdb WHERE doc_id = $1',
        [docId]
      );
      expect(result.rows).to.have.length(1);
      expect(result.rows[0].seq).to.exist;
      expect(result.rows[0].saved_timestamp).to.exist;

      // After updating the doc, the seq should change
      const savedDoc = await utils.getDoc(docId);
      savedDoc.fields.updated = true;
      await utils.saveDoc(savedDoc);

      // Wait for the update to propagate
      const startTime = Date.now();
      const originalSeq = result.rows[0].seq;
      let newSeq;
      while (Date.now() - startTime < 45000) {
        const updated = await utils.pgQuery(
          'SELECT seq FROM couchdb WHERE doc_id = $1',
          [docId]
        );
        if (updated.rows.length > 0 && updated.rows[0].seq !== originalSeq) {
          newSeq = updated.rows[0].seq;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      expect(newSeq).to.exist;
      expect(newSeq).to.not.equal(originalSeq);
    });
  });
});
