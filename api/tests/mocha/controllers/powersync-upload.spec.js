const sinon = require('sinon');
const auth = require('../../../src/auth');
const dataContext = require('../../../src/services/data-context');
const serverUtils = require('../../../src/server-utils');
const featureFlags = require('../../../src/services/feature-flags');
const { Report, Person, Place, Qualifier } = require('@medic/cht-datasource');
const { expect } = require('chai');

describe('PowerSync Upload Controller', () => {
  const sandbox = sinon.createSandbox();
  const reportGet = sandbox.stub();
  const reportCreate = sandbox.stub();
  const reportUpdate = sandbox.stub();
  const personGet = sandbox.stub();
  const personCreate = sandbox.stub();
  const personUpdate = sandbox.stub();
  const placeGet = sandbox.stub();
  const placeCreate = sandbox.stub();
  const placeUpdate = sandbox.stub();

  let serverUtilsError;
  let assertPermissions;
  let req;
  let res;
  let controller;

  before(() => {
    const bind = sinon.stub(dataContext, 'bind');
    bind.withArgs(Report.v1.get).returns(reportGet);
    bind.withArgs(Report.v1.create).returns(reportCreate);
    bind.withArgs(Report.v1.update).returns(reportUpdate);
    bind.withArgs(Person.v1.get).returns(personGet);
    bind.withArgs(Person.v1.create).returns(personCreate);
    bind.withArgs(Person.v1.update).returns(personUpdate);
    bind.withArgs(Place.v1.get).returns(placeGet);
    bind.withArgs(Place.v1.create).returns(placeCreate);
    bind.withArgs(Place.v1.update).returns(placeUpdate);
    controller = require('../../../src/controllers/powersync-upload');
  });

  beforeEach(() => {
    serverUtilsError = sinon.stub(serverUtils, 'error');
    assertPermissions = sinon.stub(auth, 'assertPermissions').resolves();
    sinon.stub(auth, 'getUserCtx').resolves({ name: 'test-user', roles: ['chw'] });
    sinon.stub(auth, 'getUserSettings').resolves({
      name: 'test-user',
      roles: ['chw'],
      facility_id: ['facility-1'],
    });
    sinon.stub(featureFlags, 'isFeatureEnabled').returns(true);
    res = { json: sinon.stub() };
  });

  afterEach(() => {
    sinon.restore();
    sandbox.reset();
  });

  describe('upload', () => {
    it('checks permissions for offline users with create/edit rights', async () => {
      req = { body: { crud: [] } };

      await controller.upload(req, res);

      expect(assertPermissions.calledOnceWithExactly(
        req,
        { isOnline: false, hasAny: ['can_create_records', 'can_edit'] }
      )).to.be.true;
    });

    it('returns 403 when PowerSync feature flag is disabled for user', async () => {
      featureFlags.isFeatureEnabled.returns(false);
      req = { body: { crud: [{ op: 'PUT', table: 'reports', id: 'r1', opData: {} }] } };

      await controller.upload(req, res);

      expect(featureFlags.isFeatureEnabled.calledOnce).to.be.true;
      expect(featureFlags.isFeatureEnabled.firstCall.args[0]).to.equal('powersync');
      expect(featureFlags.isFeatureEnabled.firstCall.args[1]).to.deep.include({ name: 'test-user' });
      expect(serverUtilsError.calledOnce).to.be.true;
      expect(serverUtilsError.firstCall.args[0].code).to.equal(403);
      expect(serverUtilsError.firstCall.args[0].message).to.equal('PowerSync is not enabled for this user.');
      expect(res.json.called).to.be.false;
    });

    it('returns error when body has no crud array', async () => {
      req = { body: {} };

      await controller.upload(req, res);

      expect(serverUtilsError.calledOnce).to.be.true;
      expect(serverUtilsError.firstCall.args[0].code).to.equal(400);
      expect(serverUtilsError.firstCall.args[0].message).to.include('crud');
    });

    it('returns empty results for empty crud array', async () => {
      req = { body: { crud: [] } };

      await controller.upload(req, res);

      expect(res.json.calledOnceWithExactly({ results: [] })).to.be.true;
    });

    it('rejects batch larger than 100', async () => {
      req = {
        body: {
          crud: Array.from({ length: 101 }, (_, i) => ({
            op: 'PUT', table: 'reports', id: `${i}`, opData: { form: 'test' }
          }))
        }
      };

      await controller.upload(req, res);

      expect(serverUtilsError.calledOnce).to.be.true;
      expect(serverUtilsError.firstCall.args[0].code).to.equal(400);
      expect(serverUtilsError.firstCall.args[0].message).to.include('101');
    });

    it('creates a report via PUT when doc does not exist', async () => {
      const newReport = { _id: 'new-1', _rev: '1-abc', form: 'pregnancy', type: 'data_record' };
      reportGet.resolves(null);
      reportCreate.resolves(newReport);

      req = {
        body: {
          crud: [{
            op: 'PUT',
            table: 'reports',
            id: 'new-1',
            clientId: 1,
            opData: { form: 'pregnancy', contact: 'chw-1', reported_date: 1700000000000 }
          }]
        }
      };

      await controller.upload(req, res);

      expect(res.json.calledOnce).to.be.true;
      const { results } = res.json.firstCall.args[0];
      expect(results).to.have.length(1);
      expect(results[0]).to.deep.equal({ id: 'new-1', ok: true });
      expect(reportCreate.calledOnce).to.be.true;
    });

    it('updates a report via PUT when doc already exists (idempotent upsert)', async () => {
      const existing = { _id: 'r-1', _rev: '1-abc', form: 'pregnancy', type: 'data_record' };
      const updated = { ...existing, _rev: '2-def', fields: { lmp: '2024-01-01' } };
      reportGet.resolves(existing);
      reportUpdate.resolves(updated);

      req = {
        body: {
          crud: [{
            op: 'PUT',
            table: 'reports',
            id: 'r-1',
            clientId: 2,
            opData: { form: 'pregnancy', fields: { lmp: '2024-01-01' } }
          }]
        }
      };

      await controller.upload(req, res);

      const { results } = res.json.firstCall.args[0];
      expect(results[0]).to.deep.include({ ok: true });
      expect(reportUpdate.calledOnce).to.be.true;
      const updateArg = reportUpdate.firstCall.args[0];
      expect(updateArg._rev).to.equal('1-abc');
    });

    it('handles PATCH by merging opData with existing doc', async () => {
      const existing = {
        _id: 'r-1', _rev: '1-abc', form: 'pregnancy', type: 'data_record',
        fields: { lmp: '2024-01' }
      };
      const updated = { ...existing, _rev: '2-def' };
      reportGet.resolves(existing);
      reportUpdate.resolves(updated);

      req = {
        body: {
          crud: [{
            op: 'PATCH',
            table: 'reports',
            id: 'r-1',
            clientId: 3,
            opData: { fields: { risk: 'high' } }
          }]
        }
      };

      await controller.upload(req, res);

      const { results } = res.json.firstCall.args[0];
      expect(results[0]).to.deep.include({ ok: true });
      const updateArg = reportUpdate.firstCall.args[0];
      expect(updateArg.fields).to.deep.equal({ risk: 'high' });
    });

    it('returns error for PATCH on non-existent doc', async () => {
      reportGet.resolves(null);

      req = {
        body: {
          crud: [{
            op: 'PATCH',
            table: 'reports',
            id: 'missing',
            clientId: 4,
            opData: { fields: {} }
          }]
        }
      };

      await controller.upload(req, res);

      const { results } = res.json.firstCall.args[0];
      expect(results[0].ok).to.be.false;
      expect(results[0].error).to.include('not found');
    });

    it('handles DELETE gracefully (soft delete not yet implemented)', async () => {
      req = {
        body: {
          crud: [{
            op: 'DELETE',
            table: 'reports',
            id: 'r-1',
            clientId: 5
          }]
        }
      };

      await controller.upload(req, res);

      const { results } = res.json.firstCall.args[0];
      expect(results[0]).to.deep.equal({ id: 'r-1', ok: true });
    });

    it('returns error for unsupported table name', async () => {
      req = {
        body: {
          crud: [{
            op: 'PUT',
            table: 'unknown_table',
            id: 'x',
            clientId: 6,
            opData: { foo: 'bar' }
          }]
        }
      };

      await controller.upload(req, res);

      const { results } = res.json.firstCall.args[0];
      expect(results[0].ok).to.be.false;
      expect(results[0].error).to.include('Unsupported table');
    });

    it('returns error for missing required fields (op, table, id)', async () => {
      req = {
        body: {
          crud: [{
            op: 'PUT',
            table: undefined,
            id: undefined,
            opData: { foo: 'bar' }
          }]
        }
      };

      await controller.upload(req, res);

      const { results } = res.json.firstCall.args[0];
      expect(results[0].ok).to.be.false;
      expect(results[0].error).to.include('Missing required fields');
    });

    it('returns error for unsupported operation type', async () => {
      req = {
        body: {
          crud: [{
            op: 'INVALID',
            table: 'reports',
            id: 'r-1',
            clientId: 7,
            opData: {}
          }]
        }
      };

      await controller.upload(req, res);

      const { results } = res.json.firstCall.args[0];
      expect(results[0].ok).to.be.false;
      expect(results[0].error).to.include('Unsupported operation');
    });

    it('returns error for PUT with no opData', async () => {
      req = {
        body: {
          crud: [{
            op: 'PUT',
            table: 'reports',
            id: 'r-1',
            clientId: 8
          }]
        }
      };

      await controller.upload(req, res);

      const { results } = res.json.firstCall.args[0];
      expect(results[0].ok).to.be.false;
      expect(results[0].error).to.include('Missing opData');
    });

    it('processes multiple operations independently (partial success)', async () => {
      const report = { _id: 'r-1', _rev: '1-abc', form: 'pregnancy', type: 'data_record' };
      reportGet
        .onFirstCall().resolves(null)
        .onSecondCall().resolves(null);
      reportCreate.resolves(report);

      req = {
        body: {
          crud: [
            { op: 'PUT', table: 'reports', id: 'r-1', clientId: 9, opData: { form: 'pregnancy', contact: 'c1' } },
            { op: 'PATCH', table: 'reports', id: 'missing', clientId: 10, opData: { fields: {} } },
          ]
        }
      };

      await controller.upload(req, res);

      const { results } = res.json.firstCall.args[0];
      expect(results).to.have.length(2);
      expect(results[0].ok).to.be.true;
      expect(results[1].ok).to.be.false;
    });

    it('catches and reports errors from cht-datasource', async () => {
      reportGet.resolves(null);
      reportCreate.rejects(new Error('Validation failed'));

      req = {
        body: {
          crud: [{
            op: 'PUT',
            table: 'reports',
            id: 'r-bad',
            clientId: 11,
            opData: { form: 'pregnancy' }
          }]
        }
      };

      await controller.upload(req, res);

      const { results } = res.json.firstCall.args[0];
      expect(results[0].ok).to.be.false;
      expect(results[0].error).to.equal('Validation failed');
    });

    it('sets type=data_record for reports if not already set', async () => {
      const newReport = { _id: 'r-2', _rev: '1-abc', form: 'delivery', type: 'data_record' };
      reportGet.resolves(null);
      reportCreate.resolves(newReport);

      req = {
        body: {
          crud: [{
            op: 'PUT',
            table: 'reports',
            id: 'r-2',
            clientId: 12,
            opData: { form: 'delivery', contact: 'chw-1' }
          }]
        }
      };

      await controller.upload(req, res);

      const createArg = reportCreate.firstCall.args[0];
      expect(createArg.type).to.equal('data_record');
    });
  });
});
