import sinon, { SinonStub } from 'sinon';
import contactTypeUtils, { type ContactType } from '@medic/contact-types-utils';
import logger from '@medic/logger';
import { expect } from 'chai';
import { Doc } from '../../src/libs/doc';
import * as Place from '../../src/postgres/place';
import * as PgDoc from '../../src/postgres/libs/doc';
import * as PgLineage from '../../src/postgres/libs/lineage';
import * as PgContact from '../../src/postgres/contact';
import { PostgresDataContext, DatabasePool } from '../../src/postgres/libs/data-context';
import { InvalidArgumentError, ResourceNotFoundError } from '../../src/libs/error';
import * as Input from '../../src/input';

describe('postgres place', () => {
  let ctx: PostgresDataContext;
  let poolQuery: SinonStub;
  let settingsGetAll: SinonStub;
  let warn: SinonStub;
  let isPlace: SinonStub;

  beforeEach(() => {
    poolQuery = sinon.stub();
    settingsGetAll = sinon.stub();
    ctx = {
      pool: { query: poolQuery } as unknown as DatabasePool,
      settings: { getAll: settingsGetAll },
      schemaConfig: { schema: 'v1', table: 'couchdb' },
      qualifiedTable: '"v1"."couchdb"',
      bind: sinon.stub(),
    } as unknown as PostgresDataContext;
    warn = sinon.stub(logger, 'warn');
    isPlace = sinon.stub(contactTypeUtils, 'isPlace');
  });

  afterEach(() => sinon.restore());

  describe('v1', () => {
    const settings = { hello: 'world' } as const;

    describe('isPlace', () => {
      beforeEach(() => settingsGetAll.returns(settings));

      it('returns true for a valid place', () => {
        const doc = { _id: 'place-1', _rev: '1-abc' };
        isPlace.returns(true);

        const result = Place.v1.isPlace(ctx.settings, doc);

        expect(result).to.be.true;
        expect(isPlace.calledOnceWithExactly(settings, doc)).to.be.true;
        expect(settingsGetAll.calledOnceWithExactly()).to.be.true;
      });

      it('returns false for a doc with a non-place type', () => {
        const doc = { _id: 'person-1', _rev: '1-abc' };
        isPlace.returns(false);

        const result = Place.v1.isPlace(ctx.settings, doc);

        expect(result).to.be.false;
        expect(isPlace.calledOnceWithExactly(settings, doc)).to.be.true;
        expect(settingsGetAll.calledOnceWithExactly()).to.be.true;
      });

      ([
        null,
        'place-id',
        { _id: 'place-1' },
        { _rev: '1-abc' }
      ] as unknown as Doc[]).forEach((doc) => {
        it(`returns false for invalid doc: ${JSON.stringify(doc)}`, () => {
          const result = Place.v1.isPlace(ctx.settings, doc);

          expect(result).to.be.false;
          expect(isPlace.notCalled).to.be.true;
          expect(settingsGetAll.notCalled).to.be.true;
        });
      });
    });

    describe('get', () => {
      const identifier = { uuid: 'place-uuid' } as const;
      let getDocByIdOuter: SinonStub;
      let getDocByIdInner: SinonStub;

      beforeEach(() => {
        getDocByIdInner = sinon.stub();
        getDocByIdOuter = sinon.stub(PgDoc, 'getDocById').returns(getDocByIdInner);
      });

      it('returns a place by UUID', async () => {
        const doc = { _id: 'place-uuid', _rev: '1-abc', type: 'health_center', name: 'HC' };
        getDocByIdInner.resolves(doc);
        settingsGetAll.returns(settings);
        isPlace.returns(true);

        const result = await Place.v1.get(ctx)(identifier);

        expect(result).to.equal(doc);
        expect(getDocByIdOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(isPlace.calledOnceWithExactly(settings, doc)).to.be.true;
        expect(warn.notCalled).to.be.true;
      });

      it('returns null when no doc is found', async () => {
        getDocByIdInner.resolves(null);
        settingsGetAll.returns(settings);
        isPlace.returns(false);

        const result = await Place.v1.get(ctx)(identifier);

        expect(result).to.be.null;
        expect(getDocByIdOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(isPlace.notCalled).to.be.true;
        expect(warn.calledOnceWithExactly(`Document [${identifier.uuid}] is not a valid place.`)).to.be.true;
      });

      it('returns null when the doc is not a place', async () => {
        const doc = { _id: 'place-uuid', _rev: '1-abc', type: 'person' };
        getDocByIdInner.resolves(doc);
        settingsGetAll.returns(settings);
        isPlace.returns(false);

        const result = await Place.v1.get(ctx)(identifier);

        expect(result).to.be.null;
        expect(getDocByIdOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(isPlace.calledOnceWithExactly(settings, doc)).to.be.true;
        expect(warn.calledOnceWithExactly(`Document [${identifier.uuid}] is not a valid place.`)).to.be.true;
      });
    });

    describe('getWithLineage', () => {
      const identifier = { uuid: 'place-uuid' } as const;
      let fetchHydratedDocOuter: SinonStub;
      let fetchHydratedDocInner: SinonStub;

      beforeEach(() => {
        fetchHydratedDocInner = sinon.stub();
        fetchHydratedDocOuter = sinon.stub(PgLineage, 'fetchHydratedDoc').returns(fetchHydratedDocInner);
      });

      it('returns a place with lineage', async () => {
        const placeWithLineage = {
          _id: 'place-uuid', _rev: '1-abc', type: 'health_center', name: 'HC',
          parent: { _id: 'district-1', _rev: '1-def', type: 'district_hospital' }
        };
        fetchHydratedDocInner.resolves(placeWithLineage);
        settingsGetAll.returns(settings);
        isPlace.returns(true);

        const result = await Place.v1.getWithLineage(ctx)(identifier);

        expect(result).to.equal(placeWithLineage);
        expect(fetchHydratedDocOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(fetchHydratedDocInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(isPlace.calledOnceWithExactly(settings, placeWithLineage)).to.be.true;
        expect(warn.notCalled).to.be.true;
      });

      it('returns null when no place is found', async () => {
        fetchHydratedDocInner.resolves(null);
        settingsGetAll.returns(settings);
        isPlace.returns(false);

        const result = await Place.v1.getWithLineage(ctx)(identifier);

        expect(result).to.be.null;
        expect(fetchHydratedDocOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(fetchHydratedDocInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(isPlace.notCalled).to.be.true;
        expect(warn.calledOnceWithExactly(`Document [${identifier.uuid}] is not a valid place.`)).to.be.true;
      });

      it('returns null when the doc is not a place', async () => {
        const notAPlace = { _id: 'place-uuid', _rev: '1-abc', type: 'person' };
        fetchHydratedDocInner.resolves(notAPlace);
        settingsGetAll.returns(settings);
        isPlace.returns(false);

        const result = await Place.v1.getWithLineage(ctx)(identifier);

        expect(result).to.be.null;
        expect(fetchHydratedDocOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(fetchHydratedDocInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(isPlace.calledOnceWithExactly(settings, notAPlace)).to.be.true;
        expect(warn.calledOnceWithExactly(`Document [${identifier.uuid}] is not a valid place.`)).to.be.true;
      });
    });

    describe('getPage', () => {
      const limit = 3;
      const cursor = null;
      const placeTypeQualifier = { contactType: 'health_center' } as const;
      const invalidPlaceTypeQualifier = { contactType: 'invalid_type' } as const;
      const placeTypes = [{ id: 'health_center' }, { id: 'district_hospital' }] as ContactType[];
      let getPlaceTypes: SinonStub;
      let queryDocsByTypeOuter: SinonStub;
      let queryDocsByTypeInner: SinonStub;
      let fetchAndFilterOuter: SinonStub;
      let fetchAndFilterInner: SinonStub;

      beforeEach(() => {
        queryDocsByTypeInner = sinon.stub();
        queryDocsByTypeOuter = sinon.stub(PgDoc, 'queryDocsByType').returns(queryDocsByTypeInner);
        getPlaceTypes = sinon.stub(contactTypeUtils, 'getPlaceTypes').returns(placeTypes);
        settingsGetAll.returns(settings);
        fetchAndFilterInner = sinon.stub();
        fetchAndFilterOuter = sinon.stub(PgDoc, 'fetchAndFilter').returns(fetchAndFilterInner);
      });

      it('returns a page of places for a valid type', async () => {
        const doc = { _id: '1', _rev: '1-a', type: 'health_center' };
        const expectedResult = {
          cursor: '3',
          data: [doc, doc, doc]
        };
        fetchAndFilterInner.resolves(expectedResult);

        const result = await Place.v1.getPage(ctx)(placeTypeQualifier, cursor, limit);

        expect(result).to.deep.equal(expectedResult);
        expect(settingsGetAll.calledOnce).to.be.true;
        expect(getPlaceTypes.calledOnceWithExactly(settings)).to.be.true;
        expect(queryDocsByTypeOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(fetchAndFilterOuter.calledOnce).to.be.true;
        expect(fetchAndFilterOuter.firstCall.args[0]).to.be.a('function');
        expect(fetchAndFilterOuter.firstCall.args[1]).to.be.a('function');
        expect(fetchAndFilterOuter.firstCall.args[2]).to.equal(limit);
        expect(fetchAndFilterInner.calledOnceWithExactly(limit, Number(cursor))).to.be.true;
      });

      it('returns a page of places when cursor is not null', async () => {
        const notNullCursor = '5';
        const expectedResult = {
          cursor: '8',
          data: [{ _id: '1', _rev: '1-a', type: 'health_center' }]
        };
        fetchAndFilterInner.resolves(expectedResult);

        const result = await Place.v1.getPage(ctx)(placeTypeQualifier, notNullCursor, limit);

        expect(result).to.deep.equal(expectedResult);
        expect(fetchAndFilterInner.calledOnceWithExactly(limit, Number(notNullCursor))).to.be.true;
      });

      it('throws an error for an invalid place type', async () => {
        await expect(
          Place.v1.getPage(ctx)(invalidPlaceTypeQualifier, cursor, limit)
        ).to.be.rejectedWith(`Invalid contact type [${invalidPlaceTypeQualifier.contactType}].`);

        expect(settingsGetAll.calledOnce).to.be.true;
        expect(getPlaceTypes.calledOnceWithExactly(settings)).to.be.true;
        expect(fetchAndFilterInner.notCalled).to.be.true;
      });

      ([
        {},
        '-1',
        undefined,
      ] as unknown as string[]).forEach((invalidCursor) => {
        it(`throws an error for invalid cursor: ${JSON.stringify(invalidCursor)}`, async () => {
          await expect(
            Place.v1.getPage(ctx)(placeTypeQualifier, invalidCursor, limit)
          ).to.be.rejectedWith(
            `The cursor must be a string or null for first page: [${JSON.stringify(invalidCursor)}]`
          );

          expect(settingsGetAll.calledOnce).to.be.true;
          expect(getPlaceTypes.calledOnceWithExactly(settings)).to.be.true;
          expect(fetchAndFilterInner.notCalled).to.be.true;
        });
      });

      it('returns an empty page when no places exist', async () => {
        const expectedResult = { data: [], cursor: null };
        fetchAndFilterInner.resolves(expectedResult);

        const result = await Place.v1.getPage(ctx)(placeTypeQualifier, cursor, limit);

        expect(result).to.deep.equal(expectedResult);
      });
    });

    describe('create', () => {
      const parentDoc = {
        _id: 'parent-1',
        _rev: '1-abc',
        type: 'district_hospital',
        name: 'District'
      } as const;
      const contactDoc = {
        _id: 'contact-1',
        _rev: '1-abc',
        type: 'person',
        name: 'Person'
      } as const;
      const createdDoc = {
        _id: 'new-uuid',
        _rev: '1-pg123',
        type: 'health_center',
        name: 'New HC',
        parent: { _id: 'parent-1' },
        contact: { _id: 'contact-1' },
      };

      let getDocsByIdsOuter: SinonStub;
      let getDocsByIdsInner: SinonStub;
      let createDocOuter: SinonStub;
      let createDocInner: SinonStub;
      let getTypeById: SinonStub;
      let isContact: SinonStub;

      beforeEach(() => {
        getDocsByIdsInner = sinon.stub();
        getDocsByIdsOuter = sinon.stub(PgDoc, 'getDocsByIds').returns(getDocsByIdsInner);
        createDocInner = sinon.stub().resolves(createdDoc);
        createDocOuter = sinon.stub(PgDoc, 'createDoc').returns(createDocInner);
        settingsGetAll.returns(settings);
        getTypeById = sinon.stub(contactTypeUtils, 'getTypeById');
        isContact = sinon.stub(PgContact.v1, 'isContact').returns(true);
      });

      it('creates a place with a custom type that has a parent', async () => {
        const customType = { id: 'health_center', person: false, parents: ['district_hospital'] };
        const input: Input.v1.PlaceInput = {
          name: 'New HC',
          type: 'health_center',
          parent: 'parent-1',
          contact: 'contact-1',
        };
        getTypeById.returns(customType);
        getDocsByIdsInner.resolves([parentDoc, contactDoc]);

        const result = await Place.v1.create(ctx)(input);

        expect(result).to.equal(createdDoc);
        expect(getDocsByIdsOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(createDocOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(getTypeById.calledOnceWithExactly(settings, input.type)).to.be.true;
        expect(getDocsByIdsInner.calledOnceWithExactly([input.parent, input.contact])).to.be.true;
        expect(isContact.calledOnceWithExactly(ctx.settings, contactDoc)).to.be.true;
        expect(createDocInner.calledOnce).to.be.true;
        const createdArg = createDocInner.firstCall.args[0];
        expect(createdArg.contact_type).to.equal('health_center');
        expect(createdArg.type).to.equal('contact');
        expect(createdArg.name).to.equal('New HC');
        expect(createdArg.parent).to.deep.equal({ _id: 'parent-1' });
        expect(createdArg.contact).to.deep.equal({ _id: 'contact-1' });
        expect(createdArg.reported_date).to.be.a('number');
      });

      it('creates a place with a default type (no custom type in settings)', async () => {
        const input: Input.v1.PlaceInput = {
          name: 'Top Level',
          type: 'district_hospital',
        };
        getTypeById.returns(null);
        getDocsByIdsInner.resolves([null, null]);

        const result = await Place.v1.create(ctx)(input);

        expect(result).to.equal(createdDoc);
        expect(createDocInner.calledOnce).to.be.true;
        const createdArg = createDocInner.firstCall.args[0];
        expect(createdArg.type).to.equal('district_hospital');
        expect(createdArg.contact_type).to.be.undefined;
        expect(createdArg.parent).to.be.undefined;
      });

      it('creates a place with a custom contact_type property', async () => {
        const customType = { id: 'custom_place', person: false, parents: ['district_hospital'] };
        const input: Input.v1.PlaceInput = {
          name: 'Custom Place',
          type: 'custom_place',
          parent: 'parent-1',
        };
        getTypeById.returns(customType);
        getDocsByIdsInner.resolves([parentDoc, null]);

        const result = await Place.v1.create(ctx)(input);

        expect(result).to.equal(createdDoc);
        expect(createDocInner.calledOnce).to.be.true;
        const createdArg = createDocInner.firstCall.args[0];
        expect(createdArg.contact_type).to.equal('custom_place');
        expect(createdArg.type).to.equal('contact');
      });

      it('throws an error when the type is a person type', async () => {
        const personType = { id: 'person_type', person: true };
        const input: Input.v1.PlaceInput = {
          name: 'Not a place',
          type: 'person_type',
        };
        getTypeById.returns(personType);

        await expect(Place.v1.create(ctx)(input))
          .to.be.rejectedWith(InvalidArgumentError, '[person_type] is not a valid place type.');

        expect(createDocInner.notCalled).to.be.true;
      });

      it('creates a place without parent when type does not require one', async () => {
        const input: Input.v1.PlaceInput = {
          name: 'Top Level',
          type: 'district_hospital',
        };
        getTypeById.returns(null);
        getDocsByIdsInner.resolves([null, null]);

        const result = await Place.v1.create(ctx)(input);

        expect(result).to.equal(createdDoc);
        const createdArg = createDocInner.firstCall.args[0];
        expect(createdArg.parent).to.be.undefined;
      });

      it('throws an error when parent is provided for a type that does not support parents', async () => {
        const input: Input.v1.PlaceInput = {
          name: 'District',
          type: 'district_hospital',
          parent: 'parent-1',
        };
        getTypeById.returns(null);
        getDocsByIdsInner.resolves([parentDoc, null]);

        await expect(Place.v1.create(ctx)(input))
          .to.be.rejectedWith(InvalidArgumentError, 'Place type [district_hospital] does not support having a parent contact.');

        expect(createDocInner.notCalled).to.be.true;
      });

      it('throws an error when parent is not provided for a type that requires one', async () => {
        const customType = { id: 'health_center', person: false, parents: ['district_hospital'] };
        const input: Input.v1.PlaceInput = {
          name: 'Needs parent',
          type: 'health_center',
        };
        getTypeById.returns(customType);
        getDocsByIdsInner.resolves([null, null]);

        await expect(Place.v1.create(ctx)(input))
          .to.be.rejectedWith(InvalidArgumentError, 'Place type [health_center] requires a parent contact.');

        expect(createDocInner.notCalled).to.be.true;
      });

      it('sets contact to undefined when contact doc is not a valid contact', async () => {
        const customType = { id: 'health_center', person: false, parents: ['district_hospital'] };
        const input: Input.v1.PlaceInput = {
          name: 'HC',
          type: 'health_center',
          parent: 'parent-1',
          contact: 'bad-contact',
        };
        getTypeById.returns(customType);
        getDocsByIdsInner.resolves([parentDoc, { _id: 'bad-contact', _rev: '1', type: 'not-contact' }]);
        isContact.returns(false);

        await Place.v1.create(ctx)(input);

        const createdArg = createDocInner.firstCall.args[0];
        expect(createdArg.contact).to.be.undefined;
      });
    });

    describe('update', () => {
      const originalDoc = {
        _id: 'place-1',
        _rev: '1-rev',
        name: 'Health Center',
        type: 'health_center',
        reported_date: 12312312,
      };

      let getDocsByIdsOuter: SinonStub;
      let getDocsByIdsInner: SinonStub;
      let updateDocOuter: SinonStub;
      let updateDocInner: SinonStub;

      beforeEach(() => {
        getDocsByIdsInner = sinon.stub();
        getDocsByIdsOuter = sinon.stub(PgDoc, 'getDocsByIds').returns(getDocsByIdsInner);
        updateDocInner = sinon.stub();
        updateDocOuter = sinon.stub(PgDoc, 'updateDoc').returns(updateDocInner);
        settingsGetAll.returns(settings);
        isPlace.returns(true);
      });

      it('updates a place successfully', async () => {
        const updatedPlace = {
          ...originalDoc,
          name: 'Updated Health Center',
        };
        getDocsByIdsInner.resolves([originalDoc]);
        updateDocInner.resolves({ ...updatedPlace, _rev: '2-pg456' });

        const result = await Place.v1.update(ctx)(updatedPlace);

        expect(result._rev).to.equal('2-pg456');
        expect(result.name).to.equal('Updated Health Center');
        expect(getDocsByIdsOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(updateDocOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(getDocsByIdsInner.calledOnceWithExactly([originalDoc._id])).to.be.true;
        expect(updateDocInner.calledOnce).to.be.true;
        expect(isPlace.args).to.deep.equal([
          [settings, updatedPlace],
          [settings, originalDoc],
        ]);
      });

      it('throws an error when the original place is not found', async () => {
        getDocsByIdsInner.resolves([null]);

        await expect(Place.v1.update(ctx)(originalDoc))
          .to.be.rejectedWith(ResourceNotFoundError, `Place record [${originalDoc._id}] not found.`);

        expect(getDocsByIdsInner.calledOnceWithExactly([originalDoc._id])).to.be.true;
        expect(updateDocInner.notCalled).to.be.true;
      });

      it('throws an error when the input is not a valid place', async () => {
        isPlace.returns(false);

        await expect(Place.v1.update(ctx)(originalDoc))
          .to.be.rejectedWith(InvalidArgumentError, 'Valid _id, _rev, and type fields must be provided.');

        expect(getDocsByIdsInner.notCalled).to.be.true;
        expect(updateDocInner.notCalled).to.be.true;
      });

      ([
        ['_rev', { ...originalDoc, _rev: 'changed-rev' }],
        ['reported_date', { ...originalDoc, reported_date: 99999999 }],
        ['type', { ...originalDoc, type: 'different_type' }],
        ['contact_type', { ...originalDoc, contact_type: 'added_contact_type' }],
      ] as [string, typeof originalDoc][]).forEach(([field, updatedPlace]) => {
        it(`throws an error when the readonly field [${field}] is changed`, async () => {
          getDocsByIdsInner.resolves([originalDoc]);

          await expect(Place.v1.update(ctx)(updatedPlace))
            .to.be.rejectedWith(InvalidArgumentError, `The [${field}] fields must not be changed.`);

          expect(updateDocInner.notCalled).to.be.true;
        });
      });

      it('throws an error when name is removed', async () => {
        const updatedPlace = { ...originalDoc, name: undefined };
        getDocsByIdsInner.resolves([originalDoc]);

        await expect(Place.v1.update(ctx)(updatedPlace as unknown as typeof originalDoc))
          .to.be.rejectedWith(InvalidArgumentError, 'The [name] field must have a [string] value.');

        expect(updateDocInner.notCalled).to.be.true;
      });

      it('throws an error when parent lineage _id changes', async () => {
        const updatedPlace = {
          ...originalDoc,
          parent: { _id: 'different-parent' }
        };
        const originalWithParent = {
          ...originalDoc,
          parent: { _id: 'original-parent' }
        };
        getDocsByIdsInner.resolves([originalWithParent]);

        await expect(Place.v1.update(ctx)(updatedPlace))
          .to.be.rejectedWith(InvalidArgumentError, 'Parent lineage does not match.');

        expect(updateDocInner.notCalled).to.be.true;
      });

      it('throws an error when parent is removed', async () => {
        const updatedPlace = {
          ...originalDoc,
          parent: undefined
        };
        const originalWithParent = {
          ...originalDoc,
          parent: { _id: 'original-parent' }
        };
        getDocsByIdsInner.resolves([originalWithParent]);

        await expect(Place.v1.update(ctx)(updatedPlace))
          .to.be.rejectedWith(InvalidArgumentError, 'Parent lineage does not match.');

        expect(updateDocInner.notCalled).to.be.true;
      });

      it('throws an error when parent is added to a doc that had none', async () => {
        const updatedPlace = {
          ...originalDoc,
          parent: { _id: 'new-parent' }
        };
        getDocsByIdsInner.resolves([originalDoc]);

        await expect(Place.v1.update(ctx)(updatedPlace))
          .to.be.rejectedWith(InvalidArgumentError, 'Parent lineage does not match.');

        expect(updateDocInner.notCalled).to.be.true;
      });

      it('minifies hydrated parent and contact lineage before storing', async () => {
        const originalWithParent = {
          ...originalDoc,
          parent: { _id: 'district-1' },
        };
        const updatedPlace = {
          ...originalDoc,
          name: 'Updated HC',
          parent: {
            _id: 'district-1',
            name: 'District Full',
            type: 'district_hospital',
            contact: { _id: 'admin-1', name: 'Admin' }
          },
          contact: {
            _id: 'nurse-1',
            name: 'Nurse Jane',
            type: 'person',
            parent: {
              _id: 'place-1',
              name: 'HC Full',
              parent: { _id: 'district-1', name: 'District Full' }
            }
          }
        };
        getDocsByIdsInner.resolves([originalWithParent]);
        updateDocInner.resolves({ ...updatedPlace, _rev: '2-pg456' });

        const result = await Place.v1.update(ctx)(updatedPlace);

        expect(result._rev).to.equal('2-pg456');
        const storedDoc = updateDocInner.firstCall.args[0];
        expect(storedDoc.parent).to.deep.equal({ _id: 'district-1' });
        expect(storedDoc.contact).to.deep.equal({
          _id: 'nurse-1',
          parent: { _id: 'place-1', parent: { _id: 'district-1' } }
        });
      });
    });
  });
});
