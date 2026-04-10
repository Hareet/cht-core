/**
 * @module powersync-connector
 *
 * Backend connector for PowerSync that handles uploading client-written
 * task and target documents to the CHT API server.
 *
 * PowerSync calls `uploadData` automatically whenever local writes are pending.
 * The rules engine writes tasks and targets to local SQLite; this connector
 * ensures those writes reach the server.
 *
 * Usage:
 *   const connector = createChtBackendConnector({ apiUrl, getAuthToken });
 *   db.connect(connector);
 *
 * Upload flow:
 *   1. Rules engine writes task/target docs via PowerSync adapter
 *   2. PowerSync queues writes in its CRUD upload queue
 *   3. PowerSync calls connector.uploadData() automatically
 *   4. Connector reads ops from queue, maps to CHT API calls
 *   5. On success, calls transaction.complete() to advance queue
 *   6. On failure, throws — PowerSync retries with backoff
 *
 * The rules_state_store table is local-only and never uploaded.
 */

/* eslint-disable no-console */

/**
 * Maps a PowerSync CRUD operation to the appropriate CHT API call.
 *
 * @param {string} apiUrl - Base URL of the CHT API (e.g. 'https://cht.example.com')
 * @param {Function} getAuthToken - Async function returning a valid auth token
 * @param {Object} op - PowerSync CrudEntry
 * @param {string} op.table - Table name ('tasks', 'targets')
 * @param {string} op.op - Operation type: 'PUT', 'PATCH', 'DELETE'
 * @param {string} op.id - Document ID
 * @param {Object} op.opData - Changed columns
 */
const processOperation = async (apiUrl, getAuthToken, op) => {
  // Only tasks and targets are uploaded. Contacts and reports are server-authoritative.
  // rules_state_store is local-only and never appears in the CRUD queue.
  if (op.table !== 'tasks' && op.table !== 'targets') {
    console.debug(`Skipping upload for read-only table: ${op.table}`);
    return;
  }

  const token = await getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  // The doc column contains the full CouchDB-compatible document as JSON.
  // We send this directly to the CHT API, which expects the full doc.
  const doc = op.opData?.doc ? JSON.parse(op.opData.doc) : { _id: op.id };

  switch (op.op) {
  case 'PUT': {
    // New document — POST to CHT API bulk docs endpoint
    const response = await fetch(`${apiUrl}/api/v1/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ docs: [doc] }),
    });
    if (!response.ok && response.status >= 500) {
      throw new Error(`Server error uploading ${op.table}/${op.id}: ${response.status}`);
    }
    // 4xx errors are surfaced but don't block the queue
    if (!response.ok) {
      console.error(`Upload rejected for ${op.table}/${op.id}: ${response.status}`);
    }
    break;
  }

  case 'PATCH': {
    // Updated document — PUT to CHT API
    const response = await fetch(`${apiUrl}/medic/${encodeURIComponent(op.id)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(doc),
    });
    if (!response.ok && response.status >= 500) {
      throw new Error(`Server error updating ${op.table}/${op.id}: ${response.status}`);
    }
    if (!response.ok) {
      console.error(`Update rejected for ${op.table}/${op.id}: ${response.status}`);
    }
    break;
  }

  case 'DELETE': {
    // Task/target deletion — rare, but handle it
    const response = await fetch(`${apiUrl}/medic/${encodeURIComponent(op.id)}`, {
      method: 'DELETE',
      headers,
    });
    if (!response.ok && response.status >= 500) {
      throw new Error(`Server error deleting ${op.table}/${op.id}: ${response.status}`);
    }
    break;
  }
  }
};

/**
 * Creates a PowerSync backend connector for the CHT.
 *
 * @param {Object} config
 * @param {string} config.apiUrl - CHT API base URL
 * @param {Function} config.getAuthToken - Async function returning a JWT token
 * @param {string} [config.powersyncUrl] - PowerSync service URL (default: 'http://powersync:8080')
 * @returns {Object} PowerSyncBackendConnector implementation
 */
const createChtBackendConnector = ({ apiUrl, getAuthToken, powersyncUrl = 'http://powersync:8080' }) => {
  return {
    /**
     * Called by PowerSync to get credentials for the sync stream connection.
     * Must return fresh credentials — called every few minutes on reconnect.
     */
    fetchCredentials: async () => {
      const token = await getAuthToken();
      return {
        endpoint: powersyncUrl,
        token,
        expiresAt: new Date(Date.now() + 3600_000), // 1 hour hint
      };
    },

    /**
     * Called automatically by PowerSync whenever local writes (tasks, targets) are pending.
     * Processes one transaction at a time. Must call transaction.complete() on success.
     * Throwing causes PowerSync to retry with exponential backoff.
     *
     * @param {Object} database - PowerSync database instance
     */
    uploadData: async (database) => {
      const transaction = await database.getNextCrudTransaction();
      if (!transaction) {
        return;
      }

      try {
        for (const op of transaction.crud) {
          await processOperation(apiUrl, getAuthToken, op);
        }
        // Advance the queue — MUST be called or queue stalls permanently
        await transaction.complete();
      } catch (err) {
        console.error('Error uploading rules engine data:', err);
        // Re-throw so PowerSync retries with backoff
        throw err;
      }
    },
  };
};

module.exports = { createChtBackendConnector };
