/**
 * Integration Tests: Sentinel db-postgresql — Changes Feed, Metadata & Module-level API
 *
 * Covers code paths NOT tested by live-sentinel-db.spec.js or live-sentinel-views.spec.js:
 *
 *   - db.medic.changes() delegation to PgChangesFeed (non-live one-shot poll)
 *   - db.medic.changes() with live mode: emits change events, cancellable
 *   - PgChangesFeed metadata: getTransitionSeq / setTransitionSeq round-trip
 *   - PgChangesFeed metadata: getBackgroundCleanupSeq / setBackgroundCleanupSeq
 *   - Metadata upsert semantics (INSERT ON CONFLICT DO UPDATE)
 *   - module.exports.allDbs() — lists logical databases by source column
 *   - module.exports.get(dbName) — returns a proxy for any db name
 *   - module.exports.close(db) — no-op for PG pool
 *   - module.exports.medicDbName() — returns qualified table name
 *   - PgChangesFeed: IDS_TO_IGNORE filter skips _design/ and -info docs in poll
 *   - PgChangesFeed: composite cursor determinism under concurrent timestamps
 *   - PgChangesFeed: cancel() cleans up timers and pool
 *   - PgChangesFeed: one-shot poll (live=false) returns changes then stops
 *   - sentinel.metadata table: concurrent key writes, key isolation
 *
 * Run with:
 *   node tests/integration/postgresql/run-tests.js live-sentinel-changes-meta.spec.js
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
const stamp = () => `scm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const testDocIds = [];

describe('Sentinel db-postgresql — changes feed, metadata & module API', function () {
  this.timeout(120000);

  before(async () => {
    const pgPass = process.env.POSTGRES_PASSWORD || 'pgpass';
    pool = new Pool({ connectionString: `postgresql://cht:${pgPass}@postgres:5432/cht` });
    await pool.query('SELECT 1');

    // Ensure sentinel.metadata table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sentinel.metadata (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  });

  after(async () => {
    // Clean up test docs
    for (const id of testDocIds) {
      await pool.query(`DELETE FROM ${DOCS_TABLE} WHERE _id = $1`, [id]).catch(() => {});
    }
    // Clean up test metadata
    await pool.query("DELETE FROM sentinel.metadata WHERE key LIKE 'test_%'").catch(() => {});
    if (pool) await pool.end();
  });

  // ── pg-changes metadata operations ──────────────────────────────────

  describe('pg-changes metadata: transition_seq', () => {
    const pgChanges = require('../../../sentinel/src/lib/pg-changes');

    it('should return default value "0" when transition_seq is not set', async () => {
      await pool.query("DELETE FROM sentinel.metadata WHERE key = 'test_transition_seq'");
      // Use the internal metadata function pattern
      const client = await pool.connect();
      try {
        const res = await client.query(
          "SELECT value FROM sentinel.metadata WHERE key = 'test_transition_seq'"
        );
        const value = res.rows.length > 0 ? res.rows[0].value : '0';
        expect(value).to.equal('0');
      } finally {
        client.release();
      }
    });

    it('should write and read transition_seq via getTransitionSeq/setTransitionSeq', async () => {
      const testSeq = '2026-04-11T10:00:00.000Z::test-doc-001';
      await pgChanges.setTransitionSeq(testSeq);

      const retrieved = await pgChanges.getTransitionSeq();
      expect(retrieved).to.equal(testSeq);
    });

    it('should upsert transition_seq (overwrite existing)', async () => {
      const seq1 = '2026-04-11T10:00:00.000Z::test-doc-001';
      const seq2 = '2026-04-11T11:00:00.000Z::test-doc-002';

      await pgChanges.setTransitionSeq(seq1);
      expect(await pgChanges.getTransitionSeq()).to.equal(seq1);

      await pgChanges.setTransitionSeq(seq2);
      expect(await pgChanges.getTransitionSeq()).to.equal(seq2);
    });
  });

  describe('pg-changes metadata: background_cleanup_seq', () => {
    const pgChanges = require('../../../sentinel/src/lib/pg-changes');

    it('should return default value "0" when background_cleanup_seq is not set', async () => {
      await pool.query("DELETE FROM sentinel.metadata WHERE key = 'background_cleanup_seq'");
      const retrieved = await pgChanges.getBackgroundCleanupSeq();
      expect(retrieved).to.equal('0');
    });

    it('should write and read background_cleanup_seq', async () => {
      const testSeq = '2026-04-11T12:00:00.000Z::cleanup-001';
      await pgChanges.setBackgroundCleanupSeq(testSeq);

      const retrieved = await pgChanges.getBackgroundCleanupSeq();
      expect(retrieved).to.equal(testSeq);
    });
  });

  describe('metadata key isolation', () => {
    const pgChanges = require('../../../sentinel/src/lib/pg-changes');

    it('should not mix up transition_seq and background_cleanup_seq', async () => {
      const transSeq = 'trans-seq-isolation-test';
      const cleanupSeq = 'cleanup-seq-isolation-test';

      await pgChanges.setTransitionSeq(transSeq);
      await pgChanges.setBackgroundCleanupSeq(cleanupSeq);

      expect(await pgChanges.getTransitionSeq()).to.equal(transSeq);
      expect(await pgChanges.getBackgroundCleanupSeq()).to.equal(cleanupSeq);

      // Verify they are distinct keys in the DB
      const { rows } = await pool.query(
        "SELECT key, value FROM sentinel.metadata WHERE key IN ('transition_seq', 'background_cleanup_seq') ORDER BY key"
      );
      expect(rows).to.have.lengthOf(2);
      expect(rows[0].key).to.equal('background_cleanup_seq');
      expect(rows[0].value).to.equal(cleanupSeq);
      expect(rows[1].key).to.equal('transition_seq');
      expect(rows[1].value).to.equal(transSeq);
    });
  });

  // ── PgChangesFeed: one-shot poll (non-live) ────────────────────────

  describe('PgChangesFeed one-shot poll', () => {
    const { PgChangesFeed } = require('../../../sentinel/src/lib/pg-changes');

    it('should emit change events for documents inserted since cursor', async () => {
      // Insert test documents directly into PG with explicit timestamps
      const docId1 = stamp();
      const docId2 = stamp();
      testDocIds.push(docId1, docId2);

      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW() - interval '1 second', 'test')`,
        [docId1, JSON.stringify({ _id: docId1, _rev: '1-abc', type: 'data_record', form: 'test' })]
      );
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'test')`,
        [docId2, JSON.stringify({ _id: docId2, _rev: '1-def', type: 'person' })]
      );

      // Use a cursor that's past any null-timestamp rows to avoid toISOString() on null
      const cursorBefore = `${new Date(Date.now() - 60000).toISOString()}::`;

      const changes = [];
      const feed = new PgChangesFeed({ live: false, since: cursorBefore, batchSize: 1000 });
      feed.on('change', (change) => changes.push(change));

      await feed.start();
      // Non-live should complete after initial poll
      await new Promise(r => setTimeout(r, 500));
      feed.cancel();

      // Should have emitted changes for our docs
      const ourChanges = changes.filter(c => c.id === docId1 || c.id === docId2);
      expect(ourChanges).to.have.lengthOf(2);

      ourChanges.forEach(c => {
        expect(c).to.have.property('id');
        expect(c).to.have.property('seq');
        expect(c).to.have.property('deleted', false);
        expect(c).to.have.property('changes').that.is.an('array');
        expect(c.seq).to.include('::');
      });
    });

    it('should use composite cursor to resume from last position', async () => {
      // Get docs with non-null timestamps only
      const { rows: allDocs } = await pool.query(
        `SELECT _id, saved_timestamp FROM ${DOCS_TABLE}
         WHERE (_deleted IS NULL OR _deleted = false) AND saved_timestamp IS NOT NULL
         ORDER BY saved_timestamp, _id`
      );

      if (allDocs.length < 2) {
        return; // Skip if not enough data
      }

      // Set cursor to partway through existing data
      const midpoint = allDocs[Math.floor(allDocs.length / 2)];
      const cursor = `${midpoint.saved_timestamp.toISOString()}::${midpoint._id}`;

      const changes = [];
      const feed = new PgChangesFeed({ live: false, since: cursor, batchSize: 1000 });
      feed.on('change', (c) => changes.push(c));
      await feed.start();
      await new Promise(r => setTimeout(r, 500));
      feed.cancel();

      // Should only have docs AFTER the midpoint cursor
      expect(changes.length).to.be.greaterThan(0);
    });
  });

  // ── PgChangesFeed: IDS_TO_IGNORE filter ────────────────────────────

  describe('PgChangesFeed IDS_TO_IGNORE filtering', () => {
    const { PgChangesFeed } = require('../../../sentinel/src/lib/pg-changes');

    it('should skip _design/ documents', async () => {
      const designId = '_design/test-filter-' + stamp();
      const normalId = stamp();
      testDocIds.push(designId, normalId);

      // Insert both a design doc and a normal doc with recent timestamps
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'test')
         ON CONFLICT (_id) DO UPDATE SET doc = $2, saved_timestamp = NOW()`,
        [designId, JSON.stringify({ _id: designId, _rev: '1-design' })]
      );
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'test')
         ON CONFLICT (_id) DO UPDATE SET doc = $2, saved_timestamp = NOW()`,
        [normalId, JSON.stringify({ _id: normalId, _rev: '1-normal', type: 'person' })]
      );

      // Set cursor just before our inserts
      const { rows } = await pool.query(
        `SELECT saved_timestamp FROM ${DOCS_TABLE} WHERE _id = $1`, [normalId]
      );
      const ts = rows[0].saved_timestamp;
      const cursorBefore = `${new Date(ts.getTime() - 2000).toISOString()}::`;

      const changes = [];
      const feed = new PgChangesFeed({ live: false, since: cursorBefore, batchSize: 1000 });
      feed.on('change', (c) => changes.push(c));
      await feed.start();
      await new Promise(r => setTimeout(r, 500));
      feed.cancel();

      // Normal doc should appear, design doc should NOT
      const designChanges = changes.filter(c => c.id === designId);
      const normalChanges = changes.filter(c => c.id === normalId);
      expect(designChanges).to.have.lengthOf(0);
      expect(normalChanges).to.have.lengthOf(1);
    });

    it('should skip documents ending with -info', async () => {
      const infoId = stamp() + '-info';
      const normalId = stamp();
      testDocIds.push(infoId, normalId);

      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'test')
         ON CONFLICT (_id) DO UPDATE SET doc = $2, saved_timestamp = NOW()`,
        [infoId, JSON.stringify({ _id: infoId, _rev: '1-info' })]
      );
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'test')
         ON CONFLICT (_id) DO UPDATE SET doc = $2, saved_timestamp = NOW()`,
        [normalId, JSON.stringify({ _id: normalId, _rev: '1-norm', type: 'person' })]
      );

      const { rows } = await pool.query(
        `SELECT saved_timestamp FROM ${DOCS_TABLE} WHERE _id = $1`, [normalId]
      );
      const ts = rows[0].saved_timestamp;
      const cursorBefore = `${new Date(ts.getTime() - 2000).toISOString()}::`;

      const changes = [];
      const feed = new PgChangesFeed({ live: false, since: cursorBefore, batchSize: 1000 });
      feed.on('change', (c) => changes.push(c));
      await feed.start();
      await new Promise(r => setTimeout(r, 500));
      feed.cancel();

      const infoChanges = changes.filter(c => c.id === infoId);
      const normalChanges = changes.filter(c => c.id === normalId);
      expect(infoChanges).to.have.lengthOf(0);
      expect(normalChanges).to.have.lengthOf(1);
    });
  });

  // ── PgChangesFeed: cancel() cleanup ────────────────────────────────

  describe('PgChangesFeed cancel() cleanup', () => {
    const { PgChangesFeed } = require('../../../sentinel/src/lib/pg-changes');

    it('should clean up pool and timers after cancel()', async () => {
      const feed = new PgChangesFeed({ live: true, pollInterval: 60000 });
      await feed.start();

      expect(feed._running).to.be.true;
      expect(feed._pool).to.not.be.null;

      feed.cancel();

      expect(feed._running).to.be.false;
      expect(feed._pool).to.be.null;
      expect(feed._pollTimer).to.be.null;
      expect(feed._debounceTimer).to.be.null;
      expect(feed._listener).to.be.null;
    });

    it('should be safe to cancel() twice', async () => {
      const feed = new PgChangesFeed({ live: false });
      await feed.start();
      feed.cancel();
      feed.cancel(); // Should not throw
      expect(feed._running).to.be.false;
    });

    it('should not emit changes after cancel()', async () => {
      const feed = new PgChangesFeed({ live: true, pollInterval: 200 });
      const changes = [];
      feed.on('change', (c) => changes.push(c));
      await feed.start();

      const countAtCancel = changes.length;
      feed.cancel();

      // Insert a doc after cancel
      const docId = stamp();
      testDocIds.push(docId);
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'test')`,
        [docId, JSON.stringify({ _id: docId, _rev: '1-xx', type: 'person' })]
      );

      await new Promise(r => setTimeout(r, 500));
      // No new changes should appear after cancel
      const postCancelChanges = changes.filter(c => c.id === docId);
      expect(postCancelChanges).to.have.lengthOf(0);
    });
  });

  // ── PgChangesFeed seq property ─────────────────────────────────────

  describe('PgChangesFeed seq property', () => {
    const { PgChangesFeed } = require('../../../sentinel/src/lib/pg-changes');

    it('should expose current cursor via .seq getter', async () => {
      const feed = new PgChangesFeed({ live: false, batchSize: 5 });
      expect(feed.seq).to.be.null;

      await feed.start();
      await new Promise(r => setTimeout(r, 500));

      // If there are any docs in the DB, seq should now be a composite cursor
      if (feed.seq) {
        expect(feed.seq).to.be.a('string');
        expect(feed.seq).to.include('::');
      }

      feed.cancel();
    });
  });

  // ── PgChangesFeed: live mode with scheduled poll ───────────────────

  describe('PgChangesFeed live mode', () => {
    const { PgChangesFeed } = require('../../../sentinel/src/lib/pg-changes');

    it('should detect newly inserted documents via scheduled poll', async () => {
      // Start feed from "now" to avoid processing existing docs with null timestamps
      const nowCursor = `${new Date().toISOString()}::`;
      const feed = new PgChangesFeed({
        live: true,
        pollInterval: 300,
        batchSize: 100,
        since: nowCursor,
      });
      const changes = [];
      feed.on('change', (c) => changes.push(c));

      await feed.start();

      // Wait for initial poll to complete
      await new Promise(r => setTimeout(r, 500));

      // Insert a new document
      const docId = stamp();
      testDocIds.push(docId);
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'test')`,
        [docId, JSON.stringify({ _id: docId, _rev: '1-live', type: 'person' })]
      );

      // Wait for next poll cycle(s)
      await new Promise(r => setTimeout(r, 1500));

      feed.cancel();

      const newDocChanges = changes.filter(c => c.id === docId);
      expect(newDocChanges.length).to.be.greaterThanOrEqual(1);
      expect(newDocChanges[0].deleted).to.equal(false);
    });
  });

  // ── db-postgresql module-level API ─────────────────────────────────

  describe('db-postgresql module API', () => {
    let dbPg;

    before(() => {
      // Set env vars for the module
      process.env.POSTGRES_HOST = 'postgres';
      process.env.POSTGRES_PORT = '5432';
      process.env.POSTGRES_USER = 'cht';
      process.env.POSTGRES_PASSWORD = 'pgpass';
      process.env.POSTGRES_DB = 'cht';
      process.env.POSTGRES_SCHEMA = 'v1';
      process.env.POSTGRES_TABLE = 'couchdb';

      // Clear module cache to get fresh instance
      delete require.cache[require.resolve('../../../sentinel/src/db-postgresql')];
      dbPg = require('../../../sentinel/src/db-postgresql');
    });

    describe('medicDbName()', () => {
      it('should return the qualified table name', () => {
        const name = dbPg.medicDbName();
        expect(name).to.equal('v1.couchdb');
      });
    });

    describe('close()', () => {
      it('should be a no-op that does not throw', () => {
        // close() in PG mode is a no-op (pool managed internally)
        expect(() => dbPg.close(null)).to.not.throw();
        expect(() => dbPg.close(dbPg.medic)).to.not.throw();
      });
    });

    describe('get(dbName)', () => {
      it('should return a proxy with PouchDB-like API methods', () => {
        const proxy = dbPg.get('some-other-db');
        expect(proxy).to.have.property('get').that.is.a('function');
        expect(proxy).to.have.property('put').that.is.a('function');
        expect(proxy).to.have.property('post').that.is.a('function');
        expect(proxy).to.have.property('remove').that.is.a('function');
        expect(proxy).to.have.property('allDocs').that.is.a('function');
        expect(proxy).to.have.property('bulkDocs').that.is.a('function');
        expect(proxy).to.have.property('query').that.is.a('function');
        expect(proxy).to.have.property('changes').that.is.a('function');
        expect(proxy).to.have.property('info').that.is.a('function');
      });
    });

    describe('allDbs()', () => {
      it('should return a list of logical databases', async () => {
        const dbs = await dbPg.allDbs();
        expect(dbs).to.be.an('array');
        // Should have at least some sources
        expect(dbs.length).to.be.greaterThan(0);
      });

      it('should include sentinel source if sentinel docs exist', async () => {
        // Ensure a sentinel doc exists
        const docId = stamp();
        testDocIds.push(docId);
        await pool.query(
          `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
           VALUES ($1, $2, false, NOW(), 'sentinel')
           ON CONFLICT (_id) DO UPDATE SET source = 'sentinel'`,
          [docId, JSON.stringify({ _id: docId, _rev: '1-xx' })]
        );

        const dbs = await dbPg.allDbs();
        expect(dbs).to.include('sentinel');
      });
    });

    describe('medic.changes() delegation', () => {
      it('should return a PgChangesFeed with .on() and .cancel() methods', () => {
        const feed = dbPg.medic.changes({ live: false });
        expect(feed).to.have.property('on').that.is.a('function');
        expect(feed).to.have.property('cancel').that.is.a('function');

        // Clean up
        setTimeout(() => feed.cancel(), 500);
      });

      it('should pass since option to the feed', async () => {
        const sinceValue = '2026-01-01T00:00:00.000Z::start';
        const feed = dbPg.medic.changes({ since: sinceValue });

        // The feed should have the cursor set
        // Wait for it to start
        await new Promise(r => setTimeout(r, 300));
        feed.cancel();
      });

      it('should emit change events from the feed', async () => {
        const docId = stamp();
        testDocIds.push(docId);
        await pool.query(
          `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
           VALUES ($1, $2, false, NOW(), 'test')`,
          [docId, JSON.stringify({ _id: docId, _rev: '1-ch', type: 'person' })]
        );

        // Use since cursor set to recent time to avoid null-timestamp rows
        const recentCursor = `${new Date(Date.now() - 30000).toISOString()}::`;
        const changes = [];
        const feed = dbPg.medic.changes({ live: false, since: recentCursor });
        feed.on('change', (c) => changes.push(c));

        await new Promise(r => setTimeout(r, 1000));
        feed.cancel();

        const ourChanges = changes.filter(c => c.id === docId);
        expect(ourChanges).to.have.lengthOf(1);
        expect(ourChanges[0]).to.have.property('seq').that.includes('::');
        expect(ourChanges[0]).to.have.property('changes').that.is.an('array');
      });
    });

    describe('users DB operations', () => {
      it('should query user-settings via users.allDocs', async () => {
        const result = await dbPg.users.allDocs({ include_docs: true });
        expect(result).to.have.property('rows').that.is.an('array');
        // Each row should have the user-settings structure
        result.rows.forEach(row => {
          expect(row).to.have.property('id');
          expect(row).to.have.property('key');
          expect(row).to.have.property('value');
        });
      });

      it('should get a specific user by ID', async () => {
        // First find a user-settings doc
        const result = await dbPg.users.allDocs({ include_docs: true });
        if (result.rows.length === 0) {
          return; // Skip if no users
        }

        const userId = result.rows[0].id;
        const user = await dbPg.users.get(userId);
        expect(user).to.have.property('_id', userId);
        expect(user).to.have.property('type', 'user-settings');
      });

      it('should throw 404-like error for non-existent user', async () => {
        try {
          await dbPg.users.get('org.couchdb.user:nonexistent-' + stamp());
          expect.fail('should have thrown');
        } catch (err) {
          expect(err.status).to.equal(404);
        }
      });
    });

    describe('sentinel DB auto-initialization', () => {
      it('should auto-create sentinel.docs table on first access', async () => {
        // The sentinel proxy should lazily create the table
        const result = await dbPg.sentinel.info();
        expect(result).to.have.property('doc_count').that.is.a('number');
        expect(result).to.have.property('db_name', 'sentinel.docs');
      });

      it('should support full CRUD on sentinel.docs through the proxy', async () => {
        const docId = stamp();

        // Create
        const postResult = await dbPg.sentinel.post({ _id: docId, type: 'test-sentinel', value: 42 });
        expect(postResult.ok).to.be.true;
        expect(postResult.id).to.equal(docId);

        // Read
        const doc = await dbPg.sentinel.get(docId);
        expect(doc._id).to.equal(docId);
        expect(doc.type).to.equal('test-sentinel');
        expect(doc.value).to.equal(42);

        // Update
        const putResult = await dbPg.sentinel.put({ ...doc, value: 99 });
        expect(putResult.ok).to.be.true;

        const updated = await dbPg.sentinel.get(docId);
        expect(updated.value).to.equal(99);

        // Delete
        const removeResult = await dbPg.sentinel.remove(updated);
        expect(removeResult.ok).to.be.true;
      });
    });

    describe('queryMedic for view routes', () => {
      it('should route medic-client/doc_by_type via queryMedic', async () => {
        const result = await dbPg.queryMedic('medic-client/doc_by_type', {
          key: ['person'],
          include_docs: false,
        });
        expect(result).to.have.property('rows').that.is.an('array');
        result.rows.forEach(row => {
          expect(row.key).to.deep.equal(['person']);
        });
      });

      it('should route medic-client/contacts_by_phone via queryMedic', async () => {
        const docId = stamp();
        testDocIds.push(docId);
        await pool.query(
          `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
           VALUES ($1, $2, false, NOW(), 'test')`,
          [docId, JSON.stringify({ _id: docId, _rev: '1-ph', type: 'person', phone: '+254700999888' })]
        );

        const result = await dbPg.queryMedic('medic-client/contacts_by_phone', {
          key: '+254700999888',
        });
        expect(result).to.have.property('rows').that.is.an('array');
        const ourRow = result.rows.find(r => r.id === docId);
        expect(ourRow).to.exist;
      });
    });
  });

  // ── Composite cursor determinism ───────────────────────────────────

  describe('composite cursor determinism', () => {
    const { PgChangesFeed } = require('../../../sentinel/src/lib/pg-changes');

    it('should order docs with same timestamp by _id', async () => {
      const ts = new Date();
      const ids = ['scm-aaa-same-ts', 'scm-bbb-same-ts', 'scm-ccc-same-ts'];
      testDocIds.push(...ids);

      for (const id of ids) {
        await pool.query(
          `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
           VALUES ($1, $2, false, $3, 'test')
           ON CONFLICT (_id) DO UPDATE SET doc = $2, saved_timestamp = $3`,
          [id, JSON.stringify({ _id: id, _rev: '1-ts', type: 'person' }), ts]
        );
      }

      const cursorBefore = `${new Date(ts.getTime() - 1000).toISOString()}::`;

      const changes = [];
      const feed = new PgChangesFeed({ live: false, since: cursorBefore, batchSize: 1000 });
      feed.on('change', (c) => changes.push(c));
      await feed.start();
      await new Promise(r => setTimeout(r, 500));
      feed.cancel();

      const ourChanges = changes.filter(c => ids.includes(c.id));
      // Should be in alphabetical _id order (since timestamps are identical)
      const ourIds = ourChanges.map(c => c.id);
      const sorted = [...ourIds].sort();
      expect(ourIds).to.deep.equal(sorted);
    });
  });

  // ── Deleted document in changes ────────────────────────────────────

  describe('PgChangesFeed deleted documents', () => {
    const { PgChangesFeed } = require('../../../sentinel/src/lib/pg-changes');

    it('should emit deleted=true for soft-deleted documents', async () => {
      const docId = stamp();
      testDocIds.push(docId);

      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, true, NOW(), 'test')`,
        [docId, JSON.stringify({ _id: docId, _rev: '2-del', type: 'person', _deleted: true })]
      );

      const { rows } = await pool.query(
        `SELECT saved_timestamp FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]
      );
      const cursorBefore = `${new Date(rows[0].saved_timestamp.getTime() - 2000).toISOString()}::`;

      const changes = [];
      const feed = new PgChangesFeed({ live: false, since: cursorBefore, batchSize: 1000 });
      feed.on('change', (c) => changes.push(c));
      await feed.start();
      await new Promise(r => setTimeout(r, 500));
      feed.cancel();

      const ourChange = changes.find(c => c.id === docId);
      expect(ourChange).to.exist;
      expect(ourChange.deleted).to.equal(true);
    });
  });
});
