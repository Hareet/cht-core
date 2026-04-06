'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const db = require('../../src/db');
const purgingUtils = require('@medic/purging-utils');
const rolesService = require('../../src/roles');

describe('Roles', () => {
  afterEach(() => sinon.restore());

  describe('getRoles', () => {
    it('should return empty object when no user-settings docs', async () => {
      sinon.stub(db, 'query').resolves({ rows: [] });
      const result = await rolesService.getRoles();
      expect(result).to.deep.equal({});
    });

    it('should deduplicate and hash role sets', async () => {
      sinon.stub(db, 'query').resolves({
        rows: [
          { roles: ['chw', 'data_entry'] },
          { roles: ['data_entry', 'chw'] }, // same set, different order
          { roles: ['chw_supervisor'] },
        ],
      });

      const result = await rolesService.getRoles();

      const chwHash = purgingUtils.getRoleHash(['chw', 'data_entry']);
      const supHash = purgingUtils.getRoleHash(['chw_supervisor']);

      expect(Object.keys(result)).to.have.length(2);
      expect(result[chwHash]).to.deep.equal(['chw', 'data_entry']);
      expect(result[supHash]).to.deep.equal(['chw_supervisor']);
    });

    it('should skip entries with no roles array', async () => {
      sinon.stub(db, 'query').resolves({
        rows: [
          { roles: null },
          { roles: 'not_an_array' },
          { roles: [] },
          { roles: ['chw'] },
        ],
      });

      const result = await rolesService.getRoles();
      expect(Object.keys(result)).to.have.length(1);
    });
  });

  describe('saveRoles', () => {
    it('should do nothing for empty roles', async () => {
      const queryStub = sinon.stub(db, 'query');
      await rolesService.saveRoles({});
      expect(queryStub.callCount).to.equal(0);
    });

    it('should upsert role mappings', async () => {
      const queryStub = sinon.stub(db, 'query').resolves();

      await rolesService.saveRoles({
        hash_a: ['chw'],
        hash_b: ['chw_supervisor'],
      });

      expect(queryStub.calledOnce).to.be.true;
      const [sql, params] = queryStub.args[0];
      expect(sql).to.include('INSERT INTO purge_roles');
      expect(sql).to.include('ON CONFLICT');
      expect(params).to.have.length(4);
      expect(params).to.include('hash_a');
      expect(params).to.include('hash_b');
    });
  });
});
