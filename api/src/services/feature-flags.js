const crypto = require('crypto');
const config = require('../config');

const FEATURES = {
  powersync: 'powersync',
};

/**
 * Returns the powersync feature flag configuration from app_settings.
 * Defaults to disabled if not configured.
 */
const getPowerSyncConfig = () => {
  const ps = config.get('powersync');
  return {
    enabled: !!(ps && ps.enabled),
    facilities: (ps && Array.isArray(ps.facilities)) ? ps.facilities : [],
    rollout_percentage: (ps && typeof ps.rollout_percentage === 'number') ? ps.rollout_percentage : 0,
  };
};

/**
 * Determines whether a user passes percentage-based rollout.
 * Uses a deterministic hash of the username so the same user always gets
 * the same result (consistent assignment).
 */
const passesRolloutPercentage = (username, percentage) => {
  if (percentage >= 100) {
    return true;
  }
  if (percentage <= 0) {
    return false;
  }
  const hash = crypto.createHash('sha256').update(username).digest();
  const value = hash.readUInt16BE(0) % 100;
  return value < percentage;
};

/**
 * Checks whether a feature is enabled for the given user context.
 *
 * @param {string} feature - Feature name (e.g. 'powersync')
 * @param {object} userCtx - User context with `name`, `facility_id` (string[]), `roles`
 * @returns {boolean} Whether the feature is enabled for this user
 */
const isFeatureEnabled = (feature, userCtx) => {
  if (feature !== FEATURES.powersync) {
    return false;
  }

  const cfg = getPowerSyncConfig();

  if (!cfg.enabled) {
    return false;
  }

  // If facilities list is non-empty, check if user's facility is included
  if (cfg.facilities.length > 0) {
    const userFacilities = Array.isArray(userCtx.facility_id)
      ? userCtx.facility_id
      : (userCtx.facility_id ? [userCtx.facility_id] : []);

    const facilityMatch = userFacilities.some(fid => cfg.facilities.includes(fid));
    if (!facilityMatch) {
      return false;
    }
  }

  // If rollout_percentage is set (> 0 and < 100), apply percentage gate
  if (cfg.rollout_percentage > 0 && cfg.rollout_percentage < 100) {
    return passesRolloutPercentage(userCtx.name || '', cfg.rollout_percentage);
  }

  return true;
};

module.exports = {
  isFeatureEnabled,
  FEATURES,
  // Exported for testing
  _passesRolloutPercentage: passesRolloutPercentage,
  _getPowerSyncConfig: getPowerSyncConfig,
};
