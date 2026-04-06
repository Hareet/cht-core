/**
 * Agent Harness — Test utility wrapper for containerized agent environments.
 *
 * This module wraps the existing test framework (tests/utils/index.js) for use
 * in multi-agent containerized environments where Docker services are already
 * running. It:
 *
 * - No-ops prepServices/tearDownServices (services are pre-running)
 * - Provides PostgreSQL and PowerSync client connections
 * - Re-exports all existing helper functions unchanged
 * - Adds PostgreSQL-specific assertion helpers
 *
 * Environment variables:
 *   COUCH_URL       - CouchDB URL (default: https://admin:pass@localhost:5984)
 *   API_URL         - CHT API URL (default: https://localhost)
 *   POSTGRES_URL    - PostgreSQL connection string (default: postgresql://postgres:postgres@localhost:5432/cht)
 *   POWERSYNC_URL   - PowerSync service URL (default: http://localhost:8080)
 */

const { Pool } = require('pg');

// PostgreSQL connection — lazy initialized
let pgPool = null;

const getPostgresUrl = () => {
  return process.env.POSTGRES_URL || 'postgresql://postgres:postgres@localhost:5432/cht';
};

const getPowersyncUrl = () => {
  return process.env.POWERSYNC_URL || 'http://localhost:8080';
};

/**
 * Get or create the PostgreSQL connection pool.
 */
const getPostgresPool = () => {
  if (!pgPool) {
    pgPool = new Pool({ connectionString: getPostgresUrl() });
  }
  return pgPool;
};

/**
 * Execute a PostgreSQL query.
 * @param {string} text - SQL query text
 * @param {Array} params - Query parameters
 * @returns {Promise<import('pg').QueryResult>}
 */
const pgQuery = (text, params) => {
  return getPostgresPool().query(text, params);
};

/**
 * Close the PostgreSQL connection pool.
 */
const closePgPool = async () => {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
};

/**
 * No-op replacement for prepServices — services are already running.
 * Only waits for API readiness and sets up default data.
 */
const prepServices = async (defaultSettings) => {
  const utils = require('./index');
  console.log('Agent harness: skipping Docker service startup (services pre-running)');

  // Wait for API to be reachable
  await utils.listenForApi();

  if (defaultSettings) {
    console.log('Agent harness: setting up default settings');
    const defaultAppSettings = utils.getDefaultSettings();
    defaultAppSettings.transitions = {};
    await utils.request({
      path: '/api/v1/settings?replace=1',
      method: 'PUT',
      body: defaultAppSettings
    });
  }

  // Set up user contact and login (same as original prepServices)
  await utils.request({
    path: `/${require('@constants').DB_NAME}/_bulk_docs`,
    method: 'POST',
    body: {
      docs: [
        require('@constants').DEFAULT_USER_CONTACT_DOC,
        require('@constants').DEFAULT_USER_ADMIN_TRAINING_DOC
      ]
    }
  }).catch(() => {
    // Docs may already exist; that's fine
  });

  await utils.setupUserDoc();
};

/**
 * No-op replacement for tearDownServices — do not tear down shared services.
 * Only cleans up test-specific resources.
 */
const tearDownServices = async () => {
  console.log('Agent harness: skipping Docker service teardown');
  await closePgPool();
};

// --- PostgreSQL assertion helpers ---

/**
 * Wait for a document to appear in PostgreSQL (via cht-sync).
 * Polls the couchdb JSONB table until the doc_id is found.
 *
 * @param {string} docId - The CouchDB document _id to wait for
 * @param {number} timeoutMs - Maximum wait time in milliseconds (default: 30000)
 * @param {number} intervalMs - Polling interval in milliseconds (default: 500)
 * @returns {Promise<object>} The JSONB document from PostgreSQL
 */
const waitForDocInPostgres = async (docId, timeoutMs = 30000, intervalMs = 500) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await pgQuery(
        'SELECT doc FROM couchdb WHERE doc_id = $1 LIMIT 1',
        [docId]
      );
      if (result.rows.length > 0) {
        return result.rows[0].doc;
      }
    } catch (err) {
      // Table may not exist yet during early startup; keep polling
      if (!err.message.includes('does not exist')) {
        throw err;
      }
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Document ${docId} did not appear in PostgreSQL within ${timeoutMs}ms`);
};

/**
 * Query documents in PostgreSQL by type.
 * @param {string} type - Document type (e.g., 'person', 'data_record')
 * @returns {Promise<Array<object>>}
 */
const getPostgresDocsByType = async (type) => {
  const result = await pgQuery(
    "SELECT doc FROM couchdb WHERE doc->>'type' = $1",
    [type]
  );
  return result.rows.map(row => row.doc);
};

/**
 * Query documents in PostgreSQL by facility (contact hierarchy).
 * @param {string} facilityId - The facility/contact _id
 * @returns {Promise<Array<object>>}
 */
const getPostgresDocsByFacility = async (facilityId) => {
  const result = await pgQuery(
    "SELECT doc FROM couchdb WHERE doc->'contact'->>'parent' = $1 OR doc->'parent'->>'_id' = $1",
    [facilityId]
  );
  return result.rows.map(row => row.doc);
};

/**
 * Check if PostgreSQL is reachable and the cht-sync schema exists.
 * @returns {Promise<boolean>}
 */
const checkPostgresReady = async () => {
  try {
    const result = await pgQuery(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'couchdb')"
    );
    return result.rows[0].exists;
  } catch {
    return false;
  }
};

/**
 * Check if PowerSync service is reachable.
 * @returns {Promise<boolean>}
 */
const checkPowersyncReady = async () => {
  try {
    const response = await fetch(`${getPowersyncUrl()}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
};

/**
 * Wait for all services to be ready (API, PostgreSQL, optionally PowerSync).
 * @param {object} options
 * @param {boolean} options.requirePowersync - Whether to wait for PowerSync (default: false)
 * @param {number} options.timeoutMs - Maximum wait time (default: 60000)
 */
const waitForAllServices = async ({ requirePowersync = false, timeoutMs = 60000 } = {}) => {
  const utils = require('./index');
  const start = Date.now();

  // Wait for API
  console.log('Agent harness: waiting for API...');
  await utils.listenForApi();
  console.log('Agent harness: API ready');

  // Wait for PostgreSQL
  console.log('Agent harness: waiting for PostgreSQL...');
  while (Date.now() - start < timeoutMs) {
    if (await checkPostgresReady()) {
      console.log('Agent harness: PostgreSQL ready');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!await checkPostgresReady()) {
    throw new Error('PostgreSQL did not become ready within timeout');
  }

  // Optionally wait for PowerSync
  if (requirePowersync) {
    console.log('Agent harness: waiting for PowerSync...');
    while (Date.now() - start < timeoutMs) {
      if (await checkPowersyncReady()) {
        console.log('Agent harness: PowerSync ready');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('PowerSync did not become ready within timeout');
  }
};

// Re-export everything from the original utils, overriding service lifecycle functions
const originalUtils = require('./index');

module.exports = {
  ...originalUtils,

  // Override service lifecycle
  prepServices,
  tearDownServices,

  // PostgreSQL utilities
  pgQuery,
  getPostgresPool,
  closePgPool,
  waitForDocInPostgres,
  getPostgresDocsByType,
  getPostgresDocsByFacility,
  checkPostgresReady,

  // PowerSync utilities
  checkPowersyncReady,
  getPowersyncUrl,

  // Combined service readiness
  waitForAllServices,
};
