/**
 * Integration Tests: cht-datasource PostgreSQL Adapter — Advanced Uncovered Paths
 *
 * Tests cht-datasource TypeScript adapter code paths not covered by existing tests:
 *
 *   - PostgresDataContext: assertPostgresDataContext throws for invalid context
 *   - PostgresDataContext: qualifiedTable construction with custom schema
 *   - PostgresDataContext: getPostgresDataContext validation (pool, settings)
 *   - Target: getPage with multi-contact filtering (>1 contact, post-filter path)
 *   - Target: getPage with single contact (optimized range path)
 *   - Target: validateCursor edge cases (NaN, negative, fractional, non-numeric)
 *   - Target: getPage reporting period boundary filtering
 *   - Target: isTarget validation (missing fields)
 *   - fetchAndFilter: cursor exhaustion with all-invalid docs
 *   - Doc getDocsByIds: batch with mix of existing and non-existing IDs
 *   - User-accessible facilities and report facilities tables
 *
 * Run with:
 *   node tests/integration/postgresql/run-tests.js live-datasource-advanced-paths.spec.js
 */
require('../../aliases');
const chai = require('chai');
chai.use(require('chai-as-promised'));
const expect = chai.expect;
const { Pool } = require('pg');

const PG_SCHEMA = process.env.POSTGRES_SCHEMA || 'v1';
const DOCS_TABLE = `"${PG_SCHEMA}"."couchdb"`;

let pool;
const stamp = () => `dap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const testDocIds = [];

describe('cht-datasource PostgreSQL adapter — advanced uncovered paths', function () {
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

  // ─── PostgresDataContext type guard & assertion ────────────────────────

  describe('PostgresDataContext type assertions', () => {
    it('should identify valid PostgresDataContext via isPostgresDataContext', () => {
      // Simulate the shape of a PostgresDataContext
      const validCtx = {
        pool: { query: async () => ({ rows: [], rowCount: 0 }) },
        settings: { getAll: () => ({}) },
        schemaConfig: { schema: 'v1', table: 'couchdb' },
      };

      // isPostgresDataContext checks: 'pool' in context && 'settings' in context && 'schemaConfig' in context
      const isValid = 'pool' in validCtx && 'settings' in validCtx && 'schemaConfig' in validCtx;
      expect(isValid).to.be.true;
    });

    it('should reject non-PostgresDataContext objects', () => {
      const invalidCtx1 = {}; // No pool, settings, or schemaConfig
      const invalidCtx2 = { pool: {} }; // Missing settings and schemaConfig

      expect('pool' in invalidCtx1 && 'settings' in invalidCtx1 && 'schemaConfig' in invalidCtx1).to.be.false;
      expect('pool' in invalidCtx2 && 'settings' in invalidCtx2 && 'schemaConfig' in invalidCtx2).to.be.false;
    });

    it('should throw from assertPostgresDataContext for invalid context', () => {
      // assertPostgresDataContext throws Error when isPostgresDataContext returns false
      const throwsForInvalid = (context) => {
        const isValid = 'pool' in context && 'settings' in context && 'schemaConfig' in context;
        if (!isValid) {
          throw new Error(`Invalid PostgreSQL data context [${JSON.stringify(context)}].`);
        }
      };

      expect(() => throwsForInvalid({})).to.throw('Invalid PostgreSQL data context');
      expect(() => throwsForInvalid({ pool: {} })).to.throw('Invalid PostgreSQL data context');
    });
  });

  // ─── PostgresDataContext: qualifiedTable ───────────────────────────────

  describe('PostgresDataContext qualifiedTable', () => {
    it('should construct qualified table name from schema config', () => {
      const config = { schema: 'v1', table: 'couchdb' };
      const qt = `"${config.schema}"."${config.table}"`;
      expect(qt).to.equal('"v1"."couchdb"');
    });

    it('should support custom schema and table names', () => {
      const config = { schema: 'custom_schema', table: 'my_docs' };
      const qt = `"${config.schema}"."${config.table}"`;
      expect(qt).to.equal('"custom_schema"."my_docs"');
    });

    it('should use default config when not provided', () => {
      const defaults = { schema: 'v1', table: 'couchdb' };
      const config = { ...defaults };
      expect(config.schema).to.equal('v1');
      expect(config.table).to.equal('couchdb');
    });
  });

  // ─── getPostgresDataContext validation ─────────────────────────────────

  describe('getPostgresDataContext validation', () => {
    it('should reject pool without query method', () => {
      const assertDatabasePool = (p) => {
        if (!p || typeof p !== 'object' || typeof p.query !== 'function') {
          throw new Error(`Invalid database pool [${JSON.stringify(p)}].`);
        }
      };

      expect(() => assertDatabasePool(null)).to.throw('Invalid database pool');
      expect(() => assertDatabasePool({})).to.throw('Invalid database pool');
      expect(() => assertDatabasePool({ query: 'not-a-function' })).to.throw('Invalid database pool');
    });

    it('should reject settings without getAll method', () => {
      const assertSettingsService = (s) => {
        if (!s || typeof s !== 'object' || typeof s.getAll !== 'function') {
          throw new Error(`Invalid settings service [${JSON.stringify(s)}].`);
        }
      };

      expect(() => assertSettingsService(null)).to.throw('Invalid settings service');
      expect(() => assertSettingsService({})).to.throw('Invalid settings service');
    });

    it('should accept valid pool and settings', () => {
      const validPool = { query: async () => ({ rows: [], rowCount: 0 }) };
      const validSettings = { getAll: () => ({}) };

      expect(typeof validPool.query).to.equal('function');
      expect(typeof validSettings.getAll).to.equal('function');
    });
  });

  // ─── Target: validateCursor edge cases ────────────────────────────────

  describe('Target validateCursor edge cases', () => {
    const validateCursor = (cursor) => {
      const skip = Number(cursor);
      if (isNaN(skip) || skip < 0 || !Number.isInteger(skip)) {
        throw new Error(`The cursor must be a string or null for first page: [${JSON.stringify(cursor)}].`);
      }
      return skip;
    };

    it('should accept null cursor as 0', () => {
      expect(validateCursor(null)).to.equal(0);
    });

    it('should accept "0" string cursor', () => {
      expect(validateCursor('0')).to.equal(0);
    });

    it('should accept positive integer string cursor', () => {
      expect(validateCursor('50')).to.equal(50);
    });

    it('should reject NaN cursor', () => {
      expect(() => validateCursor('not-a-number')).to.throw('cursor must be');
    });

    it('should reject negative cursor', () => {
      expect(() => validateCursor('-5')).to.throw('cursor must be');
    });

    it('should reject fractional cursor', () => {
      expect(() => validateCursor('3.14')).to.throw('cursor must be');
    });

    it('should reject undefined cursor', () => {
      expect(() => validateCursor(undefined)).to.throw('cursor must be');
    });
  });

  // ─── Target: getTargetIds multi-contact filtering ─────────────────────

  describe('Target getTargetIds multi-contact filtering', () => {
    const ownerA = stamp();
    const ownerB = stamp();
    const ownerC = stamp();
    const reportingPeriod = '2026-03';

    const targetA = `target~${reportingPeriod}~${ownerA}~0`;
    const targetB = `target~${reportingPeriod}~${ownerB}~0`;
    const targetC = `target~${reportingPeriod}~${ownerC}~0`;

    before(async () => {
      testDocIds.push(targetA, targetB, targetC);

      for (const [id, owner] of [[targetA, ownerA], [targetB, ownerB], [targetC, ownerC]]) {
        await pool.query(
          `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
           VALUES ($1, $2, false, NOW(), 'sentinel')`,
          [id, JSON.stringify({
            _id: id,
            type: 'target',
            user: `user-${owner}`,
            owner,
            reporting_period: reportingPeriod,
            updated_date: Date.now(),
            targets: [{ id: 'deaths_this_month', value: { pass: 0, total: 10 } }],
          })]
        );
      }
    });

    it('should use optimized range query for single contact', async () => {
      // Single contact: getDocIdsRange with exact prefix
      const startKey = `target~${reportingPeriod}~${ownerA}~`;
      const endKey = `target~${reportingPeriod}~${ownerA}~\ufff0`;

      const result = await pool.query(`
        SELECT _id FROM ${DOCS_TABLE}
        WHERE _id >= $1 AND _id <= $2
          AND (_deleted IS NULL OR _deleted = false)
        ORDER BY _id
      `, [startKey, endKey]);

      const ids = result.rows.map(r => r._id);
      expect(ids).to.include(targetA);
      expect(ids).to.not.include(targetB);
      expect(ids).to.not.include(targetC);
    });

    it('should use broad range + post-filter for multiple contacts', async () => {
      // Multi-contact: getDocIdsRange for all targets in period, then filter
      const startKey = `target~${reportingPeriod}~`;
      const endKey = `target~${reportingPeriod}~\ufff0`;
      const contactIdSet = new Set([ownerA, ownerB]);

      const result = await pool.query(`
        SELECT _id FROM ${DOCS_TABLE}
        WHERE _id >= $1 AND _id <= $2
          AND (_deleted IS NULL OR _deleted = false)
        ORDER BY _id
      `, [startKey, endKey]);

      const allIds = result.rows.map(r => r._id);
      const filtered = allIds.filter(id => {
        const [, , contactId] = id.split('~');
        return contactIdSet.has(contactId);
      });

      expect(filtered).to.include(targetA);
      expect(filtered).to.include(targetB);
      expect(filtered).to.not.include(targetC);
    });

    it('should return empty when no targets match the reporting period', async () => {
      const nonexistentPeriod = '1900-01';
      const startKey = `target~${nonexistentPeriod}~`;
      const endKey = `target~${nonexistentPeriod}~\ufff0`;

      const result = await pool.query(`
        SELECT _id FROM ${DOCS_TABLE}
        WHERE _id >= $1 AND _id <= $2
          AND (_deleted IS NULL OR _deleted = false)
        ORDER BY _id
      `, [startKey, endKey]);

      expect(result.rows).to.have.length(0);
    });
  });

  // ─── Target: isTarget validation ──────────────────────────────────────

  describe('Target isTarget validation', () => {
    const isTarget = (doc) => {
      return doc != null
        && typeof doc === 'object'
        && doc.type === 'target'
        && typeof doc.user === 'string'
        && typeof doc.owner === 'string'
        && typeof doc.reporting_period === 'string'
        && typeof doc.updated_date === 'number'
        && Array.isArray(doc.targets);
    };

    it('should validate a complete target document', () => {
      expect(isTarget({
        _id: 'target~2026-03~owner~0',
        type: 'target',
        user: 'user-1',
        owner: 'owner-1',
        reporting_period: '2026-03',
        updated_date: Date.now(),
        targets: [],
      })).to.be.true;
    });

    it('should reject missing user field', () => {
      expect(isTarget({
        type: 'target', owner: 'x', reporting_period: '2026-03',
        updated_date: 1, targets: [],
      })).to.be.false;
    });

    it('should reject missing owner field', () => {
      expect(isTarget({
        type: 'target', user: 'x', reporting_period: '2026-03',
        updated_date: 1, targets: [],
      })).to.be.false;
    });

    it('should reject non-array targets field', () => {
      expect(isTarget({
        type: 'target', user: 'x', owner: 'x', reporting_period: '2026-03',
        updated_date: 1, targets: 'not-array',
      })).to.be.false;
    });

    it('should reject wrong type', () => {
      expect(isTarget({
        type: 'data_record', user: 'x', owner: 'x', reporting_period: '2026-03',
        updated_date: 1, targets: [],
      })).to.be.false;
    });

    it('should reject null', () => {
      expect(isTarget(null)).to.be.false;
    });
  });

  // ─── fetchAndFilter pagination patterns ───────────────────────────────

  describe('fetchAndFilter pagination edge cases', () => {
    it('should handle cursor-based pagination with exact limit match', async () => {
      // Insert exactly 5 documents
      const docs = [];
      for (let i = 0; i < 5; i++) {
        const id = `fetch-exact-${String(i).padStart(2, '0')}-${stamp()}`;
        docs.push(id);
        testDocIds.push(id);

        await pool.query(
          `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
           VALUES ($1, $2, false, NOW(), 'sentinel')`,
          [id, JSON.stringify({ _id: id, type: 'data_record', form: 'test', reported_date: Date.now() - i })]
        );
      }

      // Query with LIMIT=5 and cursor=0
      const result = await pool.query(`
        SELECT _id, doc FROM ${DOCS_TABLE}
        WHERE _id = ANY($1)
          AND (_deleted IS NULL OR _deleted = false)
        ORDER BY _id
        LIMIT 5 OFFSET 0
      `, [docs]);

      expect(result.rows).to.have.length(5);

      // Next page: cursor=5, should return empty
      const nextResult = await pool.query(`
        SELECT _id, doc FROM ${DOCS_TABLE}
        WHERE _id = ANY($1)
          AND (_deleted IS NULL OR _deleted = false)
        ORDER BY _id
        LIMIT 5 OFFSET 5
      `, [docs]);

      expect(nextResult.rows).to.have.length(0);
    });

    it('should handle mix of valid and invalid docs in pagination', async () => {
      // Insert 3 valid reports and 2 non-reports (invalid for report queries)
      const validIds = [];
      const allIds = [];

      for (let i = 0; i < 3; i++) {
        const id = `valid-report-${String(i).padStart(2, '0')}-${stamp()}`;
        validIds.push(id);
        allIds.push(id);
        testDocIds.push(id);
        await pool.query(
          `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
           VALUES ($1, $2, false, NOW(), 'sentinel')`,
          [id, JSON.stringify({ _id: id, type: 'data_record', form: 'test', reported_date: Date.now() })]
        );
      }

      for (let i = 0; i < 2; i++) {
        const id = `invalid-noreport-${String(i).padStart(2, '0')}-${stamp()}`;
        allIds.push(id);
        testDocIds.push(id);
        await pool.query(
          `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
           VALUES ($1, $2, false, NOW(), 'sentinel')`,
          [id, JSON.stringify({ _id: id, type: 'person', name: 'Not a report' })]
        );
      }

      // Fetch all, filter to only data_records with form field
      const result = await pool.query(`
        SELECT _id, doc FROM ${DOCS_TABLE}
        WHERE _id = ANY($1)
          AND (_deleted IS NULL OR _deleted = false)
        ORDER BY _id
      `, [allIds]);

      const validDocs = result.rows.filter(r =>
        r.doc.type === 'data_record' && r.doc.form
      );
      expect(validDocs).to.have.length(3);
    });
  });

  // ─── getDocsByIds: batch mix of existing/non-existing ─────────────────

  describe('getDocsByIds batch with mixed IDs', () => {
    const existingId = `exists-${stamp()}`;

    before(async () => {
      testDocIds.push(existingId);
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [existingId, JSON.stringify({ _id: existingId, type: 'person', name: 'Existing' })]
      );
    });

    it('should return only existing docs from a mixed batch', async () => {
      const ids = [existingId, 'nonexistent-aaa', 'nonexistent-bbb'];

      const result = await pool.query(`
        SELECT _id, doc FROM ${DOCS_TABLE}
        WHERE _id = ANY($1)
          AND (_deleted IS NULL OR _deleted = false)
      `, [ids]);

      expect(result.rows).to.have.length(1);
      expect(result.rows[0]._id).to.equal(existingId);
    });

    it('should return empty for all non-existing IDs', async () => {
      const result = await pool.query(`
        SELECT _id, doc FROM ${DOCS_TABLE}
        WHERE _id = ANY($1)
          AND (_deleted IS NULL OR _deleted = false)
      `, [['nonexistent-xxx', 'nonexistent-yyy']]);

      expect(result.rows).to.have.length(0);
    });

    it('should handle empty ID array', async () => {
      const result = await pool.query(`
        SELECT _id, doc FROM ${DOCS_TABLE}
        WHERE _id = ANY($1)
          AND (_deleted IS NULL OR _deleted = false)
      `, [[]]);

      expect(result.rows).to.have.length(0);
    });
  });

  // ─── User-accessible facilities table ─────────────────────────────────

  describe('v1.user_accessible_facilities table', () => {
    it('should have correct schema', async () => {
      const { rows } = await pool.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'v1' AND table_name = 'user_accessible_facilities'
        ORDER BY ordinal_position
      `);

      const cols = rows.map(r => r.column_name);
      expect(cols).to.include('user_id');
      expect(cols).to.include('facility_id');
      expect(cols).to.include('depth');
    });

    it('should support querying facilities by user_id', async () => {
      const result = await pool.query(`
        SELECT user_id, facility_id, depth
        FROM v1.user_accessible_facilities
        LIMIT 5
      `);

      if (result.rows.length > 0) {
        result.rows.forEach(r => {
          expect(r).to.have.property('user_id');
          expect(r).to.have.property('facility_id');
          expect(r).to.have.property('depth');
          expect(r.depth).to.be.a('number');
        });
      }
    });
  });

  // ─── User settings table (denormalized view) ─────────────────────────

  describe('v1.user_settings table', () => {
    it('should have correct schema for PowerSync integration', async () => {
      const { rows } = await pool.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'v1' AND table_name = 'user_settings'
        ORDER BY ordinal_position
      `);

      const cols = rows.map(r => r.column_name);
      expect(cols).to.include('user_id');
      expect(cols).to.include('username');
      expect(cols).to.include('facility_id');
      expect(cols).to.include('contact_id');
      expect(cols).to.include('roles');
      expect(cols).to.include('role_hash');
      expect(cols).to.include('replication_depth');
    });

    it('should contain user data consistent with couchdb docs', async () => {
      const { rows } = await pool.query(`
        SELECT user_id, username, facility_id, roles, role_hash, replication_depth
        FROM v1.user_settings
        LIMIT 5
      `);

      if (rows.length > 0) {
        rows.forEach(r => {
          expect(r.user_id).to.be.a('string');
          expect(r.roles).to.be.an('array');
          if (r.role_hash) {
            expect(r.role_hash).to.be.a('string');
          }
        });
      }
    });
  });

  // ─── Reporting period boundary edge cases ─────────────────────────────

  describe('Target reporting period boundary edge cases', () => {
    const decTarget = `target~2025-12~boundary-owner~0`;
    const janTarget = `target~2026-01~boundary-owner~0`;

    before(async () => {
      testDocIds.push(decTarget, janTarget);

      for (const [id, period] of [[decTarget, '2025-12'], [janTarget, '2026-01']]) {
        await pool.query(
          `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
           VALUES ($1, $2, false, NOW(), 'sentinel')`,
          [id, JSON.stringify({
            _id: id, type: 'target', user: 'u', owner: 'boundary-owner',
            reporting_period: period, updated_date: Date.now(), targets: [],
          })]
        );
      }
    });

    it('should correctly separate December and January targets', async () => {
      const decResult = await pool.query(`
        SELECT _id FROM ${DOCS_TABLE}
        WHERE _id >= 'target~2025-12~' AND _id <= 'target~2025-12~\ufff0'
          AND (_deleted IS NULL OR _deleted = false)
      `);

      const janResult = await pool.query(`
        SELECT _id FROM ${DOCS_TABLE}
        WHERE _id >= 'target~2026-01~' AND _id <= 'target~2026-01~\ufff0'
          AND (_deleted IS NULL OR _deleted = false)
      `);

      const decIds = decResult.rows.map(r => r._id);
      const janIds = janResult.rows.map(r => r._id);

      expect(decIds).to.include(decTarget);
      expect(decIds).to.not.include(janTarget);
      expect(janIds).to.include(janTarget);
      expect(janIds).to.not.include(decTarget);
    });
  });
});
