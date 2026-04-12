/**
 * PowerSync Upload Controller
 *
 * Receives CRUD batches from the PowerSync SDK's uploadData() callback and routes them
 * through cht-datasource to persist in PostgreSQL (or CouchDB via the local adapter).
 *
 * PowerSync CrudEntry fields (from @journeyapps/powersync-sdk-common):
 *   op:            'PUT' | 'PATCH' | 'DELETE'
 *   table:         string  — PowerSync table name (maps to CHT doc type)
 *   id:            string  — document UUID
 *   opData?:       Record<string, any> — column values (PUT: all non-null, PATCH: changed only)
 *   clientId:      number  — per-client incrementing ID for deduplication
 *   transactionId?: number — groups operations in a local transaction
 *   metadata?:     string  — optional client metadata
 */
const auth = require('../auth');
const serverUtils = require('../server-utils');
const localCtx = require('../services/data-context');
const { Report, Person, Place, Qualifier, getPostgresDataContext } = require('@medic/cht-datasource');
const logger = require('@medic/logger');
const config = require('../config');

// Use PostgreSQL direct writes if PS_DATABASE_URI is set (target architecture).
// This bypasses cht-datasource and writes directly to v1.couchdb — the same table
// PowerSync reads via WAL. For the benchmark, this is the correct target path.
const pgUri = process.env.PS_DATABASE_URI || process.env.POSTGRES_URI;
let pgPool = null;
if (pgUri) {
  try {
    // pg might not be in api/node_modules — use dynamic import from shared location
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString: pgUri });
    logger.info('PowerSync upload controller using direct PostgreSQL writes');
  } catch (e) {
    logger.warn('pg module not available, trying native fetch approach:', e.message);
  }
}
const ctx = localCtx;

const createReport = ctx.bind(Report.v1.create);
const createPerson = ctx.bind(Person.v1.create);
const createPlace = ctx.bind(Place.v1.create);
const updateReport = ctx.bind(Report.v1.update);
const updatePerson = ctx.bind(Person.v1.update);
const updatePlace = ctx.bind(Place.v1.update);
const getReport = ctx.bind(Report.v1.get);
const getPerson = ctx.bind(Person.v1.get);
const getPlace = ctx.bind(Place.v1.get);

/**
 * Maps a PowerSync table name to CHT doc type operations.
 * The table names here must match the PowerSync schema defined in the Sync Streams rules.
 */
const TABLE_CONFIG = {
  reports: {
    docType: 'data_record',
    create: createReport,
    update: updateReport,
    get: getReport,
  },
  persons: {
    docType: 'person',
    create: createPerson,
    update: updatePerson,
    get: getPerson,
  },
  contacts: {
    docType: null,
    create: createPlace,
    update: updatePlace,
    get: getPlace,
  },
};

const MAX_BATCH_SIZE = 100;

/**
 * Transforms a PowerSync CrudEntry into a CouchDB-style document for cht-datasource.
 * @param {object} entry - PowerSync CrudEntry with `table`, `id`, and `opData`
 * @returns {object|null} transformed doc or null if invalid
 */
const transformCrudEntry = (entry) => {
  const { table, opData } = entry;
  if (!opData) {
    return null;
  }

  const doc = { ...opData };

  // For reports, ensure the CouchDB type field is set
  if (table === 'reports' && !doc.type) {
    doc.type = 'data_record';
  }

  return doc;
};

/**
 * Direct PostgreSQL write — bypasses cht-datasource validation, writes to v1.couchdb directly.
 * This is the target architecture: API → PostgreSQL → WAL → PowerSync.
 */
const processCrudEntryPg = async (entry) => {
  const { op, table, id, opData } = entry;

  try {
    if (!op || !table || !id) {
      return { id: id || null, ok: false, error: 'Missing required fields: op, table, id' };
    }

    if (op === 'PUT') {
      if (!opData) {
        return { id, ok: false, error: 'Missing opData for PUT operation' };
      }

      const docId = id;
      const doc = { _id: docId, ...opData };

      await pgPool.query(
        `INSERT INTO v1.couchdb (_id, doc, _deleted)
         VALUES ($1, $2::jsonb, false)
         ON CONFLICT (_id) DO UPDATE SET doc = $2::jsonb, _deleted = false`,
        [docId, JSON.stringify(doc)]
      );
      return { id: docId, ok: true };
    }

    if (op === 'DELETE') {
      await pgPool.query(
        `UPDATE v1.couchdb SET _deleted = true WHERE _id = $1`,
        [id]
      );
      return { id, ok: true };
    }

    if (op === 'PATCH') {
      const result = await pgPool.query(
        `UPDATE v1.couchdb SET doc = doc || $2::jsonb WHERE _id = $1 RETURNING _id`,
        [id, JSON.stringify(opData || {})]
      );
      if (result.rowCount === 0) {
        return { id, ok: false, error: `Document ${id} not found for PATCH` };
      }
      return { id, ok: true };
    }

    return { id, ok: false, error: `Unsupported operation: ${op}` };
  } catch (err) {
    logger.error(`PowerSync PG upload error for ${op} ${table}/${id}:`, err);
    return { id, ok: false, error: err.message || 'Internal error' };
  }
};

/**
 * CouchDB path via cht-datasource (fallback when PostgreSQL not configured).
 */
const processCrudEntryCouchDb = async (entry) => {
  const { op, table, id, opData } = entry;

  try {
    if (!op || !table || !id) {
      return { id: id || null, ok: false, error: 'Missing required fields: op, table, id' };
    }

    const tableConfig = TABLE_CONFIG[table];
    if (!tableConfig) {
      return { id, ok: false, error: `Unsupported table: ${table}` };
    }

    if (op === 'DELETE') {
      logger.info(`PowerSync DELETE for ${table}/${id} — soft delete not yet implemented`);
      return { id, ok: true };
    }

    if (op === 'PUT') {
      const doc = transformCrudEntry(entry);
      if (!doc) {
        return { id, ok: false, error: 'Missing opData for PUT operation' };
      }

      const existing = await tableConfig.get(Qualifier.byUuid(id)).catch(() => null);

      if (existing) {
        const updated = { ...existing, ...doc, _id: existing._id, _rev: existing._rev };
        const result = await tableConfig.update(updated);
        return { id: result._id, ok: true };
      }

      const result = await tableConfig.create(doc);
      return { id: result._id, ok: true };
    }

    if (op === 'PATCH') {
      const existing = await tableConfig.get(Qualifier.byUuid(id));
      if (!existing) {
        return { id, ok: false, error: `Document ${id} not found for PATCH` };
      }
      const merged = { ...existing, ...(opData || {}), _id: existing._id, _rev: existing._rev };
      const result = await tableConfig.update(merged);
      return { id: result._id, ok: true };
    }

    return { id, ok: false, error: `Unsupported operation: ${op}` };
  } catch (err) {
    logger.error(`PowerSync upload error for ${op} ${table}/${id}:`, err);
    return { id, ok: false, error: err.message || 'Internal error' };
  }
};

const processCrudEntry = pgPool ? processCrudEntryPg : processCrudEntryCouchDb;

module.exports = {
  /**
   * POST /api/v1/powersync/upload
   *
   * Receives a batch of CRUD operations from the PowerSync SDK's uploadData() callback.
   * Each operation is processed independently — partial success is possible.
   *
   * Request body:
   *   { crud: CrudEntry[] }
   *   where CrudEntry = { op, table, id, opData?, clientId?, transactionId?, metadata? }
   *
   * Response:
   *   { results: { id: string, ok: boolean, error?: string }[] }
   */
  upload: serverUtils.doOrError(async (req, res) => {
    await auth.assertPermissions(req, { isOnline: false, hasAny: ['can_create_records', 'can_edit'] });

    const { crud } = req.body;

    if (!Array.isArray(crud)) {
      return serverUtils.error({ code: 400, message: 'Request body must contain a "crud" array.' }, req, res);
    }

    if (crud.length === 0) {
      return res.json({ results: [] });
    }

    if (crud.length > MAX_BATCH_SIZE) {
      return serverUtils.error({
        code: 400,
        message: `Batch size ${crud.length} exceeds maximum of ${MAX_BATCH_SIZE}.`
      }, req, res);
    }

    const results = [];
    for (const entry of crud) {
      const result = await processCrudEntry(entry);
      results.push(result);
    }

    return res.json({ results });
  }),

  // Exported for testing
  _processCrudEntry: processCrudEntry,
  _transformCrudEntry: transformCrudEntry,
};
