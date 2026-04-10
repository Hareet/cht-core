/**
 * @module adapters
 *
 * Factory for creating data provider adapters for the rules engine.
 * Supports runtime selection between PouchDB (legacy) and PowerSync (new) backends.
 */

const pouchdbProvider = require('../pouchdb-provider');
const powersyncProvider = require('./powersync-adapter');
const { createChtSchema, SCHEMA_TABLES } = require('./powersync-schema');
const { createChtBackendConnector } = require('./powersync-connector');

/**
 * Creates a data provider adapter based on the specified type.
 *
 * @param {string} type - The adapter type: 'pouchdb' or 'powersync'
 * @param {Object} db - The database instance (PouchDB instance or PowerSync database)
 * @returns {Object} A provider object implementing the rules engine data interface
 */
const create = (type, db) => {
  switch (type) {
  case 'powersync':
    return powersyncProvider(db);
  case 'pouchdb':
  default:
    return pouchdbProvider(db);
  }
};

module.exports = { create, createChtSchema, SCHEMA_TABLES, createChtBackendConnector };
