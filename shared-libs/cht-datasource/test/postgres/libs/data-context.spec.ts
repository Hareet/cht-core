import { expect } from 'chai';
import sinon from 'sinon';
import {
  getPostgresDataContext,
  isPostgresDataContext,
  PostgresDataContext,
  DatabasePool,
} from '../../../src/postgres/libs/data-context';
import { DataContext } from '../../../src';
import { SettingsService } from '../../../src/local/libs/data-context';

describe('postgres context lib', () => {
  afterEach(() => sinon.restore());

  describe('isPostgresDataContext', () => {
    ([
      [{ pool: {}, settings: {}, schemaConfig: {}, bind: () => null }, true],
      [{ pool: {}, settings: {}, schemaConfig: {}, bind: () => null, extra: 'field' }, true],
      [{ pool: {}, settings: {}, bind: () => null }, false],
      [{ pool: {}, schemaConfig: {}, bind: () => null }, false],
      [{ settings: {}, schemaConfig: {}, bind: () => null }, false],
      [{ bind: () => null }, false],
      [{}, false]
    ] as [DataContext, boolean][]).forEach(([context, expected]) => {
      it(`evaluates ${JSON.stringify(context)} as ${expected}`, () => {
        expect(isPostgresDataContext(context)).to.equal(expected);
      });
    });
  });

  describe('getPostgresDataContext', () => {
    const settingsService = { getAll: () => ({}) } as SettingsService;
    const pool = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) } as unknown as DatabasePool;

    ([
      null,
      {},
      { query: 'not a function' },
      'hello'
    ] as unknown as DatabasePool[]).forEach((invalidPool) => {
      it(`throws an error if the pool is invalid [${JSON.stringify(invalidPool)}]`, () => {
        expect(() => getPostgresDataContext(invalidPool, settingsService))
          .to.throw(`Invalid database pool [${JSON.stringify(invalidPool)}].`);
      });
    });

    ([
      null,
      {},
      { getAll: 'not a function' },
      'hello'
    ] as unknown as SettingsService[]).forEach((invalidSettings) => {
      it(`throws an error if the settings service is invalid [${JSON.stringify(invalidSettings)}]`, () => {
        expect(() => getPostgresDataContext(pool, invalidSettings))
          .to.throw(`Invalid settings service [${JSON.stringify(invalidSettings)}].`);
      });
    });

    it('returns the postgres data context with default schema config', () => {
      const dataContext = getPostgresDataContext(pool, settingsService);
      expect(dataContext).to.be.instanceOf(PostgresDataContext);
      const pgCtx = dataContext as PostgresDataContext;
      expect(pgCtx.pool).to.equal(pool);
      expect(pgCtx.settings).to.equal(settingsService);
      expect(pgCtx.schemaConfig).to.deep.equal({ schema: 'v1', table: 'couchdb' });
      expect(pgCtx.qualifiedTable).to.equal('"v1"."couchdb"');
    });

    it('returns the postgres data context with custom schema config', () => {
      const dataContext = getPostgresDataContext(pool, settingsService, {
        schema: 'custom',
        table: 'docs'
      });
      const pgCtx = dataContext as PostgresDataContext;
      expect(pgCtx.schemaConfig).to.deep.equal({ schema: 'custom', table: 'docs' });
      expect(pgCtx.qualifiedTable).to.equal('"custom"."docs"');
    });

    it('returns the postgres data context with partial schema config', () => {
      const dataContext = getPostgresDataContext(pool, settingsService, { schema: 'myschema' });
      const pgCtx = dataContext as PostgresDataContext;
      expect(pgCtx.schemaConfig).to.deep.equal({ schema: 'myschema', table: 'couchdb' });
    });

    it('supports the bind method', () => {
      const dataContext = getPostgresDataContext(pool, settingsService);
      const fn = sinon.stub().returns('result');
      const result = dataContext.bind(fn);
      expect(result).to.equal('result');
      expect(fn.calledOnceWithExactly(dataContext)).to.be.true;
    });
  });
});
