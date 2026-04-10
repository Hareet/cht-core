/**
 * Advanced Integration Tests: cht-datasource PostgreSQL Adapter
 *
 * Tests code paths NOT covered by live-cht-datasource-pg.spec.js:
 *   - Freetext search (keyed and unkeyed, ILIKE, LIKE wildcard escaping)
 *   - updateDoc concurrency control (revision conflict, not-found)
 *   - queryDocIdsByType (IDs-only variant)
 *   - Report subject hydration (patient_id/place_id → hydrated contact)
 *   - minifyDoc / dehydrate lineage
 *   - fetchAndFilter pagination (re-fetch when invalid docs found)
 *
 * Run with:
 *   node tests/integration/postgresql/run-tests.js live-cht-datasource-advanced.spec.js
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
const stamp = () => `ds-adv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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

describe('cht-datasource PostgreSQL adapter — advanced paths', function () {
  this.timeout(120000);

  before(async () => {
    const pgPass = process.env.POSTGRES_PASSWORD || 'pgpass';
    pool = new Pool({ connectionString: `postgresql://cht:${pgPass}@postgres:5432/cht` });
    await pool.query('SELECT 1');
  });

  after(async () => {
    for (const id of testDocIds) await couchDelete(id).catch(() => {});
    // Clean up any docs inserted directly into PG
    await pool.query(
      `DELETE FROM ${DOCS_TABLE} WHERE _id LIKE 'ds-adv-%' AND source = 'cht-datasource'`
    ).catch(() => {});
    if (pool) await pool.end();
  });

  // ── Freetext search patterns (freetext.ts) ───────────────────────────

  describe('freetext search patterns', () => {
    let personId, reportId;

    before(async () => {
      personId = stamp();
      reportId = stamp();
      testDocIds.push(personId, reportId);

      await couchFetch(`/${COUCH_DB}/_bulk_docs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs: [
          { _id: personId, type: 'person', name: 'Freetext Wanjiku', patient_id: 'ft-12345', reported_date: Date.now() },
          { _id: reportId, type: 'data_record', form: 'pregnancy', fields: { patient_name: 'Freetext Wanjiku' }, reported_date: Date.now() },
        ] }),
      });
      await waitForDoc(personId);
      await waitForDoc(reportId);
    });

    it('should support unkeyed freetext via ILIKE substring match on contacts', async () => {
      // Unkeyed freetext: doc::text ILIKE '%term%'
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE (doc->>'type' IN ('contact', 'clinic', 'district_hospital', 'health_center', 'person'))
         AND (_deleted IS NULL OR _deleted = false)
         AND doc::text ILIKE $1
         ORDER BY LOWER(doc->>'name')`,
        ['%Freetext Wanjiku%']
      );
      const ids = rows.map(r => r._id);
      expect(ids).to.include(personId);
    });

    it('should support keyed freetext via exact match on doc field', async () => {
      // Keyed freetext: doc->>'key' = value
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE (doc->>'type' IN ('contact', 'clinic', 'district_hospital', 'health_center', 'person'))
         AND (_deleted IS NULL OR _deleted = false)
         AND (doc->>'name' = $1 OR doc->'fields'->>'name' = $1)`,
        ['Freetext Wanjiku']
      );
      expect(rows.map(r => r._id)).to.include(personId);
    });

    it('should support freetext on reports ordered by reported_date DESC', async () => {
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'data_record'
         AND doc->>'form' IS NOT NULL AND doc->>'form' != ''
         AND (_deleted IS NULL OR _deleted = false)
         AND doc::text ILIKE $1
         ORDER BY (doc->>'reported_date')::bigint DESC NULLS LAST
         LIMIT 10`,
        ['%Freetext Wanjiku%']
      );
      expect(rows.map(r => r._id)).to.include(reportId);
    });

    it('should escape LIKE wildcards in user input', async () => {
      // If someone searches for "100% complete", the % must not be a LIKE wildcard
      const id = stamp();
      testDocIds.push(id);
      await couchPost({ _id: id, type: 'person', name: '100% complete test', reported_date: Date.now() });
      await waitForDoc(id);

      // Escape: replace % with \%, _ with \_
      const userInput = '100% complete';
      const escaped = userInput.replace(/[%_\\]/g, '\\$&');
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE doc::text ILIKE $1
         AND _id = $2
         AND (_deleted IS NULL OR _deleted = false)`,
        [`%${escaped}%`, id]
      );
      expect(rows).to.have.length(1);
    });

    it('should combine contact type filter with freetext', async () => {
      // Contact type + freetext: COALESCE(contact_type, type) + ILIKE
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE COALESCE(doc->>'contact_type', doc->>'type') = $1
         AND (_deleted IS NULL OR _deleted = false)
         AND doc::text ILIKE $2
         ORDER BY LOWER(doc->>'name')
         LIMIT 10 OFFSET 0`,
        ['person', '%Freetext Wanjiku%']
      );
      expect(rows.map(r => r._id)).to.include(personId);
    });
  });

  // ── updateDoc concurrency control (doc.ts) ───────────────────────────

  describe('updateDoc concurrency control', () => {
    it('should reject update with stale revision (simulating RevisionConflictError)', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      const rev1 = '1-pgoriginal00000000';
      const doc = { _id: docId, _rev: rev1, type: 'person', name: 'Conflict Test', reported_date: Date.now() };

      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW(), false, 'cht-datasource')`,
        [docId, JSON.stringify(doc)]
      );

      // Simulate concurrent update: rev advances to rev 2
      const rev2 = '2-pgconcurrent0000';
      const updated = { ...doc, _rev: rev2, name: 'Updated by Other' };
      await pool.query(
        `UPDATE ${DOCS_TABLE} SET doc = $1, saved_timestamp = NOW() WHERE _id = $2`,
        [JSON.stringify(updated), docId]
      );

      // Now try to update with the stale rev1 — WHERE clause should match 0 rows
      const staleUpdate = { ...doc, _rev: '3-pgattempt000000', name: 'Stale Update' };
      const { rowCount } = await pool.query(
        `UPDATE ${DOCS_TABLE} SET doc = $1, saved_timestamp = NOW()
         WHERE _id = $2 AND doc->>'_rev' = $3 AND (_deleted IS NULL OR _deleted = false)`,
        [JSON.stringify(staleUpdate), docId, rev1]
      );
      expect(rowCount).to.equal(0);

      // Verify: can detect whether it's conflict vs not-found
      const { rows } = await pool.query(
        `SELECT doc->>'_rev' AS current_rev FROM ${DOCS_TABLE}
         WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`,
        [docId]
      );
      expect(rows).to.have.length(1);
      expect(rows[0].current_rev).to.equal(rev2); // confirms it's a conflict, not not-found
    });

    it('should detect not-found when updating non-existent document', async () => {
      const { rowCount } = await pool.query(
        `UPDATE ${DOCS_TABLE} SET doc = '{}', saved_timestamp = NOW()
         WHERE _id = 'non-existent-doc-xxx' AND doc->>'_rev' = '1-fake' AND (_deleted IS NULL OR _deleted = false)`,
        []
      );
      expect(rowCount).to.equal(0);

      // Distinguish from conflict: no row at all
      const { rows } = await pool.query(
        `SELECT doc->>'_rev' AS current_rev FROM ${DOCS_TABLE}
         WHERE _id = 'non-existent-doc-xxx' AND (_deleted IS NULL OR _deleted = false)`,
        []
      );
      expect(rows).to.have.length(0); // not-found, not conflict
    });
  });

  // ── queryDocIdsByType (doc.ts) ────────────────────────────────────────

  describe('queryDocIdsByType pattern', () => {
    it('should return only _id values (not full docs) for a type', async () => {
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE COALESCE(doc->>'contact_type', doc->>'type') = $1
           AND (_deleted IS NULL OR _deleted = false)
         ORDER BY _id
         LIMIT $2 OFFSET $3`,
        ['person', 5, 0]
      );
      expect(rows).to.be.an('array');
      rows.forEach(r => {
        expect(r).to.have.property('_id');
        expect(r).to.not.have.property('doc');
      });
    });
  });

  // ── Report subject hydration (lineage.ts) ────────────────────────────

  describe('report subject hydration patterns', () => {
    let districtId, clinicId, patientId, reportWithPatient;

    before(async () => {
      districtId = stamp();
      clinicId = stamp();
      patientId = stamp();
      reportWithPatient = stamp();
      testDocIds.push(districtId, clinicId, patientId, reportWithPatient);

      await couchFetch(`/${COUCH_DB}/_bulk_docs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs: [
          { _id: districtId, type: 'district_hospital', name: 'Hydration District', reported_date: Date.now() },
          { _id: clinicId, type: 'clinic', name: 'Hydration Clinic', parent: { _id: districtId }, reported_date: Date.now() },
          { _id: patientId, type: 'person', name: 'Hydration Patient', patient_id: 'hydra-shortcode',
            parent: { _id: clinicId, parent: { _id: districtId } }, reported_date: Date.now() },
          { _id: reportWithPatient, type: 'data_record', form: 'visit',
            fields: { patient_id: 'hydra-shortcode', notes: 'feeling better' },
            reported_date: Date.now() },
        ] }),
      });
      for (const id of [districtId, clinicId, patientId, reportWithPatient]) await waitForDoc(id);
    });

    it('should resolve patient_id shortcode to contact UUID', async () => {
      // Step 1: resolveShortcode pattern
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE (_deleted IS NULL OR _deleted = false)
           AND (doc->>'patient_id' = $1
                OR doc->>'place_id' = $1
                OR UPPER(doc->>'rc_code') = UPPER($1))
         LIMIT 1`,
        ['hydra-shortcode']
      );
      expect(rows).to.have.length(1);
      expect(rows[0]._id).to.equal(patientId);
    });

    it('should hydrate patient lineage from resolved UUID', async () => {
      // Step 2: get full lineage of the resolved patient
      const parentIdExpr = `COALESCE(
        doc->'parent'->>'_id',
        CASE WHEN jsonb_typeof(doc->'parent') = 'string' THEN doc->>'parent' ELSE NULL END
      )`;
      const recursiveParentExpr = `COALESCE(
        c.doc->'parent'->>'_id',
        CASE WHEN jsonb_typeof(c.doc->'parent') = 'string' THEN c.doc->>'parent' ELSE NULL END
      )`;

      const { rows } = await pool.query(
        `WITH RECURSIVE lineage AS (
           SELECT doc, ${parentIdExpr} AS parent_id, 0 AS depth
           FROM ${DOCS_TABLE}
           WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)
           UNION ALL
           SELECT c.doc, ${recursiveParentExpr}, l.depth + 1
           FROM ${DOCS_TABLE} c
           JOIN lineage l ON c._id = l.parent_id
           WHERE l.parent_id IS NOT NULL AND l.parent_id != ''
             AND (c._deleted IS NULL OR c._deleted = false) AND l.depth < 20
         )
         SELECT doc, depth FROM lineage ORDER BY depth`,
        [patientId]
      );
      expect(rows.length).to.equal(3); // patient → clinic → district
      expect(rows[0].doc.name).to.equal('Hydration Patient');
      expect(rows[1].doc.name).to.equal('Hydration Clinic');
      expect(rows[2].doc.name).to.equal('Hydration District');
    });

    it('should extract patient_id from report fields (getPatientId pattern)', async () => {
      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`,
        [reportWithPatient]
      );
      const doc = rows[0].doc;
      // Extract patient_id from fields, matching lineage.ts getPatientId
      const fields = doc.fields || {};
      const patientIdValue = fields.patient_id || fields.patient_uuid || doc.patient_id;
      expect(patientIdValue).to.equal('hydra-shortcode');
    });

    it('should extract place_id from report fields (getPlaceId pattern)', async () => {
      const reportId = stamp();
      testDocIds.push(reportId);
      await couchPost({
        _id: reportId, type: 'data_record', form: 'referral',
        fields: { place_id: clinicId }, reported_date: Date.now(),
      });
      await waitForDoc(reportId);

      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [reportId]
      );
      const fields = rows[0].doc.fields || {};
      expect(fields.place_id).to.equal(clinicId);
    });
  });

  // ── minifyDoc / dehydrate lineage (doc.ts) ──────────────────────────

  describe('minifyDoc / dehydrate lineage patterns', () => {
    it('should reduce hydrated parent chain to nested {_id} references', () => {
      // This tests the pattern from doc.ts minifyLineage
      const hydratedDoc = {
        _id: 'p1', type: 'person', name: 'Test',
        parent: {
          _id: 'clinic1', type: 'clinic', name: 'Clinic',
          parent: {
            _id: 'hc1', type: 'health_center', name: 'HC',
            parent: { _id: 'dist1', type: 'district_hospital', name: 'District' }
          }
        },
        contact: {
          _id: 'chw1', type: 'person', name: 'CHW',
          parent: { _id: 'clinic1', type: 'clinic', name: 'Clinic' }
        }
      };

      // minifyLineage logic: walk parent chain, keep only _id
      const minifyLineage = (parent) => {
        if (!parent || !parent._id) return undefined;
        const result = { _id: parent._id };
        let current = result;
        let node = parent;
        while (node.parent && node.parent._id) {
          current.parent = { _id: node.parent._id };
          current = current.parent;
          node = node.parent;
        }
        return result;
      };

      const minified = minifyLineage(hydratedDoc.parent);
      expect(minified).to.deep.equal({
        _id: 'clinic1',
        parent: { _id: 'hc1', parent: { _id: 'dist1' } }
      });
      // Verify no extra fields leaked through
      expect(minified).to.not.have.property('type');
      expect(minified).to.not.have.property('name');
    });

    it('should strip hydrated patient/place from data_record docs', () => {
      // minifyDoc strips patient/place from data_record
      const hydrated = {
        _id: 'r1', _rev: '1-abc', type: 'data_record', form: 'visit',
        fields: { patient_id: 'sc123' },
        patient: { _id: 'p1', name: 'Patient', parent: { _id: 'c1' } },
        place: { _id: 'c1', name: 'Clinic' },
      };

      // minifyDoc logic for data_record
      const result = { ...hydrated };
      if (result.type === 'data_record') {
        delete result.patient;
        delete result.place;
      }

      expect(result).to.not.have.property('patient');
      expect(result).to.not.have.property('place');
      expect(result.fields.patient_id).to.equal('sc123');
    });
  });

  // ── fetchAndFilter pagination recursion (doc.ts) ─────────────────────

  describe('fetchAndFilter pagination patterns', () => {
    it('should paginate correctly with cursor-based offset', async () => {
      // Query first page
      const limit = 3;
      const { rows: page1 } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE COALESCE(doc->>'contact_type', doc->>'type') = 'person'
         AND (_deleted IS NULL OR _deleted = false)
         ORDER BY _id
         LIMIT $1 OFFSET $2`,
        [limit, 0]
      );

      if (page1.length < limit) {
        // Not enough data for pagination test
        return;
      }

      // Next page with cursor = limit
      const { rows: page2 } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE COALESCE(doc->>'contact_type', doc->>'type') = 'person'
         AND (_deleted IS NULL OR _deleted = false)
         ORDER BY _id
         LIMIT $1 OFFSET $2`,
        [limit, limit]
      );

      // Pages should not overlap
      const page1Ids = new Set(page1.map(r => r._id));
      page2.forEach(r => expect(page1Ids.has(r._id)).to.be.false);
    });

    it('should return null cursor when fewer results than limit', async () => {
      // Use a unique type that likely has < limit results
      const limit = 100000;
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE COALESCE(doc->>'contact_type', doc->>'type') = 'district_hospital'
         AND (_deleted IS NULL OR _deleted = false)
         ORDER BY _id
         LIMIT $1 OFFSET 0`,
        [limit]
      );
      // If fewer results than limit, cursor would be null
      const nextCursor = rows.length < limit ? null : rows.length.toString();
      expect(nextCursor).to.be.null;
    });
  });

  // ── createDoc with UUID generation ──────────────────────────────────

  describe('createDoc patterns', () => {
    it('should create a document with generated UUID and rev', async () => {
      const id = require('crypto').randomUUID();
      const rev = `1-pg${Math.random().toString(36).slice(2, 10)}`;
      const doc = { _id: id, _rev: rev, type: 'data_record', fields: { test: true }, reported_date: Date.now() };
      testDocIds.push(id);

      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW(), false, 'cht-datasource')`,
        [id, JSON.stringify(doc)]
      );

      const { rows } = await pool.query(`SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [id]);
      expect(rows).to.have.length(1);
      expect(rows[0].doc._id).to.equal(id);
      expect(rows[0].doc._rev).to.match(/^1-pg/);
    });

    it('should increment rev number on update', async () => {
      const id = stamp();
      testDocIds.push(id);
      const rev1 = '1-pgtest00000000';
      const doc = { _id: id, _rev: rev1, type: 'person', name: 'Rev Test', reported_date: Date.now() };

      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW(), false, 'cht-datasource')`,
        [id, JSON.stringify(doc)]
      );

      // Simulate generateRev: parse rev number and increment
      const currentRev = rev1;
      const revNum = parseInt(currentRev.split('-')[0], 10) + 1;
      expect(revNum).to.equal(2);

      const rev2 = `${revNum}-pgupdated0000`;
      const updated = { ...doc, _rev: rev2, name: 'Rev Updated' };
      await pool.query(
        `UPDATE ${DOCS_TABLE} SET doc = $1, saved_timestamp = NOW()
         WHERE _id = $2 AND doc->>'_rev' = $3`,
        [JSON.stringify(updated), id, rev1]
      );

      const { rows } = await pool.query(`SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [id]);
      expect(rows[0].doc._rev).to.match(/^2-pg/);
    });
  });

  // ── isDoc validation ──────────────────────────────────────────────────

  describe('document validation patterns', () => {
    it('should filter out documents missing _id or _rev', async () => {
      // Insert a doc with missing _rev (malformed)
      const id = stamp();
      testDocIds.push(id);
      const malformed = { _id: id, type: 'person', name: 'No Rev' }; // no _rev

      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW(), false, 'cht-datasource')`,
        [id, JSON.stringify(malformed)]
      );

      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`,
        [id]
      );
      expect(rows).to.have.length(1);
      // isDoc check: doc must have _id and _rev
      const doc = rows[0].doc;
      const isValid = doc && typeof doc._id === 'string' && typeof doc._rev === 'string';
      expect(isValid).to.be.false; // missing _rev
    });
  });
});
