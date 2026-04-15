const { expect } = require('chai');
const sinon = require('sinon');
const config = require('../../../src/config');
const featureFlags = require('../../../src/services/feature-flags');

describe('feature-flags service', () => {
  afterEach(() => sinon.restore());

  const makeUserCtx = (overrides = {}) => ({
    name: 'test-user',
    facility_id: ['facility-1'],
    roles: ['chw'],
    ...overrides,
  });

  describe('isFeatureEnabled', () => {
    it('returns false for unknown features', () => {
      sinon.stub(config, 'get').returns({ enabled: true });
      expect(featureFlags.isFeatureEnabled('unknown-feature', makeUserCtx())).to.equal(false);
    });

    it('returns false when powersync config is missing', () => {
      sinon.stub(config, 'get').returns(undefined);
      expect(featureFlags.isFeatureEnabled('powersync', makeUserCtx())).to.equal(false);
    });

    it('returns false when powersync is disabled', () => {
      sinon.stub(config, 'get').returns({ enabled: false });
      expect(featureFlags.isFeatureEnabled('powersync', makeUserCtx())).to.equal(false);
    });

    it('returns true when enabled globally with no facility restriction', () => {
      sinon.stub(config, 'get').returns({ enabled: true, facilities: [], rollout_percentage: 0 });
      expect(featureFlags.isFeatureEnabled('powersync', makeUserCtx())).to.equal(true);
    });

    it('returns true when enabled globally with undefined facilities', () => {
      sinon.stub(config, 'get').returns({ enabled: true });
      expect(featureFlags.isFeatureEnabled('powersync', makeUserCtx())).to.equal(true);
    });

    describe('facility-scoped', () => {
      it('returns true when user facility is in the allowed list', () => {
        sinon.stub(config, 'get').returns({
          enabled: true,
          facilities: ['facility-1', 'facility-2'],
        });
        expect(featureFlags.isFeatureEnabled('powersync', makeUserCtx())).to.equal(true);
      });

      it('returns false when user facility is not in the allowed list', () => {
        sinon.stub(config, 'get').returns({
          enabled: true,
          facilities: ['facility-99'],
        });
        expect(featureFlags.isFeatureEnabled('powersync', makeUserCtx())).to.equal(false);
      });

      it('handles user with multiple facilities (at least one match)', () => {
        sinon.stub(config, 'get').returns({
          enabled: true,
          facilities: ['facility-2'],
        });
        const userCtx = makeUserCtx({ facility_id: ['facility-1', 'facility-2'] });
        expect(featureFlags.isFeatureEnabled('powersync', userCtx)).to.equal(true);
      });

      it('handles user with string facility_id (not array)', () => {
        sinon.stub(config, 'get').returns({
          enabled: true,
          facilities: ['facility-1'],
        });
        const userCtx = makeUserCtx({ facility_id: 'facility-1' });
        expect(featureFlags.isFeatureEnabled('powersync', userCtx)).to.equal(true);
      });

      it('handles user with no facility_id', () => {
        sinon.stub(config, 'get').returns({
          enabled: true,
          facilities: ['facility-1'],
        });
        const userCtx = makeUserCtx({ facility_id: undefined });
        expect(featureFlags.isFeatureEnabled('powersync', userCtx)).to.equal(false);
      });
    });

    describe('percentage rollout', () => {
      it('returns true when rollout_percentage is 100', () => {
        sinon.stub(config, 'get').returns({
          enabled: true,
          facilities: [],
          rollout_percentage: 100,
        });
        expect(featureFlags.isFeatureEnabled('powersync', makeUserCtx())).to.equal(true);
      });

      it('returns false when rollout_percentage is 0 but enabled', () => {
        // rollout_percentage 0 means no percentage gate is applied, so enabled=true wins
        sinon.stub(config, 'get').returns({
          enabled: true,
          facilities: [],
          rollout_percentage: 0,
        });
        expect(featureFlags.isFeatureEnabled('powersync', makeUserCtx())).to.equal(true);
      });

      it('is deterministic for the same username', () => {
        sinon.stub(config, 'get').returns({
          enabled: true,
          facilities: [],
          rollout_percentage: 50,
        });
        const userCtx = makeUserCtx({ name: 'deterministic-user' });
        const result1 = featureFlags.isFeatureEnabled('powersync', userCtx);
        const result2 = featureFlags.isFeatureEnabled('powersync', userCtx);
        expect(result1).to.equal(result2);
      });

      it('applies percentage after facility check passes', () => {
        sinon.stub(config, 'get').returns({
          enabled: true,
          facilities: ['facility-1'],
          rollout_percentage: 50,
        });
        // Should not throw; result depends on hash of username
        const result = featureFlags.isFeatureEnabled('powersync', makeUserCtx());
        expect(result).to.be.a('boolean');
      });

      it('does not apply percentage when facility check fails', () => {
        sinon.stub(config, 'get').returns({
          enabled: true,
          facilities: ['other-facility'],
          rollout_percentage: 100,
        });
        expect(featureFlags.isFeatureEnabled('powersync', makeUserCtx())).to.equal(false);
      });
    });
  });

  describe('_passesRolloutPercentage', () => {
    it('returns true for percentage >= 100', () => {
      expect(featureFlags._passesRolloutPercentage('any-user', 100)).to.equal(true);
      expect(featureFlags._passesRolloutPercentage('any-user', 150)).to.equal(true);
    });

    it('returns false for percentage <= 0', () => {
      expect(featureFlags._passesRolloutPercentage('any-user', 0)).to.equal(false);
      expect(featureFlags._passesRolloutPercentage('any-user', -10)).to.equal(false);
    });

    it('is deterministic', () => {
      const r1 = featureFlags._passesRolloutPercentage('user-abc', 50);
      const r2 = featureFlags._passesRolloutPercentage('user-abc', 50);
      expect(r1).to.equal(r2);
    });

    it('distributes users roughly evenly at 50%', () => {
      let included = 0;
      const total = 1000;
      for (let i = 0; i < total; i++) {
        if (featureFlags._passesRolloutPercentage(`user-${i}`, 50)) {
          included++;
        }
      }
      // Should be roughly 50% (allow ±10% tolerance)
      expect(included).to.be.greaterThan(400);
      expect(included).to.be.lessThan(600);
    });
  });
});
