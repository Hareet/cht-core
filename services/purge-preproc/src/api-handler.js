'use strict';

const engine = require('./engine');
const rolesService = require('./roles');
const db = require('./db');

// Validate the POST body for /api/v1/purge/request.
const validate = (body) => {
  const errors = [];
  if (!body.user_id || typeof body.user_id !== 'string') {
    errors.push('user_id is required and must be a string');
  }
  if (!body.facility_id || typeof body.facility_id !== 'string') {
    errors.push('facility_id is required and must be a string');
  }
  if (typeof body.current_db_size_mb !== 'number' || body.current_db_size_mb < 0) {
    errors.push('current_db_size_mb is required and must be a non-negative number');
  }
  if (typeof body.tier_budget_mb !== 'number' || body.tier_budget_mb <= 0) {
    errors.push('tier_budget_mb is required and must be a positive number');
  }
  return errors;
};

// Resolve the role hash for a specific user from their user-settings document.
const getUserRoleHash = async (userId) => {
  const rolesByHash = await rolesService.getRoles();

  // Find the user-settings doc for this user to get their specific roles
  const tbl = `${db.getSchema()}.couchdb`;
  const result = await db.query(`
    SELECT doc->'roles' AS roles
    FROM ${tbl}
    WHERE doc->>'type' = 'user-settings'
      AND _id = $1
    LIMIT 1
  `, [userId]);

  if (!result.rows.length || !Array.isArray(result.rows[0].roles)) {
    return null;
  }

  const purgingUtils = require('@medic/purging-utils');
  const sorted = purgingUtils.sortedUniqueRoles(result.rows[0].roles);
  const hash = purgingUtils.getRoleHash(sorted);

  // Verify this hash is in the active offline roles
  if (!rolesByHash[hash]) {
    return null;
  }

  return hash;
};

// Handle the /api/v1/purge/request POST.
// Can be called directly by the purge-preproc service or via an API controller.
const handlePurgeRequest = async (body) => {
  const errors = validate(body);
  if (errors.length) {
    return { status: 400, body: { error: errors.join('; ') } };
  }

  const { user_id, facility_id, current_db_size_mb, tier_budget_mb } = body;

  // Only trigger aggressive purge if over budget
  if (current_db_size_mb <= tier_budget_mb) {
    return {
      status: 200,
      body: {
        purged_count: 0,
        estimated_reduction_mb: 0,
        message: 'Device is within storage budget, no aggressive purge needed',
      },
    };
  }

  const roleHash = await getUserRoleHash(user_id);
  if (!roleHash) {
    return {
      status: 404,
      body: { error: `No offline role found for user ${user_id}` },
    };
  }

  const result = await engine.runAggressivePurge(user_id, facility_id, roleHash);

  console.log(
    `Aggressive purge for ${user_id}: ${result.purged_count} docs purged ` +
    `(tasks=${result.breakdown.tasks}, targets=${result.breakdown.targets}, reports=${result.breakdown.reports}), ` +
    `est. ${result.estimated_reduction_mb}MB reduction`
  );

  return {
    status: 200,
    body: result,
  };
};

module.exports = {
  handlePurgeRequest,
  validate,
  getUserRoleHash,
};
