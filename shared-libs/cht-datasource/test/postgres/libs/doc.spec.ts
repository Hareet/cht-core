import sinon, { SinonStub } from 'sinon';
import * as DocLib from '../../../src/libs/doc';
import logger from '@medic/logger';
import {
  getDocById,
  getDocsByIds,
  getDocIdsByIdRange,
  queryDocsByType,
  queryDocIdsByType,
  createDoc,
  updateDoc,
  fetchAndFilter,
  fetchAndFilterIds,
  minifyLineage,
  minifyDoc,
} from '../../../src/postgres/libs/doc';
import { expect } from 'chai';
import { PostgresDataContext, DatabasePool } from '../../../src/postgres/libs/data-context';
import { Nullable } from '../../../src';
import { ResourceNotFoundError, RevisionConflictError } from '../../../src/libs/error';

describe('postgres doc lib', () => {
  let poolQuery: SinonStub;
  let ctx: PostgresDataContext;
  let isDoc: SinonStub;
  let errorStub: SinonStub;

  beforeEach(() => {
    poolQuery = sinon.stub();
    ctx = {
      pool: { query: poolQuery } as unknown as DatabasePool,
      settings: { getAll: sinon.stub() },
      schemaConfig: { schema: 'v1', table: 'couchdb' },
      qualifiedTable: '"v1"."couchdb"',
      bind: sinon.stub(),
    } as unknown as PostgresDataContext;
    isDoc = sinon.stub(DocLib, 'isDoc');
    errorStub = sinon.stub(logger, 'error');
  });

  afterEach(() => sinon.restore());

  describe('getDocById', () => {
    it('returns a doc by id', async () => {
      const doc = { _id: 'uuid', _rev: '1-abc', type: 'person' };
      poolQuery.resolves({ rows: [{ doc }], rowCount: 1 });
      isDoc.returns(true);

      const result = await getDocById(ctx)('uuid');

      expect(result).to.deep.equal(doc);
      expect(poolQuery.calledOnce).to.be.true;
      expect(poolQuery.firstCall.args[0]).to.include('_id = $1');
      expect(poolQuery.firstCall.args[1]).to.deep.equal(['uuid']);
    });

    it('returns null when no doc found', async () => {
      poolQuery.resolves({ rows: [], rowCount: 0 });

      const result = await getDocById(ctx)('missing');

      expect(result).to.be.null;
    });

    it('returns null when result is not a valid doc', async () => {
      poolQuery.resolves({ rows: [{ doc: { not: 'a doc' } }], rowCount: 1 });
      isDoc.returns(false);

      const result = await getDocById(ctx)('uuid');

      expect(result).to.be.null;
    });

    it('throws and logs on query error', async () => {
      const err = new Error('connection failed');
      poolQuery.rejects(err);

      await expect(getDocById(ctx)('uuid')).to.be.rejectedWith('connection failed');
      expect(errorStub.calledOnce).to.be.true;
    });
  });

  describe('getDocsByIds', () => {
    it('returns docs in the order of provided ids', async () => {
      const doc1 = { _id: 'a', _rev: '1-x', type: 'person' };
      const doc2 = { _id: 'b', _rev: '1-y', type: 'place' };
      poolQuery.resolves({ rows: [{ _id: 'b', doc: doc2 }, { _id: 'a', doc: doc1 }], rowCount: 2 });
      isDoc.returns(true);

      const result = await getDocsByIds(ctx)(['a', 'b']);

      expect(result).to.deep.equal([doc1, doc2]);
    });

    it('returns null for missing ids', async () => {
      poolQuery.resolves({ rows: [{ _id: 'a', doc: { _id: 'a', _rev: '1' } }], rowCount: 1 });
      isDoc.returns(true);

      const result = await getDocsByIds(ctx)(['a', 'missing']);

      expect(result[0]).to.not.be.null;
      expect(result[1]).to.be.null;
    });

    it('returns all nulls when no ids have values', async () => {
      const result = await getDocsByIds(ctx)([undefined, undefined]);

      expect(result).to.deep.equal([null, null]);
      expect(poolQuery.notCalled).to.be.true;
    });

    it('replaces undefined ids with empty strings', async () => {
      poolQuery.resolves({ rows: [], rowCount: 0 });
      isDoc.returns(false);

      await getDocsByIds(ctx)(['a', undefined]);

      expect(poolQuery.firstCall.args[1]).to.deep.equal([['a', '']]);
    });
  });

  describe('getDocIdsByIdRange', () => {
    it('returns ids in the given range', async () => {
      poolQuery.resolves({ rows: [{ _id: 'a' }, { _id: 'b' }], rowCount: 2 });

      const result = await getDocIdsByIdRange(ctx)('a', 'c');

      expect(result).to.deep.equal(['a', 'b']);
      expect(poolQuery.firstCall.args[0]).to.include('>= $1');
      expect(poolQuery.firstCall.args[0]).to.include('<= $2');
    });

    it('applies limit and skip', async () => {
      poolQuery.resolves({ rows: [{ _id: 'b' }], rowCount: 1 });

      await getDocIdsByIdRange(ctx)('a', 'z', 10, 5);

      expect(poolQuery.firstCall.args[0]).to.include('LIMIT');
      expect(poolQuery.firstCall.args[0]).to.include('OFFSET');
      expect(poolQuery.firstCall.args[1]).to.deep.equal(['a', 'z', 10, 5]);
    });
  });

  describe('queryDocsByType', () => {
    it('returns docs matching the contact type', async () => {
      const doc = { _id: '1', _rev: '1-x', type: 'contact', contact_type: 'person' };
      poolQuery.resolves({ rows: [{ doc }], rowCount: 1 });
      isDoc.returns(true);

      const result = await queryDocsByType(ctx)('person', 10, 0);

      expect(result).to.deep.equal([doc]);
      expect(poolQuery.firstCall.args[0]).to.include('COALESCE');
      expect(poolQuery.firstCall.args[1]).to.deep.equal(['person', 10, 0]);
    });

    it('returns null for invalid docs', async () => {
      poolQuery.resolves({ rows: [{ doc: { bad: true } }], rowCount: 1 });
      isDoc.returns(false);

      const result = await queryDocsByType(ctx)('person', 10, 0);

      expect(result).to.deep.equal([null]);
    });
  });

  describe('queryDocIdsByType', () => {
    it('returns ids matching the contact type', async () => {
      poolQuery.resolves({ rows: [{ _id: 'a' }, { _id: 'b' }], rowCount: 2 });

      const result = await queryDocIdsByType(ctx)('clinic', 10, 0);

      expect(result).to.deep.equal(['a', 'b']);
      expect(poolQuery.firstCall.args[1]).to.deep.equal(['clinic', 10, 0]);
    });
  });

  describe('createDoc', () => {
    it('creates a document and returns it with _id and _rev', async () => {
      poolQuery.resolves({ rows: [], rowCount: 1 });

      const result = await createDoc(ctx)({ name: 'test', type: 'person' });

      expect(result._id).to.be.a('string').with.length.greaterThan(0);
      expect(result._rev).to.match(/^1-pg/);
      expect(result.name).to.equal('test');
      expect(poolQuery.calledOnce).to.be.true;
      expect(poolQuery.firstCall.args[0]).to.include('INSERT INTO');
    });

    it('throws on insert failure', async () => {
      poolQuery.resolves({ rows: [], rowCount: 0 });

      await expect(createDoc(ctx)({ type: 'person' })).to.be.rejectedWith('Error creating document.');
    });

    it('uses the provided idHint as _id instead of generating a UUID', async () => {
      poolQuery.resolves({ rows: [], rowCount: 1 });
      const idHint = 'client-minted-uuid';

      const result = await createDoc(ctx)({ name: 'test', type: 'person' }, idHint);

      expect(result._id).to.equal(idHint);
      expect(poolQuery.firstCall.args[1][0]).to.equal(idHint);
    });
  });

  describe('updateDoc', () => {
    it('updates a document and returns it with a new _rev', async () => {
      poolQuery.resolves({ rows: [], rowCount: 1 });
      const doc = { _id: 'abc', _rev: '1-pg123', type: 'person', name: 'updated' };

      const result = await updateDoc(ctx)(doc);

      expect(result._id).to.equal('abc');
      expect(result._rev).to.match(/^2-pg/);
      expect(result.name).to.equal('updated');
      expect(poolQuery.calledOnce).to.be.true;
      expect(poolQuery.firstCall.args[0]).to.include('UPDATE');
      expect(poolQuery.firstCall.args[0]).to.include("doc->>'_rev' = $3");
      expect(poolQuery.firstCall.args[1][1]).to.equal('abc');
      expect(poolQuery.firstCall.args[1][2]).to.equal('1-pg123');
    });

    it('throws ResourceNotFoundError when document does not exist', async () => {
      // UPDATE returns 0 rows
      poolQuery.onFirstCall().resolves({ rows: [], rowCount: 0 });
      // Follow-up SELECT also returns 0 rows (document not found)
      poolQuery.onSecondCall().resolves({ rows: [], rowCount: 0 });

      await expect(updateDoc(ctx)({ _id: 'abc', _rev: '1-x' }))
        .to.be.rejectedWith(ResourceNotFoundError, 'Document [abc] not found.');

      expect(poolQuery.calledTwice).to.be.true;
      // Verify the follow-up query checks for document existence
      expect(poolQuery.secondCall.args[0]).to.include('_id = $1');
      expect(poolQuery.secondCall.args[1]).to.deep.equal(['abc']);
    });

    it('throws RevisionConflictError when _rev does not match (concurrent modification)', async () => {
      const doc = { _id: 'abc', _rev: '1-pg123', type: 'person', name: 'stale-update' };
      // UPDATE returns 0 rows (rev mismatch)
      poolQuery.onFirstCall().resolves({ rows: [], rowCount: 0 });
      // Follow-up SELECT finds the document with a different rev
      poolQuery.onSecondCall().resolves({ rows: [{ current_rev: '2-pg999' }], rowCount: 1 });

      await expect(updateDoc(ctx)(doc))
        .to.be.rejectedWith(RevisionConflictError, 'Document [abc] has been modified. Expected rev [1-pg123] but found [2-pg999].');

      expect(poolQuery.calledTwice).to.be.true;
      // Verify _rev is passed as the third parameter for the WHERE clause check
      expect(poolQuery.firstCall.args[1][2]).to.equal('1-pg123');
    });

    it('throws ResourceNotFoundError when document has been deleted', async () => {
      const doc = { _id: 'abc', _rev: '1-pg123', type: 'person', name: 'deleted-doc' };
      // UPDATE returns 0 rows (_deleted = true filtered out by WHERE)
      poolQuery.onFirstCall().resolves({ rows: [], rowCount: 0 });
      // Follow-up SELECT also returns 0 rows (deleted docs are filtered)
      poolQuery.onSecondCall().resolves({ rows: [], rowCount: 0 });

      await expect(updateDoc(ctx)(doc))
        .to.be.rejectedWith(ResourceNotFoundError, 'Document [abc] not found.');

      expect(poolQuery.calledTwice).to.be.true;
    });

    it('increments the rev number correctly across multiple updates', async () => {
      poolQuery.resolves({ rows: [], rowCount: 1 });

      const result1 = await updateDoc(ctx)({ _id: 'abc', _rev: '3-pg999', type: 'person' });

      expect(result1._rev).to.match(/^4-pg/);
      expect(poolQuery.firstCall.args[1][2]).to.equal('3-pg999');
    });
  });

  describe('fetchAndFilter', () => {
    it('returns all results with null cursor when fewer results than limit', async () => {
      const getFunction = sinon.stub()
        .resolves(['a', 'b']);
      const filterFn = (v: Nullable<string>) => v !== null;

      const result = await fetchAndFilter(getFunction, filterFn, 3)(3, 0);

      expect(result.data).to.deep.equal(['a', 'b']);
      expect(result.cursor).to.be.null;
    });

    it('returns cursor adjusted for over-fetching when more results exist', async () => {
      const getFunction = sinon.stub()
        .resolves(['a', 'b', 'c']);
      const filterFn = () => true;

      // limit=2, fetch 2 items, get 3 back → overFetchCount=1, nextSkip=0+2-1=1
      const result = await fetchAndFilter(getFunction, filterFn, 2)(2, 0);

      expect(result.data).to.deep.equal(['a', 'b']);
      expect(result.cursor).to.equal('1');
    });

    it('re-fetches when too many docs are filtered out', async () => {
      const getFunction = sinon.stub();
      getFunction.onFirstCall().resolves([null, null]);
      getFunction.onSecondCall().resolves(['a', 'b']);
      const filterFn = (v: Nullable<string>) => v !== null;

      const result = await fetchAndFilter(getFunction, filterFn, 2)(2, 0);

      expect(result.data).to.deep.equal(['a', 'b']);
      expect(getFunction.calledTwice).to.be.true;
    });
  });

  describe('fetchAndFilterIds', () => {
    it('deduplicates returned ids', async () => {
      const getFunction = sinon.stub()
        .resolves(['a', 'b', 'a', 'c']);

      const result = await fetchAndFilterIds(getFunction, 3)(4, 0);

      expect(result.data).to.deep.equal(['a', 'b', 'c']);
    });

    it('filters null ids', async () => {
      const getFunction = sinon.stub()
        .resolves([null, 'a', null]);

      const result = await fetchAndFilterIds(getFunction, 3)(3, 0);

      expect(result.data).to.deep.equal(['a']);
      expect(result.cursor).to.be.null;
    });
  });

  describe('minifyLineage', () => {
    it('returns undefined for null', () => {
      expect(minifyLineage(null)).to.be.undefined;
    });

    it('returns undefined for undefined', () => {
      expect(minifyLineage(undefined)).to.be.undefined;
    });

    it('returns undefined for non-identifiable object', () => {
      expect(minifyLineage({ name: 'no id' })).to.be.undefined;
    });

    it('returns { _id } for a single-level parent', () => {
      const parent = { _id: 'p1', name: 'District', type: 'district_hospital' };

      const result = minifyLineage(parent);

      expect(result).to.deep.equal({ _id: 'p1' });
    });

    it('minifies a two-level parent chain', () => {
      const parent = {
        _id: 'p1', name: 'Clinic', type: 'clinic',
        parent: { _id: 'p2', name: 'District', type: 'district_hospital' }
      };

      const result = minifyLineage(parent);

      expect(result).to.deep.equal({ _id: 'p1', parent: { _id: 'p2' } });
    });

    it('minifies a three-level parent chain', () => {
      const parent = {
        _id: 'p1', name: 'CHW Area',
        parent: {
          _id: 'p2', name: 'Facility',
          parent: {
            _id: 'p3', name: 'County'
          }
        }
      };

      const result = minifyLineage(parent);

      expect(result).to.deep.equal({
        _id: 'p1',
        parent: { _id: 'p2', parent: { _id: 'p3' } }
      });
    });

    it('stops at parent without _id', () => {
      const parent = {
        _id: 'p1',
        parent: { name: 'no-id-parent' }
      };

      const result = minifyLineage(parent);

      expect(result).to.deep.equal({ _id: 'p1' });
    });

    it('does not mutate the input', () => {
      const parent = {
        _id: 'p1', name: 'Clinic',
        parent: { _id: 'p2', name: 'District' }
      };
      const copy = JSON.parse(JSON.stringify(parent));

      minifyLineage(parent);

      expect(parent).to.deep.equal(copy);
    });
  });

  describe('minifyDoc', () => {
    it('returns a doc unchanged when no lineage fields exist', () => {
      const doc = { _id: 'a', _rev: '1-x', type: 'person', name: 'Alice' };

      const result = minifyDoc(doc);

      expect(result).to.deep.equal(doc);
      expect(result).to.not.equal(doc); // new object
    });

    it('minifies hydrated parent lineage', () => {
      const doc = {
        _id: 'person-1', _rev: '1-x', type: 'person', name: 'Alice',
        parent: {
          _id: 'clinic-1', name: 'Clinic A', type: 'clinic',
          parent: { _id: 'district-1', name: 'District', type: 'district_hospital' }
        }
      };

      const result = minifyDoc(doc);

      expect(result.parent).to.deep.equal({
        _id: 'clinic-1',
        parent: { _id: 'district-1' }
      });
      expect(result.name).to.equal('Alice');
    });

    it('minifies hydrated contact field', () => {
      const doc = {
        _id: 'clinic-1', _rev: '1-x', type: 'clinic', name: 'Clinic A',
        contact: {
          _id: 'user-1', name: 'John', type: 'person',
          parent: {
            _id: 'clinic-1', name: 'Clinic A', type: 'clinic',
            parent: { _id: 'district-1', name: 'District' }
          }
        }
      };

      const result = minifyDoc(doc);

      expect(result.contact).to.deep.equal({
        _id: 'user-1',
        parent: { _id: 'clinic-1', parent: { _id: 'district-1' } }
      });
    });

    it('minifies contact without parent', () => {
      const doc = {
        _id: 'clinic-1', _rev: '1-x', type: 'clinic',
        contact: { _id: 'user-1', name: 'John', type: 'person' }
      };

      const result = minifyDoc(doc);

      expect(result.contact).to.deep.equal({ _id: 'user-1' });
    });

    it('preserves non-identifiable contact unchanged', () => {
      const doc = {
        _id: 'clinic-1', _rev: '1-x', type: 'clinic',
        contact: 'just-a-string'
      };

      const result = minifyDoc(doc);

      expect(result.contact).to.equal('just-a-string');
    });

    it('deletes patient and place from data_record docs', () => {
      const doc = {
        _id: 'r1', _rev: '1-x', type: 'data_record', form: 'pregnancy',
        contact: { _id: 'c1' },
        patient: {
          _id: 'patient-1', name: 'Bob', type: 'person',
          parent: { _id: 'clinic-1', name: 'Clinic' }
        },
        place: {
          _id: 'place-1', name: 'Health Center',
          parent: { _id: 'district-1' }
        }
      };

      const result = minifyDoc(doc);

      expect(result).to.not.have.property('patient');
      expect(result).to.not.have.property('place');
      expect(result.form).to.equal('pregnancy');
      expect(result.contact).to.deep.equal({ _id: 'c1' });
    });

    it('does not delete patient/place from non-report docs', () => {
      const doc = {
        _id: 'c1', _rev: '1-x', type: 'person',
        patient: { _id: 'p1' },
        place: { _id: 'pl1' }
      };

      const result = minifyDoc(doc);

      expect(result).to.have.property('patient');
      expect(result).to.have.property('place');
    });

    it('minifies linked_docs for contact types', () => {
      const doc = {
        _id: 'clinic-1', _rev: '1-x', type: 'clinic',
        linked_docs: {
          tag1: { _id: 'linked-1', name: 'Linked Doc' },
          tag2: 'already-a-string',
          tag3: { _id: 'linked-3', type: 'person', parent: { _id: 'p1' } }
        }
      };

      const result = minifyDoc(doc);

      expect(result.linked_docs).to.deep.equal({
        tag1: 'linked-1',
        tag2: 'already-a-string',
        tag3: 'linked-3'
      });
    });

    it('does not process linked_docs for non-contact types', () => {
      const doc = {
        _id: 'r1', _rev: '1-x', type: 'data_record', form: 'test',
        linked_docs: { tag1: { _id: 'linked-1', name: 'Full Doc' } }
      };

      const result = minifyDoc(doc);

      expect(result.linked_docs).to.deep.equal({ tag1: { _id: 'linked-1', name: 'Full Doc' } });
    });

    it('does not process linked_docs that is an array', () => {
      const doc = {
        _id: 'clinic-1', _rev: '1-x', type: 'clinic',
        linked_docs: [{ _id: 'linked-1' }]
      };

      const result = minifyDoc(doc);

      expect(result.linked_docs).to.deep.equal([{ _id: 'linked-1' }]);
    });

    it('handles a fully hydrated person with lineage', () => {
      const doc = {
        _id: 'person-1', _rev: '2-abc', type: 'person', name: 'Alice',
        parent: {
          _id: 'chw-area-1', name: 'CHW Area',
          contact: { _id: 'chw-1', name: 'CHW John' },
          parent: {
            _id: 'facility-1', name: 'Facility',
            contact: { _id: 'nurse-1', name: 'Nurse Jane' },
            parent: {
              _id: 'county-1', name: 'County',
              parent: { _id: 'national-1', name: 'National' }
            }
          }
        }
      };

      const result = minifyDoc(doc);

      expect(result.parent).to.deep.equal({
        _id: 'chw-area-1',
        parent: {
          _id: 'facility-1',
          parent: {
            _id: 'county-1',
            parent: { _id: 'national-1' }
          }
        }
      });
      expect(result.name).to.equal('Alice');
    });

    it('does not mutate the original document', () => {
      const doc = {
        _id: 'r1', _rev: '1-x', type: 'data_record', form: 'test',
        contact: { _id: 'c1', name: 'Full Contact' },
        patient: { _id: 'p1', name: 'Patient' },
        parent: { _id: 'parent-1', name: 'Parent' }
      };
      const originalDoc = JSON.parse(JSON.stringify(doc));

      minifyDoc(doc);

      expect(doc).to.deep.equal(originalDoc);
    });
  });
});
