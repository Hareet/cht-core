'use strict';

const { Pool } = require('pg');

let pool;

const getPool = () => {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.POSTGRESQL_URL || 'postgresql://localhost:5432/cht',
      max: parseInt(process.env.PG_POOL_MAX || '10', 10),
    });
  }
  return pool;
};

// Schema where cht-sync places the couchdb table. Configurable for testing.
const SCHEMA = process.env.COUCHDB_SCHEMA || 'v1';

const query = (text, params) => getPool().query(text, params);

const getClient = () => getPool().connect();

const getSchema = () => SCHEMA;

const end = async () => {
  if (pool) {
    await pool.end();
    pool = null;
  }
};

module.exports = {
  query,
  getClient,
  getSchema,
  end,
  // For testing: allow injecting a mock pool
  _setPool: (mockPool) => { pool = mockPool; },
};
