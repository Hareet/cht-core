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

const query = (text, params) => getPool().query(text, params);

const getClient = () => getPool().connect();

const end = async () => {
  if (pool) {
    await pool.end();
    pool = null;
  }
};

module.exports = {
  query,
  getClient,
  end,
  // For testing: allow injecting a mock pool
  _setPool: (mockPool) => { pool = mockPool; },
};
