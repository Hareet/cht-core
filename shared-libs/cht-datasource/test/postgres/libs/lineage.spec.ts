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
  getPatientId,
  getPlaceId,
  hydrateReportSubjects,
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

  describe('getPatientId', () => {
    it('extracts patient_id from fields', () => {
      const doc = { _id: 'r1', _rev: '1', type: 'data_record', fields: { patient_id: 'PAT-001' } } as Doc;
      expect(getPatientId(doc)).to.equal('PAT-001');
    });

    it('extracts patient_uuid from fields', () => {
      const doc = { _id: 'r1', _rev: '1', type: 'data_record', fields: { patient_uuid: 'uuid-123' } } as Doc;
      expect(getPatientId(doc)).to.equal('uuid-123');
    });

    it('prefers patient_id over patient_uuid in fields', () => {
      const doc = {
        _id: 'r1', _rev: '1', type: 'data_record',
        fields: { patient_id: 'PAT-001', patient_uuid: 'uuid-123' }
      } as Doc;
      expect(getPatientId(doc)).to.equal('PAT-001');
    });

    it('falls back to top-level patient_id', () => {
      const doc = { _id: 'r1', _rev: '1', type: 'data_record', patient_id: 'PAT-TOP' } as Doc;
      expect(getPatientId(doc)).to.equal('PAT-TOP');
    });

    it('returns null when no patient_id exists', () => {
      const doc = { _id: 'r1', _rev: '1', type: 'data_record', fields: { some_field: 'val' } } as Doc;
      expect(getPatientId(doc)).to.be.null;
    });

    it('returns null for empty string patient_id', () => {
      const doc = { _id: 'r1', _rev: '1', type: 'data_record', fields: { patient_id: '' } } as Doc;
      expect(getPatientId(doc)).to.be.null;
    });

    it('returns null when fields is absent', () => {
      const doc = { _id: 'r1', _rev: '1', type: 'data_record' } as Doc;
      expect(getPatientId(doc)).to.be.null;
    });
  });

  describe('getPlaceId', () => {
    it('extracts place_id from fields', () => {
      const doc = { _id: 'r1', _rev: '1', type: 'data_record', fields: { place_id: 'PLACE-001' } } as Doc;
      expect(getPlaceId(doc)).to.equal('PLACE-001');
    });

    it('falls back to top-level place_id', () => {
      const doc = { _id: 'r1', _rev: '1', type: 'data_record', place_id: 'PLACE-TOP' } as Doc;
      expect(getPlaceId(doc)).to.equal('PLACE-TOP');
    });

    it('returns null when no place_id exists', () => {
      const doc = { _id: 'r1', _rev: '1', type: 'data_record', fields: {} } as Doc;
      expect(getPlaceId(doc)).to.be.null;
    });

    it('returns null for empty string place_id', () => {
      const doc = { _id: 'r1', _rev: '1', type: 'data_record', fields: { place_id: '' } } as Doc;
      expect(getPlaceId(doc)).to.be.null;
    });
  });

  describe('hydrateReportSubjects', () => {
    it('returns non-report docs unchanged', async () => {
      const doc = { _id: 'c1', _rev: '1', type: 'person', name: 'Alice' } as Doc;

      const result = await hydrateReportSubjects(ctx)(doc);

      expect(result).to.deep.equal(doc);
      expect(poolQuery.notCalled).to.be.true;
    });

    it('returns report unchanged when no patient_id or place_id', async () => {
      const doc = {
        _id: 'r1', _rev: '1', type: 'data_record', form: 'pregnancy',
        fields: { some_field: 'value' }
      } as Doc;

      const result = await hydrateReportSubjects(ctx)(doc);

      expect(result).to.deep.equal(doc);
      expect(poolQuery.notCalled).to.be.true;
    });

    it('resolves patient_id shortcode and attaches hydrated patient', async () => {
      const report = {
        _id: 'r1', _rev: '1', type: 'data_record', form: 'pregnancy',
        fields: { patient_id: 'PAT-001' }
      } as Doc;
      const patientDoc = { _id: 'patient-uuid', _rev: '1', type: 'person', name: 'Bob' };

      sinon.stub(require('../../../src/libs/doc'), 'isDoc').returns(true);
      // Call 1: resolveShortcode for patient_id
      poolQuery.onCall(0).resolves({ rows: [{ _id: 'patient-uuid' }], rowCount: 1 });
      // Call 2: getLineageDocsById for patient (no parents)
      poolQuery.onCall(1).resolves({ rows: [{ doc: patientDoc, depth: 0 }], rowCount: 1 });

      const result = await hydrateReportSubjects(ctx)(report);

      expect((result as Record<string, unknown>).patient).to.deep.equal(patientDoc);
      expect((result as Record<string, unknown>).place).to.be.undefined;
    });

    it('resolves place_id shortcode and attaches hydrated place', async () => {
      const report = {
        _id: 'r1', _rev: '1', type: 'data_record', form: 'visit',
        fields: { place_id: 'PLACE-001' }
      } as Doc;
      const placeDoc = { _id: 'place-uuid', _rev: '1', type: 'clinic', name: 'Health Center' };

      sinon.stub(require('../../../src/libs/doc'), 'isDoc').returns(true);
      // Call 1: resolveShortcode for place_id
      poolQuery.onCall(0).resolves({ rows: [{ _id: 'place-uuid' }], rowCount: 1 });
      // Call 2: getLineageDocsById for place (no parents)
      poolQuery.onCall(1).resolves({ rows: [{ doc: placeDoc, depth: 0 }], rowCount: 1 });

      const result = await hydrateReportSubjects(ctx)(report);

      expect((result as Record<string, unknown>).place).to.deep.equal(placeDoc);
      expect((result as Record<string, unknown>).patient).to.be.undefined;
    });

    it('resolves both patient_id and place_id', async () => {
      const report = {
        _id: 'r1', _rev: '1', type: 'data_record', form: 'visit',
        fields: { patient_id: 'PAT-001', place_id: 'PLACE-001' }
      } as Doc;
      const patientDoc = { _id: 'patient-uuid', _rev: '1', type: 'person', name: 'Bob' };
      const placeDoc = { _id: 'place-uuid', _rev: '1', type: 'clinic', name: 'Clinic A' };

      sinon.stub(require('../../../src/libs/doc'), 'isDoc').returns(true);
      // Calls 1-2: resolveShortcode for patient_id and place_id (parallel)
      poolQuery.onCall(0).resolves({ rows: [{ _id: 'patient-uuid' }], rowCount: 1 });
      poolQuery.onCall(1).resolves({ rows: [{ _id: 'place-uuid' }], rowCount: 1 });
      // Calls 3-4: getLineageDocsById for patient and place (parallel)
      poolQuery.onCall(2).resolves({ rows: [{ doc: patientDoc, depth: 0 }], rowCount: 1 });
      poolQuery.onCall(3).resolves({ rows: [{ doc: placeDoc, depth: 0 }], rowCount: 1 });

      const result = await hydrateReportSubjects(ctx)(report);

      expect((result as Record<string, unknown>).patient).to.deep.equal(patientDoc);
      expect((result as Record<string, unknown>).place).to.deep.equal(placeDoc);
    });

    it('falls back to shortcode as UUID when shortcode resolution fails', async () => {
      const report = {
        _id: 'r1', _rev: '1', type: 'data_record', form: 'pregnancy',
        fields: { patient_id: 'actual-uuid-123' }
      } as Doc;
      const patientDoc = { _id: 'actual-uuid-123', _rev: '1', type: 'person', name: 'Bob' };

      sinon.stub(require('../../../src/libs/doc'), 'isDoc').returns(true);
      // Call 1: resolveShortcode returns nothing (shortcode IS the uuid)
      poolQuery.onCall(0).resolves({ rows: [], rowCount: 0 });
      // Call 2: getLineageDocsById using the fallback uuid
      poolQuery.onCall(1).resolves({ rows: [{ doc: patientDoc, depth: 0 }], rowCount: 1 });

      const result = await hydrateReportSubjects(ctx)(report);

      expect((result as Record<string, unknown>).patient).to.deep.equal(patientDoc);
    });

    it('does not attach patient when resolved contact is not found', async () => {
      const report = {
        _id: 'r1', _rev: '1', type: 'data_record', form: 'pregnancy',
        fields: { patient_id: 'nonexistent' }
      } as Doc;

      // Call 1: resolveShortcode returns nothing
      poolQuery.onCall(0).resolves({ rows: [], rowCount: 0 });
      // Call 2: getLineageDocsById returns nothing (contact doesn't exist)
      poolQuery.onCall(1).resolves({ rows: [], rowCount: 0 });

      const result = await hydrateReportSubjects(ctx)(report);

      expect((result as Record<string, unknown>).patient).to.be.undefined;
      expect(result.type).to.equal('data_record');
    });

    it('hydrates patient with full parent lineage', async () => {
      const report = {
        _id: 'r1', _rev: '1', type: 'data_record', form: 'pregnancy',
        fields: { patient_id: 'PAT-001' }
      } as Doc;
      const patientDoc = { _id: 'patient-uuid', _rev: '1', type: 'person', name: 'Bob', parent: { _id: 'clinic-1' } };
      const clinicDoc = { _id: 'clinic-1', _rev: '1', type: 'clinic', name: 'Clinic A' };

      sinon.stub(require('../../../src/libs/doc'), 'isDoc').returns(true);
      // Call 1: resolveShortcode for patient_id
      poolQuery.onCall(0).resolves({ rows: [{ _id: 'patient-uuid' }], rowCount: 1 });
      // Call 2: getLineageDocsById for patient (with parent)
      poolQuery.onCall(1).resolves({
        rows: [
          { doc: patientDoc, depth: 0 },
          { doc: clinicDoc, depth: 1 },
        ],
        rowCount: 2
      });
      // Call 3: getDocsByIds for primary contacts (clinic has no contact ref, so empty)
      poolQuery.onCall(2).resolves({ rows: [], rowCount: 0 });

      const result = await hydrateReportSubjects(ctx)(report);

      const patient = (result as Record<string, unknown>).patient as Record<string, unknown>;
      expect(patient).to.not.be.undefined;
      expect(patient._id).to.equal('patient-uuid');
    });
  });

  describe('fetchHydratedDoc with report subjects', () => {
    it('hydrates report with patient when patient_id is present', async () => {
      const reportDoc = {
        _id: 'r1', _rev: '1', type: 'data_record', form: 'pregnancy',
        fields: { patient_id: 'PAT-001' }
      };
      const patientDoc = { _id: 'patient-uuid', _rev: '1', type: 'person', name: 'Bob' };

      sinon.stub(require('../../../src/libs/doc'), 'isDoc').returns(true);
      // Call 1: getLineageDocsById for report (no parent lineage)
      poolQuery.onCall(0).resolves({ rows: [{ doc: reportDoc, depth: 0 }], rowCount: 1 });
      // Call 2: resolveShortcode for patient_id
      poolQuery.onCall(1).resolves({ rows: [{ _id: 'patient-uuid' }], rowCount: 1 });
      // Call 3: getLineageDocsById for patient
      poolQuery.onCall(2).resolves({ rows: [{ doc: patientDoc, depth: 0 }], rowCount: 1 });

      const result = await fetchHydratedDoc(ctx)('r1');

      expect(result).to.not.be.null;
      expect((result as Record<string, unknown>).patient).to.deep.equal(patientDoc);
      expect(result!.type).to.equal('data_record');
    });

    it('does not attach subjects for non-report documents', async () => {
      const contactDoc = { _id: 'c1', _rev: '1', type: 'person', name: 'Alice' };

      sinon.stub(require('../../../src/libs/doc'), 'isDoc').returns(true);
      poolQuery.onCall(0).resolves({ rows: [{ doc: contactDoc, depth: 0 }], rowCount: 1 });

      const result = await fetchHydratedDoc(ctx)('c1');

      expect(result).to.deep.equal(contactDoc);
      expect((result as Record<string, unknown>).patient).to.be.undefined;
      expect(poolQuery.callCount).to.equal(1);
    });
  });
});
