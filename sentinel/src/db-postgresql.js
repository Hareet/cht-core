/**
 * PostgreSQL database module for Sentinel.
 *
 * Provides the same API surface as db.js (PouchDB-backed) so existing Sentinel code
 * works against PostgreSQL without modification. Activated by CHT_DB_BACKEND=postgresql.
 *
 * Depends on:
 *   - Agent 1's cht-datasource PostgreSQL adapter (lineage, doc queries)
 *   - Agent 2's pg-changes.js (LISTEN/NOTIFY changes feed, metadata)
 *   - Agent 4's purge tables (purge_status, purge_roles)
 *   - cht-sync's v1.couchdb table (source of truth)
 */
const { Pool } = require('pg');
const logger = require('@medic/logger');

const SCHEMA = process.env.POSTGRES_SCHEMA || 'v1';
const TABLE = process.env.POSTGRES_TABLE || 'couchdb';
const QT = `"${SCHEMA}"."${TABLE}"`;  // qualified table

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'postgres',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  user: process.env.POSTGRES_USER || 'cht',
  password: process.env.POSTGRES_PASSWORD || 'pgpass',
  database: process.env.POSTGRES_DB || 'cht',
  max: 10,
});

pool.on('error', (err) => {
  logger.error('PostgreSQL pool error: %o', err);
});

// ─── Helper: convert PouchDB-style options to SQL ──────────────────────

const generateRev = (currentRev) => {
  const revNum = currentRev
    ? parseInt(currentRev.split('-')[0], 10) + 1
    : 1;
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${revNum}-pg${suffix}`;
};

// ─── PouchDB-compatible database wrapper ───────────────────────────────

const createDbProxy = (tableName, schema = SCHEMA) => {
  const qt = `"${schema}"."${tableName}"`;
  const isSentinelTable = tableName !== TABLE;

  return {
    /**
     * PouchDB .get(id) → SELECT doc
     */
    get: async (id) => {
      const { rows } = await pool.query(
        `SELECT _id, doc, _deleted, saved_timestamp FROM ${qt}
         WHERE _id = $1`,
        [id]
      );
      if (rows.length === 0) {
        const err = new Error(`missing: ${id}`);
        err.status = 404;
        err.reason = 'missing';
        throw err;
      }
      const row = rows[0];
      if (row._deleted) {
        const err = new Error(`deleted: ${id}`);
        err.status = 404;
        err.reason = 'deleted';
        throw err;
      }
      return row.doc;
    },

    /**
     * PouchDB .put(doc) → INSERT or UPDATE
     */
    put: async (doc) => {
      const id = doc._id;
      const newRev = generateRev(doc._rev);
      const newDoc = { ...doc, _rev: newRev };

      if (doc._deleted) {
        const { rowCount } = await pool.query(
          `UPDATE ${qt} SET _deleted = true, doc = $1, saved_timestamp = NOW() WHERE _id = $2`,
          [JSON.stringify(newDoc), id]
        );
        if (rowCount === 0) {
          // Doc doesn't exist, insert the deletion marker
          await pool.query(
            `INSERT INTO ${qt} (_id, doc, _deleted, saved_timestamp, source) VALUES ($1, $2, true, NOW(), 'sentinel')
             ON CONFLICT (_id) DO UPDATE SET _deleted = true, doc = $2, saved_timestamp = NOW()`,
            [id, JSON.stringify(newDoc)]
          );
        }
        return { ok: true, id, rev: newRev };
      }

      const { rowCount } = await pool.query(
        `INSERT INTO ${qt} (_id, doc, _deleted, saved_timestamp, source) VALUES ($1, $2, false, NOW(), 'sentinel')
         ON CONFLICT (_id) DO UPDATE SET doc = $2, _deleted = false, saved_timestamp = NOW()`,
        [id, JSON.stringify(newDoc)]
      );
      return { ok: true, id, rev: newRev };
    },

    /**
     * PouchDB .post(doc) → INSERT with generated ID
     */
    post: async (doc) => {
      const id = doc._id || require('crypto').randomUUID();
      const rev = generateRev();
      const newDoc = { ...doc, _id: id, _rev: rev };

      await pool.query(
        `INSERT INTO ${qt} (_id, doc, _deleted, saved_timestamp, source) VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [id, JSON.stringify(newDoc)]
      );
      return { ok: true, id, rev };
    },

    /**
     * PouchDB .remove(doc) → mark _deleted = true
     */
    remove: async (doc) => {
      const id = typeof doc === 'string' ? doc : doc._id;
      const rev = typeof doc === 'string' ? undefined : doc._rev;
      const newRev = generateRev(rev);

      await pool.query(
        `UPDATE ${qt} SET _deleted = true, saved_timestamp = NOW() WHERE _id = $1`,
        [id]
      );
      return { ok: true, id, rev: newRev };
    },

    /**
     * PouchDB .allDocs(opts) → SELECT with various filtering modes
     */
    allDocs: async (opts = {}) => {
      const params = [];
      let sql;

      if (opts.keys) {
        // Fetch by key array
        sql = `SELECT _id, doc, _deleted FROM ${qt} WHERE _id = ANY($1)`;
        params.push(opts.keys);

        if (!opts.include_docs) {
          // Return just _id and _rev
          const { rows } = await pool.query(sql, params);
          const keyOrder = new Map(opts.keys.map((k, i) => [k, i]));
          const result = opts.keys.map(key => {
            const row = rows.find(r => r._id === key);
            if (!row) {
              return { key, error: 'not_found' };
            }
            if (row._deleted) {
              return { id: key, key, value: { rev: row.doc?._rev, deleted: true } };
            }
            return { id: key, key, value: { rev: row.doc?._rev } };
          });
          return { rows: result, total_rows: result.length };
        }

        const { rows } = await pool.query(sql, params);
        const rowMap = new Map(rows.map(r => [r._id, r]));
        const result = opts.keys.map(key => {
          const row = rowMap.get(key);
          if (!row) {
            return { key, error: 'not_found' };
          }
          if (row._deleted) {
            return { id: key, key, value: { rev: row.doc?._rev, deleted: true } };
          }
          return { id: key, key, value: { rev: row.doc?._rev }, doc: row.doc };
        });
        return { rows: result, total_rows: result.length };
      }

      // Range query
      const conditions = [`(_deleted IS NULL OR _deleted = false)`];
      if (opts.startkey) {
        conditions.push(`_id >= $${params.length + 1}`);
        params.push(opts.startkey);
      }
      if (opts.endkey) {
        conditions.push(`_id <= $${params.length + 1}`);
        params.push(opts.endkey);
      }

      const orderDir = opts.descending ? 'DESC' : 'ASC';
      sql = `SELECT _id, doc FROM ${qt} WHERE ${conditions.join(' AND ')} ORDER BY _id ${orderDir}`;

      if (opts.limit) {
        sql += ` LIMIT $${params.length + 1}`;
        params.push(opts.limit);
      }

      const { rows } = await pool.query(sql, params);
      return {
        rows: rows.map(row => ({
          id: row._id,
          key: row._id,
          value: { rev: row.doc?._rev },
          ...(opts.include_docs ? { doc: row.doc } : {}),
        })),
        total_rows: rows.length,
      };
    },

    /**
     * PouchDB .bulkDocs(docs) → batch INSERT/UPDATE
     */
    bulkDocs: async (docsOrObj) => {
      const docs = Array.isArray(docsOrObj) ? docsOrObj : docsOrObj.docs;
      if (!docs || docs.length === 0) {
        return [];
      }

      const results = [];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const doc of docs) {
          const id = doc._id;
          const newRev = generateRev(doc._rev);
          const newDoc = { ...doc, _rev: newRev };
          const deleted = !!doc._deleted;

          await client.query(
            `INSERT INTO ${qt} (_id, doc, _deleted, saved_timestamp, source)
             VALUES ($1, $2, $3, NOW(), 'sentinel')
             ON CONFLICT (_id) DO UPDATE SET doc = $2, _deleted = $3, saved_timestamp = NOW()`,
            [id, JSON.stringify(newDoc), deleted]
          );
          results.push({ ok: true, id, rev: newRev });
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      return results;
    },

    /**
     * PouchDB .query(viewName, opts) → SQL equivalent of CouchDB views
     */
    query: async (viewName, opts = {}) => {
      return queryView(viewName, opts);
    },

    /**
     * PouchDB .changes(opts) → delegate to pg-changes module
     */
    changes: (opts = {}) => {
      const { PgChangesFeed } = require('./lib/pg-changes');
      const feed = new PgChangesFeed({
        live: opts.live || false,
        since: opts.since || null,
        batchSize: opts.limit || 100,
      });
      // Auto-start; return the feed for .on() chaining
      feed.start().catch(err => feed.emit('error', err));
      return feed;
    },

    /**
     * PouchDB .info() → basic db stats
     */
    info: async () => {
      const { rows } = await pool.query(`SELECT count(*) as count FROM ${qt}`);
      return {
        db_name: `${schema}.${tableName}`,
        doc_count: parseInt(rows[0].count, 10),
        update_seq: 'postgresql',
      };
    },
  };
};

// ─── CouchDB View → SQL Query Mapping ──────────────────────────────────

const queryView = async (viewName, opts = {}) => {
  const params = [];
  let sql;

  switch (viewName) {
  case 'medic-client/doc_by_type': {
    const typeKey = opts.key ? opts.key[0] : (opts.keys ? opts.keys[0][0] : null);
    sql = `SELECT _id, doc FROM ${QT}
           WHERE doc->>'type' = $1 AND (_deleted IS NULL OR _deleted = false)`;
    params.push(typeKey);
    if (opts.include_docs) {
      const { rows } = await pool.query(sql, params);
      return { rows: rows.map(r => ({ id: r._id, key: [r.doc?.type], doc: r.doc, value: null })) };
    }
    const { rows } = await pool.query(sql, params);
    return { rows: rows.map(r => ({ id: r._id, key: [r.doc?.type], value: null })) };
  }

  case 'medic/reports_by_form_and_parent': {
    // reduce: _stats with group: true
    if (opts.keys && opts.group) {
      const formParentPairs = opts.keys;
      // Build a query for all key pairs
      const conditions = formParentPairs.map((pair, i) => {
        const fi = params.length + 1;
        const pi = params.length + 2;
        params.push(pair[0], pair[1]);
        return `(doc->>'form' = $${fi} AND doc->'contact'->'parent'->>'_id' = $${pi})`;
      });

      sql = `SELECT doc->>'form' as form, doc->'contact'->'parent'->>'_id' as parent_id,
                    count(*) as count,
                    min((doc->>'reported_date')::bigint) as min,
                    max((doc->>'reported_date')::bigint) as max
             FROM ${QT}
             WHERE doc->>'type' = 'data_record'
               AND (${conditions.join(' OR ')})
               AND (_deleted IS NULL OR _deleted = false)
             GROUP BY doc->>'form', doc->'contact'->'parent'->>'_id'`;

      const { rows } = await pool.query(sql, params);
      return {
        rows: rows.map(r => ({
          key: [r.form, r.parent_id],
          value: { count: parseInt(r.count), min: parseInt(r.min), max: parseInt(r.max), sum: 0, sumsqr: 0 },
        })),
      };
    }
    return { rows: [] };
  }

  case 'medic-client/contacts_by_phone': {
    const phone = opts.key;
    sql = `SELECT _id, doc FROM ${QT}
           WHERE doc->>'phone' = $1
             AND doc->>'type' IN ('contact','person','clinic','health_center','district_hospital')
             AND (_deleted IS NULL OR _deleted = false)`;
    params.push(phone);
    const { rows } = await pool.query(sql, params);
    return {
      rows: rows.map(r => ({
        id: r._id,
        key: r.doc?.phone,
        value: null,
        ...(opts.include_docs ? { doc: r.doc } : {}),
      })),
    };
  }

  case 'medic-client/contacts_by_reference': {
    // keys: [['shortcode', id], ...]
    if (opts.keys) {
      const shortcodes = opts.keys.filter(k => k[0] === 'shortcode').map(k => k[1]);
      const externals = opts.keys.filter(k => k[0] === 'external').map(k => k[1]);

      const conditions = [];
      if (shortcodes.length) {
        conditions.push(`(doc->>'patient_id' = ANY($${params.length + 1}) OR doc->>'place_id' = ANY($${params.length + 1}))`);
        params.push(shortcodes);
      }
      if (externals.length) {
        conditions.push(`UPPER(doc->>'rc_code') = ANY($${params.length + 1})`);
        params.push(externals.map(e => e.toUpperCase()));
      }

      if (!conditions.length) {
        return { rows: [] };
      }

      sql = `SELECT _id, doc FROM ${QT}
             WHERE (${conditions.join(' OR ')})
               AND doc->>'type' IN ('contact','person','clinic','health_center','district_hospital','national_office')
               AND (_deleted IS NULL OR _deleted = false)`;
      const { rows } = await pool.query(sql, params);
      return {
        rows: rows.map(r => {
          const prefix = r.doc?.patient_id || r.doc?.place_id ? 'shortcode' : 'external';
          const ref = r.doc?.patient_id || r.doc?.place_id || r.doc?.rc_code;
          return { id: r._id, key: [prefix, ref], value: r.doc?.reported_date };
        }),
      };
    }
    return { rows: [] };
  }

  case 'medic/contacts_by_depth': {
    // key: [contactId] or [contactId, depth]
    const contactId = opts.key[0];
    sql = `WITH RECURSIVE tree AS (
             SELECT _id, doc, 0 AS depth FROM ${QT}
             WHERE doc->'parent'->>'_id' = $1
               AND (_deleted IS NULL OR _deleted = false)
             UNION ALL
             SELECT c._id, c.doc, t.depth + 1
             FROM ${QT} c JOIN tree t ON c.doc->'parent'->>'_id' = t._id
             WHERE c._deleted IS NULL OR c._deleted = false
           )
           SELECT _id, doc, depth FROM tree ORDER BY depth`;
    params.push(contactId);
    const { rows } = await pool.query(sql, params);
    return {
      rows: rows.map(r => ({
        id: r._id,
        key: [contactId, r.depth],
        value: {
          shortcode: r.doc?.patient_id || r.doc?.place_id,
          primary_contact: typeof r.doc?.contact === 'object' ? r.doc?.contact?._id : r.doc?.contact,
        },
      })),
    };
  }

  case 'medic/docs_by_shortcode': {
    // keys: [shortcode1, shortcode2, ...]
    if (opts.keys) {
      sql = `SELECT _id, doc->>'patient_id' as patient_id, doc->>'place_id' as place_id, doc->>'case_id' as case_id
             FROM ${QT}
             WHERE (doc->>'patient_id' = ANY($1) OR doc->>'place_id' = ANY($1) OR doc->>'case_id' = ANY($1))
               AND (_deleted IS NULL OR _deleted = false)`;
      params.push(opts.keys);
      const { rows } = await pool.query(sql, params);
      return {
        rows: rows.map(r => ({
          id: r._id,
          key: r.patient_id || r.place_id || r.case_id,
        })),
      };
    }
    return { rows: [] };
  }

  case 'medic/tasks_in_terminal_state': {
    const endKey = opts.end_key ? JSON.parse(opts.end_key) : null;
    const startKey = opts.start_key ? JSON.parse(opts.start_key) : '';
    const limit = opts.limit || 1000;

    sql = `SELECT _id, doc->'emission'->>'endDate' as end_date FROM ${QT}
           WHERE doc->>'type' = 'task'
             AND doc->>'state' IN ('Cancelled','Completed','Failed')
             AND doc->'emission'->>'endDate' IS NOT NULL
             AND (_deleted IS NULL OR _deleted = false)`;

    if (endKey) {
      sql += ` AND doc->'emission'->>'endDate' <= $${params.length + 1}`;
      params.push(endKey);
    }
    if (startKey) {
      sql += ` AND doc->'emission'->>'endDate' >= $${params.length + 1}`;
      params.push(startKey);
    }
    sql += ` ORDER BY doc->'emission'->>'endDate' LIMIT $${params.length + 1}`;
    params.push(limit);

    const { rows } = await pool.query(sql, params);
    return {
      rows: rows.map(r => ({ id: r._id, key: r.end_date, value: null })),
    };
  }

  default:
    logger.warn(`pg-db: Unknown view query: ${viewName}`);
    return { rows: [] };
  }
};

// ─── queryMedic: direct HTTP view equivalent ───────────────────────────

const queryMedic = async (viewPath, queryParams = {}, body = null) => {
  const [ddoc, view] = viewPath.split('/');

  if (ddoc === 'allDocs') {
    // allDocs range query
    const startKey = queryParams.start_key ? JSON.parse(queryParams.start_key) : null;
    const endKey = queryParams.end_key ? JSON.parse(queryParams.end_key) : null;
    const limit = queryParams.limit || 1000;
    const startDocId = queryParams.startkey_docid || null;

    const conditions = [`(_deleted IS NULL OR _deleted = false)`];
    const params = [];
    if (startKey !== null) {
      conditions.push(`_id >= $${params.length + 1}`);
      params.push(startKey);
    }
    if (endKey !== null) {
      conditions.push(`_id <= $${params.length + 1}`);
      params.push(endKey);
    }

    const sql = `SELECT _id, doc FROM ${QT} WHERE ${conditions.join(' AND ')} ORDER BY _id LIMIT $${params.length + 1}`;
    params.push(limit);
    const { rows } = await pool.query(sql, params);

    return {
      rows: rows.map(r => ({
        id: r._id,
        key: r._id,
        value: { rev: r.doc?._rev },
        ...(queryParams.include_docs ? { doc: r.doc } : {}),
      })),
    };
  }

  // View queries routed to queryView
  const viewName = `${ddoc}/${view}`;
  return queryView(viewName, {
    ...queryParams,
    start_key: queryParams.start_key,
    end_key: queryParams.end_key,
  });
};

// ─── Sentinel-specific db wrapper ──────────────────────────────────────

const createSentinelDb = () => {
  // Sentinel data stored in sentinel schema tables, but we also need
  // backwards compat for code that stores arbitrary docs (infodocs, outbound tasks, etc.)
  // We use sentinel.metadata for key-value, and the v1.couchdb-sentinel pattern for docs.

  // For now, use a dedicated table in the sentinel schema
  // that mirrors the couchdb table structure for sentinel docs
  const ensureSentinelTable = async () => {
    await pool.query('CREATE SCHEMA IF NOT EXISTS sentinel');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sentinel.docs (
        _id TEXT PRIMARY KEY,
        doc JSONB,
        _deleted BOOLEAN DEFAULT false,
        saved_timestamp TIMESTAMPTZ DEFAULT NOW(),
        source TEXT DEFAULT 'sentinel'
      )
    `);
  };

  // Lazy init
  let initialized = false;
  const init = async () => {
    if (!initialized) {
      await ensureSentinelTable();
      initialized = true;
    }
  };

  const proxy = createDbProxy('docs', 'sentinel');

  // Wrap each method to ensure table exists
  const wrapped = {};
  for (const [key, fn] of Object.entries(proxy)) {
    if (typeof fn === 'function') {
      wrapped[key] = async (...args) => {
        await init();
        return fn(...args);
      };
    } else {
      wrapped[key] = fn;
    }
  }
  return wrapped;
};

// ─── Users db wrapper ──────────────────────────────────────────────────

const createUsersDb = () => {
  // Users come from CouchDB _users, but in PG they're in v1.couchdb as user-settings docs
  return {
    allDocs: async (opts = {}) => {
      // Fetch user-settings documents (which contain roles)
      if (opts.include_docs) {
        const { rows } = await pool.query(
          `SELECT _id, doc FROM ${QT}
           WHERE doc->>'type' = 'user-settings'
             AND (_deleted IS NULL OR _deleted = false)`
        );
        return {
          rows: rows.map(r => ({
            id: r._id,
            key: r._id,
            value: { rev: r.doc?._rev },
            doc: r.doc,
          })),
        };
      }
      const { rows } = await pool.query(
        `SELECT _id, doc->>'_rev' as rev FROM ${QT}
         WHERE doc->>'type' = 'user-settings'
           AND (_deleted IS NULL OR _deleted = false)`
      );
      return {
        rows: rows.map(r => ({ id: r._id, key: r._id, value: { rev: r.rev } })),
      };
    },
    get: async (id) => {
      const { rows } = await pool.query(
        `SELECT doc FROM ${QT} WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`,
        [id]
      );
      if (rows.length === 0) {
        const err = new Error(`missing: ${id}`);
        err.status = 404;
        throw err;
      }
      return rows[0].doc;
    },
  };
};

// ─── Module exports (same interface as db.js) ──────────────────────────

module.exports.medic = createDbProxy(TABLE, SCHEMA);
module.exports.sentinel = createSentinelDb();
module.exports.users = createUsersDb();

module.exports.allDbs = async () => {
  // Return logical database names based on what exists
  const { rows } = await pool.query(
    `SELECT DISTINCT source FROM ${QT} WHERE source IS NOT NULL`
  );
  const dbs = rows.map(r => r.source);
  // Also check for user-meta patterns in doc IDs
  const { rows: metaRows } = await pool.query(
    `SELECT DISTINCT split_part(_id, ':', 1) as prefix FROM ${QT}
     WHERE _id LIKE 'org.couchdb.user:%'`
  );
  return [...new Set([...dbs, ...metaRows.map(r => r.prefix)])];
};

module.exports.get = (dbName) => {
  // In PostgreSQL, all data is in one database. Return a proxy that filters by source.
  return createDbProxy(TABLE, SCHEMA);
};

module.exports.close = (db) => {
  // No-op in PostgreSQL — connections managed by pool
};

module.exports.queryMedic = queryMedic;

module.exports.medicDbName = () => `${SCHEMA}.${TABLE}`;

// Export pool for direct access when needed
module.exports._pool = pool;
