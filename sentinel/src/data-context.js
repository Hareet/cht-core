const { getLocalDataContext, getPostgresDataContext } = require('@medic/cht-datasource');
const config = require('./config');

if (process.env.CHT_DB_BACKEND === 'postgresql') {
  // Use native PostgreSQL adapter — proper SQL queries, lineage CTEs,
  // optimistic locking via _rev. Pool comes from db-postgresql.js.
  const db = require('./db');
  const settingsService = { getAll: () => config.getAll() };
  module.exports = getPostgresDataContext(db._pool, settingsService);
} else {
  const db = require('./db');
  module.exports = getLocalDataContext(config, db);
}
