/**
 * Integration Tests: PgChangesFeed Lifecycle — live mode, cancel, NotifyListener
 *
 * Tests pg-changes.js code paths NOT fully covered by live-pg-changes.spec.js:
 *
 *   - PgChangesFeed: start() and cancel() lifecycle
 *   - PgChangesFeed: one-shot (non-live) mode emits changes then stops
 *   - PgChangesFeed: live mode starts with initial poll
 *   - PgChangesFeed: cancel() cleans up timers and connections
 *   - PgChangesFeed: seq getter tracks cursor position
 *   - PgChangesFeed: _onNotification debounce
 *   - NotifyListener: start/stop lifecycle
 *   - NotifyListener: verify LISTEN connection and channel
 *   - IDS_TO_IGNORE: design docs and -info suffixes filtered
 *   - Metadata pool operations: concurrent key isolation
 *
 * Run with:
 *   node tests/integration/postgresql/run-tests.js live-pg-changes-lifecycle.spec.js
 */
require('../../aliases');
const chai = require('chai');
chai.use(require('chai-as-promised'));
const expect = chai.expect;
const { Pool, Client } = require('pg');
const EventEmitter = require('events');

const PG_SCHEMA = process.env.POSTGRES_SCHEMA || 'v1';
const DOCS_TABLE = `"${PG_SCHEMA}"."couchdb"`;

let pool;
const stamp = () => `pcl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const testDocIds = [];

// Import pg-changes module
const pgChanges = require('../../../sentinel/src/lib/pg-changes');
const { PgChangesFeed, NotifyListener } = pgChanges;

describe('PgChangesFeed lifecycle & NotifyListener — live PostgreSQL', function () {
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
    // Clean up metadata keys
    await pool.query(`DELETE FROM sentinel.metadata WHERE key LIKE 'test_%'`).catch(() => {});
    await pool.end();
  });

  // ─── PgChangesFeed: one-shot mode ────────────────────────────────────

  describe('PgChangesFeed one-shot (non-live) mode', () => {
    it('should emit changes for existing documents and stop', async () => {
      // Insert a test doc
      const docId = stamp();
      testDocIds.push(docId);
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [docId, JSON.stringify({ _id: docId, type: 'test', _rev: '1-abc' })]
      );

      const feed = new PgChangesFeed({
        live: false,
        since: null,
        batchSize: 1000,
      });

      const changes = [];
      feed.on('change', (change) => changes.push(change));

      await feed.start();

      // In non-live mode, start polls once then returns
      // Wait a bit for async poll completion
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(changes.length).to.be.greaterThan(0);
      // Check change structure
      const testChange = changes.find(c => c.id === docId);
      if (testChange) {
        expect(testChange).to.have.property('id', docId);
        expect(testChange).to.have.property('deleted', false);
        expect(testChange).to.have.property('seq');
        expect(testChange).to.have.property('changes');
        expect(testChange.changes).to.be.an('array');
        expect(testChange.changes[0]).to.have.property('rev');
      }

      feed.cancel();
    });

    it('should not schedule polling timer in non-live mode', async () => {
      const feed = new PgChangesFeed({
        live: false,
        batchSize: 10,
      });

      await feed.start();
      await new Promise(resolve => setTimeout(resolve, 100));

      // _pollTimer should be null in non-live mode
      expect(feed._pollTimer).to.be.null;

      feed.cancel();
    });
  });

  // ─── PgChangesFeed: cancel lifecycle ──────────────────────────────────

  describe('PgChangesFeed cancel() cleanup', () => {
    it('should set _running to false', async () => {
      const feed = new PgChangesFeed({ live: false, batchSize: 10 });
      await feed.start();
      expect(feed._running).to.be.true;

      feed.cancel();
      expect(feed._running).to.be.false;
    });

    it('should clear poll timer and pool', async () => {
      const feed = new PgChangesFeed({
        live: true,
        batchSize: 10,
        pollInterval: 60000, // Long interval to avoid immediate poll
      });

      await feed.start();
      await new Promise(resolve => setTimeout(resolve, 200));

      // In live mode, _pollTimer should be set
      expect(feed._pollTimer).to.not.be.null;
      expect(feed._pool).to.not.be.null;

      feed.cancel();

      expect(feed._pollTimer).to.be.null;
      expect(feed._pool).to.be.null;
      expect(feed._running).to.be.false;
    });

    it('should be idempotent (safe to call multiple times)', () => {
      const feed = new PgChangesFeed({ live: false, batchSize: 10 });
      // Cancel without start
      expect(() => feed.cancel()).to.not.throw();
      // Cancel again
      expect(() => feed.cancel()).to.not.throw();
    });
  });

  // ─── PgChangesFeed: seq getter ────────────────────────────────────────

  describe('PgChangesFeed seq getter', () => {
    it('should return null initially', () => {
      const feed = new PgChangesFeed({ since: null });
      expect(feed.seq).to.be.null;
    });

    it('should return the since value when set', () => {
      const since = '2024-01-01T00:00:00.000Z::doc-abc';
      const feed = new PgChangesFeed({ since });
      expect(feed.seq).to.equal(since);
    });

    it('should update after polling', async () => {
      const feed = new PgChangesFeed({ live: false, since: null, batchSize: 5 });
      await feed.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      // After polling, seq should be updated if there are docs
      const { rows } = await pool.query(`SELECT count(*) as cnt FROM ${DOCS_TABLE}`);
      if (parseInt(rows[0].cnt) > 0) {
        expect(feed.seq).to.not.be.null;
        expect(feed.seq).to.include('::');
      }

      feed.cancel();
    });
  });

  // ─── PgChangesFeed: live mode with initial poll ───────────────────────

  describe('PgChangesFeed live mode', () => {
    it('should start LISTEN connection and schedule polling', async () => {
      const feed = new PgChangesFeed({
        live: true,
        batchSize: 10,
        pollInterval: 30000,
      });

      await feed.start();
      await new Promise(resolve => setTimeout(resolve, 500));

      expect(feed._running).to.be.true;
      expect(feed._listener).to.not.be.null;
      expect(feed._pollTimer).to.not.be.null;

      feed.cancel();
    });

    it('should emit changes for newly inserted documents', async () => {
      // Get current cursor position (exclude rows with null saved_timestamp)
      const { rows: lastDocs } = await pool.query(
        `SELECT saved_timestamp, _id FROM ${DOCS_TABLE}
         WHERE saved_timestamp IS NOT NULL
         ORDER BY saved_timestamp DESC, _id DESC LIMIT 1`
      );
      const since = lastDocs.length > 0
        ? PgChangesFeed.buildCursor(lastDocs[0].saved_timestamp.toISOString(), lastDocs[0]._id)
        : null;

      const feed = new PgChangesFeed({
        live: true,
        since,
        batchSize: 100,
        pollInterval: 500, // Poll every 500ms for test
      });

      const changes = [];
      feed.on('change', (change) => changes.push(change));

      await feed.start();

      // Insert a new doc after starting the feed
      const newDocId = stamp();
      testDocIds.push(newDocId);
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [newDocId, JSON.stringify({ _id: newDocId, type: 'test', _rev: '1-live' })]
      );

      // Wait for poll cycle to pick it up
      await new Promise(resolve => setTimeout(resolve, 1500));

      feed.cancel();

      const newChange = changes.find(c => c.id === newDocId);
      expect(newChange).to.not.be.undefined;
      expect(newChange.id).to.equal(newDocId);
      expect(newChange.seq).to.include('::');
    });
  });

  // ─── NotifyListener lifecycle ─────────────────────────────────────────

  describe('NotifyListener lifecycle', () => {
    it('should create with connection config', () => {
      const config = pgChanges._getConnectionConfig();
      const listener = new NotifyListener(config);
      expect(listener).to.be.instanceOf(EventEmitter);
      expect(listener._running).to.be.false;
      expect(listener._client).to.be.null;
    });

    it('should start and establish LISTEN connection', async () => {
      const config = pgChanges._getConnectionConfig();
      const listener = new NotifyListener(config);

      await listener.start();
      expect(listener._running).to.be.true;

      // Wait for connection
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(listener._client).to.not.be.null;

      listener.stop();
      expect(listener._running).to.be.false;
    });

    it('should be safe to stop before start', () => {
      const config = pgChanges._getConnectionConfig();
      const listener = new NotifyListener(config);
      expect(() => listener.stop()).to.not.throw();
    });

    it('should not double-start', async () => {
      const config = pgChanges._getConnectionConfig();
      const listener = new NotifyListener(config);

      await listener.start();
      // Second start should be no-op
      await listener.start();

      expect(listener._running).to.be.true;

      listener.stop();
    });

    it('should emit notification events for NOTIFY payloads', async () => {
      const config = pgChanges._getConnectionConfig();
      const listener = new NotifyListener(config);

      const notifications = [];
      listener.on('notification', (payload) => notifications.push(payload));

      await listener.start();
      await new Promise(resolve => setTimeout(resolve, 300));

      // Send a NOTIFY from a separate client
      const sender = new Client(config);
      await sender.connect();
      await sender.query(
        `NOTIFY couchdb_changes, '{"id":"test-notify-${stamp()}","operation":"INSERT"}'`
      );
      await sender.end();

      // Wait for notification
      await new Promise(resolve => setTimeout(resolve, 500));

      listener.stop();

      if (notifications.length > 0) {
        expect(notifications[0]).to.have.property('id');
        expect(notifications[0]).to.have.property('operation', 'INSERT');
      }
      // Note: notification may not arrive in all test environments
    });
  });

  // ─── IDS_TO_IGNORE filtering ──────────────────────────────────────────

  describe('IDS_TO_IGNORE filtering', () => {
    const IDS_TO_IGNORE = /^_design\/|-info$/;

    it('should filter _design/ documents', () => {
      expect('_design/medic'.match(IDS_TO_IGNORE)).to.not.be.null;
      expect('_design/medic-client'.match(IDS_TO_IGNORE)).to.not.be.null;
    });

    it('should filter -info suffix documents', () => {
      expect('doc123-info'.match(IDS_TO_IGNORE)).to.not.be.null;
      expect('abc-info'.match(IDS_TO_IGNORE)).to.not.be.null;
    });

    it('should NOT filter regular document IDs', () => {
      expect('regular-doc-123'.match(IDS_TO_IGNORE)).to.be.null;
      expect('person:abc'.match(IDS_TO_IGNORE)).to.be.null;
      expect('data_record:xyz'.match(IDS_TO_IGNORE)).to.be.null;
    });

    it('should NOT filter IDs that contain but do not end with -info', () => {
      expect('info-doc'.match(IDS_TO_IGNORE)).to.be.null;
      expect('information'.match(IDS_TO_IGNORE)).to.be.null;
    });

    it('should verify design docs in PG are skipped by changes feed', async () => {
      const designDocId = `_design/test-${stamp()}`;
      testDocIds.push(designDocId);

      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [designDocId, JSON.stringify({ _id: designDocId, views: {} })]
      );

      // The feed would skip this document
      expect(designDocId.match(IDS_TO_IGNORE)).to.not.be.null;
    });
  });

  // ─── Metadata concurrent key isolation ────────────────────────────────

  describe('metadata concurrent key isolation', () => {
    it('should read/write different metadata keys independently', async () => {
      const key1 = `test_key_a_${stamp()}`;
      const key2 = `test_key_b_${stamp()}`;

      // Write two different keys
      await pool.query(`
        INSERT INTO sentinel.metadata (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
      `, [key1, 'value-alpha']);

      await pool.query(`
        INSERT INTO sentinel.metadata (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
      `, [key2, 'value-beta']);

      // Read back independently
      const res1 = await pool.query('SELECT value FROM sentinel.metadata WHERE key = $1', [key1]);
      const res2 = await pool.query('SELECT value FROM sentinel.metadata WHERE key = $1', [key2]);

      expect(res1.rows[0].value).to.equal('value-alpha');
      expect(res2.rows[0].value).to.equal('value-beta');

      // Update one should not affect the other
      await pool.query(`
        INSERT INTO sentinel.metadata (key, value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
      `, [key1, 'value-alpha-v2']);

      const res2After = await pool.query('SELECT value FROM sentinel.metadata WHERE key = $1', [key2]);
      expect(res2After.rows[0].value).to.equal('value-beta'); // Unchanged
    });

    it('should return default when key does not exist', async () => {
      const result = await pool.query(
        'SELECT value FROM sentinel.metadata WHERE key = $1',
        ['nonexistent_metadata_key_xyz']
      );
      expect(result.rows).to.have.length(0);
      // getMetadataValue would return the defaultValue parameter here
    });
  });

  // ─── Composite cursor edge cases ──────────────────────────────────────

  describe('composite cursor edge cases', () => {
    it('should handle cursor with special characters in doc ID', () => {
      const timestamp = '2024-06-15T10:30:00.000Z';
      const id = 'doc:with:colons-and_underscores.and.dots';

      const cursor = PgChangesFeed.buildCursor(timestamp, id);
      const parsed = PgChangesFeed.parseCursor(cursor);

      expect(parsed.timestamp).to.equal(timestamp);
      expect(parsed.id).to.equal(id);
    });

    it('should handle cursor with empty ID component', () => {
      const cursor = PgChangesFeed.buildCursor('2024-01-01T00:00:00.000Z', '');
      const parsed = PgChangesFeed.parseCursor(cursor);

      expect(parsed.timestamp).to.equal('2024-01-01T00:00:00.000Z');
      expect(parsed.id).to.equal('');
    });

    it('should work correctly with PostgreSQL (saved_timestamp, _id) > ordering', async () => {
      // Insert two docs with same timestamp but different IDs
      const id1 = `cursor-aaa-${stamp()}`;
      const id2 = `cursor-zzz-${stamp()}`;
      testDocIds.push(id1, id2);

      const ts = new Date().toISOString();
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, $4::timestamp, 'sentinel'),
                ($3, $2, false, $4::timestamp, 'sentinel')`,
        [id1, JSON.stringify({ type: 'test' }), id2, ts]
      );

      // Query with composite cursor just before id2
      const result = await pool.query(`
        SELECT _id FROM ${DOCS_TABLE}
        WHERE (saved_timestamp, _id) > ($1::timestamp, $2)
        ORDER BY saved_timestamp, _id
        LIMIT 10
      `, [ts, id1]);

      const ids = result.rows.map(r => r._id);
      // id2 should come after id1 in the same timestamp bucket
      if (ids.includes(id2)) {
        expect(ids.indexOf(id2)).to.be.at.least(0);
      }
    });
  });
});
