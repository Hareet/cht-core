import sinon, { SinonStub } from 'sinon';
import contactTypeUtils, { type ContactType } from '@medic/contact-types-utils';
import logger from '@medic/logger';
import { Doc } from '../../src/libs/doc';
import * as Qualifier from '../../src/qualifier';
import * as Person from '../../src/postgres/person';
import * as PgDoc from '../../src/postgres/libs/doc';
import * as PgLineage from '../../src/postgres/libs/lineage';
import { expect } from 'chai';
import { PostgresDataContext, DatabasePool } from '../../src/postgres/libs/data-context';
import * as Input from '../../src/input';
import { InvalidArgumentError, ResourceNotFoundError } from '../../src';

describe('postgres person', () => {
  let pgContext: PostgresDataContext;
  let settingsGetAll: SinonStub;
  let warn: SinonStub;
  let debug: SinonStub;
  let isPerson: SinonStub;
  let isPersonType: SinonStub;

  beforeEach(() => {
    settingsGetAll = sinon.stub();
    pgContext = {
      pool: { query: sinon.stub() } as unknown as DatabasePool,
      settings: { getAll: settingsGetAll },
      schemaConfig: { schema: 'v1', table: 'couchdb' },
      qualifiedTable: '"v1"."couchdb"',
      bind: sinon.stub(),
    } as unknown as PostgresDataContext;
    warn = sinon.stub(logger, 'warn');
    debug = sinon.stub(logger, 'debug');
    isPerson = sinon.stub(contactTypeUtils, 'isPerson');
    isPersonType = sinon.stub(contactTypeUtils, 'isPersonType');
  });

  afterEach(() => sinon.restore());

  describe('v1', () => {
    const settings = { hello: 'world' } as const;

    describe('isPerson', () => {
      beforeEach(() => settingsGetAll.returns(settings));

      it('returns true for valid person', () => {
        const doc = { _id: 'contact-id', _rev: 'rev' };
        isPerson.returns(true);

        const result = Person.v1.isPerson(pgContext.settings, doc);

        expect(result).to.be.true;
        expect(isPerson.calledOnceWithExactly(settings, doc)).to.be.true;
        expect(settingsGetAll.calledOnceWithExactly()).to.be.true;
      });

      it('returns false for docs with an invalid type', () => {
        const doc = { _id: 'contact-id', _rev: 'rev' };
        isPerson.returns(false);

        const result = Person.v1.isPerson(pgContext.settings, doc);

        expect(result).to.be.false;
        expect(isPerson.calledOnceWithExactly(settings, doc)).to.be.true;
        expect(settingsGetAll.calledOnceWithExactly()).to.be.true;
      });

      ([
        null,
        'contact-id',
        { _id: 'contact-id' },
        { _rev: 'rev' }
      ] as unknown as Doc[]).forEach((doc) => {
        it(`returns false for invalid doc: ${JSON.stringify(doc)}`, () => {
          const result = Person.v1.isPerson(pgContext.settings, doc);

          expect(result).to.be.false;
          expect(isPerson.notCalled).to.be.true;
          expect(settingsGetAll.notCalled).to.be.true;
        });
      });
    });

    describe('get', () => {
      const identifier = { uuid: 'uuid' } as const;
      let getDocByIdOuter: SinonStub;
      let getDocByIdInner: SinonStub;

      beforeEach(() => {
        getDocByIdInner = sinon.stub();
        getDocByIdOuter = sinon.stub(PgDoc, 'getDocById').returns(getDocByIdInner);
      });

      it('returns a person by UUID', async () => {
        const doc = { type: 'person', _id: 'uuid', _rev: '1' };
        getDocByIdInner.resolves(doc);
        settingsGetAll.returns(settings);
        isPerson.returns(true);

        const result = await Person.v1.get(pgContext)(identifier);

        expect(result).to.equal(doc);
        expect(getDocByIdOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(isPerson.calledOnceWithExactly(settings, doc)).to.be.true;
        expect(warn.notCalled).to.be.true;
      });

      it('returns null if the identified doc does not have a person type', async () => {
        const doc = { type: 'not-person', _id: '_id', _rev: '1' };
        getDocByIdInner.resolves(doc);
        settingsGetAll.returns(settings);
        isPerson.returns(false);

        const result = await Person.v1.get(pgContext)(identifier);

        expect(result).to.be.null;
        expect(getDocByIdOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(isPerson.calledOnceWithExactly(settings, doc)).to.be.true;
        expect(warn.calledOnceWithExactly(`Document [${identifier.uuid}] is not a valid person.`)).to.be.true;
      });

      it('returns null if the identified doc is not found', async () => {
        getDocByIdInner.resolves(null);

        const result = await Person.v1.get(pgContext)(identifier);

        expect(result).to.be.null;
        expect(getDocByIdOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(settingsGetAll.notCalled).to.be.true;
        expect(isPerson.notCalled).to.be.true;
        expect(warn.calledOnceWithExactly(`Document [${identifier.uuid}] is not a valid person.`)).to.be.true;
      });
    });

    describe('getWithLineage', () => {
      const identifier = { uuid: 'uuid' } as const;
      let mockFetchHydratedDoc: SinonStub;

      beforeEach(() => {
        mockFetchHydratedDoc = sinon.stub(PgLineage, 'fetchHydratedDoc');
      });

      it('returns a person with lineage', async () => {
        const personWithLineage = { type: 'person', _id: 'uuid', _rev: 'rev' };
        const mockFunction = sinon.stub().resolves(personWithLineage);
        mockFetchHydratedDoc.returns(mockFunction);
        isPerson.returns(true);
        settingsGetAll.returns(settings);

        const result = await Person.v1.getWithLineage(pgContext)(identifier);

        expect(result).to.equal(personWithLineage);
        expect(mockFetchHydratedDoc.calledOnceWithExactly(pgContext)).to.be.true;
        expect(mockFunction.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(isPerson.calledOnceWithExactly(settings, personWithLineage)).to.be.true;
        expect(warn.notCalled).to.be.true;
        expect(debug.notCalled).to.be.true;
      });

      it('returns null when no person or lineage is found', async () => {
        const mockFunction = sinon.stub().resolves(null);
        mockFetchHydratedDoc.returns(mockFunction);

        const result = await Person.v1.getWithLineage(pgContext)(identifier);

        expect(result).to.be.null;
        expect(mockFetchHydratedDoc.calledOnceWithExactly(pgContext)).to.be.true;
        expect(mockFunction.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(isPerson.notCalled).to.be.true;
        expect(warn.calledOnceWithExactly(`Document [${identifier.uuid}] is not a valid person.`)).to.be.true;
        expect(debug.notCalled).to.be.true;
      });

      it('returns null if the doc returned is not a person', async () => {
        const notPerson = { type: 'not-person', _id: 'uuid', _rev: 'rev' };
        const mockFunction = sinon.stub().resolves(notPerson);
        mockFetchHydratedDoc.returns(mockFunction);
        isPerson.returns(false);
        settingsGetAll.returns(settings);

        const result = await Person.v1.getWithLineage(pgContext)(identifier);

        expect(result).to.be.null;
        expect(mockFetchHydratedDoc.calledOnceWithExactly(pgContext)).to.be.true;
        expect(mockFunction.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(isPerson.calledOnceWithExactly(settings, notPerson)).to.be.true;
        expect(warn.calledOnceWithExactly(`Document [${identifier.uuid}] is not a valid person.`)).to.be.true;
        expect(debug.notCalled).to.be.true;
      });
    });

    describe('getPage', () => {
      const limit = 3;
      const cursor = null;
      const notNullCursor = '5';
      const personIdentifier = 'person';
      const personTypeQualifier = { contactType: personIdentifier } as const;
      const invalidPersonTypeQualifier = { contactType: 'invalid' } as const;
      const personType = [{ person: true, id: personIdentifier }] as ContactType[];
      let getPersonTypes: SinonStub;
      let queryDocsByTypeInner: SinonStub;
      let queryDocsByTypeOuter: SinonStub;
      let fetchAndFilterInner: SinonStub;
      let fetchAndFilterOuter: SinonStub;

      beforeEach(() => {
        queryDocsByTypeInner = sinon.stub();
        queryDocsByTypeOuter = sinon.stub(PgDoc, 'queryDocsByType').returns(queryDocsByTypeInner);
        getPersonTypes = sinon.stub(contactTypeUtils, 'getPersonTypes').returns(personType);
        settingsGetAll.returns(settings);
        fetchAndFilterInner = sinon.stub();
        fetchAndFilterOuter = sinon.stub(PgDoc, 'fetchAndFilter').returns(fetchAndFilterInner);
      });

      it('returns a page of people', async () => {
        const doc = { type: 'person' };
        const docs = [doc, doc, doc];
        const expectedResult = {
          cursor: '3',
          data: docs
        };
        fetchAndFilterInner.resolves(expectedResult);

        const res = await Person.v1.getPage(pgContext)(personTypeQualifier, cursor, limit);

        expect(res).to.deep.equal(expectedResult);
        expect(settingsGetAll.callCount).to.equal(1);
        expect(getPersonTypes.calledOnceWithExactly(settings)).to.be.true;
        expect(queryDocsByTypeOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(queryDocsByTypeInner.notCalled).to.be.true;
        expect(fetchAndFilterOuter.calledOnce).to.be.true;
        expect(fetchAndFilterOuter.firstCall.args[0]).to.be.a('function');
        expect(fetchAndFilterOuter.firstCall.args[1]).to.be.a('function');
        expect(fetchAndFilterOuter.firstCall.args[2]).to.be.equal(limit);
        expect(fetchAndFilterInner.calledOnceWithExactly(limit, Number(cursor))).to.be.true;
        expect(isPerson.notCalled).to.be.true;
      });

      it('returns a page of people when cursor is not null', async () => {
        const doc = { type: 'person' };
        const docs = [doc, doc, doc];
        const expectedResult = {
          cursor: '8',
          data: docs
        };
        fetchAndFilterInner.resolves(expectedResult);

        const res = await Person.v1.getPage(pgContext)(personTypeQualifier, notNullCursor, limit);

        expect(res).to.deep.equal(expectedResult);
        expect(settingsGetAll.callCount).to.equal(1);
        expect(getPersonTypes.calledOnceWithExactly(settings)).to.be.true;
        expect(queryDocsByTypeOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(queryDocsByTypeInner.notCalled).to.be.true;
        expect(fetchAndFilterOuter.firstCall.args[0]).to.be.a('function');
        expect(fetchAndFilterOuter.firstCall.args[1]).to.be.a('function');
        expect(fetchAndFilterOuter.firstCall.args[2]).to.be.equal(limit);
        expect(fetchAndFilterInner.calledOnceWithExactly(limit, Number(notNullCursor))).to.be.true;
        expect(isPerson.notCalled).to.be.true;
      });

      it('throws an error if person identifier is invalid/does not exist', async () => {
        await expect(Person.v1.getPage(pgContext)(invalidPersonTypeQualifier, cursor, limit)).to.be.rejectedWith(
          `Invalid contact type [${invalidPersonTypeQualifier.contactType}].`
        );

        expect(settingsGetAll.calledOnce).to.be.true;
        expect(getPersonTypes.calledOnceWithExactly(settings)).to.be.true;
        expect(queryDocsByTypeOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(queryDocsByTypeInner.notCalled).to.be.true;
        expect(fetchAndFilterInner.notCalled).to.be.true;
        expect(fetchAndFilterOuter.notCalled).to.be.true;
      });

      [
        {},
        '-1',
        undefined,
      ].forEach((invalidSkip) => {
        it(`throws an error if cursor is invalid: ${JSON.stringify(invalidSkip)}`, async () => {
          await expect(Person.v1.getPage(pgContext)(personTypeQualifier, invalidSkip as string, limit))
            .to.be.rejectedWith(`The cursor must be a string or null for first page: [${JSON.stringify(invalidSkip)}]`);

          expect(settingsGetAll.calledOnce).to.be.true;
          expect(getPersonTypes.calledOnceWithExactly(settings)).to.be.true;
          expect(queryDocsByTypeOuter.calledOnceWithExactly(pgContext)).to.be.true;
          expect(queryDocsByTypeInner.notCalled).to.be.true;
          expect(fetchAndFilterInner.notCalled).to.be.true;
          expect(fetchAndFilterOuter.notCalled).to.be.true;
          expect(isPerson.notCalled).to.be.true;
        });
      });

      it('returns empty array if people does not exist', async () => {
        const expectedResult = {
          data: [],
          cursor
        };
        fetchAndFilterInner.resolves(expectedResult);

        const res = await Person.v1.getPage(pgContext)(personTypeQualifier, cursor, limit);

        expect(res).to.deep.equal(expectedResult);
        expect(settingsGetAll.calledOnce).to.be.true;
        expect(getPersonTypes.calledOnceWithExactly(settings)).to.be.true;
        expect(queryDocsByTypeOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(queryDocsByTypeInner.notCalled).to.be.true;
        expect(fetchAndFilterOuter.firstCall.args[0]).to.be.a('function');
        expect(fetchAndFilterOuter.firstCall.args[1]).to.be.a('function');
        expect(fetchAndFilterOuter.firstCall.args[2]).to.be.equal(limit);
        expect(fetchAndFilterInner.calledOnceWithExactly(limit, Number(cursor))).to.be.true;
        expect(isPerson.notCalled).to.be.true;
      });
    });

    describe('create', () => {
      const parent = {
        _id: 'p1',
        _rev: '1',
        type: 'clinic'
      } as const;
      const personDoc = { hello: 'world' };

      let getDocByIdOuter: SinonStub;
      let getDocByIdInner: SinonStub;
      let createDocOuter: SinonStub;
      let createDocInner: SinonStub;
      let getTypeById: SinonStub;

      beforeEach(() => {
        getDocByIdInner = sinon.stub();
        getDocByIdOuter = sinon.stub(PgDoc, 'getDocById').returns(getDocByIdInner);
        createDocInner = sinon.stub().resolves(personDoc);
        createDocOuter = sinon.stub(PgDoc, 'createDoc').returns(createDocInner);
        settingsGetAll.returns(settings);
        getTypeById = sinon.stub(contactTypeUtils, 'getTypeById');
        isPersonType.returns(true);
      });

      it('creates a person with default person type', async () => {
        const input = {
          name: 'user-1',
          type: 'person',
          parent: parent._id,
        };
        getDocByIdInner.resolves(parent);

        const person = await Person.v1.create(pgContext)(input);

        expect(person).to.equal(personDoc);
        expect(getDocByIdOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(createDocOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(settingsGetAll.calledOnceWithExactly()).to.be.true;
        expect(getTypeById.calledOnceWithExactly(settings, input.type)).to.be.true;
        expect(isPersonType.calledOnceWithExactly({ id: input.type })).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly(input.parent)).to.be.true;
        expect(createDocInner.calledOnce).to.be.true;
        const createdDoc = createDocInner.firstCall.args[0];
        expect(createdDoc.name).to.equal(input.name);
        expect(createdDoc.type).to.equal('person');
        expect(createdDoc.parent).to.deep.equal({ _id: parent._id });
        expect(createdDoc.reported_date).to.be.a('number');
      });

      it('creates a person with custom person type', async () => {
        const customPersonType = { id: 'custom-person', person: true, parents: [parent.type] };
        const input = {
          name: 'user-1',
          type: customPersonType.id,
          parent: parent._id,
          reported_date: 123445566,
        };
        getTypeById.returns(customPersonType);
        getDocByIdInner.resolves(parent);

        const person = await Person.v1.create(pgContext)(input);

        expect(person).to.equal(personDoc);
        expect(getDocByIdOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(createDocOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(settingsGetAll.calledOnceWithExactly()).to.be.true;
        expect(getTypeById.calledOnceWithExactly(settings, input.type)).to.be.true;
        expect(isPersonType.calledOnceWithExactly(customPersonType)).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly(input.parent)).to.be.true;
        expect(createDocInner.calledOnce).to.be.true;
        const createdDoc = createDocInner.firstCall.args[0];
        expect(createdDoc.type).to.equal('contact');
        expect(createdDoc.contact_type).to.equal(customPersonType.id);
        expect(createdDoc.parent).to.deep.equal({ _id: parent._id });
        expect(createdDoc.reported_date).to.be.a('number');
      });

      [
        { id: 'not-person' },
        null
      ].forEach((typeData) => {
        it(`throws error if input type is not a person (typeData: ${JSON.stringify(typeData)})`, async () => {
          getTypeById.returns(typeData);
          isPersonType.returns(false);
          const personInput = {
            type: 'not-person',
            name: 'user-1',
            parent: 'p1'
          };

          await expect(Person.v1.create(pgContext)(personInput))
            .to.be.rejectedWith('[not-person] is not a valid person type.');

          expect(getDocByIdOuter.calledOnceWithExactly(pgContext)).to.be.true;
          expect(createDocOuter.calledOnceWithExactly(pgContext)).to.be.true;
          expect(settingsGetAll.calledOnceWithExactly()).to.be.true;
          expect(getTypeById.calledOnceWithExactly(settings, personInput.type)).to.be.true;
          expect(isPersonType.calledOnceWithExactly({ id: 'not-person' })).to.be.true;
          expect(getDocByIdInner.notCalled).to.be.true;
          expect(createDocInner.notCalled).to.be.true;
        });
      });

      it('throws error when parent doc is not found', async () => {
        const input = {
          name: 'user-1',
          type: 'person',
          parent: parent._id,
        };
        getDocByIdInner.resolves(null);

        await expect(Person.v1.create(pgContext)(input))
          .to.be.rejectedWith(`Parent contact [${input.parent}] not found.`);

        expect(getDocByIdOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(createDocOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(settingsGetAll.calledOnceWithExactly()).to.be.true;
        expect(getTypeById.calledOnceWithExactly(settings, input.type)).to.be.true;
        expect(isPersonType.calledOnceWithExactly({ id: input.type })).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly(input.parent)).to.be.true;
        expect(createDocInner.notCalled).to.be.true;
      });
    });

    describe('update', () => {
      const originalDoc = {
        _id: 'person-1',
        _rev: '1-rev',
        name: 'apoorva',
        type: 'person',
        reported_date: 12312312,
        parent: {
          _id: 'parent-1',
          parent: {
            _id: 'parent-2'
          }
        },
        hello: 'world'
      } as const;

      let getPersonInner: SinonStub;
      let getPersonOuter: SinonStub;
      let updateDocOuter: SinonStub;
      let updateDocInner: SinonStub;

      beforeEach(() => {
        getPersonInner = sinon.stub();
        getPersonOuter = sinon.stub(Person.v1, 'get').returns(getPersonInner);
        updateDocOuter = sinon.stub(PgDoc, 'updateDoc');
        updateDocInner = sinon.stub();
        updateDocOuter.returns(updateDocInner);
        settingsGetAll.returns(settings);
        isPerson.returns(true);
      });

      it('updates doc for valid update input', async () => {
        const updateDocInput = {
          ...originalDoc,
          name: 'apoorva2',
          hello: undefined,
          world: 'hello'
        };
        getPersonInner.resolves(originalDoc);
        updateDocInner.resolves({ _rev: '2' });

        const result = await Person.v1.update(pgContext)(updateDocInput);

        expect(result).to.deep.equal({ ...updateDocInput, _rev: '2' });
        expect(updateDocOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(getPersonOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(settingsGetAll.calledOnceWithExactly()).to.be.true;
        expect(getPersonInner.calledOnceWithExactly(Qualifier.byUuid(originalDoc._id))).to.be.true;
        expect(updateDocInner.calledOnceWithExactly(updateDocInput)).to.be.true;
      });

      [
        { ...originalDoc, _id: undefined },
        { ...originalDoc, _rev: undefined },
      ].forEach((updateDocInput) => {
        it('throws error if input type is not a doc', async () => {
          await expect(Person.v1.update(pgContext)(updateDocInput as unknown as Input.v1.UpdatePersonInput))
            .to.be.rejectedWith(InvalidArgumentError, 'Valid _id, _rev, and type fields must be provided.');

          expect(updateDocOuter.calledOnceWithExactly(pgContext)).to.be.true;
          expect(getPersonOuter.calledOnceWithExactly(pgContext)).to.be.true;
          expect(settingsGetAll.notCalled).to.be.true;
          expect(getPersonInner.notCalled).to.be.true;
          expect(updateDocInner.notCalled).to.be.true;
        });
      });

      it('throws error if input does not have a person type', async () => {
        isPerson.returns(false);

        await expect(Person.v1.update(pgContext)(originalDoc))
          .to.be.rejectedWith(InvalidArgumentError, 'Valid _id, _rev, and type fields must be provided.');

        expect(updateDocOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(getPersonOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(settingsGetAll.calledOnceWithExactly()).to.be.true;
        expect(getPersonInner.notCalled).to.be.true;
        expect(updateDocInner.notCalled).to.be.true;
      });

      it('throws error when no person found', async () => {
        getPersonInner.resolves(null);

        await expect(Person.v1.update(pgContext)(originalDoc))
          .to.be.rejectedWith(ResourceNotFoundError, `Person record [${originalDoc._id}] not found.`);

        expect(updateDocOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(getPersonOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(settingsGetAll.calledOnceWithExactly()).to.be.true;
        expect(getPersonInner.calledOnceWithExactly(Qualifier.byUuid(originalDoc._id))).to.be.true;
        expect(updateDocInner.notCalled).to.be.true;
      });

      ([
        ['_rev', { ...originalDoc, _rev: 'updated' }],
        ['reported_date', { ...originalDoc, reported_date: 'updated' }],
        ['type', { ...originalDoc, type: 'updated' }],
        ['contact_type', { ...originalDoc, contact_type: 'updated' }],
      ] as [string, Input.v1.UpdatePersonInput][]).forEach(([field, updateDocInput]) => {
        it(`throws error when changing immutable field [${field}]`, async () => {
          getPersonInner.resolves(originalDoc);

          await expect(Person.v1.update(pgContext)(updateDocInput))
            .to.be.rejectedWith(InvalidArgumentError, `The [${field}] fields must not be changed.`);

          expect(updateDocOuter.calledOnceWithExactly(pgContext)).to.be.true;
          expect(getPersonOuter.calledOnceWithExactly(pgContext)).to.be.true;
          expect(settingsGetAll.calledOnceWithExactly()).to.be.true;
          expect(getPersonInner.calledOnceWithExactly(Qualifier.byUuid(originalDoc._id))).to.be.true;
          expect(updateDocInner.notCalled).to.be.true;
        });
      });

      it('throws error when trying to remove name value', async () => {
        getPersonInner.resolves(originalDoc);
        const updateDocInput = { ...originalDoc, name: undefined };

        await expect(Person.v1.update(pgContext)(updateDocInput))
          .to.be.rejectedWith(InvalidArgumentError, `The [name] field must have a [string] value.`);

        expect(updateDocOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(getPersonOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(settingsGetAll.calledOnceWithExactly()).to.be.true;
        expect(getPersonInner.calledOnceWithExactly(Qualifier.byUuid(originalDoc._id))).to.be.true;
        expect(updateDocInner.notCalled).to.be.true;
      });

      [
        { name: 'new name' },
        { world: 'hello' }
      ].forEach(updated => {
        it(`updates person that does not have an existing name value (${JSON.stringify(updated)})`, async () => {
          const origDocWithoutName = {
            ...originalDoc,
            name: undefined
          };
          const updateDocInput = {
            ...origDocWithoutName,
            ...updated,
          };
          getPersonInner.resolves(origDocWithoutName);
          updateDocInner.resolves({ _rev: '2' });

          const result = await Person.v1.update(pgContext)(updateDocInput);

          expect(result).to.deep.equal({ ...updateDocInput, _rev: '2' });
          expect(updateDocOuter.calledOnceWithExactly(pgContext)).to.be.true;
          expect(getPersonOuter.calledOnceWithExactly(pgContext)).to.be.true;
          expect(settingsGetAll.calledOnceWithExactly()).to.be.true;
          expect(getPersonInner.calledOnceWithExactly(Qualifier.byUuid(originalDoc._id))).to.be.true;
          expect(updateDocInner.calledOnceWithExactly(updateDocInput)).to.be.true;
        });
      });

      it('throws error when parent lineage _id changes', async () => {
        const updateDocInput = {
          ...originalDoc,
          parent: {
            _id: 'different-parent',
            parent: {
              _id: 'parent-2'
            }
          }
        };
        getPersonInner.resolves(originalDoc);

        await expect(Person.v1.update(pgContext)(updateDocInput))
          .to.be.rejectedWith(InvalidArgumentError, 'Parent lineage does not match.');

        expect(getPersonInner.calledOnceWithExactly(Qualifier.byUuid(originalDoc._id))).to.be.true;
        expect(updateDocInner.notCalled).to.be.true;
      });

      it('throws error when parent is removed', async () => {
        const updateDocInput = {
          ...originalDoc,
          parent: undefined
        };
        getPersonInner.resolves(originalDoc);

        await expect(Person.v1.update(pgContext)(updateDocInput))
          .to.be.rejectedWith(InvalidArgumentError, 'Parent lineage does not match.');

        expect(getPersonInner.calledOnceWithExactly(Qualifier.byUuid(originalDoc._id))).to.be.true;
        expect(updateDocInner.notCalled).to.be.true;
      });

      it('throws error when grandparent lineage _id changes', async () => {
        const updateDocInput = {
          ...originalDoc,
          parent: {
            _id: 'parent-1',
            parent: {
              _id: 'different-grandparent'
            }
          }
        };
        getPersonInner.resolves(originalDoc);

        await expect(Person.v1.update(pgContext)(updateDocInput))
          .to.be.rejectedWith(InvalidArgumentError, 'Parent lineage does not match.');

        expect(getPersonInner.calledOnceWithExactly(Qualifier.byUuid(originalDoc._id))).to.be.true;
        expect(updateDocInner.notCalled).to.be.true;
      });

      it('minifies hydrated parent lineage before storing', async () => {
        const updateDocInput = {
          ...originalDoc,
          name: 'updated-name',
          parent: {
            _id: 'parent-1',
            name: 'Parent Full Name',
            type: 'clinic',
            parent: {
              _id: 'parent-2',
              name: 'Grandparent Full Name',
              type: 'district_hospital'
            }
          }
        };
        getPersonInner.resolves(originalDoc);
        updateDocInner.resolves({ _rev: '2' });

        const result = await Person.v1.update(pgContext)(updateDocInput);

        expect(result._rev).to.equal('2');
        expect(result.name).to.equal('updated-name');
        // Verify updateDoc received minified lineage, not the hydrated version
        const storedDoc = updateDocInner.firstCall.args[0];
        expect(storedDoc.parent).to.deep.equal({
          _id: 'parent-1',
          parent: { _id: 'parent-2' }
        });
      });
    });
  });
});
