import sinon, { SinonStub } from 'sinon';
import { expect } from 'chai';
import logger from '@medic/logger';
import * as Report from '../../src/postgres/report';
import * as PgDoc from '../../src/postgres/libs/doc';
import * as PgLineage from '../../src/postgres/libs/lineage';
import * as PgFreetext from '../../src/postgres/libs/freetext';
import * as PgContact from '../../src/postgres/contact';
import { PostgresDataContext, DatabasePool } from '../../src/postgres/libs/data-context';

describe('postgres report', () => {
  let ctx: PostgresDataContext;
  let poolQuery: SinonStub;
  let settingsGetAll: SinonStub;
  let warn: SinonStub;

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
  });

  afterEach(() => sinon.restore());

  describe('v1', () => {
    describe('get', () => {
      const identifier = { uuid: 'report-uuid' } as const;
      let getDocByIdOuter: SinonStub;
      let getDocByIdInner: SinonStub;

      beforeEach(() => {
        getDocByIdInner = sinon.stub();
        getDocByIdOuter = sinon.stub(PgDoc, 'getDocById').returns(getDocByIdInner);
      });

      it('returns a report when found', async () => {
        const doc = { _id: 'report-uuid', _rev: '1-abc', type: 'data_record', form: 'pregnancy' };
        getDocByIdInner.resolves(doc);

        const result = await Report.v1.get(ctx)(identifier);

        expect(result).to.deep.equal(doc);
        expect(getDocByIdOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(warn.notCalled).to.be.true;
      });

      it('returns null when document is not found', async () => {
        getDocByIdInner.resolves(null);

        const result = await Report.v1.get(ctx)(identifier);

        expect(result).to.be.null;
        expect(getDocByIdOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(warn.calledOnceWithExactly(`Document [${identifier.uuid}] is not a valid report.`)).to.be.true;
      });

      it('returns null when document is not a report (wrong type)', async () => {
        const doc = { _id: 'report-uuid', _rev: '1-abc', type: 'person' };
        getDocByIdInner.resolves(doc);

        const result = await Report.v1.get(ctx)(identifier);

        expect(result).to.be.null;
        expect(getDocByIdOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(warn.calledOnceWithExactly(`Document [${identifier.uuid}] is not a valid report.`)).to.be.true;
      });

      it('returns null when document is data_record but has no form', async () => {
        const doc = { _id: 'report-uuid', _rev: '1-abc', type: 'data_record' };
        getDocByIdInner.resolves(doc);

        const result = await Report.v1.get(ctx)(identifier);

        expect(result).to.be.null;
        expect(getDocByIdOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(warn.calledOnceWithExactly(`Document [${identifier.uuid}] is not a valid report.`)).to.be.true;
      });
    });

    describe('getWithLineage', () => {
      const identifier = { uuid: 'report-uuid' } as const;
      let fetchHydratedDocOuter: SinonStub;
      let fetchHydratedDocInner: SinonStub;

      beforeEach(() => {
        fetchHydratedDocInner = sinon.stub();
        fetchHydratedDocOuter = sinon.stub(PgLineage, 'fetchHydratedDoc').returns(fetchHydratedDocInner);
      });

      it('returns a report with lineage when found', async () => {
        const report = {
          _id: 'report-uuid',
          _rev: '1-abc',
          type: 'data_record',
          form: 'pregnancy',
          contact: { _id: 'contact-1', parent: { _id: 'parent-1' } }
        };
        fetchHydratedDocInner.resolves(report);

        const result = await Report.v1.getWithLineage(ctx)(identifier);

        expect(result).to.deep.equal(report);
        expect(fetchHydratedDocOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(fetchHydratedDocInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(warn.notCalled).to.be.true;
      });

      it('returns null when document is not found', async () => {
        fetchHydratedDocInner.resolves(null);

        const result = await Report.v1.getWithLineage(ctx)(identifier);

        expect(result).to.be.null;
        expect(fetchHydratedDocOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(fetchHydratedDocInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(warn.calledOnceWithExactly(`Document [${identifier.uuid}] is not a valid report.`)).to.be.true;
      });

      it('returns null when document is not a report', async () => {
        const doc = { _id: 'report-uuid', _rev: '1-abc', type: 'person' };
        fetchHydratedDocInner.resolves(doc);

        const result = await Report.v1.getWithLineage(ctx)(identifier);

        expect(result).to.be.null;
        expect(fetchHydratedDocOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(fetchHydratedDocInner.calledOnceWithExactly(identifier.uuid)).to.be.true;
        expect(warn.calledOnceWithExactly(`Document [${identifier.uuid}] is not a valid report.`)).to.be.true;
      });
    });

    describe('getUuidsPage', () => {
      let queryByFreetextOuter: SinonStub;
      let queryByFreetextInner: SinonStub;

      beforeEach(() => {
        queryByFreetextInner = sinon.stub();
        queryByFreetextOuter = sinon.stub(PgFreetext, 'queryByFreetext').returns(queryByFreetextInner);
      });

      it('returns a page of report UUIDs for a freetext qualifier', async () => {
        const qualifier = { freetext: 'pregnancy' };
        const expectedPage = { data: ['uuid-1', 'uuid-2'], cursor: '2' };
        queryByFreetextInner.resolves(expectedPage);

        const result = await Report.v1.getUuidsPage(ctx)(qualifier, null, 2);

        expect(result).to.deep.equal(expectedPage);
        expect(queryByFreetextOuter.calledOnceWithExactly(ctx, 'reports')).to.be.true;
        expect(queryByFreetextInner.calledOnce).to.be.true;
        expect(queryByFreetextInner.firstCall.args[0]).to.deep.equal({ freetext: 'pregnancy' });
        expect(queryByFreetextInner.firstCall.args[1]).to.equal(null);
        expect(queryByFreetextInner.firstCall.args[2]).to.equal(2);
      });

      it('normalizes freetext to trimmed lowercase', async () => {
        const qualifier = { freetext: '  PREGNANCY  ' };
        const expectedPage = { data: ['uuid-1'], cursor: null };
        queryByFreetextInner.resolves(expectedPage);

        const result = await Report.v1.getUuidsPage(ctx)(qualifier, null, 10);

        expect(result).to.deep.equal(expectedPage);
        expect(queryByFreetextInner.firstCall.args[0]).to.deep.equal({ freetext: 'pregnancy' });
      });

      it('passes cursor through to freetext query', async () => {
        const qualifier = { freetext: 'visit' };
        const expectedPage = { data: ['uuid-3'], cursor: null };
        queryByFreetextInner.resolves(expectedPage);

        const result = await Report.v1.getUuidsPage(ctx)(qualifier, '5', 10);

        expect(result).to.deep.equal(expectedPage);
        expect(queryByFreetextInner.firstCall.args[1]).to.equal('5');
        expect(queryByFreetextInner.firstCall.args[2]).to.equal(10);
      });
    });

    describe('create', () => {
      const contactDoc = {
        _id: 'contact-1',
        _rev: '1-abc',
        type: 'person',
        parent: { _id: 'parent-1' }
      } as const;
      const supportedForms = ['pregnancy', 'home_visit'];
      const reportDoc = { _id: 'new-report', _rev: '1-pgabc', type: 'data_record', form: 'pregnancy' };

      let createDocOuter: SinonStub;
      let createDocInner: SinonStub;
      let getDocByIdOuter: SinonStub;
      let getDocByIdInner: SinonStub;
      let getDocIdsByIdRangeOuter: SinonStub;
      let getDocIdsByIdRangeInner: SinonStub;
      let isContact: SinonStub;

      beforeEach(() => {
        createDocInner = sinon.stub().resolves(reportDoc);
        createDocOuter = sinon.stub(PgDoc, 'createDoc').returns(createDocInner);
        getDocByIdInner = sinon.stub().resolves(contactDoc);
        getDocByIdOuter = sinon.stub(PgDoc, 'getDocById').returns(getDocByIdInner);
        getDocIdsByIdRangeInner = sinon.stub().resolves(supportedForms.map(f => `form:${f}`));
        getDocIdsByIdRangeOuter = sinon.stub(PgDoc, 'getDocIdsByIdRange').returns(getDocIdsByIdRangeInner);
        isContact = sinon.stub(PgContact.v1, 'isContact').returns(true);
      });

      it('creates a report with valid input', async () => {
        const input = {
          form: 'pregnancy',
          contact: 'contact-1',
        };

        const result = await Report.v1.create(ctx)(input);

        expect(result).to.equal(reportDoc);
        expect(createDocOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(getDocByIdOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(getDocIdsByIdRangeOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(getDocIdsByIdRangeInner.calledOnceWithExactly('form:', 'form:\ufff0')).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly('contact-1')).to.be.true;
        expect(isContact.calledOnceWithExactly(ctx.settings, contactDoc)).to.be.true;
        expect(createDocInner.calledOnce).to.be.true;
        const createdDoc = createDocInner.firstCall.args[0];
        expect(createdDoc.form).to.equal('pregnancy');
        expect(createdDoc.contact).to.deep.equal({ _id: 'contact-1' });
        expect(createdDoc.type).to.equal('data_record');
        expect(createdDoc.reported_date).to.be.a('number');
      });

      it('throws an error when the form is not supported', async () => {
        const input = {
          form: 'unsupported-form',
          contact: 'contact-1',
        };

        await expect(Report.v1.create(ctx)(input))
          .to.be.rejectedWith(`Invalid form value [${input.form}].`);

        expect(getDocIdsByIdRangeInner.calledOnceWithExactly('form:', 'form:\ufff0')).to.be.true;
        expect(getDocByIdInner.notCalled).to.be.true;
        expect(isContact.notCalled).to.be.true;
        expect(createDocInner.notCalled).to.be.true;
      });

      it('throws an error when the contact is not found', async () => {
        const input = {
          form: 'pregnancy',
          contact: 'missing-contact',
        };
        getDocByIdInner.resolves(null);
        isContact.returns(false);

        await expect(Report.v1.create(ctx)(input))
          .to.be.rejectedWith(`Contact [${input.contact}] not found.`);

        expect(getDocIdsByIdRangeInner.calledOnceWithExactly('form:', 'form:\ufff0')).to.be.true;
        expect(getDocByIdInner.calledOnceWithExactly('missing-contact')).to.be.true;
        expect(isContact.calledOnceWithExactly(ctx.settings, null)).to.be.true;
        expect(createDocInner.notCalled).to.be.true;
      });

      it('throws an error when the contact is not a valid contact type', async () => {
        const input = {
          form: 'pregnancy',
          contact: 'contact-1',
        };
        const nonContactDoc = { _id: 'contact-1', _rev: '1-abc', type: 'data_record' };
        getDocByIdInner.resolves(nonContactDoc);
        isContact.returns(false);

        await expect(Report.v1.create(ctx)(input))
          .to.be.rejectedWith(`Contact [${input.contact}] not found.`);

        expect(getDocByIdInner.calledOnceWithExactly('contact-1')).to.be.true;
        expect(isContact.calledOnceWithExactly(ctx.settings, nonContactDoc)).to.be.true;
        expect(createDocInner.notCalled).to.be.true;
      });
    });

    describe('update', () => {
      const originalReport = {
        _id: 'report-1',
        _rev: '1-rev',
        type: 'data_record',
        form: 'pregnancy',
        reported_date: 12312312,
        contact: { _id: 'contact-1' },
        fields: { hello: 'world' }
      } as const;
      const supportedForms = ['pregnancy', 'home_visit', 'new-form'];

      let getDocsByIdsOuter: SinonStub;
      let getDocsByIdsInner: SinonStub;
      let updateDocOuter: SinonStub;
      let updateDocInner: SinonStub;
      let getDocIdsByIdRangeOuter: SinonStub;
      let getDocIdsByIdRangeInner: SinonStub;

      beforeEach(() => {
        getDocsByIdsInner = sinon.stub().resolves([originalReport]);
        getDocsByIdsOuter = sinon.stub(PgDoc, 'getDocsByIds').returns(getDocsByIdsInner);
        updateDocInner = sinon.stub().resolves({ _rev: '2-pgxyz' });
        updateDocOuter = sinon.stub(PgDoc, 'updateDoc').returns(updateDocInner);
        getDocIdsByIdRangeInner = sinon.stub().resolves(supportedForms.map(f => `form:${f}`));
        getDocIdsByIdRangeOuter = sinon.stub(PgDoc, 'getDocIdsByIdRange').returns(getDocIdsByIdRangeInner);
      });

      it('updates a report with valid input', async () => {
        const updateInput = {
          ...originalReport,
          fields: { hello: 'updated' }
        };

        const result = await Report.v1.update(ctx)(updateInput);

        expect(result).to.deep.equal({ ...updateInput, _rev: '2-pgxyz' });
        expect(getDocsByIdsOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(updateDocOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(getDocIdsByIdRangeOuter.calledOnceWithExactly(ctx)).to.be.true;
        expect(getDocsByIdsInner.calledOnceWithExactly([updateInput._id])).to.be.true;
        expect(getDocIdsByIdRangeInner.notCalled).to.be.true;
        expect(updateDocInner.calledOnce).to.be.true;
      });

      it('throws an error when the original report is not found', async () => {
        getDocsByIdsInner.resolves([null]);
        const updateInput = { ...originalReport, fields: { hello: 'updated' } };

        await expect(Report.v1.update(ctx)(updateInput))
          .to.be.rejectedWith(`Report record [${updateInput._id}] not found.`);

        expect(getDocsByIdsInner.calledOnceWithExactly([updateInput._id])).to.be.true;
        expect(updateDocInner.notCalled).to.be.true;
      });

      it('throws an error when a readonly field (_rev) is changed', async () => {
        const updateInput = {
          ...originalReport,
          _rev: 'changed-rev',
        };

        await expect(Report.v1.update(ctx)(updateInput))
          .to.be.rejectedWith('The [_rev] fields must not be changed.');

        expect(getDocsByIdsInner.calledOnceWithExactly([updateInput._id])).to.be.true;
        expect(updateDocInner.notCalled).to.be.true;
      });

      it('throws an error when a readonly field (reported_date) is changed', async () => {
        const updateInput = {
          ...originalReport,
          reported_date: 999999999,
        };

        await expect(Report.v1.update(ctx)(updateInput))
          .to.be.rejectedWith('The [reported_date] fields must not be changed.');

        expect(getDocsByIdsInner.calledOnceWithExactly([updateInput._id])).to.be.true;
        expect(updateDocInner.notCalled).to.be.true;
      });

      it('throws an error when input is not a valid report', async () => {
        const updateInput = {
          _id: 'report-1',
          _rev: '1-rev',
          type: 'not-data-record',
          form: 'pregnancy',
        };

        await expect(Report.v1.update(ctx)(updateInput as never))
          .to.be.rejectedWith('Valid _id, _rev, form, and type fields must be provided.');

        expect(getDocsByIdsInner.notCalled).to.be.true;
        expect(updateDocInner.notCalled).to.be.true;
      });

      it('validates form when form is changed to a new value', async () => {
        const updateInput = {
          ...originalReport,
          form: 'new-form',
        };
        updateDocInner.resolves({ _rev: '2-pgxyz' });

        const result = await Report.v1.update(ctx)(updateInput);

        expect(result).to.deep.equal({ ...updateInput, _rev: '2-pgxyz' });
        expect(getDocIdsByIdRangeInner.calledOnceWithExactly('form:', 'form:\ufff0')).to.be.true;
        expect(updateDocInner.calledOnce).to.be.true;
      });

      it('throws an error when form is changed to an invalid form', async () => {
        const updateInput = {
          ...originalReport,
          form: 'invalid-form',
        };

        await expect(Report.v1.update(ctx)(updateInput))
          .to.be.rejectedWith(`Invalid form value [${updateInput.form}].`);

        expect(getDocIdsByIdRangeInner.calledOnceWithExactly('form:', 'form:\ufff0')).to.be.true;
        expect(updateDocInner.notCalled).to.be.true;
      });

      it('minifies hydrated lineage and removes patient/place before storing', async () => {
        const updateInput = {
          ...originalReport,
          fields: { hello: 'updated' },
          contact: {
            _id: 'contact-1',
            name: 'Full Contact Name',
            type: 'person',
            parent: {
              _id: 'clinic-1',
              name: 'Full Clinic Name',
              parent: { _id: 'district-1', name: 'Full District' }
            }
          },
          patient: {
            _id: 'patient-1',
            name: 'Patient Bob',
            parent: { _id: 'clinic-1', name: 'Clinic' }
          },
          place: {
            _id: 'place-1',
            name: 'Health Center',
            parent: { _id: 'district-1' }
          }
        };

        const result = await Report.v1.update(ctx)(updateInput);

        expect(result._rev).to.equal('2-pgxyz');
        const storedDoc = updateDocInner.firstCall.args[0];
        // contact should be minified
        expect(storedDoc.contact).to.deep.equal({
          _id: 'contact-1',
          parent: { _id: 'clinic-1', parent: { _id: 'district-1' } }
        });
        // patient and place should be removed from stored doc
        expect(storedDoc).to.not.have.property('patient');
        expect(storedDoc).to.not.have.property('place');
      });
    });
  });
});
