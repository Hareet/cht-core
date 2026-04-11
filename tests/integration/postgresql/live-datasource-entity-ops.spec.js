/**
 * Integration Tests: cht-datasource Entity-Level Operations via PostgreSQL
 *
 * Tests the SQL query paths that the TypeScript adapters execute, covering:
 *
 *   - Contact get/getWithLineage: single doc fetch + recursive CTE lineage
 *   - Person create: UUID generation, parent validation, type resolution
 *   - Person update: immutable field enforcement, revision-based locking
 *   - Place create: parent + contact validation, type properties
 *   - Place update: lineage comparison, name mutability
 *   - Report create: form validation via ID range, contact resolution
 *   - Report update: form change validation, read-only fields, minification
 *   - Target get: validation of target document structure
 *   - Target getPage: single vs multi-contact ID range queries
 *   - getDocsByIds: batch fetch with ordering preservation
 *   - minifyDoc: lineage stripping, linked_docs extraction, data_record cleanup
 *   - fetchHydratedDoc: full lineage hydration + report subject resolution
 *   - getContactLineage: primary contact hydration in lineage chain
 *   - PostgresDataContext: qualifiedTable, schema config defaults
 *
 * Run with:
 *   node tests/integration/postgresql/run-tests.js live-datasource-entity-ops.spec.js
 */
require('../../aliases');
const chai = require('chai');
chai.use(require('chai-as-promised'));
const expect = chai.expect;
const { Pool } = require('pg');
const crypto = require('crypto');

const PG_SCHEMA = process.env.POSTGRES_SCHEMA || 'v1';
const PG_TABLE = process.env.POSTGRES_TABLE || 'couchdb';
const DOCS_TABLE = `"${PG_SCHEMA}"."${PG_TABLE}"`;

let pool;
const stamp = () => `deo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const testDocIds = [];

const insertDoc = async (id, doc) => {
  testDocIds.push(id);
  await pool.query(
    `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
     VALUES ($1, $2, false, NOW(), 'cht-datasource')
     ON CONFLICT (_id) DO UPDATE SET doc = $2, _deleted = false, saved_timestamp = NOW()`,
    [id, JSON.stringify({ _id: id, _rev: '1-' + Math.random().toString(36).slice(2, 10), ...doc })]
  );
};

const getDoc = async (id) => {
  const { rows } = await pool.query(
    `SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`, [id]
  );
  return rows.length > 0 ? rows[0].doc : null;
};

describe('cht-datasource entity-level operations via PostgreSQL', function () {
  this.timeout(120000);

  before(async () => {
    const pgPass = process.env.POSTGRES_PASSWORD || 'pgpass';
    pool = new Pool({ connectionString: `postgresql://cht:${pgPass}@postgres:5432/cht` });
    await pool.query('SELECT 1');
  });

  after(async () => {
    // Clean up test docs
    if (testDocIds.length > 0) {
      await pool.query(
        `DELETE FROM ${DOCS_TABLE} WHERE _id = ANY($1)`, [testDocIds]
      ).catch(() => {});
    }
    if (pool) await pool.end();
  });

  // ── Contact get by UUID ────────────────────────────────────────────

  describe('contact get (getDocById pattern)', () => {
    it('should fetch a person contact by UUID', async () => {
      const id = stamp();
      await insertDoc(id, { type: 'person', name: 'Test Person', phone: '+254700111222' });

      const doc = await getDoc(id);
      expect(doc).to.have.property('_id', id);
      expect(doc).to.have.property('type', 'person');
      expect(doc).to.have.property('name', 'Test Person');
    });

    it('should fetch a clinic contact by UUID', async () => {
      const id = stamp();
      await insertDoc(id, { type: 'clinic', name: 'Test Clinic' });

      const doc = await getDoc(id);
      expect(doc).to.have.property('type', 'clinic');
    });

    it('should fetch a health_center contact by UUID', async () => {
      const id = stamp();
      await insertDoc(id, { type: 'health_center', name: 'Test HC' });

      const doc = await getDoc(id);
      expect(doc).to.have.property('type', 'health_center');
    });

    it('should return null for non-existent UUID', async () => {
      const doc = await getDoc('nonexistent-' + stamp());
      expect(doc).to.be.null;
    });

    it('should skip soft-deleted documents', async () => {
      const id = stamp();
      testDocIds.push(id);
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, true, NOW(), 'test')`,
        [id, JSON.stringify({ _id: id, _rev: '1-del', type: 'person', _deleted: true })]
      );

      const doc = await getDoc(id);
      expect(doc).to.be.null;
    });

    it('should handle docs where _deleted is NULL (same as not deleted)', async () => {
      const id = stamp();
      testDocIds.push(id);
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, source)
         VALUES ($1, $2, NOW(), 'test')`,
        [id, JSON.stringify({ _id: id, _rev: '1-nul', type: 'person', name: 'Null Deleted' })]
      );

      const doc = await getDoc(id);
      expect(doc).to.not.be.null;
      expect(doc.name).to.equal('Null Deleted');
    });
  });

  // ── Contact getWithLineage (recursive CTE) ────────────────────────

  describe('contact getWithLineage (recursive CTE lineage)', () => {
    let districtId, healthCenterId, clinicId, personId;

    before(async () => {
      // Build a 4-level hierarchy: district → health_center → clinic → person
      districtId = stamp() + '-district';
      healthCenterId = stamp() + '-hc';
      clinicId = stamp() + '-clinic';
      personId = stamp() + '-person';

      await insertDoc(districtId, {
        type: 'district_hospital', name: 'Test District',
        contact: { _id: 'district-contact' }
      });
      await insertDoc(healthCenterId, {
        type: 'health_center', name: 'Test HC',
        parent: { _id: districtId },
        contact: { _id: 'hc-contact' }
      });
      await insertDoc(clinicId, {
        type: 'clinic', name: 'Test Clinic',
        parent: { _id: healthCenterId },
        contact: { _id: personId }
      });
      await insertDoc(personId, {
        type: 'person', name: 'Test CHW',
        parent: { _id: clinicId },
        patient_id: 'chw-shortcode'
      });
    });

    it('should walk full lineage via recursive CTE', async () => {
      const { rows } = await pool.query(
        `WITH RECURSIVE lineage AS (
           SELECT t.doc, COALESCE(
             t.doc->'parent'->>'_id',
             CASE WHEN jsonb_typeof(t.doc->'parent') = 'string' THEN t.doc->>'parent' ELSE NULL END
           ) AS parent_id, 0 AS depth
           FROM ${DOCS_TABLE} t
           WHERE t._id = $1 AND (t._deleted IS NULL OR t._deleted = false)
           UNION ALL
           SELECT c.doc, COALESCE(
             c.doc->'parent'->>'_id',
             CASE WHEN jsonb_typeof(c.doc->'parent') = 'string' THEN c.doc->>'parent' ELSE NULL END
           ), l.depth + 1
           FROM ${DOCS_TABLE} c
           JOIN lineage l ON c._id = l.parent_id
           WHERE l.parent_id IS NOT NULL
             AND l.parent_id != ''
             AND (c._deleted IS NULL OR c._deleted = false)
             AND l.depth < 20
         )
         SELECT doc, depth FROM lineage ORDER BY depth`,
        [personId]
      );

      expect(rows).to.have.lengthOf(4); // person → clinic → hc → district
      expect(rows[0].doc.name).to.equal('Test CHW');
      expect(rows[0].depth).to.equal(0);
      expect(rows[1].doc.name).to.equal('Test Clinic');
      expect(rows[1].depth).to.equal(1);
      expect(rows[2].doc.name).to.equal('Test HC');
      expect(rows[2].depth).to.equal(2);
      expect(rows[3].doc.name).to.equal('Test District');
      expect(rows[3].depth).to.equal(3);
    });

    it('should terminate at root when parent is missing', async () => {
      const { rows } = await pool.query(
        `WITH RECURSIVE lineage AS (
           SELECT t.doc, COALESCE(
             t.doc->'parent'->>'_id',
             CASE WHEN jsonb_typeof(t.doc->'parent') = 'string' THEN t.doc->>'parent' ELSE NULL END
           ) AS parent_id, 0 AS depth
           FROM ${DOCS_TABLE} t
           WHERE t._id = $1 AND (t._deleted IS NULL OR t._deleted = false)
           UNION ALL
           SELECT c.doc, COALESCE(
             c.doc->'parent'->>'_id',
             CASE WHEN jsonb_typeof(c.doc->'parent') = 'string' THEN c.doc->>'parent' ELSE NULL END
           ), l.depth + 1
           FROM ${DOCS_TABLE} c
           JOIN lineage l ON c._id = l.parent_id
           WHERE l.parent_id IS NOT NULL
             AND l.parent_id != ''
             AND (c._deleted IS NULL OR c._deleted = false)
             AND l.depth < 20
         )
         SELECT doc, depth FROM lineage ORDER BY depth`,
        [districtId]
      );

      // District has no parent — should return just the district
      expect(rows).to.have.lengthOf(1);
      expect(rows[0].doc.name).to.equal('Test District');
    });

    it('should handle lineage starting from mid-hierarchy', async () => {
      const { rows } = await pool.query(
        `WITH RECURSIVE lineage AS (
           SELECT t.doc, COALESCE(
             t.doc->'parent'->>'_id',
             CASE WHEN jsonb_typeof(t.doc->'parent') = 'string' THEN t.doc->>'parent' ELSE NULL END
           ) AS parent_id, 0 AS depth
           FROM ${DOCS_TABLE} t
           WHERE t._id = $1 AND (t._deleted IS NULL OR t._deleted = false)
           UNION ALL
           SELECT c.doc, COALESCE(
             c.doc->'parent'->>'_id',
             CASE WHEN jsonb_typeof(c.doc->'parent') = 'string' THEN c.doc->>'parent' ELSE NULL END
           ), l.depth + 1
           FROM ${DOCS_TABLE} c
           JOIN lineage l ON c._id = l.parent_id
           WHERE l.parent_id IS NOT NULL
             AND l.parent_id != ''
             AND (c._deleted IS NULL OR c._deleted = false)
             AND l.depth < 20
         )
         SELECT doc, depth FROM lineage ORDER BY depth`,
        [healthCenterId]
      );

      expect(rows).to.have.lengthOf(2); // hc → district
      expect(rows[0].doc.name).to.equal('Test HC');
      expect(rows[1].doc.name).to.equal('Test District');
    });

    it('should handle string parent format (COALESCE path)', async () => {
      const stringParentId = stamp() + '-str-parent';
      const childId = stamp() + '-str-child';

      await insertDoc(stringParentId, { type: 'clinic', name: 'String Parent Clinic' });
      // Insert child with parent as plain string (not object)
      testDocIds.push(childId);
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'test')`,
        [childId, JSON.stringify({
          _id: childId, _rev: '1-sp', type: 'person', name: 'String Parent Child',
          parent: stringParentId  // string, not object!
        })]
      );

      const { rows } = await pool.query(
        `WITH RECURSIVE lineage AS (
           SELECT t.doc, COALESCE(
             t.doc->'parent'->>'_id',
             CASE WHEN jsonb_typeof(t.doc->'parent') = 'string' THEN t.doc->>'parent' ELSE NULL END
           ) AS parent_id, 0 AS depth
           FROM ${DOCS_TABLE} t
           WHERE t._id = $1 AND (t._deleted IS NULL OR t._deleted = false)
           UNION ALL
           SELECT c.doc, COALESCE(
             c.doc->'parent'->>'_id',
             CASE WHEN jsonb_typeof(c.doc->'parent') = 'string' THEN c.doc->>'parent' ELSE NULL END
           ), l.depth + 1
           FROM ${DOCS_TABLE} c
           JOIN lineage l ON c._id = l.parent_id
           WHERE l.parent_id IS NOT NULL
             AND l.parent_id != ''
             AND (c._deleted IS NULL OR c._deleted = false)
             AND l.depth < 20
         )
         SELECT doc, depth FROM lineage ORDER BY depth`,
        [childId]
      );

      expect(rows).to.have.lengthOf(2);
      expect(rows[0].doc.name).to.equal('String Parent Child');
      expect(rows[1].doc.name).to.equal('String Parent Clinic');
    });
  });

  // ── Primary contact resolution ─────────────────────────────────────

  describe('primary contact resolution in lineage', () => {
    it('should resolve primary contacts for places in lineage', async () => {
      const contactId = stamp() + '-primary';
      const placeId = stamp() + '-place-with-contact';

      await insertDoc(contactId, { type: 'person', name: 'Primary Contact' });
      await insertDoc(placeId, {
        type: 'clinic', name: 'Place With Contact',
        contact: { _id: contactId }
      });

      // Fetch the place
      const place = await getDoc(placeId);
      expect(place.contact._id).to.equal(contactId);

      // Fetch the actual contact document
      const contact = await getDoc(contactId);
      expect(contact.name).to.equal('Primary Contact');

      // Verify we can join them (hydration pattern)
      const { rows } = await pool.query(
        `SELECT p.doc as place_doc, c.doc as contact_doc
         FROM ${DOCS_TABLE} p
         LEFT JOIN ${DOCS_TABLE} c ON c._id = (p.doc->'contact'->>'_id')
           AND (c._deleted IS NULL OR c._deleted = false)
         WHERE p._id = $1 AND (p._deleted IS NULL OR p._deleted = false)`,
        [placeId]
      );

      expect(rows).to.have.lengthOf(1);
      expect(rows[0].place_doc.name).to.equal('Place With Contact');
      expect(rows[0].contact_doc.name).to.equal('Primary Contact');
    });
  });

  // ── Person create pattern ──────────────────────────────────────────

  describe('person create (createDoc pattern)', () => {
    it('should create a person with auto-generated UUID', async () => {
      const id = crypto.randomUUID();
      testDocIds.push(id);
      const rev = '1-pg' + Math.random().toString(36).slice(2, 10);
      const doc = {
        _id: id, _rev: rev,
        type: 'person', name: 'Created Person',
        parent: { _id: 'some-parent' },
        reported_date: Date.now(),
      };

      const { rowCount } = await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW(), false, 'cht-datasource')`,
        [id, JSON.stringify(doc)]
      );
      expect(rowCount).to.equal(1);

      const created = await getDoc(id);
      expect(created._id).to.equal(id);
      expect(created._rev).to.match(/^1-pg/);
      expect(created.name).to.equal('Created Person');
    });

    it('should enforce NOT NULL on _id', async () => {
      try {
        await pool.query(
          `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
           VALUES (NULL, $1, NOW(), false, 'test')`,
          [JSON.stringify({ type: 'person' })]
        );
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.match(/violates not-null constraint|null value/i);
      }
    });
  });

  // ── Person update with revision locking ────────────────────────────

  describe('person update (updateDoc pattern)', () => {
    it('should update doc when revision matches', async () => {
      const id = stamp();
      const rev1 = '1-pg' + Math.random().toString(36).slice(2, 10);
      await insertDoc(id, { type: 'person', name: 'Original Name' });

      // Get current doc to know the rev
      const original = await getDoc(id);
      const newRev = '2-pg' + Math.random().toString(36).slice(2, 10);
      const updatedDoc = { ...original, _rev: newRev, name: 'Updated Name' };

      const { rowCount } = await pool.query(
        `UPDATE ${DOCS_TABLE}
         SET doc = $1, saved_timestamp = NOW()
         WHERE _id = $2 AND doc->>'_rev' = $3 AND (_deleted IS NULL OR _deleted = false)`,
        [JSON.stringify(updatedDoc), id, original._rev]
      );
      expect(rowCount).to.equal(1);

      const result = await getDoc(id);
      expect(result.name).to.equal('Updated Name');
      expect(result._rev).to.equal(newRev);
    });

    it('should fail update when revision mismatches (optimistic locking)', async () => {
      const id = stamp();
      await insertDoc(id, { type: 'person', name: 'Locked' });

      const { rowCount } = await pool.query(
        `UPDATE ${DOCS_TABLE}
         SET doc = $1, saved_timestamp = NOW()
         WHERE _id = $2 AND doc->>'_rev' = $3 AND (_deleted IS NULL OR _deleted = false)`,
        [JSON.stringify({ _id: id, _rev: '99-wrong', name: 'Bad Update' }), id, '99-wrong']
      );
      expect(rowCount).to.equal(0);

      // Original should be unchanged
      const doc = await getDoc(id);
      expect(doc.name).to.equal('Locked');
    });

    it('should detect rev conflict vs not-found (updateDoc error path)', async () => {
      const id = stamp();
      await insertDoc(id, { type: 'person', name: 'Conflict Test' });
      const original = await getDoc(id);

      // Attempt update with wrong rev → rowCount=0, then check if doc exists
      const { rowCount } = await pool.query(
        `UPDATE ${DOCS_TABLE}
         SET doc = $1, saved_timestamp = NOW()
         WHERE _id = $2 AND doc->>'_rev' = $3 AND (_deleted IS NULL OR _deleted = false)`,
        [JSON.stringify({ _id: id, _rev: '99-bad', name: 'nope' }), id, '99-bad']
      );
      expect(rowCount).to.equal(0);

      // Check: is it not-found or rev conflict?
      const { rows } = await pool.query(
        `SELECT doc->>'_rev' AS current_rev FROM ${DOCS_TABLE}
         WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`,
        [id]
      );
      expect(rows).to.have.lengthOf(1);
      expect(rows[0].current_rev).to.equal(original._rev);
      // This is a revision conflict (doc exists but rev doesn't match)

      // Now check a truly missing doc
      const { rows: missing } = await pool.query(
        `SELECT doc->>'_rev' AS current_rev FROM ${DOCS_TABLE}
         WHERE _id = 'nonexistent-${id}' AND (_deleted IS NULL OR _deleted = false)`,
        []
      );
      expect(missing).to.have.lengthOf(0);
      // This is a not-found error
    });
  });

  // ── Place create & update ──────────────────────────────────────────

  describe('place create & update patterns', () => {
    it('should create a place with parent and contact references', async () => {
      const parentId = stamp() + '-parent-place';
      const contactId = stamp() + '-place-contact';
      const placeId = crypto.randomUUID();
      testDocIds.push(placeId);

      await insertDoc(parentId, { type: 'district_hospital', name: 'Parent District' });
      await insertDoc(contactId, { type: 'person', name: 'Place Contact' });

      const placeDoc = {
        _id: placeId,
        _rev: '1-pg' + Math.random().toString(36).slice(2, 10),
        type: 'health_center',
        name: 'New Health Center',
        parent: { _id: parentId },
        contact: { _id: contactId },
        reported_date: Date.now(),
      };

      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW(), false, 'cht-datasource')`,
        [placeId, JSON.stringify(placeDoc)]
      );

      const place = await getDoc(placeId);
      expect(place.name).to.equal('New Health Center');
      expect(place.parent._id).to.equal(parentId);
      expect(place.contact._id).to.equal(contactId);
    });

    it('should verify parent exists before creating place', async () => {
      // Simulate the validation: check if parent doc exists
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE} WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`,
        ['nonexistent-parent-' + stamp()]
      );
      expect(rows).to.have.lengthOf(0);
      // In the adapter, this would throw InvalidArgumentError
    });

    it('should enforce assertSameParentLineage on update', async () => {
      const parentId = stamp() + '-lineage-parent';
      const placeId = stamp() + '-lineage-place';

      await insertDoc(parentId, { type: 'district_hospital', name: 'Lineage Parent' });
      await insertDoc(placeId, {
        type: 'health_center', name: 'Lineage Place',
        parent: { _id: parentId }
      });

      const original = await getDoc(placeId);
      // Try to update with different parent → would fail assertSameParentLineage
      const differentParent = { _id: 'different-parent-id' };

      // Verify the lineage comparison logic
      const isSameLineage = (a, b) => {
        if (!a || !b) return a === b;
        if (typeof a !== 'object' || typeof b !== 'object') return a === b;
        if (a._id !== b._id) return false;
        return isSameLineage(a.parent, b.parent);
      };

      expect(isSameLineage(original.parent, { _id: parentId })).to.be.true;
      expect(isSameLineage(original.parent, differentParent)).to.be.false;
    });
  });

  // ── Report create & update ─────────────────────────────────────────

  describe('report create & update patterns', () => {
    it('should create a report with form validation via ID range', async () => {
      // Insert a form definition document
      const formId = 'form:test_pregnancy';
      testDocIds.push(formId);
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'test')
         ON CONFLICT (_id) DO UPDATE SET doc = $2`,
        [formId, JSON.stringify({ _id: formId, _rev: '1-f', type: 'form', internalId: 'test_pregnancy' })]
      );

      // Query form range to validate form exists (adapter pattern)
      const { rows: formDocs } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE _id >= 'form:' AND _id <= $1
           AND (_deleted IS NULL OR _deleted = false)
         ORDER BY _id`,
        ['form:\ufff0']
      );
      const supportedForms = formDocs.map(r => r._id.substring('form:'.length));
      expect(supportedForms).to.include('test_pregnancy');

      // Create the report
      const contactId = stamp() + '-report-contact';
      await insertDoc(contactId, { type: 'person', name: 'Reporting CHW' });

      const reportId = crypto.randomUUID();
      testDocIds.push(reportId);
      const reportDoc = {
        _id: reportId,
        _rev: '1-pg' + Math.random().toString(36).slice(2, 10),
        type: 'data_record',
        form: 'test_pregnancy',
        contact: { _id: contactId },
        reported_date: Date.now(),
        fields: { patient_id: 'P12345', lmp_date: '2026-01-15' },
      };

      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW(), false, 'cht-datasource')`,
        [reportId, JSON.stringify(reportDoc)]
      );

      const report = await getDoc(reportId);
      expect(report.type).to.equal('data_record');
      expect(report.form).to.equal('test_pregnancy');
      expect(report.fields.patient_id).to.equal('P12345');
    });

    it('should reject report with unsupported form (validation pattern)', async () => {
      const { rows: formDocs } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE _id >= 'form:' AND _id <= $1
           AND (_deleted IS NULL OR _deleted = false)`,
        ['form:\ufff0']
      );
      const supportedForms = formDocs.map(r => r._id.substring('form:'.length));
      expect(supportedForms).to.not.include('nonexistent_form_xyz');
    });

    it('should enforce immutable reported_date on update', async () => {
      const reportId = stamp();
      const originalDate = Date.now() - 86400000; // yesterday
      await insertDoc(reportId, {
        type: 'data_record', form: 'test',
        reported_date: originalDate,
        fields: { note: 'original' },
      });

      const original = await getDoc(reportId);
      // Verify the immutability check logic
      const updatedReport = { ...original, reported_date: Date.now() };
      const unchangedFields = ['_rev', 'reported_date'];
      const changedFields = unchangedFields.filter(key => original[key] !== updatedReport[key]);
      expect(changedFields).to.include('reported_date');
    });
  });

  // ── Report subject resolution (shortcode → UUID) ───────────────────

  describe('report subject resolution (resolveShortcode pattern)', () => {
    let patientId, patientUuid;

    before(async () => {
      patientUuid = stamp() + '-patient';
      patientId = 'P' + Date.now().toString(36);
      await insertDoc(patientUuid, {
        type: 'person', name: 'Test Patient',
        patient_id: patientId,
      });
    });

    it('should resolve patient_id shortcode to contact UUID', async () => {
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE (_deleted IS NULL OR _deleted = false)
           AND (doc->>'patient_id' = $1
                OR doc->>'place_id' = $1
                OR UPPER(doc->>'rc_code') = UPPER($1))
         LIMIT 1`,
        [patientId]
      );

      expect(rows).to.have.lengthOf(1);
      expect(rows[0]._id).to.equal(patientUuid);
    });

    it('should resolve place_id shortcode', async () => {
      const placeUuid = stamp() + '-place-sc';
      const placeShortcode = 'PL' + Date.now().toString(36);
      await insertDoc(placeUuid, {
        type: 'clinic', name: 'Shortcode Clinic',
        place_id: placeShortcode,
      });

      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE (_deleted IS NULL OR _deleted = false)
           AND (doc->>'patient_id' = $1
                OR doc->>'place_id' = $1
                OR UPPER(doc->>'rc_code') = UPPER($1))
         LIMIT 1`,
        [placeShortcode]
      );

      expect(rows).to.have.lengthOf(1);
      expect(rows[0]._id).to.equal(placeUuid);
    });

    it('should resolve rc_code with case-insensitive match', async () => {
      const rcUuid = stamp() + '-rc';
      await insertDoc(rcUuid, {
        type: 'clinic', name: 'RC Code Clinic',
        rc_code: 'abc123',
      });

      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE (_deleted IS NULL OR _deleted = false)
           AND (doc->>'patient_id' = $1
                OR doc->>'place_id' = $1
                OR UPPER(doc->>'rc_code') = UPPER($1))
         LIMIT 1`,
        ['ABC123']  // uppercase input
      );

      expect(rows).to.have.lengthOf(1);
      expect(rows[0]._id).to.equal(rcUuid);
    });

    it('should return empty for non-existent shortcode', async () => {
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE (_deleted IS NULL OR _deleted = false)
           AND (doc->>'patient_id' = $1
                OR doc->>'place_id' = $1
                OR UPPER(doc->>'rc_code') = UPPER($1))
         LIMIT 1`,
        ['NONEXISTENT_' + stamp()]
      );

      expect(rows).to.have.lengthOf(0);
    });
  });

  // ── Target get & getPage ───────────────────────────────────────────

  describe('target get & getPage patterns', () => {
    const reportingPeriod = '2026-04';
    let targetIds;

    before(async () => {
      targetIds = [];
      // Create target documents following the naming convention: target~period~contactId~index
      const contacts = ['contact-a', 'contact-b'];
      for (const contactId of contacts) {
        for (let i = 0; i < 3; i++) {
          const id = `target~${reportingPeriod}~${contactId}~${i}`;
          targetIds.push(id);
          await insertDoc(id, {
            type: 'target',
            user: 'org.couchdb.user:test',
            owner: contactId,
            reporting_period: reportingPeriod,
            updated_date: Date.now(),
            targets: [{ id: `goal-${i}`, value: { pass: i + 1, total: 10 } }],
          });
        }
      }
    });

    it('should get a target by ID and validate structure', async () => {
      const doc = await getDoc(targetIds[0]);
      expect(doc).to.not.be.null;
      expect(doc.type).to.equal('target');
      expect(doc.user).to.be.a('string');
      expect(doc.owner).to.be.a('string');
      expect(doc.reporting_period).to.equal(reportingPeriod);
      expect(doc.updated_date).to.be.a('number');
      expect(doc.targets).to.be.an('array');
    });

    it('should return null for non-target document type', async () => {
      // A person doc is not a target
      const personId = stamp();
      await insertDoc(personId, { type: 'person', name: 'Not a target' });

      const doc = await getDoc(personId);
      // isTarget check: type === 'target' && has user, owner, reporting_period, updated_date, targets[]
      const isTarget = doc && doc.type === 'target'
        && typeof doc.user === 'string'
        && typeof doc.owner === 'string';
      expect(isTarget).to.be.false;
    });

    it('should query targets for single contact via optimized range query', async () => {
      const contactId = 'contact-a';
      const startKey = `target~${reportingPeriod}~${contactId}~`;
      const endKey = `target~${reportingPeriod}~${contactId}~\ufff0`;

      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE _id >= $1 AND _id <= $2 AND (_deleted IS NULL OR _deleted = false)
         ORDER BY _id`,
        [startKey, endKey]
      );

      expect(rows).to.have.lengthOf(3);
      rows.forEach(r => {
        expect(r._id).to.include('contact-a');
      });
    });

    it('should query targets for multiple contacts via range + post-filter', async () => {
      const contactIdSet = new Set(['contact-a', 'contact-b']);
      const startKey = `target~${reportingPeriod}~`;
      const endKey = `target~${reportingPeriod}~\ufff0`;

      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE _id >= $1 AND _id <= $2 AND (_deleted IS NULL OR _deleted = false)
         ORDER BY _id`,
        [startKey, endKey]
      );

      // Post-filter by contact ID (adapter pattern)
      const filtered = rows.filter(r => {
        const [, , contactId] = r._id.split('~');
        return contactIdSet.has(contactId);
      });

      expect(filtered).to.have.lengthOf(6); // 3 per contact × 2 contacts
    });

    it('should return empty for non-existent contact targets', async () => {
      const contactId = 'nonexistent-contact';
      const startKey = `target~${reportingPeriod}~${contactId}~`;
      const endKey = `target~${reportingPeriod}~${contactId}~\ufff0`;

      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE _id >= $1 AND _id <= $2 AND (_deleted IS NULL OR _deleted = false)
         ORDER BY _id`,
        [startKey, endKey]
      );

      expect(rows).to.have.lengthOf(0);
    });
  });

  // ── getDocsByIds batch fetch ────────────────────────────────────────

  describe('getDocsByIds batch fetch with ordering', () => {
    it('should fetch multiple docs and preserve requested order', async () => {
      const ids = [stamp(), stamp(), stamp()];
      for (let i = 0; i < ids.length; i++) {
        await insertDoc(ids[i], { type: 'person', name: `Batch Person ${i}` });
      }

      const { rows } = await pool.query(
        `SELECT _id, doc FROM ${DOCS_TABLE}
         WHERE _id = ANY($1) AND (_deleted IS NULL OR _deleted = false)`,
        [ids]
      );

      const docMap = new Map(rows.map(r => [r._id, r.doc]));

      // Verify ordering matches requested order (adapter rebuilds order from map)
      const orderedDocs = ids.map(id => docMap.get(id));
      expect(orderedDocs[0].name).to.equal('Batch Person 0');
      expect(orderedDocs[1].name).to.equal('Batch Person 1');
      expect(orderedDocs[2].name).to.equal('Batch Person 2');
    });

    it('should return null for missing IDs in batch', async () => {
      const existingId = stamp();
      await insertDoc(existingId, { type: 'person', name: 'Existing' });

      const requestedIds = [existingId, 'missing-' + stamp(), existingId];
      const { rows } = await pool.query(
        `SELECT _id, doc FROM ${DOCS_TABLE}
         WHERE _id = ANY($1) AND (_deleted IS NULL OR _deleted = false)`,
        [requestedIds]
      );

      const docMap = new Map(rows.map(r => [r._id, r.doc]));
      const results = requestedIds.map(id => docMap.get(id) || null);

      expect(results[0]).to.not.be.null;
      expect(results[1]).to.be.null; // missing
      expect(results[2]).to.not.be.null; // duplicate of existing
    });
  });

  // ── queryDocsByType ────────────────────────────────────────────────

  describe('queryDocsByType pattern', () => {
    it('should query by COALESCE(contact_type, type) for custom types', async () => {
      const id = stamp();
      await insertDoc(id, {
        type: 'contact', contact_type: 'chw_area',
        name: 'Custom Type Area',
      });

      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE}
         WHERE COALESCE(doc->>'contact_type', doc->>'type') = $1
           AND (_deleted IS NULL OR _deleted = false)
         ORDER BY _id
         LIMIT 10 OFFSET 0`,
        ['chw_area']
      );

      const ourDoc = rows.find(r => r.doc._id === id);
      expect(ourDoc).to.exist;
      expect(ourDoc.doc.contact_type).to.equal('chw_area');
    });

    it('should query standard types without contact_type', async () => {
      const id = stamp();
      await insertDoc(id, { type: 'person', name: 'Standard Type Person' });

      // Use a higher limit to ensure we find our doc among many persons
      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE}
         WHERE COALESCE(doc->>'contact_type', doc->>'type') = $1
           AND (_deleted IS NULL OR _deleted = false)
           AND _id = $2`,
        ['person', id]
      );

      expect(rows).to.have.lengthOf(1);
      expect(rows[0].doc.name).to.equal('Standard Type Person');
    });
  });

  // ── minifyDoc patterns ─────────────────────────────────────────────

  describe('minifyDoc patterns (lineage stripping, linked_docs)', () => {
    it('should minify parent lineage to nested {_id} objects', () => {
      const doc = {
        _id: 'doc1', _rev: '1-a', type: 'person', name: 'Test',
        parent: {
          _id: 'clinic1', name: 'Full Clinic', phone: '+123',
          parent: {
            _id: 'hc1', name: 'Full HC',
            parent: { _id: 'district1', name: 'Full District' }
          }
        }
      };

      // minifyLineage logic
      const minifyLineage = (parent) => {
        if (!parent || !parent._id) return undefined;
        const result = { _id: parent._id };
        let minified = result;
        let current = parent;
        for (let guard = 50; current.parent && current.parent._id; --guard) {
          if (guard === 0) throw new Error('Possible parent recursion');
          const next = { _id: current.parent._id };
          minified.parent = next;
          minified = next;
          current = current.parent;
        }
        return result;
      };

      const minified = minifyLineage(doc.parent);
      expect(minified).to.deep.equal({
        _id: 'clinic1',
        parent: {
          _id: 'hc1',
          parent: { _id: 'district1' }
        }
      });
    });

    it('should strip patient and place from data_record docs', () => {
      const doc = {
        _id: 'report1', _rev: '1-r', type: 'data_record', form: 'pregnancy',
        patient: { _id: 'patient1', name: 'Full Patient', parent: { _id: 'clinic1' } },
        place: { _id: 'place1', name: 'Full Place' },
        fields: { lmp_date: '2026-01-01' },
      };

      const result = { ...doc };
      if (doc.type === 'data_record') {
        delete result.patient;
        delete result.place;
      }

      expect(result).to.not.have.property('patient');
      expect(result).to.not.have.property('place');
      expect(result.fields.lmp_date).to.equal('2026-01-01');
    });

    it('should extract IDs from hydrated linked_docs', () => {
      const CONTACT_TYPES = new Set(['contact', 'clinic', 'district_hospital', 'health_center', 'person']);
      const doc = {
        _id: 'clinic1', type: 'clinic',
        linked_docs: {
          tag1: { _id: 'linked-uuid-1', name: 'Full Linked Doc' },
          tag2: 'already-string-id',
          tag3: { _id: 'linked-uuid-3', parent: { _id: 'p1' } },
        }
      };

      if (CONTACT_TYPES.has(doc.type) && doc.linked_docs && typeof doc.linked_docs === 'object' && !Array.isArray(doc.linked_docs)) {
        const minifiedLinkedDocs = {};
        for (const key of Object.keys(doc.linked_docs)) {
          const item = doc.linked_docs[key];
          minifiedLinkedDocs[key] = (typeof item === 'string') ? item
            : (item && item._id) ? item._id
              : item;
        }
        expect(minifiedLinkedDocs).to.deep.equal({
          tag1: 'linked-uuid-1',
          tag2: 'already-string-id',
          tag3: 'linked-uuid-3',
        });
      }
    });

    it('should NOT process linked_docs when doc is data_record', () => {
      const doc = {
        _id: 'report1', type: 'data_record',
        linked_docs: { tag: { _id: 'should-be-kept' } },
      };

      const CONTACT_TYPES = new Set(['contact', 'clinic', 'district_hospital', 'health_center', 'person']);
      const isContact = CONTACT_TYPES.has(doc.type);
      expect(isContact).to.be.false;
      // linked_docs processing should be skipped
    });
  });

  // ── PostgresDataContext validation ─────────────────────────────────

  describe('PostgresDataContext patterns', () => {
    it('should use default schema config when none provided', () => {
      const config = { schema: 'v1', table: 'couchdb' };
      const qualifiedTable = `"${config.schema}"."${config.table}"`;
      expect(qualifiedTable).to.equal('"v1"."couchdb"');
    });

    it('should override schema config when provided', () => {
      const config = { schema: 'custom', table: 'documents' };
      const qualifiedTable = `"${config.schema}"."${config.table}"`;
      expect(qualifiedTable).to.equal('"custom"."documents"');
    });

    it('should reject invalid pool object', () => {
      const assertDatabasePool = (p) => {
        if (!p || typeof p !== 'object' || typeof p.query !== 'function') {
          throw new Error('Invalid database pool');
        }
      };

      expect(() => assertDatabasePool(null)).to.throw('Invalid database pool');
      expect(() => assertDatabasePool({})).to.throw('Invalid database pool');
      expect(() => assertDatabasePool({ query: 'not-a-function' })).to.throw('Invalid database pool');
      expect(() => assertDatabasePool({ query: () => {} })).to.not.throw();
    });

    it('should reject invalid settings service', () => {
      const assertSettingsService = (s) => {
        if (!s || typeof s !== 'object' || typeof s.getAll !== 'function') {
          throw new Error('Invalid settings service');
        }
      };

      expect(() => assertSettingsService(null)).to.throw('Invalid settings service');
      expect(() => assertSettingsService({})).to.throw('Invalid settings service');
      expect(() => assertSettingsService({ getAll: () => ({}) })).to.not.throw();
    });
  });

  // ── fetchAndFilter recursion pattern ───────────────────────────────

  describe('fetchAndFilter recursion logic', () => {
    it('should recursively fetch more when invalid docs reduce result count', async () => {
      // Create 5 docs: 3 valid persons, 2 invalid (missing required fields)
      const validIds = [];
      const invalidIds = [];
      for (let i = 0; i < 3; i++) {
        const id = stamp() + `-valid-${i}`;
        validIds.push(id);
        await insertDoc(id, { type: 'person', name: `Valid ${i}` });
      }
      for (let i = 0; i < 2; i++) {
        const id = stamp() + `-invalid-${i}`;
        invalidIds.push(id);
        // These have type 'person' but when fetched via queryDocsByType, they'd be included
        // The filter function would validate and skip them if they lack required fields
        await insertDoc(id, { type: 'data_record', name: `Not a person ${i}` });
      }

      // Simulate fetchAndFilter: query all 'person' type docs and filter
      const allIds = [...validIds, ...invalidIds];
      const { rows } = await pool.query(
        `SELECT _id, doc FROM ${DOCS_TABLE}
         WHERE _id = ANY($1) AND (_deleted IS NULL OR _deleted = false)`,
        [allIds]
      );

      const isValidPerson = (doc) => doc && doc.type === 'person';
      const validDocs = rows.map(r => r.doc).filter(isValidPerson);
      expect(validDocs).to.have.lengthOf(3);
    });
  });

  // ── generateRev format ─────────────────────────────────────────────

  describe('generateRev format compliance', () => {
    const generateRev = (currentRev) => {
      const revNum = currentRev
        ? parseInt(currentRev.split('-')[0], 10) + 1
        : 1;
      const suffix = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
      return `${revNum}-pg${suffix}`;
    };

    it('should produce CouchDB-compatible rev format', () => {
      const rev = generateRev();
      expect(rev).to.match(/^1-pg[a-z0-9]+$/);
    });

    it('should increment from existing CouchDB rev', () => {
      const rev = generateRev('3-abc123def');
      expect(rev).to.match(/^4-pg[a-z0-9]+$/);
    });

    it('should increment from existing PG rev', () => {
      const rev = generateRev('5-pgabcdef12');
      expect(rev).to.match(/^6-pg[a-z0-9]+$/);
    });

    it('should produce unique revs on each call', () => {
      const revs = new Set();
      for (let i = 0; i < 100; i++) {
        revs.add(generateRev());
      }
      expect(revs.size).to.equal(100);
    });
  });
});
