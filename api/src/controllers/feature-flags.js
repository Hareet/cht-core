const auth = require('../auth');
const serverUtils = require('../server-utils');
const settingsService = require('../services/settings');
const config = require('../config');

const VALID_FEATURES = ['powersync'];

const validatePowerSyncBody = (body) => {
  const errors = [];

  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    errors.push('"enabled" must be a boolean');
  }

  if (body.facilities !== undefined) {
    if (!Array.isArray(body.facilities)) {
      errors.push('"facilities" must be an array of UUID strings');
    } else if (body.facilities.some(f => typeof f !== 'string')) {
      errors.push('"facilities" must contain only strings');
    }
  }

  if (body.rollout_percentage !== undefined) {
    if (typeof body.rollout_percentage !== 'number' || body.rollout_percentage < 0 || body.rollout_percentage > 100) {
      errors.push('"rollout_percentage" must be a number between 0 and 100');
    }
  }

  return errors;
};

module.exports = {
  get: serverUtils.doOrError(async (req, res) => {
    await auth.check(req, ['can_edit', 'can_configure']);

    const feature = req.params.feature;
    if (!VALID_FEATURES.includes(feature)) {
      return serverUtils.error({ code: 404, message: `Unknown feature: ${feature}` }, req, res);
    }

    const current = config.get(feature) || {};
    return res.json({
      feature,
      enabled: !!current.enabled,
      facilities: Array.isArray(current.facilities) ? current.facilities : [],
      rollout_percentage: typeof current.rollout_percentage === 'number' ? current.rollout_percentage : 0,
    });
  }),

  put: serverUtils.doOrError(async (req, res) => {
    await auth.check(req, ['can_edit', 'can_configure']);

    const feature = req.params.feature;
    if (!VALID_FEATURES.includes(feature)) {
      return serverUtils.error({ code: 404, message: `Unknown feature: ${feature}` }, req, res);
    }

    const errors = validatePowerSyncBody(req.body);
    if (errors.length > 0) {
      return serverUtils.error({ code: 400, message: errors.join('; ') }, req, res);
    }

    const current = config.get(feature) || {};
    const updated = {
      enabled: req.body.enabled !== undefined ? req.body.enabled : !!current.enabled,
      facilities: req.body.facilities !== undefined ? req.body.facilities : (current.facilities || []),
      rollout_percentage: req.body.rollout_percentage !== undefined
        ? req.body.rollout_percentage
        : (current.rollout_percentage || 0),
    };

    // Deep-extend app_settings with the updated feature config
    await settingsService.update({ [feature]: updated });

    return res.json({
      success: true,
      feature,
      ...updated,
    });
  }),
};
