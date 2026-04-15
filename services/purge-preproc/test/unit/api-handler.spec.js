'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const db = require('../../src/db');
const engine = require('../../src/engine');
const rolesService = require('../../src/roles');
const apiHandler = require('../../src/api-handler');

describe('API Handler', () => {
  afterEach(() => sinon.restore());

  describe('validate', () => {
    it('should return no errors for valid body', () => {
      const errors = apiHandler.validate({
        user_id: 'user-chw1',
        facility_id: 'facility-123',
        current_db_size_mb: 500,
        tier_budget_mb: 400,
      });
      expect(errors).to.deep.equal([]);
    });

    it('should require user_id', () => {
      const errors = apiHandler.validate({
        facility_id: 'f1',
        current_db_size_mb: 100,
        tier_budget_mb: 200,
      });
      expect(errors).to.have.lengthOf(1);
      expect(errors[0]).to.include('user_id');
    });

    it('should require facility_id', () => {
      const errors = apiHandler.validate({
        user_id: 'u1',
        current_db_size_mb: 100,
        tier_budget_mb: 200,
      });
      expect(errors).to.have.lengthOf(1);
      expect(errors[0]).to.include('facility_id');
    });

    it('should require non-negative current_db_size_mb', () => {
      const errors = apiHandler.validate({
        user_id: 'u1',
        facility_id: 'f1',
        current_db_size_mb: -1,
        tier_budget_mb: 200,
      });
      expect(errors).to.have.lengthOf(1);
      expect(errors[0]).to.include('current_db_size_mb');
    });

    it('should require positive tier_budget_mb', () => {
      const errors = apiHandler.validate({
        user_id: 'u1',
        facility_id: 'f1',
        current_db_size_mb: 100,
        tier_budget_mb: 0,
      });
      expect(errors).to.have.lengthOf(1);
      expect(errors[0]).to.include('tier_budget_mb');
    });

    it('should collect multiple errors', () => {
      const errors = apiHandler.validate({});
      expect(errors.length).to.be.at.least(4);
    });
  });

  describe('getUserRoleHash', () => {
    it('should resolve role hash for valid offline user', async () => {
      sinon.stub(rolesService, 'getRoles').resolves({
        'abc123hash': ['chw'],
      });

      sinon.stub(db, 'query').resolves({
        rows: [{ roles: ['chw'] }],
      });

      const purgingUtils = require('@medic/purging-utils');
      sinon.stub(purgingUtils, 'sortedUniqueRoles').returns(['chw']);
      sinon.stub(purgingUtils, 'getRoleHash').returns('abc123hash');

      const hash = await apiHandler.getUserRoleHash('user-chw1');
      expect(hash).to.equal('abc123hash');
    });

    it('should return null when user not found', async () => {
      sinon.stub(rolesService, 'getRoles').resolves({ 'abc': ['chw'] });
      sinon.stub(db, 'query').resolves({ rows: [] });

      const hash = await apiHandler.getUserRoleHash('nonexistent');
      expect(hash).to.be.null;
    });

    it('should return null when user has no matching offline role', async () => {
      sinon.stub(rolesService, 'getRoles').resolves({
        'abc123hash': ['chw'],
      });

      sinon.stub(db, 'query').resolves({
        rows: [{ roles: ['mm-online', 'admin'] }],
      });

      const purgingUtils = require('@medic/purging-utils');
      sinon.stub(purgingUtils, 'sortedUniqueRoles').returns(['admin', 'mm-online']);
      sinon.stub(purgingUtils, 'getRoleHash').returns('online-hash');

      const hash = await apiHandler.getUserRoleHash('online-user');
      expect(hash).to.be.null;
    });
  });

  describe('handlePurgeRequest', () => {
    it('should return 400 for invalid body', async () => {
      const result = await apiHandler.handlePurgeRequest({});
      expect(result.status).to.equal(400);
      expect(result.body.error).to.be.a('string');
    });

    it('should return 200 with zero purge when within budget', async () => {
      const result = await apiHandler.handlePurgeRequest({
        user_id: 'u1',
        facility_id: 'f1',
        current_db_size_mb: 100,
        tier_budget_mb: 200,
      });

      expect(result.status).to.equal(200);
      expect(result.body.purged_count).to.equal(0);
      expect(result.body.message).to.include('within storage budget');
    });

    it('should return 404 when user has no offline role', async () => {
      sinon.stub(rolesService, 'getRoles').resolves({});
      sinon.stub(db, 'query').resolves({ rows: [] });

      const result = await apiHandler.handlePurgeRequest({
        user_id: 'unknown-user',
        facility_id: 'f1',
        current_db_size_mb: 500,
        tier_budget_mb: 400,
      });

      expect(result.status).to.equal(404);
      expect(result.body.error).to.include('No offline role');
    });

    it('should call runAggressivePurge when over budget', async () => {
      sinon.stub(rolesService, 'getRoles').resolves({
        'hash_chw': ['chw'],
      });
      sinon.stub(db, 'query').resolves({
        rows: [{ roles: ['chw'] }],
      });

      const purgingUtils = require('@medic/purging-utils');
      sinon.stub(purgingUtils, 'sortedUniqueRoles').returns(['chw']);
      sinon.stub(purgingUtils, 'getRoleHash').returns('hash_chw');

      sinon.stub(engine, 'runAggressivePurge').resolves({
        purged_count: 150,
        estimated_reduction_mb: 0.44,
        breakdown: { tasks: 50, targets: 30, reports: 70 },
      });

      sinon.stub(console, 'log');

      const result = await apiHandler.handlePurgeRequest({
        user_id: 'user-chw1',
        facility_id: 'facility-123',
        current_db_size_mb: 500,
        tier_budget_mb: 400,
      });

      expect(result.status).to.equal(200);
      expect(result.body.purged_count).to.equal(150);
      expect(result.body.estimated_reduction_mb).to.equal(0.44);
      expect(result.body.breakdown.tasks).to.equal(50);
      expect(result.body.breakdown.targets).to.equal(30);
      expect(result.body.breakdown.reports).to.equal(70);

      expect(engine.runAggressivePurge.calledOnce).to.be.true;
      expect(engine.runAggressivePurge.calledWith('user-chw1', 'facility-123', 'hash_chw')).to.be.true;
    });

    it('should trigger purge when exactly at budget boundary (over by 1)', async () => {
      sinon.stub(rolesService, 'getRoles').resolves({ 'h1': ['chw'] });
      sinon.stub(db, 'query').resolves({ rows: [{ roles: ['chw'] }] });

      const purgingUtils = require('@medic/purging-utils');
      sinon.stub(purgingUtils, 'sortedUniqueRoles').returns(['chw']);
      sinon.stub(purgingUtils, 'getRoleHash').returns('h1');

      sinon.stub(engine, 'runAggressivePurge').resolves({
        purged_count: 10,
        estimated_reduction_mb: 0.03,
        breakdown: { tasks: 10, targets: 0, reports: 0 },
      });
      sinon.stub(console, 'log');

      const result = await apiHandler.handlePurgeRequest({
        user_id: 'u1',
        facility_id: 'f1',
        current_db_size_mb: 401,
        tier_budget_mb: 400,
      });

      expect(result.status).to.equal(200);
      expect(result.body.purged_count).to.equal(10);
    });

    it('should not trigger purge when exactly at budget', async () => {
      const result = await apiHandler.handlePurgeRequest({
        user_id: 'u1',
        facility_id: 'f1',
        current_db_size_mb: 400,
        tier_budget_mb: 400,
      });

      expect(result.status).to.equal(200);
      expect(result.body.purged_count).to.equal(0);
    });
  });
});
