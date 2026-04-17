const { getLocalDataContext, getPostgresDataContext } = require('@medic/cht-datasource');
const logger = require('@medic/logger');
const db = require('../db');
const config = require('../config');

const CHT_DB_BACKEND = (process.env.CHT_DB_BACKEND || 'couchdb').toLowerCase();

const getPostgresUrl = () => {
  if (process.env.POSTGRES_URL) {
    return process.env.POSTGRES_URL;
  }
  const user = process.env.POSTGRES_USER || 'cht';
  const pass = process.env.POSTGRES_PASSWORD || 'pgpass';
  const host = process.env.POSTGRES_HOST || 'postgres';
  const port = process.env.POSTGRES_PORT || '5432';
  const database = process.env.POSTGRES_DB || 'cht';
  return `postgresql://${user}:${pass}@${host}:${port}/${database}`;
};

const buildPostgresContext = () => {
  // Lazy require — `pg` ships with api but keep it out of the CouchDB-only code path.
  // eslint-disable-next-line global-require
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: getPostgresUrl() });
  const schemaConfig = {
    schema: process.env.CHT_PG_SCHEMA || 'v1',
    table: process.env.CHT_PG_TABLE || 'couchdb',
  };
  logger.info(
    `data-context: using Postgres adapter (schema="${schemaConfig.schema}", table="${schemaConfig.table}")`
  );
  return getPostgresDataContext(pool, config, schemaConfig);
};

const buildCouchdbContext = () => {
  logger.info('data-context: using CouchDB (local) adapter');
  return getLocalDataContext(config, db);
};

module.exports = CHT_DB_BACKEND === 'postgres' ? buildPostgresContext() : buildCouchdbContext();
