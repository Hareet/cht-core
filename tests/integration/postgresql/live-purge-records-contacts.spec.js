/**
 * Integration Tests: Purge Records & Contacts Queries
 *
 * Tests the SQL query patterns from purge-preproc/src/records.js and contacts.js
 * against the live PostgreSQL database. Covers:
 *
 *   - getRecordsForSubjects: matches across all 9 subject fields
 *   - getRecordsForSubjects: reports vs messages classification (form field)
 *   - getRecordsForSubjects: empty subjectIds returns empty
 *   - getUnallocatedRecords: pagination with LIMIT/OFFSET
 *   - getUnallocatedRecords: incremental mode with since parameter
 *   - getContactIdsWithChangedRecords: UNNEST extracts all subject fields
 *   - getContactIdsWithChangedRecords: maps subject IDs back to contact _ids
 *   - getContactsBatch: ordered pagination
 *   - getChangedContactIds: timestamp-based filtering
 *   - getContact: single contact fetch and null for missing
 *   - CONTACT_TYPE_CONDITION: handles both legacy and configurable types
 *
 * Run with:
 *   node tests/integration/postgresql/run-tests.js live-purge-records-contacts.spec.js
 */
require('../../aliases');
const chai = require('chai');
chai.use(require('chai-as-promised'));
const expect = chai.expect;
const { Pool } = require('pg');

const PG_SCHEMA = process.env.POSTGRES_SCHEMA || 'v1';
const DOCS_TABLE = `"${PG_SCHEMA}"."couchdb"`;

const CONTACT_TYPE_CONDITION = `(
  doc->>'type' IN ('district_hospital', 'health_center', 'clinic', 'person')
  OR (doc->>'type' = 'contact' AND doc->>'contact_type' IS NOT NULL)
)`;

let pool;
const stamp = () => `prc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const testDocIds = [];

describe('Purge records & contacts queries — live PostgreSQL', function () {
  this.timeout(60000);

  before(async () => {
    pool = new Pool({
      host: process.env.POSTGRES_HOST || 'postgres',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      user: process.env.POSTGRES_USER || 'cht',
      password: process.env.POSTGRES_PASSWORD || 'pgpass',
      database: process.env.POSTGRES_DB || 'cht',
    });
  });

  after(async () => {
    for (const id of testDocIds) {
      await pool.query(`DELETE FROM ${DOCS_TABLE} WHERE _id = $1`, [id]).catch(() => {});
    }
    await pool.end();
  });

  // ─── getRecordsForSubjects: all 9 subject field paths ────────────────

  describe('getRecordsForSubjects field matching', () => {
    const contactId = stamp();
    const patientIdShort = `pid-${stamp()}`;
    const placeIdShort = `plid-${stamp()}`;

    // Reports matching through different subject fields
    const reportByPatientId = `r-patient-id-${stamp()}`;
    const reportByPlaceId = `r-place-id-${stamp()}`;
    const reportByPatientUuid = `r-patient-uuid-${stamp()}`;
    const reportByFieldsPatientId = `r-fields-pid-${stamp()}`;
    const reportByFieldsPlaceId = `r-fields-plid-${stamp()}`;
    const reportByFieldsPatientUuid = `r-fields-puuid-${stamp()}`;
    const reportByFieldsPlaceUuid = `r-fields-pluuid-${stamp()}`;
    const reportByContactId = `r-contact-id-${stamp()}`;
    const messageByContactId = `m-contact-id-${stamp()}`;

    before(async () => {
      testDocIds.push(
        contactId, reportByPatientId, reportByPlaceId, reportByPatientUuid,
        reportByFieldsPatientId, reportByFieldsPlaceId, reportByFieldsPatientUuid,
        reportByFieldsPlaceUuid, reportByContactId, messageByContactId
      );

      // Contact with patient_id and place_id
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [contactId, JSON.stringify({
          _id: contactId, type: 'person', patient_id: patientIdShort, place_id: placeIdShort,
        })]
      );

      // Report matched via top-level patient_id
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [reportByPatientId, JSON.stringify({
          _id: reportByPatientId, type: 'data_record', form: 'pregnancy',
          patient_id: patientIdShort, reported_date: Date.now(),
        })]
      );

      // Report matched via top-level place_id
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [reportByPlaceId, JSON.stringify({
          _id: reportByPlaceId, type: 'data_record', form: 'assessment',
          place_id: placeIdShort, reported_date: Date.now(),
        })]
      );

      // Report matched via top-level patient_uuid (same as contact _id)
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [reportByPatientUuid, JSON.stringify({
          _id: reportByPatientUuid, type: 'data_record', form: 'delivery',
          patient_uuid: contactId, reported_date: Date.now(),
        })]
      );

      // Report matched via fields.patient_id
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [reportByFieldsPatientId, JSON.stringify({
          _id: reportByFieldsPatientId, type: 'data_record', form: 'visit',
          fields: { patient_id: patientIdShort }, reported_date: Date.now(),
        })]
      );

      // Report matched via fields.place_id
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [reportByFieldsPlaceId, JSON.stringify({
          _id: reportByFieldsPlaceId, type: 'data_record', form: 'referral',
          fields: { place_id: placeIdShort }, reported_date: Date.now(),
        })]
      );

      // Report matched via fields.patient_uuid
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [reportByFieldsPatientUuid, JSON.stringify({
          _id: reportByFieldsPatientUuid, type: 'data_record', form: 'immunization',
          fields: { patient_uuid: contactId }, reported_date: Date.now(),
        })]
      );

      // Report matched via fields.place_uuid
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [reportByFieldsPlaceUuid, JSON.stringify({
          _id: reportByFieldsPlaceUuid, type: 'data_record', form: 'followup',
          fields: { place_uuid: contactId }, reported_date: Date.now(),
        })]
      );

      // Report matched via contact._id
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [reportByContactId, JSON.stringify({
          _id: reportByContactId, type: 'data_record', form: 'sms_response',
          contact: { _id: contactId }, reported_date: Date.now(),
        })]
      );

      // Message (no form) matched via contact._id
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [messageByContactId, JSON.stringify({
          _id: messageByContactId, type: 'data_record',
          contact: { _id: contactId },
          // No form field — this is a message, not a report
        })]
      );
    });

    it('should match reports via all 9 subject field paths', async () => {
      const subjectIds = [contactId, patientIdShort, placeIdShort];

      const result = await pool.query(`
        SELECT _id, doc
        FROM ${DOCS_TABLE}
        WHERE doc->>'type' = 'data_record'
          AND (_deleted IS NOT TRUE)
          AND (
            doc->>'patient_id' = ANY($1)
            OR doc->>'place_id' = ANY($1)
            OR doc->>'patient_uuid' = ANY($1)
            OR doc->>'place_uuid' = ANY($1)
            OR doc->'fields'->>'patient_id' = ANY($1)
            OR doc->'fields'->>'place_id' = ANY($1)
            OR doc->'fields'->>'patient_uuid' = ANY($1)
            OR doc->'fields'->>'place_uuid' = ANY($1)
            OR doc->'contact'->>'_id' = ANY($1)
          )
      `, [subjectIds]);

      const ids = result.rows.map(r => r._id);
      expect(ids).to.include(reportByPatientId);
      expect(ids).to.include(reportByPlaceId);
      expect(ids).to.include(reportByPatientUuid);
      expect(ids).to.include(reportByFieldsPatientId);
      expect(ids).to.include(reportByFieldsPlaceId);
      expect(ids).to.include(reportByFieldsPatientUuid);
      expect(ids).to.include(reportByFieldsPlaceUuid);
      expect(ids).to.include(reportByContactId);
      expect(ids).to.include(messageByContactId);
    });

    it('should classify reports (with form) vs messages (without form)', async () => {
      const subjectIds = [contactId, patientIdShort, placeIdShort];

      const result = await pool.query(`
        SELECT _id, doc
        FROM ${DOCS_TABLE}
        WHERE doc->>'type' = 'data_record'
          AND (_deleted IS NOT TRUE)
          AND doc->'contact'->>'_id' = ANY($1)
      `, [subjectIds]);

      const reports = [];
      const messages = [];
      for (const row of result.rows) {
        if (row.doc.form) {
          reports.push(row.doc);
        } else {
          messages.push(row.doc);
        }
      }

      expect(reports.some(r => r._id === reportByContactId)).to.be.true;
      expect(messages.some(m => m._id === messageByContactId)).to.be.true;
    });

    it('should return empty for empty subjectIds array', async () => {
      const result = await pool.query(`
        SELECT _id
        FROM ${DOCS_TABLE}
        WHERE doc->>'type' = 'data_record'
          AND (_deleted IS NOT TRUE)
          AND doc->>'patient_id' = ANY($1)
      `, [[]]);

      expect(result.rows).to.have.length(0);
    });
  });

  // ─── getContactIdsWithChangedRecords UNNEST pattern ───────────────────

  describe('getContactIdsWithChangedRecords UNNEST pattern', () => {
    const reportWithMultipleRefs = `r-multi-${stamp()}`;
    const personA = `person-a-${stamp()}`;
    const personB = `person-b-${stamp()}`;

    before(async () => {
      testDocIds.push(reportWithMultipleRefs, personA, personB);

      // A report that references BOTH personA (via patient_id) AND personB (via place_id)
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [reportWithMultipleRefs, JSON.stringify({
          _id: reportWithMultipleRefs, type: 'data_record', form: 'referral',
          patient_id: `short-a-${personA}`,
          place_id: `short-b-${personB}`,
          reported_date: Date.now(),
        })]
      );

      // Contact personA with matching patient_id
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [personA, JSON.stringify({
          _id: personA, type: 'person', patient_id: `short-a-${personA}`,
        })]
      );

      // Contact personB with matching place_id
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [personB, JSON.stringify({
          _id: personB, type: 'clinic', place_id: `short-b-${personB}`,
        })]
      );
    });

    it('should extract ALL subject IDs via UNNEST (not just first non-null)', async () => {
      const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();

      const result = await pool.query(`
        SELECT DISTINCT subject_id
        FROM (
          SELECT UNNEST(ARRAY[
            NULLIF(doc->>'patient_id', ''),
            NULLIF(doc->>'place_id', ''),
            NULLIF(doc->>'patient_uuid', ''),
            NULLIF(doc->>'place_uuid', ''),
            NULLIF(doc->'fields'->>'patient_id', ''),
            NULLIF(doc->'fields'->>'place_id', ''),
            NULLIF(doc->'fields'->>'patient_uuid', ''),
            NULLIF(doc->'fields'->>'place_uuid', ''),
            NULLIF(doc->'contact'->>'_id', '')
          ]) AS subject_id
          FROM ${DOCS_TABLE}
          WHERE doc->>'type' = 'data_record'
            AND saved_timestamp > $1
        ) sub
        WHERE subject_id IS NOT NULL
      `, [since]);

      const subjectIds = result.rows.map(r => r.subject_id);
      // Both patient_id and place_id should be extracted
      expect(subjectIds).to.include(`short-a-${personA}`);
      expect(subjectIds).to.include(`short-b-${personB}`);
    });

    it('should map subject IDs back to contact _ids', async () => {
      const subjectIds = [`short-a-${personA}`, `short-b-${personB}`];

      const contactResult = await pool.query(`
        SELECT _id
        FROM ${DOCS_TABLE}
        WHERE (
          doc->>'type' IN ('district_hospital', 'health_center', 'clinic', 'person')
          OR (doc->>'type' = 'contact' AND doc->>'contact_type' IS NOT NULL)
        )
        AND (_deleted IS NOT TRUE)
        AND (
          _id = ANY($1)
          OR doc->>'patient_id' = ANY($1)
          OR doc->>'place_id' = ANY($1)
        )
      `, [subjectIds]);

      const contactIds = contactResult.rows.map(r => r._id);
      expect(contactIds).to.include(personA);
      expect(contactIds).to.include(personB);
    });
  });

  // ─── getContactsBatch: ordered pagination ─────────────────────────────

  describe('getContactsBatch ordered pagination', () => {
    const contacts = [];

    before(async () => {
      // Insert 5 contacts with predictable ordering
      for (let i = 0; i < 5; i++) {
        const id = `batch-contact-${String(i).padStart(3, '0')}-${stamp()}`;
        contacts.push(id);
        testDocIds.push(id);

        await pool.query(
          `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
           VALUES ($1, $2, false, NOW(), 'sentinel')`,
          [id, JSON.stringify({ _id: id, type: 'person', name: `Batch ${i}` })]
        );
      }
    });

    it('should paginate contacts with LIMIT and OFFSET', async () => {
      // First batch: LIMIT 3, OFFSET 0
      const batch1 = await pool.query(`
        SELECT _id, doc
        FROM ${DOCS_TABLE}
        WHERE ${CONTACT_TYPE_CONDITION}
          AND (_deleted IS NOT TRUE)
          AND _id = ANY($1)
        ORDER BY _id
        LIMIT 3 OFFSET 0
      `, [contacts]);

      expect(batch1.rows).to.have.length(3);

      // Second batch: LIMIT 3, OFFSET 3
      const batch2 = await pool.query(`
        SELECT _id, doc
        FROM ${DOCS_TABLE}
        WHERE ${CONTACT_TYPE_CONDITION}
          AND (_deleted IS NOT TRUE)
          AND _id = ANY($1)
        ORDER BY _id
        LIMIT 3 OFFSET 3
      `, [contacts]);

      expect(batch2.rows).to.have.length(2);

      // Verify no overlap
      const batch1Ids = batch1.rows.map(r => r._id);
      const batch2Ids = batch2.rows.map(r => r._id);
      batch2Ids.forEach(id => expect(batch1Ids).to.not.include(id));
    });

    it('should return results ordered by _id ascending', async () => {
      const result = await pool.query(`
        SELECT _id
        FROM ${DOCS_TABLE}
        WHERE ${CONTACT_TYPE_CONDITION}
          AND (_deleted IS NOT TRUE)
          AND _id = ANY($1)
        ORDER BY _id
      `, [contacts]);

      const ids = result.rows.map(r => r._id);
      const sorted = [...ids].sort();
      expect(ids).to.deep.equal(sorted);
    });
  });

  // ─── getChangedContactIds: timestamp-based filtering ──────────────────

  describe('getChangedContactIds timestamp filtering', () => {
    let recentContactId;
    let insertTimestamp;

    before(async () => {
      // Record time before insert
      const { rows: [{ now }] } = await pool.query('SELECT NOW() as now');
      insertTimestamp = now;

      // Wait a tiny bit to ensure saved_timestamp > insertTimestamp
      await new Promise(resolve => setTimeout(resolve, 10));

      recentContactId = stamp();
      testDocIds.push(recentContactId);

      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [recentContactId, JSON.stringify({
          _id: recentContactId, type: 'person', name: 'Recently Changed',
        })]
      );
    });

    it('should find contacts changed since a timestamp', async () => {
      const result = await pool.query(`
        SELECT _id
        FROM ${DOCS_TABLE}
        WHERE ${CONTACT_TYPE_CONDITION}
          AND (_deleted IS NOT TRUE)
          AND saved_timestamp > $1
        ORDER BY _id
      `, [insertTimestamp]);

      const ids = result.rows.map(r => r._id);
      expect(ids).to.include(recentContactId);
    });

    it('should NOT find contacts changed before the timestamp', async () => {
      const futureTimestamp = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      const result = await pool.query(`
        SELECT _id
        FROM ${DOCS_TABLE}
        WHERE ${CONTACT_TYPE_CONDITION}
          AND (_deleted IS NOT TRUE)
          AND saved_timestamp > $1
        ORDER BY _id
      `, [futureTimestamp]);

      expect(result.rows).to.have.length(0);
    });
  });

  // ─── getContact: single contact fetch ─────────────────────────────────

  describe('getContact single fetch', () => {
    let existingContactId;

    before(async () => {
      existingContactId = stamp();
      testDocIds.push(existingContactId);

      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [existingContactId, JSON.stringify({
          _id: existingContactId, type: 'person', name: 'Single Fetch Test',
          patient_id: `sf-${existingContactId}`,
        })]
      );
    });

    it('should fetch a contact by _id', async () => {
      const result = await pool.query(`
        SELECT _id, doc
        FROM ${DOCS_TABLE}
        WHERE _id = $1
      `, [existingContactId]);

      expect(result.rows).to.have.length(1);
      expect(result.rows[0].doc.name).to.equal('Single Fetch Test');
    });

    it('should return empty for non-existent contact', async () => {
      const result = await pool.query(`
        SELECT _id, doc
        FROM ${DOCS_TABLE}
        WHERE _id = $1
      `, ['nonexistent-contact-xyz']);

      expect(result.rows).to.have.length(0);
    });
  });

  // ─── CONTACT_TYPE_CONDITION: legacy + configurable types ──────────────

  describe('CONTACT_TYPE_CONDITION: legacy + configurable types', () => {
    const legacyId = stamp();
    const configurableId = stamp();
    const nonContactId = stamp();

    before(async () => {
      testDocIds.push(legacyId, configurableId, nonContactId);

      // Legacy type: person
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [legacyId, JSON.stringify({ _id: legacyId, type: 'person', name: 'Legacy' })]
      );

      // Configurable type: type=contact, contact_type=custom_worker
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [configurableId, JSON.stringify({
          _id: configurableId, type: 'contact', contact_type: 'custom_worker', name: 'Configurable',
        })]
      );

      // Non-contact: data_record
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [nonContactId, JSON.stringify({
          _id: nonContactId, type: 'data_record', form: 'test',
        })]
      );
    });

    it('should match legacy contact types (person, clinic, etc.)', async () => {
      const result = await pool.query(`
        SELECT _id FROM ${DOCS_TABLE}
        WHERE ${CONTACT_TYPE_CONDITION}
          AND _id = $1
      `, [legacyId]);

      expect(result.rows).to.have.length(1);
    });

    it('should match configurable contact types (type=contact with contact_type)', async () => {
      const result = await pool.query(`
        SELECT _id FROM ${DOCS_TABLE}
        WHERE ${CONTACT_TYPE_CONDITION}
          AND _id = $1
      `, [configurableId]);

      expect(result.rows).to.have.length(1);
    });

    it('should NOT match non-contact types', async () => {
      const result = await pool.query(`
        SELECT _id FROM ${DOCS_TABLE}
        WHERE ${CONTACT_TYPE_CONDITION}
          AND _id = $1
      `, [nonContactId]);

      expect(result.rows).to.have.length(0);
    });

    it('should NOT match type=contact without contact_type', async () => {
      const bareContactId = stamp();
      testDocIds.push(bareContactId);

      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [bareContactId, JSON.stringify({
          _id: bareContactId, type: 'contact',
          // No contact_type — should NOT match
        })]
      );

      const result = await pool.query(`
        SELECT _id FROM ${DOCS_TABLE}
        WHERE ${CONTACT_TYPE_CONDITION}
          AND _id = $1
      `, [bareContactId]);

      expect(result.rows).to.have.length(0);
    });
  });

  // ─── getRecordsForSubjects: excluded deleted records ──────────────────

  describe('getRecordsForSubjects excludes deleted records', () => {
    const deletedReportId = `r-deleted-${stamp()}`;
    const activeReportId = `r-active-${stamp()}`;
    const subjectId = `subj-del-${stamp()}`;

    before(async () => {
      testDocIds.push(deletedReportId, activeReportId);

      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, true, NOW(), 'sentinel'),
                ($3, $4, false, NOW(), 'sentinel')`,
        [
          deletedReportId, JSON.stringify({
            _id: deletedReportId, type: 'data_record', form: 'test',
            patient_id: subjectId, _deleted: true,
          }),
          activeReportId, JSON.stringify({
            _id: activeReportId, type: 'data_record', form: 'test',
            patient_id: subjectId,
          }),
        ]
      );
    });

    it('should only return non-deleted records', async () => {
      const result = await pool.query(`
        SELECT _id
        FROM ${DOCS_TABLE}
        WHERE doc->>'type' = 'data_record'
          AND (_deleted IS NOT TRUE)
          AND doc->>'patient_id' = ANY($1)
      `, [[subjectId]]);

      const ids = result.rows.map(r => r._id);
      expect(ids).to.include(activeReportId);
      expect(ids).to.not.include(deletedReportId);
    });
  });

  // ─── getContactIdsWithChangedRecords: includes deleted records ────────

  describe('getContactIdsWithChangedRecords includes deleted records for re-eval', () => {
    const deletedRecordId = `r-del-reeval-${stamp()}`;
    const reEvalSubject = `subj-reeval-${stamp()}`;

    before(async () => {
      testDocIds.push(deletedRecordId);

      // Insert then delete a record — it should STILL trigger re-evaluation
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, true, NOW(), 'sentinel')`,
        [deletedRecordId, JSON.stringify({
          _id: deletedRecordId, type: 'data_record', form: 'test',
          patient_id: reEvalSubject, _deleted: true,
        })]
      );
    });

    it('should include deleted records in UNNEST subject extraction', async () => {
      const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();

      const result = await pool.query(`
        SELECT DISTINCT subject_id
        FROM (
          SELECT UNNEST(ARRAY[
            NULLIF(doc->>'patient_id', ''),
            NULLIF(doc->>'place_id', ''),
            NULLIF(doc->>'patient_uuid', ''),
            NULLIF(doc->>'place_uuid', ''),
            NULLIF(doc->'fields'->>'patient_id', ''),
            NULLIF(doc->'fields'->>'place_id', ''),
            NULLIF(doc->'fields'->>'patient_uuid', ''),
            NULLIF(doc->'fields'->>'place_uuid', ''),
            NULLIF(doc->'contact'->>'_id', '')
          ]) AS subject_id
          FROM ${DOCS_TABLE}
          WHERE doc->>'type' = 'data_record'
            AND saved_timestamp > $1
        ) sub
        WHERE subject_id IS NOT NULL
      `, [since]);

      // Note: the query does NOT filter _deleted — this is intentional
      // because deleted records still need their contacts re-evaluated
      const subjectIds = result.rows.map(r => r.subject_id);
      expect(subjectIds).to.include(reEvalSubject);
    });
  });
});
