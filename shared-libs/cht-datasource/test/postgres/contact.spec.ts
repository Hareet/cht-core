import sinon, { SinonStub } from 'sinon';
import { Doc } from '../../src/libs/doc';
import logger from '@medic/logger';
import contactTypeUtils from '@medic/contact-types-utils';
import * as PgDoc from '../../src/postgres/libs/doc';
import * as PgLineage from '../../src/postgres/libs/lineage';
import * as PgFreetext from '../../src/postgres/libs/freetext';
import * as Contact from '../../src/postgres/contact';
import { expect } from 'chai';
import { PostgresDataContext, DatabasePool } from '../../src/postgres/libs/data-context';
import * as Qualifier from '../../src/qualifier';
import { InvalidArgumentError } from '../../src';

describe('postgres contact', () => {
  let pgContext: PostgresDataContext;
  let settingsGetAll: SinonStub;
  let warn: SinonStub;
  let isContact: SinonStub;

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
    isContact = sinon.stub(contactTypeUtils, 'isContact');
  });

  afterEach(() => sinon.restore());

  describe('v1', () => {
    const settings = { hello: 'world' } as const;

    beforeEach(() => {
      settingsGetAll.returns(settings);
    });

    describe('isContact', () => {
      it('returns true for valid contact', () => {
        const doc = { _id: 'contact-id', _rev: 'rev' };
        isContact.returns(true);

        const result = Contact.v1.isContact(pgContext.settings, doc);

        expect(result).to.be.true;
        expect(isContact.calledOnceWithExactly(settings, doc)).to.be.true;
        expect(settingsGetAll.calledOnceWithExactly()).to.be.true;
      });

      it('returns false for docs with an invalid type', () => {
        const doc = { _id: 'contact-id', _rev: 'rev' };
        isContact.returns(false);

        const result = Contact.v1.isContact(pgContext.settings, doc);

        expect(result).to.be.false;
        expect(isContact.calledOnceWithExactly(settings, doc)).to.be.true;
        expect(settingsGetAll.calledOnceWithExactly()).to.be.true;
      });

      ([
        null,
        'contact-id',
        { _id: 'contact-id' },
        { _rev: 'rev' }
      ] as unknown as Doc[]).forEach((doc) => {
        it(`returns false for invalid doc [${JSON.stringify(doc)}]`, () => {
          const result = Contact.v1.isContact(pgContext.settings, doc);

          expect(result).to.be.false;
          expect(isContact.notCalled).to.be.true;
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

      it('returns a contact by UUID', async () => {
        const doc = { type: 'person', _id: 'uuid', _rev: '1' };
        getDocByIdInner.resolves(doc);
        isContact.returns(true);

        const result = await Contact.v1.get(pgContext)(identifier);

        expect(result).to.equal(doc);
        expect(getDocByIdOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(isContact.calledOnceWithExactly(settings, doc)).to.be.true;
        expect(warn.notCalled).to.be.true;
      });

      it('returns null if the identified doc does not have a contact type', async () => {
        const doc = { type: 'not-contact', _id: '_id', _rev: '1' };
        getDocByIdInner.resolves(doc);
        isContact.returns(false);

        const result = await Contact.v1.get(pgContext)(identifier);

        expect(result).to.be.null;
        expect(getDocByIdOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(isContact.calledOnceWithExactly(settings, doc)).to.be.true;
        expect(warn.calledOnceWithExactly(`Document [${identifier.uuid}] is not a valid contact.`)).to.be.true;
      });

      it('returns null if the identified doc is not found', async () => {
        getDocByIdInner.resolves(null);

        const result = await Contact.v1.get(pgContext)(identifier);

        expect(result).to.be.null;
        expect(getDocByIdOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(settingsGetAll.notCalled).to.be.true;
        expect(isContact.notCalled).to.be.true;
        expect(warn.calledOnceWithExactly(`Document [${identifier.uuid}] is not a valid contact.`)).to.be.true;
      });

      it('propagates error if getDocById throws an error', async () => {
        const err = new Error('connection failed');
        getDocByIdInner.rejects(err);

        await expect(Contact.v1.get(pgContext)(identifier)).to.be.rejectedWith('connection failed');

        expect(getDocByIdOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(settingsGetAll.notCalled).to.be.true;
        expect(warn.notCalled).to.be.true;
      });
    });

    describe('getWithLineage', () => {
      const identifier = { uuid: 'uuid' } as const;
      let fetchHydratedDocOuter: SinonStub;
      let fetchHydratedDocInner: SinonStub;

      beforeEach(() => {
        fetchHydratedDocInner = sinon.stub();
        fetchHydratedDocOuter = sinon.stub(PgLineage, 'fetchHydratedDoc').returns(fetchHydratedDocInner);
      });

      it('returns a contact with lineage for person type contact', async () => {
        const contact = { type: 'person', _id: 'uuid', _rev: 'rev' };
        fetchHydratedDocInner.resolves(contact);
        isContact.returns(true);

        const result = await Contact.v1.getWithLineage(pgContext)(identifier);

        expect(result).to.equal(contact);
        expect(fetchHydratedDocOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(fetchHydratedDocInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(isContact.calledOnceWithExactly(settings, contact)).to.be.true;
        expect(warn.notCalled).to.be.true;
      });

      it('returns a contact with lineage for place type contact', async () => {
        const placeContact = {
          type: 'place', _id: 'place0', _rev: 'rev',
          contact: { _id: 'contact0', _rev: 'rev' }
        };
        fetchHydratedDocInner.resolves(placeContact);
        isContact.returns(true);

        const result = await Contact.v1.getWithLineage(pgContext)(identifier);

        expect(result).to.equal(placeContact);
        expect(fetchHydratedDocOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(fetchHydratedDocInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(isContact.calledOnceWithExactly(settings, placeContact)).to.be.true;
        expect(warn.notCalled).to.be.true;
      });

      it('returns null when no contact is found', async () => {
        fetchHydratedDocInner.resolves(null);

        const result = await Contact.v1.getWithLineage(pgContext)(identifier);

        expect(result).to.be.null;
        expect(fetchHydratedDocOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(fetchHydratedDocInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(isContact.notCalled).to.be.true;
        expect(warn.calledOnceWithExactly(`Document [${identifier.uuid}] is not a valid contact.`)).to.be.true;
      });

      it('returns null if the doc returned is not a contact', async () => {
        const notContact = { type: 'not-person', _id: 'uuid', _rev: 'rev' };
        fetchHydratedDocInner.resolves(notContact);
        isContact.returns(false);

        const result = await Contact.v1.getWithLineage(pgContext)(identifier);

        expect(result).to.be.null;
        expect(fetchHydratedDocOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(fetchHydratedDocInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(isContact.calledOnceWithExactly(settings, notContact)).to.be.true;
        expect(warn.calledOnceWithExactly(`Document [${identifier.uuid}] is not a valid contact.`)).to.be.true;
      });

      it('propagates error if fetchHydratedDoc throws an error', async () => {
        const err = new Error('lineage error');
        fetchHydratedDocInner.rejects(err);

        await expect(Contact.v1.getWithLineage(pgContext)(identifier)).to.be.rejectedWith('lineage error');

        expect(fetchHydratedDocOuter.calledOnceWithExactly(pgContext)).to.be.true;
        expect(fetchHydratedDocInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(warn.notCalled).to.be.true;
      });
    });

    describe('getUuidsPage', () => {
      const limit = 3;
      const contactType = 'person';
      const expectedResult = { cursor: '3', data: ['1', '2', '3'] };
      let queryDocIdsByTypeInner: SinonStub;
      let queryDocIdsByTypeOuter: SinonStub;
      let fetchAndFilterIdsInner: SinonStub;
      let fetchAndFilterIdsOuter: SinonStub;
      let queryByFreetextInner: SinonStub;
      let queryByFreetextOuter: SinonStub;
      let getContactTypeIds: SinonStub;

      beforeEach(() => {
        getContactTypeIds = sinon.stub(contactTypeUtils, 'getContactTypeIds').returns([contactType]);

        queryDocIdsByTypeInner = sinon.stub();
        queryDocIdsByTypeOuter = sinon.stub(PgDoc, 'queryDocIdsByType').returns(queryDocIdsByTypeInner);

        fetchAndFilterIdsInner = sinon.stub();
        fetchAndFilterIdsOuter = sinon.stub(PgDoc, 'fetchAndFilterIds').returns(fetchAndFilterIdsInner);

        queryByFreetextInner = sinon.stub();
        queryByFreetextOuter = sinon.stub(PgFreetext, 'queryByFreetext').returns(queryByFreetextInner);
      });

      describe('contact type qualifier', () => {
        beforeEach(() => {
          fetchAndFilterIdsInner.resolves(expectedResult);
        });

        ([
          [null, 0],
          ['1', 1]
        ] as [string | null, number][]).forEach(([cursor, skip]) => {
          it(`returns page of UUIDs for valid contact type with cursor [${cursor}]`, async () => {
            const qualifier = Qualifier.byContactType(contactType);

            const res = await Contact.v1.getUuidsPage(pgContext)(qualifier, cursor, limit);

            expect(res).to.deep.equal(expectedResult);
            expect(getContactTypeIds.calledOnceWithExactly(settings)).to.be.true;
            expect(queryByFreetextInner.notCalled).to.be.true;
            expect(fetchAndFilterIdsOuter.calledOnce).to.be.true;
            expect(fetchAndFilterIdsOuter.args[0][1]).to.equal(limit);
            expect(fetchAndFilterIdsInner.calledOnceWithExactly(limit, skip)).to.be.true;
            // Verify the page function calls queryDocIdsByType with the contact type
            const pageFn = fetchAndFilterIdsOuter.firstCall.args[0] as (l: number, s: number) => unknown;
            pageFn(limit, skip);

            expect(queryDocIdsByTypeInner.calledWithExactly(contactType, limit, skip)).to.be.true;
          });
        });

        it('throws for invalid contact type', async () => {
          getContactTypeIds.returns(['not-person']);
          const qualifier = Qualifier.byContactType(contactType);

          await expect(Contact.v1.getUuidsPage(pgContext)(qualifier, null, limit))
            .to.be.rejectedWith(InvalidArgumentError, `Invalid contact type [${contactType}].`);

          expect(getContactTypeIds.calledOnceWithExactly(settings)).to.be.true;
          expect(queryByFreetextInner.notCalled).to.be.true;
          expect(fetchAndFilterIdsOuter.notCalled).to.be.true;
          expect(fetchAndFilterIdsInner.notCalled).to.be.true;
        });

        it('throws for invalid cursor', async () => {
          const qualifier = Qualifier.byContactType(contactType);
          const cursor = 'not a number';

          await expect(Contact.v1.getUuidsPage(pgContext)(qualifier, cursor, limit))
            .to.be.rejectedWith(
              InvalidArgumentError,
              `The cursor must be a string or null for first page: [${JSON.stringify(cursor)}]`
            );

          expect(getContactTypeIds.calledOnceWithExactly(settings)).to.be.true;
          expect(fetchAndFilterIdsOuter.notCalled).to.be.true;
          expect(fetchAndFilterIdsInner.notCalled).to.be.true;
        });

        it('throws for negative cursor', async () => {
          const qualifier = Qualifier.byContactType(contactType);
          const cursor = '-1';

          await expect(Contact.v1.getUuidsPage(pgContext)(qualifier, cursor, limit))
            .to.be.rejectedWith(
              InvalidArgumentError,
              `The cursor must be a string or null for first page: [${JSON.stringify(cursor)}]`
            );
        });

        it('throws for non-integer cursor', async () => {
          const qualifier = Qualifier.byContactType(contactType);
          const cursor = '1.5';

          await expect(Contact.v1.getUuidsPage(pgContext)(qualifier, cursor, limit))
            .to.be.rejectedWith(
              InvalidArgumentError,
              `The cursor must be a string or null for first page: [${JSON.stringify(cursor)}]`
            );
        });
      });

      describe('freetext qualifier', () => {
        it('delegates to queryByFreetext for freetext search', async () => {
          const freetext = 'key:value';
          const qualifier = Qualifier.byFreetext(freetext);
          queryByFreetextInner.resolves(expectedResult);

          const res = await Contact.v1.getUuidsPage(pgContext)(qualifier, null, limit);

          expect(res).to.deep.equal(expectedResult);
          expect(getContactTypeIds.notCalled).to.be.true;
          expect(fetchAndFilterIdsOuter.notCalled).to.be.true;
          expect(fetchAndFilterIdsInner.notCalled).to.be.true;
          expect(queryByFreetextOuter.calledOnceWithExactly(pgContext, 'contacts')).to.be.true;
          expect(queryByFreetextInner.calledOnce).to.be.true;
          const callArgs = queryByFreetextInner.firstCall.args;
          expect(callArgs[0].freetext).to.equal('key:value');
          expect(callArgs[1]).to.be.null;
          expect(callArgs[2]).to.equal(limit);
        });

        it('normalizes freetext qualifier before querying', async () => {
          const freetext = '  HAS:DELIMITER  ';
          const qualifier = Qualifier.byFreetext(freetext);
          queryByFreetextInner.resolves(expectedResult);

          const res = await Contact.v1.getUuidsPage(pgContext)(qualifier, null, limit);

          expect(res).to.deep.equal(expectedResult);
          expect(queryByFreetextInner.calledOnce).to.be.true;
          const callArgs = queryByFreetextInner.firstCall.args;
          expect(callArgs[0].freetext).to.equal('has:delimiter');
        });

        it('passes cursor through to freetext query', async () => {
          const freetext = 'key:value';
          const qualifier = Qualifier.byFreetext(freetext);
          const cursor = '10';
          queryByFreetextInner.resolves(expectedResult);

          await Contact.v1.getUuidsPage(pgContext)(qualifier, cursor, limit);

          const callArgs = queryByFreetextInner.firstCall.args;
          expect(callArgs[1]).to.equal(cursor);
          expect(callArgs[2]).to.equal(limit);
        });

        it('delegates to queryByFreetext for unkeyed freetext search', async () => {
          const freetext = 'searchterm';
          const qualifier = Qualifier.byFreetext(freetext);
          queryByFreetextInner.resolves(expectedResult);

          const res = await Contact.v1.getUuidsPage(pgContext)(qualifier, null, limit);

          expect(res).to.deep.equal(expectedResult);
          expect(queryByFreetextInner.calledOnce).to.be.true;
          const callArgs = queryByFreetextInner.firstCall.args;
          expect(callArgs[0].freetext).to.equal('searchterm');
        });

        it('validates contact type when combined with freetext qualifier', async () => {
          getContactTypeIds.returns(['not-person']);
          const qualifier = Qualifier.and(
            Qualifier.byContactType(contactType),
            Qualifier.byFreetext('key:value')
          );

          await expect(Contact.v1.getUuidsPage(pgContext)(qualifier, null, limit))
            .to.be.rejectedWith(InvalidArgumentError, `Invalid contact type [${contactType}].`);

          expect(getContactTypeIds.calledOnceWithExactly(settings)).to.be.true;
          expect(queryByFreetextInner.notCalled).to.be.true;
          expect(fetchAndFilterIdsOuter.notCalled).to.be.true;
        });

        it('delegates combined contact type and freetext to queryByFreetext', async () => {
          const qualifier = Qualifier.and(
            Qualifier.byContactType(contactType),
            Qualifier.byFreetext('key:value')
          );
          queryByFreetextInner.resolves(expectedResult);

          const res = await Contact.v1.getUuidsPage(pgContext)(qualifier, null, limit);

          expect(res).to.deep.equal(expectedResult);
          expect(getContactTypeIds.calledOnceWithExactly(settings)).to.be.true;
          expect(queryByFreetextInner.calledOnce).to.be.true;
          const callArgs = queryByFreetextInner.firstCall.args;
          expect(callArgs[0].freetext).to.equal('key:value');
          expect(callArgs[0].contactType).to.equal(contactType);
        });
      });
    });
  });
});
