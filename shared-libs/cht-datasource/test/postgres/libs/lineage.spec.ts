import sinon, { SinonStub } from 'sinon';
import logger from '@medic/logger';
import { expect } from 'chai';
import * as PgDoc from '../../../src/postgres/libs/doc';
import {
  getLineageDocsById,
  getPrimaryContactIds,
  hydratePrimaryContact,
  hydrateLineage,
  getContactLineage,
  fetchHydratedDoc,
  resolveShortcode,
} from '../../../src/postgres/libs/lineage';
import { PostgresDataContext, DatabasePool } from '../../../src/postgres/libs/data-context';
import { Doc } from '../../../src/libs/doc';
import { NonEmptyArray, Nullable } from '../../../src/libs/core';

describe('postgres lineage lib', () => {
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
    sinon.stub(logger, 'debug');
  });

  afterEach(() => sinon.restore());

  describe('getLineageDocsById', () => {
    it('returns lineage docs ordered by depth', async () => {
      const doc0 = { _id: 'a', _rev: '1', parent: { _id: 'b' } };
      const doc1 = { _id: 'b', _rev: '1', parent: { _id: 'c' } };
      const doc2 = { _id: 'c', _rev: '1' };
      poolQuery.resolves({
        rows: [
          { doc: doc0, depth: 0 },
          { doc: doc1, depth: 1 },
          { doc: doc2, depth: 2 },
        ],
        rowCount: 3
      });
      sinon.stub(require('../../../src/libs/doc'), 'isDoc').returns(true);

      const result = await getLineageDocsById(ctx)('a');

      expect(result).to.have.length(3);
      expect(poolQuery.calledOnce).to.be.true;
      expect(poolQuery.firstCall.args[0]).to.include('RECURSIVE');
      expect(poolQuery.firstCall.args[1]).to.deep.equal(['a']);
    });

    it('returns empty array when doc not found', async () => {
      poolQuery.resolves({ rows: [], rowCount: 0 });

      const result = await getLineageDocsById(ctx)('missing');

      expect(result).to.deep.equal([]);
    });
  });

  describe('getPrimaryContactIds', () => {
    it('extracts contact ids from places', () => {
      const places = [
        { _id: 'p1', _rev: '1', contact: { _id: 'c1' } },
        { _id: 'p2', _rev: '1', contact: { _id: 'c2' } },
        null,
      ] as NonEmptyArray<Nullable<Doc>>;

      const result = getPrimaryContactIds(places);

      expect(result).to.deep.equal(['c1', 'c2']);
    });

    it('skips places without contacts', () => {
      const places = [
        { _id: 'p1', _rev: '1' },
        { _id: 'p2', _rev: '1', contact: 'not-identifiable' },
      ] as NonEmptyArray<Nullable<Doc>>;

      const result = getPrimaryContactIds(places);

      expect(result).to.deep.equal([]);
    });
  });

  describe('hydratePrimaryContact', () => {
    it('attaches contact to place', () => {
      const contact = { _id: 'c1', _rev: '1', name: 'Alice' } as Doc;
      const place = { _id: 'p1', _rev: '1', contact: { _id: 'c1' } } as Doc;

      const result = hydratePrimaryContact([contact])(place);

      expect(result).to.deep.include({ contact: contact });
    });

    it('returns place unchanged when contact not found', () => {
      const place = { _id: 'p1', _rev: '1', contact: { _id: 'missing' } } as Doc;

      const result = hydratePrimaryContact([])(place);

      expect(result).to.equal(place);
    });

    it('returns null for null place', () => {
      const result = hydratePrimaryContact([])(null);
      expect(result).to.be.null;
    });

    it('returns place when contact is not identifiable', () => {
      const place = { _id: 'p1', _rev: '1', contact: 'just-a-string' } as unknown as Doc;

      const result = hydratePrimaryContact([])(place);

      expect(result).to.equal(place);
    });
  });

  describe('hydrateLineage', () => {
    it('builds nested parent structure', () => {
      const contact = { _id: 'a', _rev: '1', type: 'person', parent: { _id: 'b' } } as any;
      const parent = { _id: 'b', _rev: '1', type: 'clinic' } as Doc;

      const result = hydrateLineage(contact, [parent]);

      expect(result._id).to.equal('a');
      expect((result as any).parent._id).to.equal('b');
    });

    it('uses placeholder for missing lineage docs', () => {
      const contact = { _id: 'a', _rev: '1', type: 'person', parent: { _id: 'b' } } as any;

      const result = hydrateLineage(contact, [null]);

      expect(result._id).to.equal('a');
      expect((result as any).parent._id).to.equal('b');
    });
  });

  describe('fetchHydratedDoc', () => {
    it('returns null when doc not found', async () => {
      poolQuery.resolves({ rows: [], rowCount: 0 });

      const result = await fetchHydratedDoc(ctx)('missing');

      expect(result).to.be.null;
    });

    it('returns doc without lineage when no parents', async () => {
      const doc = { _id: 'a', _rev: '1', type: 'person' };
      poolQuery.onFirstCall().resolves({ rows: [{ doc, depth: 0 }], rowCount: 1 });
      sinon.stub(require('../../../src/libs/doc'), 'isDoc').returns(true);

      const result = await fetchHydratedDoc(ctx)('a');

      expect(result).to.deep.equal(doc);
    });
  });

  describe('resolveShortcode', () => {
    it('resolves a patient_id shortcode', async () => {
      poolQuery.resolves({ rows: [{ _id: 'contact-123' }], rowCount: 1 });

      const result = await resolveShortcode(ctx)('PAT-001');

      expect(result).to.equal('contact-123');
      expect(poolQuery.firstCall.args[0]).to.include('patient_id');
      expect(poolQuery.firstCall.args[0]).to.include('place_id');
      expect(poolQuery.firstCall.args[0]).to.include('rc_code');
    });

    it('returns null when shortcode not found', async () => {
      poolQuery.resolves({ rows: [], rowCount: 0 });

      const result = await resolveShortcode(ctx)('UNKNOWN');

      expect(result).to.be.null;
    });
  });
});
