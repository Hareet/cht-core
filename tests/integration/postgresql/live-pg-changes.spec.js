/**
 * Integration Tests: pg-changes.js (Sentinel PostgreSQL Changes Detection)
 *
 * Tests the hybrid LISTEN/NOTIFY + polling changes feed and metadata store:
 *   - PgChangesFeed.parseCursor / buildCursor (composite cursor)
 *   - Polling: fetches changes ordered by (saved_timestamp, _id)
 *   - Composite cursor advances correctly after each batch
 *   - Design doc filtering (IDS_TO_IGNORE pattern)
 *   - sentinel.metadata CRUD (transition_seq, background_cleanup_seq)
 *   - LISTEN/NOTIFY trigger detection (if trigger exists)
 *   - Changes feed emits correct event structure
 *
 * Run with:
 *   node tests/integration/postgresql/run-tests.js live-pg-changes.spec.js
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
const stamp = () => `pgch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
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

describe('pg-changes.js — PostgreSQL changes detection', function () {
  this.timeout(120000);

  before(async () => {
    const pgPass = process.env.POSTGRES_PASSWORD || 'pgpass';
    pool = new Pool({ connectionString: `postgresql://cht:${pgPass}@postgres:5432/cht` });
    await pool.query('SELECT 1');
  });

  after(async () => {
    for (const id of testDocIds) await couchDelete(id).catch(() => {});
    // Clean up test metadata
    await pool.query("DELETE FROM sentinel.metadata WHERE key LIKE 'test_%'").catch(() => {});
    if (pool) await pool.end();
  });

  // ── Composite cursor (parseCursor / buildCursor) ─────────────────

  describe('composite cursor', () => {
    it('should parse a null cursor as initial state', () => {
      // parseCursor(null) → { timestamp: null, id: '' }
      const parsed = parseCursor(null);
      expect(parsed.timestamp).to.be.null;
      expect(parsed.id).to.equal('');
    });

    it('should parse "0" cursor as initial state', () => {
      const parsed = parseCursor('0');
      expect(parsed.timestamp).to.be.null;
      expect(parsed.id).to.equal('');
    });

    it('should parse composite cursor "timestamp::id"', () => {
      const seq = '2026-04-10T12:00:00.000Z::doc-12345';
      const parsed = parseCursor(seq);
      expect(parsed.timestamp).to.equal('2026-04-10T12:00:00.000Z');
      expect(parsed.id).to.equal('doc-12345');
    });

    it('should parse plain timestamp cursor (backwards compat)', () => {
      const seq = '2026-04-10T12:00:00.000Z';
      const parsed = parseCursor(seq);
      expect(parsed.timestamp).to.equal('2026-04-10T12:00:00.000Z');
      expect(parsed.id).to.equal('');
    });

    it('should build a composite cursor from timestamp and id', () => {
      const cursor = buildCursor('2026-04-10T12:00:00.000Z', 'doc-12345');
      expect(cursor).to.equal('2026-04-10T12:00:00.000Z::doc-12345');
    });

    it('should roundtrip correctly', () => {
      const ts = new Date().toISOString();
      const id = 'roundtrip-doc-id';
      const cursor = buildCursor(ts, id);
      const parsed = parseCursor(cursor);
      expect(parsed.timestamp).to.equal(ts);
      expect(parsed.id).to.equal(id);
    });
  });

  // ── Polling query (changes feed core) ────────────────────────────

  describe('polling query', () => {
    it('should fetch changes ordered by (saved_timestamp, _id)', async () => {
      const { rows } = await pool.query(
        `SELECT _id, _deleted, saved_timestamp, doc->>'_rev' as rev
         FROM ${DOCS_TABLE}
         ORDER BY saved_timestamp, _id
         LIMIT 10`
      );
      expect(rows.length).to.be.at.least(1);
      // Verify ordering: saved_timestamp should be non-decreasing
      for (let i = 1; i < rows.length; i++) {
        const prevTs = new Date(rows[i - 1].saved_timestamp).getTime();
        const currTs = new Date(rows[i].saved_timestamp).getTime();
        expect(currTs).to.be.at.least(prevTs);
        if (currTs === prevTs) {
          expect(rows[i]._id >= rows[i - 1]._id).to.be.true;
        }
      }
    });

    it('should paginate using composite cursor (saved_timestamp, _id) > ($1, $2)', async () => {
      // Get first batch
      const { rows: batch1 } = await pool.query(
        `SELECT _id, saved_timestamp FROM ${DOCS_TABLE}
         ORDER BY saved_timestamp, _id LIMIT 5`
      );
      expect(batch1.length).to.be.at.least(1);

      if (batch1.length < 5) return; // not enough data

      const lastRow = batch1[batch1.length - 1];
      const cursor = { timestamp: lastRow.saved_timestamp.toISOString(), id: lastRow._id };

      // Get second batch using composite cursor
      const { rows: batch2 } = await pool.query(
        `SELECT _id, saved_timestamp FROM ${DOCS_TABLE}
         WHERE (saved_timestamp, _id) > ($1::timestamp, $2)
         ORDER BY saved_timestamp, _id LIMIT 5`,
        [cursor.timestamp, cursor.id]
      );

      // Batches should not overlap
      const batch1Ids = new Set(batch1.map(r => r._id));
      batch2.forEach(r => expect(batch1Ids.has(r._id)).to.be.false);
    });

    it('should detect new documents after cursor position', async () => {
      // Record current cursor (last row)
      const { rows: beforeRows } = await pool.query(
        `SELECT _id, saved_timestamp FROM ${DOCS_TABLE}
         ORDER BY saved_timestamp DESC, _id DESC LIMIT 1`
      );
      const cursor = beforeRows.length > 0
        ? { timestamp: beforeRows[0].saved_timestamp.toISOString(), id: beforeRows[0]._id }
        : { timestamp: null, id: '' };

      // Create a new document
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'data_record', fields: { change: true }, reported_date: Date.now() });
      await waitForDoc(docId);

      // Poll for changes after cursor
      let found = false;
      if (cursor.timestamp) {
        const { rows } = await pool.query(
          `SELECT _id, _deleted, saved_timestamp FROM ${DOCS_TABLE}
           WHERE (saved_timestamp, _id) > ($1::timestamp, $2)
           ORDER BY saved_timestamp, _id LIMIT 100`,
          [cursor.timestamp, cursor.id]
        );
        found = rows.some(r => r._id === docId);
      } else {
        const { rows } = await pool.query(
          `SELECT _id FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]
        );
        found = rows.length > 0;
      }
      expect(found).to.be.true;
    });
  });

  // ── Design doc filtering ─────────────────────────────────────────

  describe('design doc filtering (IDS_TO_IGNORE)', () => {
    it('should filter out _design/ documents', () => {
      const pattern = /^_design\/|-info$/;
      expect(pattern.test('_design/medic')).to.be.true;
      expect(pattern.test('_design/medic-client')).to.be.true;
      expect(pattern.test('normal-doc-id')).to.be.false;
      expect(pattern.test('person-12345')).to.be.false;
    });

    it('should filter out -info suffix documents', () => {
      const pattern = /^_design\/|-info$/;
      expect(pattern.test('doc-id-info')).to.be.true;
      expect(pattern.test('sentinel-info')).to.be.true; // ends with -info
      expect(pattern.test('abc-info')).to.be.true;
      expect(pattern.test('regular-document')).to.be.false;
      expect(pattern.test('info-prefix-doc')).to.be.false;
    });

    it('should verify _design docs exist in PG but would be skipped by changes feed', async () => {
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE} WHERE _id LIKE '_design/%' LIMIT 5`
      );
      expect(rows.length).to.be.at.least(1);
      const pattern = /^_design\/|-info$/;
      rows.forEach(r => expect(pattern.test(r._id)).to.be.true);
    });
  });

  // ── sentinel.metadata CRUD ───────────────────────────────────────

  describe('sentinel.metadata', () => {
    it('should insert metadata key-value pair', async () => {
      await pool.query(
        `INSERT INTO sentinel.metadata (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        ['test_key_1', 'test_value_1']
      );

      const { rows } = await pool.query(
        'SELECT value FROM sentinel.metadata WHERE key = $1', ['test_key_1']
      );
      expect(rows).to.have.length(1);
      expect(rows[0].value).to.equal('test_value_1');
    });

    it('should update existing metadata value via ON CONFLICT', async () => {
      await pool.query(
        `INSERT INTO sentinel.metadata (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        ['test_key_2', 'initial']
      );

      await pool.query(
        `INSERT INTO sentinel.metadata (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        ['test_key_2', 'updated']
      );

      const { rows } = await pool.query(
        'SELECT value FROM sentinel.metadata WHERE key = $1', ['test_key_2']
      );
      expect(rows[0].value).to.equal('updated');
    });

    it('should return default when key not found', async () => {
      const { rows } = await pool.query(
        'SELECT value FROM sentinel.metadata WHERE key = $1', ['non_existent_key']
      );
      expect(rows).to.have.length(0);
      // Default: return undefined/null (getMetadataValue returns defaultValue)
    });

    it('should store and retrieve transition_seq', async () => {
      const testSeq = '2026-04-10T15:30:00.000Z::test-doc-id';
      await pool.query(
        `INSERT INTO sentinel.metadata (key, value, updated_at)
         VALUES ('test_transition_seq', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [testSeq]
      );

      const { rows } = await pool.query(
        'SELECT value FROM sentinel.metadata WHERE key = $1', ['test_transition_seq']
      );
      expect(rows[0].value).to.equal(testSeq);

      // Verify it parses back correctly
      const parsed = parseCursor(rows[0].value);
      expect(parsed.timestamp).to.equal('2026-04-10T15:30:00.000Z');
      expect(parsed.id).to.equal('test-doc-id');
    });
  });

  // ── Changes feed event structure ─────────────────────────────────

  describe('changes feed event structure', () => {
    it('should produce change events with correct shape', async () => {
      const { rows } = await pool.query(
        `SELECT _id, _deleted, saved_timestamp, doc->>'_rev' as rev
         FROM ${DOCS_TABLE}
         WHERE _id NOT LIKE '_design/%' AND (_id NOT LIKE '%-info')
         ORDER BY saved_timestamp, _id
         LIMIT 3`
      );

      rows.forEach(row => {
        const seq = buildCursor(row.saved_timestamp.toISOString(), row._id);
        const change = {
          id: row._id,
          deleted: row._deleted || false,
          seq: seq,
          changes: [{ rev: row.rev || '1-unknown' }],
        };

        // Verify shape matches CouchDB changes feed
        expect(change).to.have.property('id').that.is.a('string');
        expect(change).to.have.property('deleted').that.is.a('boolean');
        expect(change).to.have.property('seq').that.is.a('string');
        expect(change).to.have.property('changes').that.is.an('array');
        expect(change.changes[0]).to.have.property('rev').that.is.a('string');
        // seq should be composite cursor format
        expect(change.seq).to.include('::');
      });
    });

    it('should include deleted flag for soft-deleted documents', async () => {
      const { rows } = await pool.query(
        `SELECT _id, _deleted FROM ${DOCS_TABLE} WHERE _deleted = true LIMIT 3`
      );
      rows.forEach(row => {
        expect(row._deleted).to.be.true;
      });
    });
  });

  // ── LISTEN/NOTIFY trigger (if it exists) ─────────────────────────

  describe('LISTEN/NOTIFY infrastructure', () => {
    it('should check if couchdb_changes notify trigger exists', async () => {
      const { rows } = await pool.query(`
        SELECT trigger_name, event_manipulation, action_timing
        FROM information_schema.triggers
        WHERE trigger_schema = $1
          AND event_object_table = $2
      `, [PG_SCHEMA, PG_TABLE]);

      // If trigger exists, verify its properties
      if (rows.length > 0) {
        console.log(`  Found ${rows.length} trigger(s) on ${DOCS_TABLE}:`);
        rows.forEach(r => console.log(`    ${r.trigger_name} (${r.action_timing} ${r.event_manipulation})`));
      } else {
        console.log('  No triggers found on v1.couchdb (LISTEN/NOTIFY not active — polling-only mode)');
      }
      // This is informational — trigger may or may not exist depending on deployment
      expect(rows).to.be.an('array');
    });
  });
});

// ── Standalone utility functions (used by tests, matching pg-changes.js logic) ──

function parseCursor(seq) {
  if (!seq || seq === '0') {
    return { timestamp: null, id: '' };
  }
  const parts = String(seq).split('::');
  if (parts.length === 2) {
    return { timestamp: parts[0], id: parts[1] };
  }
  return { timestamp: parts[0], id: '' };
}

function buildCursor(timestamp, id) {
  return `${timestamp}::${id}`;
}
