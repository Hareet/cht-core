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
const ctx = require('../services/data-context');
const { Report, Person, Place, Qualifier } = require('@medic/cht-datasource');
const logger = require('@medic/logger');
const featureFlags = require('../services/feature-flags');

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
 * Transforms a PowerSync CrudEntry into a cht-datasource input shape.
 *
 * Bridges the PowerSync client schema (which mirrors cht-sync dbt column names,
 * e.g. `contact_id`) and the cht-datasource ReportInput shape (which expects
 * `contact` as the contact UUID string). cht-datasource fetches the contact
 * doc by UUID and minifies it into the nested {_id, parent, ...} form.
 *
 * @param {object} entry - PowerSync CrudEntry with `table`, `id`, and `opData`
 * @returns {object|null} transformed doc or null if invalid
 */
const transformCrudEntry = (entry) => {
  const { table, opData } = entry;
  if (!opData) {
    return null;
  }

  const doc = { ...opData };

  if (table === 'reports') {
    if (!doc.type) {
      doc.type = 'data_record';
    }
    // PowerSync `reports.contact_id` column → cht-datasource `contact` UUID.
    if (doc.contact_id && !doc.contact) {
      doc.contact = doc.contact_id;
    }
  }

  return doc;
};

/**
 * Processes a single CRUD entry via cht-datasource.
 */
const processCrudEntry = async (entry) => {
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

      // Preserve the client-minted UUID as the server `_id`. PowerSync best practice:
      // client-generated UUIDs must round-trip so retried uploads are idempotent and
      // cross-device references resolve without an ID mapping table.
      const result = await tableConfig.create(doc, id);
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

    const userCtx = await auth.getUserCtx(req);
    const userSettings = await auth.getUserSettings(userCtx);
    if (!featureFlags.isFeatureEnabled('powersync', userSettings)) {
      // IMPORTANT: PowerSync SDK retries on 4xx/5xx errors, which will block the upload queue.
      // The client-side uploadData() implementation MUST catch 403 specifically and handle it
      // by falling back to CouchDB replication instead of rethrowing. See Agent 5's connector.
      return serverUtils.error(
        { code: 403, message: 'PowerSync is not enabled for this user.' },
        req, res
      );
    }

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

  /**
   * GET /api/v1/powersync/status
   *
   * Returns whether PowerSync is enabled for the authenticated user, and
   * which cht-datasource backend (`couchdb` | `postgres`) the api is
   * currently configured to use. Benchmark harnesses and client code use
   * `backend` as a pre-flight check so writes land where callers expect.
   *
   * Auth failures on the permission lookup don't break the backend probe
   * — we still return `backend` so a pre-flight can detect mismatches even
   * when the caller isn't authed as a powersync-enabled user.
   *
   * Response: { powersync_enabled: boolean, backend: 'couchdb'|'postgres' }
   */
  status: serverUtils.doOrError(async (req, res) => {
    const backend = (process.env.CHT_DB_BACKEND || 'couchdb').toLowerCase();
    let enabled = false;
    try {
      const userCtx = await auth.getUserCtx(req);
      const userSettings = await auth.getUserSettings(userCtx);
      enabled = featureFlags.isFeatureEnabled('powersync', userSettings);
    } catch {
      // Backend probe must still succeed even if auth/user-settings lookup fails
    }
    return res.json({ powersync_enabled: enabled, backend });
  }),

  // Exported for testing
  _processCrudEntry: processCrudEntry,
  _transformCrudEntry: transformCrudEntry,
};
