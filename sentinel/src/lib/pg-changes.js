/**
 * PostgreSQL Changes Detection for Sentinel
 *
 * Replaces CouchDB's `db.medic.changes({ live: true, since: seq })` with a hybrid
 * LISTEN/NOTIFY + polling approach against the cht-sync `v1.couchdb` table.
 *
 * Architecture:
 *   1. LISTEN on 'couchdb_changes' channel for real-time notifications
 *   2. Poll `saved_timestamp > last_seen` as fallback (catches missed NOTIFY)
 *   3. Use (saved_timestamp, _id) as composite cursor for deterministic ordering
 *   4. Emit 'change' events compatible with the existing feed.js interface
 *
 * The trigger `v1.notify_couchdb_change()` must exist on the `v1.couchdb` table.
 */
const { Client, Pool } = require('pg');
const EventEmitter = require('events');
const logger = require('@medic/logger');

const POLL_INTERVAL_MS = 5000;       // 5s fallback poll
const NOTIFY_DEBOUNCE_MS = 100;      // Debounce rapid notifications
const BATCH_SIZE = 100;              // Max changes per poll
const RECONNECT_DELAY_MS = 5000;     // Delay before reconnecting listener

const IDS_TO_IGNORE = /^_design\/|-info$/;

const getConnectionConfig = () => ({
  host: process.env.POSTGRES_HOST || 'postgres',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  user: process.env.POSTGRES_USER || 'cht',
  password: process.env.POSTGRES_PASSWORD || 'pgpass',
  database: process.env.POSTGRES_DB || 'cht',
});

const getSchema = () => process.env.POSTGRES_SCHEMA || 'v1';
const getTable = () => process.env.POSTGRES_TABLE || 'couchdb';

/**
 * Manages a dedicated LISTEN connection for real-time change notifications.
 * Separate from the query pool since LISTEN requires a persistent connection.
 */
class NotifyListener extends EventEmitter {
  constructor(config) {
    super();
    this._config = config;
    this._client = null;
    this._running = false;
    this._wasConnected = false;
  }

  async start() {
    if (this._running) {
      return;
    }
    this._running = true;
    await this._connect();
  }

  async _connect() {
    if (!this._running) {
      return;
    }

    try {
      this._client = new Client(this._config);

      this._client.on('notification', (msg) => {
        try {
          const payload = JSON.parse(msg.payload);
          this.emit('notification', payload);
        } catch (err) {
          logger.warn('pg-changes: Failed to parse notification payload: %o', err);
        }
      });

      this._client.on('error', (err) => {
        logger.error('pg-changes: LISTEN connection error: %o', err);
        this._reconnect();
      });

      this._client.on('end', () => {
        if (this._running) {
          logger.warn('pg-changes: LISTEN connection ended unexpectedly');
          this._reconnect();
        }
      });

      await this._client.connect();
      await this._client.query('LISTEN couchdb_changes');

      if (this._wasConnected) {
        logger.info('pg-changes: LISTEN connection re-established — triggering catch-up poll');
        this.emit('reconnected');
      } else {
        logger.info('pg-changes: LISTEN connection established on couchdb_changes');
      }
      this._wasConnected = true;
    } catch (err) {
      logger.error('pg-changes: Failed to establish LISTEN connection: %o', err);
      this._reconnect();
    }
  }

  _reconnect() {
    this._cleanup();
    if (this._running) {
      setTimeout(() => this._connect(), RECONNECT_DELAY_MS);
    }
  }

  _cleanup() {
    if (this._client) {
      try {
        this._client.removeAllListeners();
        this._client.end().catch(() => {});
      } catch {
        // ignore cleanup errors
      }
      this._client = null;
    }
  }

  stop() {
    this._running = false;
    this._cleanup();
  }
}

/**
 * PostgreSQL Changes Feed — drop-in conceptual replacement for CouchDB changes.
 *
 * Emits:
 *   'change' — { id, deleted, seq } for each changed document
 *   'error'  — on unrecoverable errors
 *
 * The `seq` field uses `saved_timestamp::text || '::' || _id` as a composite
 * cursor, since multiple docs can share the same saved_timestamp.
 */
class PgChangesFeed extends EventEmitter {
  constructor(options = {}) {
    super();
    this._config = getConnectionConfig();
    this._schema = getSchema();
    this._table = getTable();
    this._batchSize = options.batchSize || BATCH_SIZE;
    this._pollInterval = options.pollInterval || POLL_INTERVAL_MS;
    this._live = options.live !== false;
    this._since = options.since || null; // composite cursor: 'timestamp::id' or null

    this._pool = null;
    this._listener = null;
    this._pollTimer = null;
    this._debounceTimer = null;
    this._running = false;
    this._polling = false;
    this._pendingPoll = false;
  }

  /**
   * Parse a composite seq cursor into { timestamp, id } components.
   * If the cursor is a plain timestamp or null, id defaults to empty string.
   */
  static parseCursor(seq) {
    if (!seq || seq === '0') {
      return { timestamp: null, id: '' };
    }
    const parts = String(seq).split('::');
    if (parts.length === 2) {
      return { timestamp: parts[0], id: parts[1] };
    }
    // Backwards compat: plain timestamp
    return { timestamp: parts[0], id: '' };
  }

  /**
   * Build a composite seq cursor from timestamp and id.
   */
  static buildCursor(timestamp, id) {
    return `${timestamp}::${id}`;
  }

  async start() {
    if (this._running) {
      return this;
    }
    this._running = true;

    this._pool = new Pool(this._config);
    this._pool.on('error', (err) => {
      logger.error('pg-changes: Pool error: %o', err);
    });

    if (this._live) {
      this._listener = new NotifyListener(this._config);
      this._listener.on('notification', () => this._onNotification());
      this._listener.on('reconnected', () => this._onReconnected());
      await this._listener.start();
    }

    // Initial poll to catch up
    await this._poll();

    if (this._live) {
      this._schedulePoll();
    }

    return this;
  }

  _onNotification() {
    // Debounce rapid notifications to batch them into a single poll
    if (this._debounceTimer) {
      return;
    }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._poll().catch(err => {
        logger.error('pg-changes: Notification-triggered poll error: %o', err);
      });
    }, NOTIFY_DEBOUNCE_MS);
  }

  /**
   * Called when the LISTEN connection drops and is re-established.
   * NOTIFY payloads are transient — any fired while the connection was down
   * are permanently lost. An immediate poll (bypassing debounce) ensures
   * changes during the gap are picked up without waiting for the next
   * scheduled fallback poll.
   */
  _onReconnected() {
    // Cancel any pending debounce — we want an immediate full poll
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._poll().catch(err => {
      logger.error('pg-changes: Reconnection catch-up poll error: %o', err);
    });
  }

  _schedulePoll() {
    if (!this._running) {
      return;
    }
    this._pollTimer = setTimeout(async () => {
      try {
        await this._poll();
      } catch (err) {
        logger.error('pg-changes: Scheduled poll error: %o', err);
      }
      this._schedulePoll();
    }, this._pollInterval);
  }

  async _poll() {
    if (!this._running) {
      return;
    }
    if (this._polling) {
      // A poll is already in progress. Flag that another poll is needed so
      // changes arriving between the current query and its completion are
      // not delayed until the next scheduled fallback poll.
      this._pendingPoll = true;
      return;
    }
    this._polling = true;
    this._pendingPoll = false;

    try {
      const { timestamp, id } = PgChangesFeed.parseCursor(this._since);
      const client = await this._pool.connect();

      try {
        let result;

        if (!timestamp) {
          // No cursor — fetch from the beginning
          result = await client.query(
            `SELECT _id, _deleted, saved_timestamp, doc->>'_rev' as rev
             FROM ${this._schema}.${this._table}
             ORDER BY saved_timestamp, _id
             LIMIT $1`,
            [this._batchSize]
          );
        } else {
          // Composite cursor: get rows after (timestamp, id)
          result = await client.query(
            `SELECT _id, _deleted, saved_timestamp, doc->>'_rev' as rev
             FROM ${this._schema}.${this._table}
             WHERE (saved_timestamp, _id) > ($1::timestamp, $2)
             ORDER BY saved_timestamp, _id
             LIMIT $3`,
            [timestamp, id, this._batchSize]
          );
        }

        for (const row of result.rows) {
          if (row._id.match(IDS_TO_IGNORE)) {
            continue;
          }

          const seq = PgChangesFeed.buildCursor(row.saved_timestamp.toISOString(), row._id);
          this._since = seq;

          this.emit('change', {
            id: row._id,
            deleted: row._deleted || false,
            seq: seq,
            changes: [{ rev: row.rev || '1-unknown' }],
          });
        }

        if (result.rows.length > 0) {
          const lastRow = result.rows[result.rows.length - 1];
          this._since = PgChangesFeed.buildCursor(
            lastRow.saved_timestamp.toISOString(),
            lastRow._id
          );
        }
      } finally {
        client.release();
      }
    } catch (err) {
      logger.error('pg-changes: Poll query error: %o', err);
      this.emit('error', err);
    } finally {
      this._polling = false;
      if (this._pendingPoll && this._running) {
        this._pendingPoll = false;
        // Re-poll immediately for notifications received during the previous poll
        this._poll().catch(err => {
          logger.error('pg-changes: Pending re-poll error: %o', err);
        });
      }
    }
  }

  /**
   * Cancel the feed. Compatible with CouchDB changes feed `.cancel()` API.
   */
  cancel() {
    this._running = false;

    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    if (this._listener) {
      this._listener.stop();
      this._listener = null;
    }
    if (this._pool) {
      this._pool.end().catch(() => {});
      this._pool = null;
    }
  }

  /**
   * Get the current cursor position.
   */
  get seq() {
    return this._since;
  }
}

/**
 * Sentinel metadata operations backed by PostgreSQL.
 * Replaces sentinel/src/lib/metadata.js get/set on sentinel CouchDB.
 */
const metadataPool = new Pool(getConnectionConfig());

let metadataInitialized = false;

const ensureMetadataTable = async () => {
  if (metadataInitialized) {
    return;
  }
  const client = await metadataPool.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS sentinel');
    await client.query(`
      CREATE TABLE IF NOT EXISTS sentinel.metadata (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    metadataInitialized = true;
  } finally {
    client.release();
  }
};

const getMetadataValue = async (key, defaultValue) => {
  await ensureMetadataTable();
  const client = await metadataPool.connect();
  try {
    const res = await client.query(
      'SELECT value FROM sentinel.metadata WHERE key = $1',
      [key]
    );
    return res.rows.length > 0 ? res.rows[0].value : defaultValue;
  } finally {
    client.release();
  }
};

const setMetadataValue = async (key, value) => {
  await ensureMetadataTable();
  const client = await metadataPool.connect();
  try {
    await client.query(
      `INSERT INTO sentinel.metadata (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, String(value)]
    );
  } finally {
    client.release();
  }
};

module.exports = {
  PgChangesFeed,
  NotifyListener,

  getTransitionSeq: () => getMetadataValue('transition_seq', '0'),
  setTransitionSeq: (seq) => setMetadataValue('transition_seq', seq),
  getBackgroundCleanupSeq: () => getMetadataValue('background_cleanup_seq', '0'),
  setBackgroundCleanupSeq: (seq) => setMetadataValue('background_cleanup_seq', seq),

  // For testing
  _getConnectionConfig: getConnectionConfig,
  _metadataPool: metadataPool,
  _resetMetadataInit: () => { metadataInitialized = false; },
};
