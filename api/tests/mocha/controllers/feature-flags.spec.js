const sinon = require('sinon');
const { expect } = require('chai');
const auth = require('../../../src/auth');
const serverUtils = require('../../../src/server-utils');
const settingsService = require('../../../src/services/settings');
const config = require('../../../src/config');
const controller = require('../../../src/controllers/feature-flags');

describe('Feature flags controller', () => {
  let req;
  let res;

  beforeEach(() => {
    req = { params: {}, body: {} };
    res = { json: sinon.stub() };
    sinon.stub(serverUtils, 'error').returns();
  });

  afterEach(() => sinon.restore());

  describe('get', () => {
    it('requires can_edit and can_configure permissions', async () => {
      sinon.stub(auth, 'check').rejects({ code: 403, message: 'Forbidden' });
      req.params.feature = 'powersync';

      await controller.get(req, res);

      expect(auth.check.calledOnce).to.be.true;
      expect(auth.check.firstCall.args[1]).to.deep.equal(['can_edit', 'can_configure']);
      expect(serverUtils.error.calledOnce).to.be.true;
      expect(serverUtils.error.firstCall.args[0].code).to.equal(403);
    });

    it('returns 404 for unknown feature', async () => {
      sinon.stub(auth, 'check').resolves();
      req.params.feature = 'nonexistent';

      await controller.get(req, res);

      expect(serverUtils.error.calledOnce).to.be.true;
      expect(serverUtils.error.firstCall.args[0].code).to.equal(404);
    });

    it('returns current powersync config', async () => {
      sinon.stub(auth, 'check').resolves();
      sinon.stub(config, 'get').returns({
        enabled: true,
        facilities: ['fac-1', 'fac-2'],
        rollout_percentage: 25,
      });
      req.params.feature = 'powersync';

      await controller.get(req, res);

      expect(res.json.calledOnce).to.be.true;
      expect(res.json.firstCall.args[0]).to.deep.equal({
        feature: 'powersync',
        enabled: true,
        facilities: ['fac-1', 'fac-2'],
        rollout_percentage: 25,
      });
    });

    it('returns defaults when powersync config is missing', async () => {
      sinon.stub(auth, 'check').resolves();
      sinon.stub(config, 'get').returns(undefined);
      req.params.feature = 'powersync';

      await controller.get(req, res);

      expect(res.json.firstCall.args[0]).to.deep.equal({
        feature: 'powersync',
        enabled: false,
        facilities: [],
        rollout_percentage: 0,
      });
    });
  });

  describe('put', () => {
    it('requires can_edit and can_configure permissions', async () => {
      sinon.stub(auth, 'check').rejects({ code: 403, message: 'Forbidden' });
      req.params.feature = 'powersync';
      req.body = { enabled: true };

      await controller.put(req, res);

      expect(serverUtils.error.calledOnce).to.be.true;
      expect(serverUtils.error.firstCall.args[0].code).to.equal(403);
    });

    it('returns 404 for unknown feature', async () => {
      sinon.stub(auth, 'check').resolves();
      req.params.feature = 'nonexistent';
      req.body = { enabled: true };

      await controller.put(req, res);

      expect(serverUtils.error.calledOnce).to.be.true;
      expect(serverUtils.error.firstCall.args[0].code).to.equal(404);
    });

    it('validates enabled must be boolean', async () => {
      sinon.stub(auth, 'check').resolves();
      req.params.feature = 'powersync';
      req.body = { enabled: 'yes' };

      await controller.put(req, res);

      expect(serverUtils.error.calledOnce).to.be.true;
      expect(serverUtils.error.firstCall.args[0].code).to.equal(400);
      expect(serverUtils.error.firstCall.args[0].message).to.include('"enabled" must be a boolean');
    });

    it('validates facilities must be array of strings', async () => {
      sinon.stub(auth, 'check').resolves();
      req.params.feature = 'powersync';
      req.body = { facilities: 'not-array' };

      await controller.put(req, res);

      expect(serverUtils.error.calledOnce).to.be.true;
      expect(serverUtils.error.firstCall.args[0].code).to.equal(400);
    });

    it('validates facilities array contains only strings', async () => {
      sinon.stub(auth, 'check').resolves();
      req.params.feature = 'powersync';
      req.body = { facilities: ['valid', 123] };

      await controller.put(req, res);

      expect(serverUtils.error.calledOnce).to.be.true;
      expect(serverUtils.error.firstCall.args[0].code).to.equal(400);
    });

    it('validates rollout_percentage is between 0 and 100', async () => {
      sinon.stub(auth, 'check').resolves();
      req.params.feature = 'powersync';
      req.body = { rollout_percentage: 150 };

      await controller.put(req, res);

      expect(serverUtils.error.calledOnce).to.be.true;
      expect(serverUtils.error.firstCall.args[0].code).to.equal(400);
      expect(serverUtils.error.firstCall.args[0].message).to.include('rollout_percentage');
    });

    it('validates rollout_percentage is a number', async () => {
      sinon.stub(auth, 'check').resolves();
      req.params.feature = 'powersync';
      req.body = { rollout_percentage: 'fifty' };

      await controller.put(req, res);

      expect(serverUtils.error.calledOnce).to.be.true;
      expect(serverUtils.error.firstCall.args[0].code).to.equal(400);
    });

    it('updates settings and returns new state', async () => {
      sinon.stub(auth, 'check').resolves();
      sinon.stub(config, 'get').returns(undefined);
      const settingsUpdate = sinon.stub(settingsService, 'update').resolves(true);
      req.params.feature = 'powersync';
      req.body = { enabled: true, facilities: ['fac-1'], rollout_percentage: 50 };

      await controller.put(req, res);

      expect(settingsUpdate.calledOnce).to.be.true;
      expect(settingsUpdate.firstCall.args[0]).to.deep.equal({
        powersync: {
          enabled: true,
          facilities: ['fac-1'],
          rollout_percentage: 50,
        },
      });
      expect(res.json.calledOnce).to.be.true;
      expect(res.json.firstCall.args[0]).to.deep.equal({
        success: true,
        feature: 'powersync',
        enabled: true,
        facilities: ['fac-1'],
        rollout_percentage: 50,
      });
    });

    it('merges with existing config when only partial update is sent', async () => {
      sinon.stub(auth, 'check').resolves();
      sinon.stub(config, 'get').returns({
        enabled: true,
        facilities: ['fac-1'],
        rollout_percentage: 25,
      });
      const settingsUpdate = sinon.stub(settingsService, 'update').resolves(true);
      req.params.feature = 'powersync';
      req.body = { rollout_percentage: 75 };

      await controller.put(req, res);

      expect(settingsUpdate.firstCall.args[0]).to.deep.equal({
        powersync: {
          enabled: true,
          facilities: ['fac-1'],
          rollout_percentage: 75,
        },
      });
    });

    it('can disable feature', async () => {
      sinon.stub(auth, 'check').resolves();
      sinon.stub(config, 'get').returns({
        enabled: true,
        facilities: ['fac-1'],
        rollout_percentage: 50,
      });
      sinon.stub(settingsService, 'update').resolves(true);
      req.params.feature = 'powersync';
      req.body = { enabled: false };

      await controller.put(req, res);

      expect(res.json.firstCall.args[0]).to.deep.include({
        success: true,
        enabled: false,
        facilities: ['fac-1'],
        rollout_percentage: 50,
      });
    });

    it('can set empty facilities to enable for all', async () => {
      sinon.stub(auth, 'check').resolves();
      sinon.stub(config, 'get').returns({
        enabled: true,
        facilities: ['fac-1'],
        rollout_percentage: 0,
      });
      sinon.stub(settingsService, 'update').resolves(true);
      req.params.feature = 'powersync';
      req.body = { facilities: [] };

      await controller.put(req, res);

      expect(res.json.firstCall.args[0]).to.deep.include({
        success: true,
        facilities: [],
      });
    });
  });
});
