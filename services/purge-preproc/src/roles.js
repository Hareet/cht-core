'use strict';

const db = require('./db');
const purgingUtils = require('@medic/purging-utils');

// Retrieve unique offline role sets from the cht-sync couchdb table.
// User docs are stored in CouchDB as org.couchdb.user:<name> and replicated
// to PostgreSQL via cht-sync. We extract distinct role arrays and hash them.
const getRoles = async () => {
  const result = await db.query(`
    SELECT DISTINCT doc->'roles' AS roles
    FROM couchdb
    WHERE doc->>'type' = 'user-settings'
      AND doc->'roles' IS NOT NULL
      AND jsonb_array_length(doc->'roles') > 0
  `);

  const rolesByHash = {};

  for (const row of result.rows) {
    const roles = row.roles;
    if (!Array.isArray(roles) || !roles.length) {
      continue;
    }

    const sorted = purgingUtils.sortedUniqueRoles(roles);
    const hash = purgingUtils.getRoleHash(sorted);
    rolesByHash[hash] = sorted;
  }

  return rolesByHash;
};

// Persist role hash -> roles mapping for auditability
const saveRoles = async (rolesByHash) => {
  if (!Object.keys(rolesByHash).length) {
    return;
  }

  const values = Object.entries(rolesByHash).map(([hash, roles], i) => {
    const offset = i * 2;
    return `($${offset + 1}, $${offset + 2}::jsonb, NOW())`;
  });

  const params = Object.entries(rolesByHash).flatMap(([hash, roles]) => [hash, JSON.stringify(roles)]);

  await db.query(`
    INSERT INTO purge_roles (role_hash, roles, updated_at)
    VALUES ${values.join(', ')}
    ON CONFLICT (role_hash) DO UPDATE SET roles = EXCLUDED.roles, updated_at = NOW()
  `, params);
};

module.exports = {
  getRoles,
  saveRoles,
};
