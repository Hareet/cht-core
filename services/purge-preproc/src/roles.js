'use strict';

const db = require('./db');
const purgingUtils = require('@medic/purging-utils');

// The 'mm-online' role (and '_admin' / 'admin') marks a user as online-only.
// Online users access all documents directly and don't need purging.
// This mirrors shared-libs/user-management/src/roles.js: hasOnlineRole() and isOffline().
const ONLINE_ROLE = 'mm-online';
const ADMIN_ROLES = ['_admin', 'admin'];

const hasOnlineRole = (roles) => {
  return roles.some(role => role === ONLINE_ROLE || ADMIN_ROLES.includes(role));
};

// Retrieve unique offline role sets from the cht-sync couchdb table.
// User-settings docs (type: 'user-settings') contain roles arrays.
// We filter out online-only users since purging only applies to offline users.
const getRoles = async () => {
  const tbl = `${db.getSchema()}.couchdb`;
  const result = await db.query(`
    SELECT DISTINCT doc->'roles' AS roles
    FROM ${tbl}
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

    // Skip online-only users — they access all docs and don't need purging
    if (hasOnlineRole(roles)) {
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
