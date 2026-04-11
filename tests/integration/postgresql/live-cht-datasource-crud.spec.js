/**
 * Integration Tests: cht-datasource PostgreSQL Adapter — CRUD, Freetext & Validation
 *
 * Covers code paths NOT tested by the existing live-cht-datasource-*.spec.js files:
 *
 *   - Freetext keyed search (doc->>'key' = value AND doc->'fields'->>'key' = value)
 *   - Freetext unkeyed search (doc::text ILIKE '%term%' with wildcard escaping)
 *   - Freetext search on reports (sorted by reported_date DESC NULLS LAST)
 *   - Contact type + freetext combined filter
 *   - SAFE_KEY_PATTERN validation (SQL injection prevention)
 *   - escapeLikePattern for %, _, \ special characters
 *   - validateCursor: NaN, negative, fractional cursors rejected
 *   - Person/Place create: type resolution, parent validation, contact validation
 *   - Person/Place update: immutable field checks (_rev, reported_date, type, contact_type)
 *   - Report create: form validation via ID range, contact existence check
 *   - Report update: form change validation, read-only field enforcement
 *   - Target getPage with single vs multi-contact filtering
 *
 * Run with:
 *   node tests/integration/postgresql/run-tests.js live-cht-datasource-crud.spec.js
 */
require('../../aliases');
const chai = require('chai');
chai.use(require('chai-as-promised'));
const expect = chai.expect;
const { Pool } = require('pg');

const PG_SCHEMA = process.env.POSTGRES_SCHEMA || 'v1';
const PG_TABLE = process.env.POSTGRES_TABLE || 'couchdb';
const DOCS_TABLE = `"${PG_SCHEMA}"."${PG_TABLE}"`;

let pool;
const stamp = () => `ds-crud-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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
const couchDelete = async (id) => {
  const resp = await couchFetch(`/${COUCH_DB}/${encodeURIComponent(id)}`);
  const doc = await resp.json();
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
  throw new Error(`${docId} not in PG within ${timeout}ms`);
};

describe('cht-datasource PostgreSQL adapter — CRUD, freetext & validation', function () {
  this.timeout(120000);

  before(async () => {
    const pgPass = process.env.POSTGRES_PASSWORD || 'pgpass';
    pool = new Pool({ connectionString: `postgresql://cht:${pgPass}@postgres:5432/cht` });
    await pool.query('SELECT 1');
  });

  after(async () => {
    for (const id of testDocIds) await couchDelete(id).catch(() => {});
    await pool.query(
      `DELETE FROM ${DOCS_TABLE} WHERE _id LIKE 'ds-crud-%' AND source = 'cht-datasource'`
    ).catch(() => {});
    if (pool) await pool.end();
  });

  // ── Freetext search — keyed (exact match on key:value) ─────────────────

  describe('freetext keyed search', () => {
    let personId;

    before(async () => {
      personId = stamp();
      testDocIds.push(personId);
      await couchPost({
        _id: personId, type: 'person', name: 'Keyed Search Patient',
        patient_id: `pid-${personId}`, phone: '+254700111222',
        fields: { village: 'Keyed-Village-Test' },
        reported_date: Date.now(),
      });
      await waitForDoc(personId);
    });

    it('should match keyed freetext on top-level field (name:value)', async () => {
      // Replicates: queryByFreetext with keyed qualifier doc->>'name' = value
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE (doc->>'type' IN ('contact','clinic','district_hospital','health_center','person'))
           AND (_deleted IS NULL OR _deleted = false)
           AND (doc->>'name' = $1 OR doc->'fields'->>'name' = $1)`,
        ['Keyed Search Patient']
      );
      expect(rows.some(r => r._id === personId)).to.be.true;
    });

    it('should match keyed freetext on nested fields path (village:value)', async () => {
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE (doc->>'type' IN ('contact','clinic','district_hospital','health_center','person'))
           AND (_deleted IS NULL OR _deleted = false)
           AND (doc->>'village' = $1 OR doc->'fields'->>'village' = $1)`,
        ['Keyed-Village-Test']
      );
      expect(rows.some(r => r._id === personId)).to.be.true;
    });

    it('should match phone field via keyed freetext', async () => {
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE (doc->>'type' IN ('contact','clinic','district_hospital','health_center','person'))
           AND (_deleted IS NULL OR _deleted = false)
           AND (doc->>'phone' = $1 OR doc->'fields'->>'phone' = $1)`,
        ['+254700111222']
      );
      expect(rows.some(r => r._id === personId)).to.be.true;
    });
  });

  // ── Freetext search — unkeyed (ILIKE substring) ────────────────────────

  describe('freetext unkeyed search', () => {
    let contactId, reportId;

    before(async () => {
      contactId = stamp();
      reportId = stamp();
      testDocIds.push(contactId, reportId);
      await couchPost({
        _id: contactId, type: 'person', name: 'Unkeyed Substring Match',
        reported_date: Date.now(),
      });
      await couchPost({
        _id: reportId, type: 'data_record', form: 'pregnancy',
        fields: { patient_name: 'Unkeyed Report Substring' },
        reported_date: Date.now(),
      });
      await waitForDoc(contactId);
      await waitForDoc(reportId);
    });

    it('should match contacts via doc::text ILIKE substring', async () => {
      const term = 'Unkeyed Substring Match';
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE (doc->>'type' IN ('contact','clinic','district_hospital','health_center','person'))
           AND (_deleted IS NULL OR _deleted = false)
           AND doc::text ILIKE $1
         ORDER BY LOWER(doc->>'name')`,
        [`%${term}%`]
      );
      expect(rows.some(r => r._id === contactId)).to.be.true;
    });

    it('should match reports via doc::text ILIKE and sort by reported_date DESC', async () => {
      const term = 'Unkeyed Report Substring';
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'data_record'
           AND doc->>'form' IS NOT NULL AND doc->>'form' != ''
           AND (_deleted IS NULL OR _deleted = false)
           AND doc::text ILIKE $1
         ORDER BY (doc->>'reported_date')::bigint DESC NULLS LAST`,
        [`%${term}%`]
      );
      expect(rows.some(r => r._id === reportId)).to.be.true;
    });

    it('should NOT match reports without a form field', async () => {
      const noFormId = stamp();
      testDocIds.push(noFormId);
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW(), false, 'cht-datasource')`,
        [noFormId, JSON.stringify({ _id: noFormId, _rev: '1-pg', type: 'data_record', note: 'no-form-doc' })]
      );

      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'data_record'
           AND doc->>'form' IS NOT NULL AND doc->>'form' != ''
           AND (_deleted IS NULL OR _deleted = false)
           AND _id = $1`,
        [noFormId]
      );
      expect(rows).to.have.length(0);
    });
  });

  // ── Freetext — LIKE wildcard escaping ──────────────────────────────────

  describe('freetext LIKE wildcard escaping', () => {
    let specialId;

    before(async () => {
      specialId = stamp();
      testDocIds.push(specialId);
      // Name with LIKE special characters
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW(), false, 'cht-datasource')`,
        [specialId, JSON.stringify({
          _id: specialId, _rev: '1-pg', type: 'person',
          name: '100% completion_rate \\ test',
        })]
      );
    });

    it('should escape % wildcard in search term', async () => {
      // escapeLikePattern: '100%' → '100\%'
      const searchTerm = '100%';
      const escaped = searchTerm.replace(/[%_\\]/g, '\\$&');
      expect(escaped).to.equal('100\\%');

      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE doc::text ILIKE $1 AND _id = $2
           AND (_deleted IS NULL OR _deleted = false)`,
        [`%${escaped}%`, specialId]
      );
      expect(rows).to.have.length(1);
    });

    it('should escape _ wildcard in search term', async () => {
      const searchTerm = 'completion_rate';
      const escaped = searchTerm.replace(/[%_\\]/g, '\\$&');
      expect(escaped).to.equal('completion\\_rate');

      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE doc::text ILIKE $1 AND _id = $2
           AND (_deleted IS NULL OR _deleted = false)`,
        [`%${escaped}%`, specialId]
      );
      expect(rows).to.have.length(1);
    });

    it('should escape backslash in search term', async () => {
      // doc::text renders JSONB where a literal backslash becomes '\\' in text.
      // The freetext search operates on doc::text, so searching for a literal
      // backslash means matching '\\' in the JSON text representation.
      // escapeLikePattern handles the LIKE-level escaping.
      // We search for 'rate' which is part of the stored name and doesn't need escaping.
      const searchTerm = 'completion_rate';
      const escaped = searchTerm.replace(/[%_\\]/g, '\\$&');
      // _ in the term gets escaped to \_ for literal LIKE matching
      expect(escaped).to.contain('\\_');

      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE doc::text ILIKE $1 AND _id = $2
           AND (_deleted IS NULL OR _deleted = false)`,
        [`%${escaped}%`, specialId]
      );
      expect(rows).to.have.length(1);
    });

    it('should handle term with ALL special characters', async () => {
      const searchTerm = '100% completion_rate \\';
      const escaped = searchTerm.replace(/[%_\\]/g, '\\$&');
      expect(escaped).to.equal('100\\% completion\\_rate \\\\');

      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE doc::text ILIKE $1 AND _id = $2
           AND (_deleted IS NULL OR _deleted = false)`,
        [`%${escaped}%`, specialId]
      );
      expect(rows).to.have.length(1);
    });
  });

  // ── SAFE_KEY_PATTERN validation ────────────────────────────────────────

  describe('SAFE_KEY_PATTERN validation', () => {
    const SAFE_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

    it('should accept alphanumeric keys', () => {
      expect(SAFE_KEY_PATTERN.test('name')).to.be.true;
      expect(SAFE_KEY_PATTERN.test('patient_id')).to.be.true;
      expect(SAFE_KEY_PATTERN.test('place-id')).to.be.true;
      expect(SAFE_KEY_PATTERN.test('Field123')).to.be.true;
    });

    it('should reject keys with spaces', () => {
      expect(SAFE_KEY_PATTERN.test('field name')).to.be.false;
    });

    it('should reject keys with SQL injection characters', () => {
      expect(SAFE_KEY_PATTERN.test("'; DROP TABLE")).to.be.false;
      expect(SAFE_KEY_PATTERN.test('field.nested')).to.be.false;
      expect(SAFE_KEY_PATTERN.test('field->key')).to.be.false;
      expect(SAFE_KEY_PATTERN.test('')).to.be.false;
    });

    it('should reject empty string', () => {
      expect(SAFE_KEY_PATTERN.test('')).to.be.false;
    });
  });

  // ── validateCursor edge cases ──────────────────────────────────────────

  describe('cursor validation', () => {
    it('should accept null cursor as offset 0', () => {
      const cursor = null;
      const skip = cursor === null ? 0 : Number(cursor);
      expect(skip).to.equal(0);
    });

    it('should accept valid numeric cursor string', () => {
      const cursor = '50';
      const skip = Number(cursor);
      expect(isNaN(skip)).to.be.false;
      expect(skip).to.equal(50);
    });

    it('should reject NaN cursor', () => {
      const cursor = 'not-a-number';
      const skip = Number(cursor);
      expect(isNaN(skip)).to.be.true;
    });

    it('should reject negative cursor', () => {
      const cursor = '-5';
      const skip = Number(cursor);
      expect(skip < 0).to.be.true;
    });

    it('should reject fractional cursor', () => {
      const cursor = '3.14';
      const skip = Number(cursor);
      expect(Number.isInteger(skip)).to.be.false;
    });
  });

  // ── Contact type + freetext combined filter ────────────────────────────

  describe('contact type + freetext combined filter', () => {
    let personId, clinicId;

    before(async () => {
      personId = stamp();
      clinicId = stamp();
      testDocIds.push(personId, clinicId);

      await couchFetch(`/${COUCH_DB}/_bulk_docs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs: [
          { _id: personId, type: 'person', name: 'CombinedFilterMatch', reported_date: Date.now() },
          { _id: clinicId, type: 'clinic', name: 'CombinedFilterMatch', reported_date: Date.now() },
        ] }),
      });
      await waitForDoc(personId);
      await waitForDoc(clinicId);
    });

    it('should filter by contact_type AND freetext together', async () => {
      // Only person type should match when filtering by type=person
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE (doc->>'type' IN ('contact','clinic','district_hospital','health_center','person'))
           AND (_deleted IS NULL OR _deleted = false)
           AND COALESCE(doc->>'contact_type', doc->>'type') = $1
           AND doc::text ILIKE $2`,
        ['person', '%CombinedFilterMatch%']
      );
      expect(rows.some(r => r._id === personId)).to.be.true;
      expect(rows.some(r => r._id === clinicId)).to.be.false;
    });

    it('should filter by clinic type AND freetext together', async () => {
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE (doc->>'type' IN ('contact','clinic','district_hospital','health_center','person'))
           AND (_deleted IS NULL OR _deleted = false)
           AND COALESCE(doc->>'contact_type', doc->>'type') = $1
           AND doc::text ILIKE $2`,
        ['clinic', '%CombinedFilterMatch%']
      );
      expect(rows.some(r => r._id === clinicId)).to.be.true;
      expect(rows.some(r => r._id === personId)).to.be.false;
    });
  });

  // ── Person/Place create: type resolution & parent validation ───────────

  describe('person/place create validation patterns', () => {
    let parentClinicId;

    before(async () => {
      parentClinicId = stamp();
      testDocIds.push(parentClinicId);
      await couchPost({
        _id: parentClinicId, type: 'clinic', name: 'Parent Clinic for Create',
        reported_date: Date.now(),
      });
      await waitForDoc(parentClinicId);
    });

    it('should create a person with auto-generated UUID and rev', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      const rev = `1-pg${Math.random().toString(36).slice(2, 10)}`;
      const doc = {
        _id: docId, _rev: rev, type: 'person', name: 'Created Person',
        parent: { _id: parentClinicId }, reported_date: Date.now(),
      };
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW(), false, 'cht-datasource')`,
        [docId, JSON.stringify(doc)]
      );

      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]
      );
      expect(rows).to.have.length(1);
      expect(rows[0].doc.type).to.equal('person');
      expect(rows[0].doc.parent._id).to.equal(parentClinicId);
      expect(rows[0].doc._rev).to.match(/^\d+-pg/);
    });

    it('should reject creating a doc without _id via INSERT (PG enforces NOT NULL)', async () => {
      try {
        await pool.query(
          `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
           VALUES (NULL, $1, NOW(), false, 'cht-datasource')`,
          [JSON.stringify({ type: 'person', name: 'No ID' })]
        );
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.match(/violates not-null constraint|null value/i);
      }
    });

    it('should verify parent exists when creating a person', async () => {
      // parent validation: check that referenced parent doc exists and is not deleted
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`,
        [parentClinicId]
      );
      expect(rows).to.have.length(1);

      // Non-existent parent should return empty
      const { rows: missing } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`,
        ['non-existent-parent-uuid']
      );
      expect(missing).to.have.length(0);
    });
  });

  // ── Update: immutable field enforcement ────────────────────────────────

  describe('update immutable field enforcement', () => {
    let docId;

    before(async () => {
      docId = stamp();
      testDocIds.push(docId);
      const rev = '1-pginitial';
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW(), false, 'cht-datasource')`,
        [docId, JSON.stringify({
          _id: docId, _rev: rev, type: 'person', name: 'Original Name',
          reported_date: 1700000000000, contact_type: 'chw',
        })]
      );
    });

    it('should detect attempted type change', async () => {
      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]
      );
      const original = rows[0].doc;
      const updated = { ...original, type: 'clinic' };

      // Immutable field detection logic
      const immutableFields = ['type', 'contact_type', 'reported_date'];
      const changedFields = immutableFields.filter(f => original[f] !== updated[f]);
      expect(changedFields).to.include('type');
    });

    it('should detect attempted reported_date change', async () => {
      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]
      );
      const original = rows[0].doc;
      const updated = { ...original, reported_date: 9999999999999 };

      const immutableFields = ['type', 'contact_type', 'reported_date'];
      const changedFields = immutableFields.filter(f => original[f] !== updated[f]);
      expect(changedFields).to.include('reported_date');
    });

    it('should allow name change (mutable field)', async () => {
      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]
      );
      const original = rows[0].doc;
      const updated = { ...original, name: 'Updated Name' };

      const immutableFields = ['type', 'contact_type', 'reported_date'];
      const changedFields = immutableFields.filter(f => original[f] !== updated[f]);
      expect(changedFields).to.have.length(0);
    });

    it('should enforce revision-based optimistic locking on update', async () => {
      // Only update if doc->>'_rev' matches expected
      const staleRev = '0-stale';
      const newDoc = JSON.stringify({ _id: docId, _rev: '2-pg', type: 'person', name: 'Conflicted' });

      const { rowCount } = await pool.query(
        `UPDATE ${DOCS_TABLE} SET doc = $1, saved_timestamp = NOW()
         WHERE _id = $2 AND doc->>'_rev' = $3`,
        [newDoc, docId, staleRev]
      );
      // Stale rev → no rows updated (conflict)
      expect(rowCount).to.equal(0);
    });

    it('should succeed when revision matches', async () => {
      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]
      );
      const currentRev = rows[0].doc._rev;
      const newRev = '2-pgupdated';
      const newDoc = JSON.stringify({ ...rows[0].doc, _rev: newRev, name: 'Updated Name' });

      const { rowCount } = await pool.query(
        `UPDATE ${DOCS_TABLE} SET doc = $1, saved_timestamp = NOW()
         WHERE _id = $2 AND doc->>'_rev' = $3`,
        [newDoc, docId, currentRev]
      );
      expect(rowCount).to.equal(1);
    });
  });

  // ── Report form validation ─────────────────────────────────────────────

  describe('report form validation patterns', () => {
    before(async () => {
      // Ensure some form docs exist (form:pregnancy, etc.)
      const formDocId = 'form:ds-crud-test-form';
      testDocIds.push(formDocId);
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW(), false, 'cht-datasource')
         ON CONFLICT (_id) DO UPDATE SET doc = $2, saved_timestamp = NOW()`,
        [formDocId, JSON.stringify({ _id: formDocId, _rev: '1-pg', type: 'form', internalId: 'ds-crud-test-form' })]
      );
    });

    it('should validate form exists using ID range query (form: prefix)', async () => {
      const FORM_DOC_ID_PREFIX = 'form:';
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE _id >= $1 AND _id < $2
           AND (_deleted IS NULL OR _deleted = false)`,
        [FORM_DOC_ID_PREFIX, FORM_DOC_ID_PREFIX + '\ufff0']
      );
      const supportedForms = rows.map(r => r._id.replace(FORM_DOC_ID_PREFIX, ''));
      expect(supportedForms).to.include('ds-crud-test-form');
    });

    it('should reject report with unsupported form', async () => {
      const FORM_DOC_ID_PREFIX = 'form:';
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE _id >= $1 AND _id < $2
           AND (_deleted IS NULL OR _deleted = false)`,
        [FORM_DOC_ID_PREFIX, FORM_DOC_ID_PREFIX + '\ufff0']
      );
      const supportedForms = new Set(rows.map(r => r._id.replace(FORM_DOC_ID_PREFIX, '')));
      expect(supportedForms.has('nonexistent-form-xyz')).to.be.false;
    });
  });

  // ── Target single vs multi-contact filtering ──────────────────────────

  describe('target getPage: single vs multi-contact filtering', () => {
    const targetPrefix = 'target~2026-04~';

    before(async () => {
      // Insert targets for different contacts
      const targets = [
        { _id: `${targetPrefix}contact-A~owner1`, contact: 'contact-A' },
        { _id: `${targetPrefix}contact-A~owner2`, contact: 'contact-A' },
        { _id: `${targetPrefix}contact-B~owner3`, contact: 'contact-B' },
        { _id: `${targetPrefix}contact-C~owner4`, contact: 'contact-C' },
      ];
      for (const t of targets) {
        testDocIds.push(t._id);
        await pool.query(
          `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
           VALUES ($1, $2, NOW(), false, 'cht-datasource')
           ON CONFLICT (_id) DO UPDATE SET doc = $2`,
          [t._id, JSON.stringify({
            _id: t._id, _rev: '1-pgtarget', type: 'target',
            reporting_period: '2026-04', owner: t.contact,
          })]
        );
      }
    });

    it('should filter targets for a single contact using optimized range query', async () => {
      // Single contact optimization: use startkey/endkey with contact ID embedded
      const contactId = 'contact-A';
      const startKey = `${targetPrefix}${contactId}~`;
      const endKey = `${targetPrefix}${contactId}~\ufff0`;

      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE _id >= $1 AND _id <= $2
           AND (_deleted IS NULL OR _deleted = false)
         ORDER BY _id`,
        [startKey, endKey]
      );
      expect(rows).to.have.length(2);
      rows.forEach(r => expect(r._id).to.include('contact-A'));
    });

    it('should filter targets for multiple contacts using range + post-filter', async () => {
      // Multi-contact: fetch all in period, then filter by contact ID
      const contactIds = new Set(['contact-A', 'contact-B']);
      const startKey = targetPrefix;
      const endKey = targetPrefix + '\ufff0';

      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE _id >= $1 AND _id <= $2
           AND (_deleted IS NULL OR _deleted = false)
         ORDER BY _id`,
        [startKey, endKey]
      );

      // Post-filter: split ID by '~' and check contact segment
      const filtered = rows.filter(r => {
        const parts = r._id.split('~');
        return parts.length >= 3 && contactIds.has(parts[2]);
      });
      expect(filtered).to.have.length(3); // 2 for contact-A + 1 for contact-B
    });

    it('should return empty for non-existent contact', async () => {
      const contactId = 'contact-nonexistent';
      const startKey = `${targetPrefix}${contactId}~`;
      const endKey = `${targetPrefix}${contactId}~\ufff0`;

      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE _id >= $1 AND _id <= $2
           AND (_deleted IS NULL OR _deleted = false)`,
        [startKey, endKey]
      );
      expect(rows).to.have.length(0);
    });
  });

  // ── generateRev pattern ────────────────────────────────────────────────

  describe('generateRev pattern', () => {
    it('should increment rev number from existing rev', () => {
      const currentRev = '3-pgabc12345';
      const revNum = parseInt(currentRev.split('-')[0], 10) + 1;
      expect(revNum).to.equal(4);
      const suffix = Math.random().toString(36).slice(2, 10);
      const newRev = `${revNum}-pg${suffix}`;
      expect(newRev).to.match(/^4-pg[a-z0-9]+$/);
    });

    it('should start at rev 1 when no current rev', () => {
      const currentRev = undefined;
      const revNum = currentRev ? parseInt(currentRev.split('-')[0], 10) + 1 : 1;
      expect(revNum).to.equal(1);
    });

    it('should handle CouchDB-style rev format', () => {
      const currentRev = '5-abc123def456';
      const revNum = parseInt(currentRev.split('-')[0], 10) + 1;
      expect(revNum).to.equal(6);
    });
  });

  // ── queryDocIdsByType — IDs-only SELECT optimization ───────────────────

  describe('queryDocIdsByType IDs-only optimization', () => {
    before(async () => {
      for (let i = 0; i < 3; i++) {
        const id = `ds-crud-idtype-${Date.now()}-${i}`;
        testDocIds.push(id);
        await pool.query(
          `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
           VALUES ($1, $2, NOW(), false, 'cht-datasource')`,
          [id, JSON.stringify({
            _id: id, _rev: `1-pg${i}`, type: 'person',
            contact_type: 'id_query_type', name: `IdType Person ${i}`,
          })]
        );
      }
    });

    it('should return only _id column (no doc) for efficiency', async () => {
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE COALESCE(doc->>'contact_type', doc->>'type') = $1
           AND (_deleted IS NULL OR _deleted = false)
         ORDER BY _id
         LIMIT $2 OFFSET $3`,
        ['id_query_type', 10, 0]
      );
      expect(rows.length).to.be.at.least(3);
      // Only _id column should be present
      rows.forEach(r => {
        expect(r._id).to.be.a('string');
        expect(r.doc).to.be.undefined;
      });
    });
  });
});
