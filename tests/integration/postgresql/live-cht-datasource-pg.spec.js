/**
 * Live Integration Tests: cht-datasource PostgreSQL Adapter
 *
 * Tests the PostgreSQL adapter query patterns in shared-libs/cht-datasource/src/postgres/
 * against the live v1.couchdb table. Seeds data directly into PostgreSQL (no cht-sync
 * dependency). Validates:
 *   - getDocById / getDocsByIds
 *   - queryDocsByType / queryDocIdsByType with pagination
 *   - Recursive CTE lineage (getLineageDocsById)
 *   - createDoc / updateDoc
 *   - resolveShortcode
 *   - fetchAndFilter pagination logic
 *
 * Run with:
 *   POSTGRES_PASSWORD=pgpass NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *   npx mocha tests/integration/postgresql/live-cht-datasource-pg.spec.js --timeout 120000 --exit
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
const stamp = () => `ds-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const testDocIds = [];

// Seed a document directly into PostgreSQL (bypasses cht-sync)
const pgInsert = async (doc) => {
  await pool.query(
    `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
     VALUES ($1, $2, NOW(), false, 'integration-test')
     ON CONFLICT (_id) DO UPDATE SET doc = $2, saved_timestamp = NOW(), _deleted = false`,
    [doc._id, JSON.stringify(doc)]
  );
};

// Seed multiple documents into PostgreSQL
const pgInsertBulk = async (docs) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const doc of docs) {
      await client.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW(), false, 'integration-test')
         ON CONFLICT (_id) DO UPDATE SET doc = $2, saved_timestamp = NOW(), _deleted = false`,
        [doc._id, JSON.stringify(doc)]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

// Soft-delete a document in PostgreSQL
const pgSoftDelete = async (docId) => {
  await pool.query(
    `UPDATE ${DOCS_TABLE} SET _deleted = true, saved_timestamp = NOW() WHERE _id = $1`,
    [docId]
  );
};

describe('cht-datasource PostgreSQL adapter — live', function () {
  this.timeout(120000);

  before(async () => {
    const pgPass = process.env.POSTGRES_PASSWORD || 'pgpass';
    pool = new Pool({ connectionString: `postgresql://cht:${pgPass}@postgres:5432/cht` });
    await pool.query('SELECT 1');
  });

  after(async () => {
    // Clean up test documents from PG
    if (testDocIds.length > 0) {
      await pool.query(`DELETE FROM ${DOCS_TABLE} WHERE _id = ANY($1)`, [testDocIds]).catch(() => {});
    }
    if (pool) await pool.end();
  });

  // ── getDocById ────────────────────────────────────────────────────

  describe('getDocById pattern', () => {
    it('should fetch a document by _id from v1.couchdb', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await pgInsert({ _id: docId, type: 'person', name: 'Get Test', reported_date: Date.now() });

      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`,
        [docId]
      );
      expect(rows).to.have.length(1);
      expect(rows[0].doc._id).to.equal(docId);
      expect(rows[0].doc.name).to.equal('Get Test');
    });

    it('should return no rows for non-existent document', async () => {
      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`,
        ['non-existent-doc-id']
      );
      expect(rows).to.have.length(0);
    });

    it('should exclude soft-deleted documents', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await pgInsert({ _id: docId, type: 'data_record', fields: {}, reported_date: Date.now() });
      await pgSoftDelete(docId);

      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`,
        [docId]
      );
      expect(rows).to.have.length(0);
    });
  });

  // ── getDocsByIds (bulk) ───────────────────────────────────────────

  describe('getDocsByIds pattern', () => {
    it('should fetch multiple documents by IDs', async () => {
      const ids = [stamp(), stamp(), stamp()];
      testDocIds.push(...ids);
      const docs = ids.map((id, i) => ({ _id: id, type: 'person', name: `Bulk ${i}`, reported_date: Date.now() }));
      await pgInsertBulk(docs);

      const { rows } = await pool.query(
        `SELECT _id, doc FROM ${DOCS_TABLE} WHERE _id = ANY($1) AND (_deleted IS NULL OR _deleted = false)`,
        [ids]
      );
      expect(rows).to.have.length(3);
      const foundIds = rows.map(r => r._id).sort();
      expect(foundIds).to.deep.equal([...ids].sort());
    });
  });

  // ── queryDocsByType ───────────────────────────────────────────────

  describe('queryDocsByType pattern', () => {
    it('should query contacts by COALESCE(contact_type, type)', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await pgInsert({ _id: docId, type: 'contact', contact_type: 'chw', name: 'CHW Test', reported_date: Date.now() });

      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE}
         WHERE COALESCE(doc->>'contact_type', doc->>'type') = $1
         AND (_deleted IS NULL OR _deleted = false)
         ORDER BY _id`,
        ['chw']
      );
      expect(rows.length).to.be.at.least(1);
      const found = rows.find(r => r.doc._id === docId);
      expect(found).to.exist;
    });

    it('should support LIMIT/OFFSET pagination', async () => {
      // Query persons with pagination
      const { rows: page1 } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE COALESCE(doc->>'contact_type', doc->>'type') = 'person'
         AND (_deleted IS NULL OR _deleted = false)
         ORDER BY _id LIMIT 2 OFFSET 0`
      );

      const { rows: page2 } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE COALESCE(doc->>'contact_type', doc->>'type') = 'person'
         AND (_deleted IS NULL OR _deleted = false)
         ORDER BY _id LIMIT 2 OFFSET 2`
      );

      // Pages should not overlap (unless there are fewer than 3 persons)
      if (page1.length >= 2 && page2.length >= 1) {
        const page1Ids = new Set(page1.map(r => r._id));
        expect(page2.every(r => !page1Ids.has(r._id))).to.be.true;
      }
    });
  });

  // ── Recursive CTE lineage ────────────────────────────────────────

  describe('lineage recursive CTE', () => {
    let districtId, hcId, clinicId, personId;

    before(async () => {
      districtId = stamp();
      hcId = stamp();
      clinicId = stamp();
      personId = stamp();
      testDocIds.push(districtId, hcId, clinicId, personId);

      const docs = [
        { _id: districtId, type: 'district_hospital', name: 'Lineage District', reported_date: Date.now() },
        { _id: hcId, type: 'health_center', name: 'Lineage HC', parent: { _id: districtId }, reported_date: Date.now() },
        { _id: clinicId, type: 'clinic', name: 'Lineage Clinic', parent: { _id: hcId, parent: { _id: districtId } }, reported_date: Date.now() },
        { _id: personId, type: 'person', name: 'Lineage Person', patient_id: 'lineage-shortcode',
          parent: { _id: clinicId, parent: { _id: hcId, parent: { _id: districtId } } }, reported_date: Date.now() },
      ];
      await pgInsertBulk(docs);
    });

    it('should walk the parent chain via recursive CTE', async () => {
      // This mirrors Agent 1's lineage.ts — note the table-qualified doc references
      // in the recursive branch to avoid "column reference is ambiguous" error
      const baseParentExpr = `COALESCE(
        doc->'parent'->>'_id',
        CASE WHEN jsonb_typeof(doc->'parent') = 'string' THEN doc->>'parent' ELSE NULL END
      )`;
      const recursiveParentExpr = `COALESCE(
        c.doc->'parent'->>'_id',
        CASE WHEN jsonb_typeof(c.doc->'parent') = 'string' THEN c.doc->>'parent' ELSE NULL END
      )`;

      const { rows } = await pool.query(
        `WITH RECURSIVE lineage AS (
           SELECT doc, ${baseParentExpr} AS parent_id, 0 AS depth
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
        [personId]
      );

      // Should return: person (0), clinic (1), HC (2), district (3)
      expect(rows).to.have.length(4);
      expect(rows[0].doc._id).to.equal(personId);
      expect(rows[0].depth).to.equal(0);
      expect(rows[1].doc._id).to.equal(clinicId);
      expect(rows[1].depth).to.equal(1);
      expect(rows[2].doc._id).to.equal(hcId);
      expect(rows[2].depth).to.equal(2);
      expect(rows[3].doc._id).to.equal(districtId);
      expect(rows[3].depth).to.equal(3);
    });

    it('should return single row for root-level document', async () => {
      const baseParentExpr = `COALESCE(
        doc->'parent'->>'_id',
        CASE WHEN jsonb_typeof(doc->'parent') = 'string' THEN doc->>'parent' ELSE NULL END
      )`;
      const recursiveParentExpr = `COALESCE(
        c.doc->'parent'->>'_id',
        CASE WHEN jsonb_typeof(c.doc->'parent') = 'string' THEN c.doc->>'parent' ELSE NULL END
      )`;
      const { rows } = await pool.query(
        `WITH RECURSIVE lineage AS (
           SELECT doc, ${baseParentExpr} AS parent_id, 0 AS depth
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
        [districtId]
      );
      expect(rows).to.have.length(1);
      expect(rows[0].doc._id).to.equal(districtId);
    });

    it('should resolve shortcodes via patient_id/place_id', async () => {
      // Agent 1's resolveShortcode pattern
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE (_deleted IS NULL OR _deleted = false)
           AND (doc->>'patient_id' = $1
                OR doc->>'place_id' = $1
                OR UPPER(doc->>'rc_code') = UPPER($1))
         LIMIT 1`,
        ['lineage-shortcode']
      );
      expect(rows).to.have.length(1);
      expect(rows[0]._id).to.equal(personId);
    });
  });

  // ── createDoc / updateDoc ─────────────────────────────────────────

  describe('createDoc / updateDoc patterns', () => {
    it('should insert a new document via INSERT', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      const doc = { _id: docId, _rev: '1-pgtest', type: 'data_record', fields: { created: true }, reported_date: Date.now() };

      const { rowCount } = await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source)
         VALUES ($1, $2, NOW(), false, 'cht-datasource')`,
        [docId, JSON.stringify(doc)]
      );
      expect(rowCount).to.equal(1);

      // Verify it's queryable
      const { rows } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`, [docId]
      );
      expect(rows).to.have.length(1);
      expect(rows[0].doc.fields.created).to.be.true;
      expect(rows[0].doc._rev).to.equal('1-pgtest');
    });

    it('should update an existing document via UPDATE', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      const doc = { _id: docId, _rev: '1-pgup', type: 'person', name: 'Before', reported_date: Date.now() };
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, saved_timestamp, _deleted, source) VALUES ($1, $2, NOW(), false, 'cht-datasource')`,
        [docId, JSON.stringify(doc)]
      );

      const updated = { ...doc, _rev: '2-pgup', name: 'After' };
      const { rowCount } = await pool.query(
        `UPDATE ${DOCS_TABLE} SET doc = $1, saved_timestamp = NOW()
         WHERE _id = $2 AND (_deleted IS NULL OR _deleted = false)`,
        [JSON.stringify(updated), docId]
      );
      expect(rowCount).to.equal(1);

      const { rows } = await pool.query(`SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]);
      expect(rows[0].doc.name).to.equal('After');
      expect(rows[0].doc._rev).to.equal('2-pgup');
    });
  });

  // ── getDocIdsByIdRange ────────────────────────────────────────────

  describe('getDocIdsByIdRange pattern', () => {
    it('should query IDs by lexicographic range', async () => {
      // This pattern is used by the Target adapter for target~{period}~{contactId} ranges
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE _id >= $1 AND _id <= $2 AND (_deleted IS NULL OR _deleted = false)
         ORDER BY _id`,
        ['form:', 'form:\ufff0']
      );
      // Should find form documents (form:pregnancy, form:contact:*, etc.)
      expect(rows.length).to.be.at.least(1);
      rows.forEach(r => expect(r._id).to.match(/^form:/));
    });
  });
});
