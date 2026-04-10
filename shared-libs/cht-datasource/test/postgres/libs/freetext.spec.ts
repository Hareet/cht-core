import sinon, { SinonStub } from 'sinon';
import { expect } from 'chai';
import { queryByFreetext } from '../../../src/postgres/libs/freetext';
import { PostgresDataContext, DatabasePool } from '../../../src/postgres/libs/data-context';

describe('postgres freetext lib', () => {
  let poolQuery: SinonStub;
  let ctx: PostgresDataContext;

  beforeEach(() => {
    poolQuery = sinon.stub();
    ctx = {
      pool: { query: poolQuery } as unknown as DatabasePool,
      settings: { getAll: sinon.stub() },
      schemaConfig: { schema: 'v1', table: 'couchdb' },
      qualifiedTable: '"v1"."couchdb"',
      bind: sinon.stub(),
    } as unknown as PostgresDataContext;
  });

  afterEach(() => sinon.restore());

  describe('queryByFreetext - contacts', () => {
    it('searches contacts by unkeyed freetext', async () => {
      poolQuery.resolves({ rows: [{ _id: 'a' }, { _id: 'b' }], rowCount: 2 });

      const result = await queryByFreetext(ctx, 'contacts')(
        { freetext: 'john' }, null, 10
      );

      expect(result.data).to.deep.equal(['a', 'b']);
      expect(result.cursor).to.be.null;
      expect(poolQuery.calledOnce).to.be.true;
      const sql = poolQuery.firstCall.args[0];
      expect(sql).to.include('ILIKE');
      expect(sql).to.include("'contact'");
      expect(sql).to.include("'person'");
      expect(sql).to.include('LOWER');
    });

    it('searches contacts by keyed freetext (exact match)', async () => {
      poolQuery.resolves({ rows: [{ _id: 'c1' }], rowCount: 1 });

      const result = await queryByFreetext(ctx, 'contacts')(
        { freetext: 'name:Alice Smith' }, null, 10
      );

      expect(result.data).to.deep.equal(['c1']);
      const sql = poolQuery.firstCall.args[0];
      expect(sql).to.include("'name'");
      expect(sql).to.not.include('ILIKE');
    });

    it('applies contact type filter when qualifier has contactType', async () => {
      poolQuery.resolves({ rows: [], rowCount: 0 });

      await queryByFreetext(ctx, 'contacts')(
        { freetext: 'test', contactType: 'person' }, null, 10
      );

      const sql = poolQuery.firstCall.args[0];
      expect(sql).to.include('COALESCE');
      const params = poolQuery.firstCall.args[1];
      expect(params).to.include('person');
    });

    it('returns cursor when results fill the page', async () => {
      poolQuery.resolves({
        rows: Array.from({ length: 5 }, (_, i) => ({ _id: `id-${i}` })),
        rowCount: 5
      });

      const result = await queryByFreetext(ctx, 'contacts')(
        { freetext: 'test' }, null, 5
      );

      expect(result.data).to.have.length(5);
      expect(result.cursor).to.equal('5');
    });

    it('returns null cursor when fewer results than limit', async () => {
      poolQuery.resolves({ rows: [{ _id: 'a' }], rowCount: 1 });

      const result = await queryByFreetext(ctx, 'contacts')(
        { freetext: 'test' }, null, 10
      );

      expect(result.cursor).to.be.null;
    });

    it('passes cursor as offset', async () => {
      poolQuery.resolves({ rows: [], rowCount: 0 });

      await queryByFreetext(ctx, 'contacts')(
        { freetext: 'test' }, '20', 10
      );

      const params = poolQuery.firstCall.args[1];
      expect(params).to.include(20);
    });
  });

  describe('queryByFreetext - reports', () => {
    it('searches reports with data_record filter', async () => {
      poolQuery.resolves({ rows: [{ _id: 'r1' }], rowCount: 1 });

      const result = await queryByFreetext(ctx, 'reports')(
        { freetext: 'pregnancy' }, null, 10
      );

      expect(result.data).to.deep.equal(['r1']);
      const sql = poolQuery.firstCall.args[0];
      expect(sql).to.include("'data_record'");
      expect(sql).to.include('reported_date');
    });

    it('searches reports by keyed freetext', async () => {
      poolQuery.resolves({ rows: [], rowCount: 0 });

      await queryByFreetext(ctx, 'reports')(
        { freetext: 'form:pregnancy' }, null, 10
      );

      const sql = poolQuery.firstCall.args[0];
      expect(sql).to.include("'form'");
      expect(sql).to.include('fields');
    });
  });
});
