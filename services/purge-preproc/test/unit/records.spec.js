'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const db = require('../../src/db');
const records = require('../../src/records');

describe('Records', () => {
  afterEach(() => sinon.restore());

  describe('getContactIdsWithChangedRecords', () => {
    it('should include deleted records when finding changed contacts', async () => {
      const queryStub = sinon.stub(db, 'query');
      sinon.stub(db, 'getSchema').returns('v1');

      // First query: find changed data_records (should NOT filter _deleted)
      queryStub.onFirstCall().resolves({
        rows: [
          { subject_id: 'patient1' },  // from a deleted record
          { subject_id: 'patient2' },  // from a modified record
        ],
      });

      // Second query: find contacts matching those subject IDs
      queryStub.onSecondCall().resolves({
        rows: [
          { _id: 'patient1' },
          { _id: 'patient2' },
        ],
      });

      const since = new Date('2025-06-01');
      const result = await records.getContactIdsWithChangedRecords(since);

      expect(result).to.deep.equal(['patient1', 'patient2']);

      // Verify the first query does NOT contain '_deleted IS NOT TRUE'
      const firstQuery = queryStub.args[0][0];
      expect(firstQuery).to.not.include('_deleted');
      expect(firstQuery).to.include('saved_timestamp');
      expect(firstQuery).to.include('data_record');
    });

    it('should filter null subject IDs from deleted records', async () => {
      const queryStub = sinon.stub(db, 'query');
      sinon.stub(db, 'getSchema').returns('v1');

      // A deleted record whose subject fields are all null/empty
      queryStub.onFirstCall().resolves({
        rows: [
          { subject_id: null },
          { subject_id: 'patient1' },
        ],
      });

      queryStub.onSecondCall().resolves({
        rows: [{ _id: 'patient1' }],
      });

      const result = await records.getContactIdsWithChangedRecords(new Date('2025-01-01'));

      expect(result).to.deep.equal(['patient1']);
      // Only the non-null subject IDs should be queried (passed as array param)
      expect(queryStub.args[1][1][0]).to.deep.equal(['patient1']);
    });

    it('should return empty array when no changed records', async () => {
      const queryStub = sinon.stub(db, 'query');
      sinon.stub(db, 'getSchema').returns('v1');

      queryStub.onFirstCall().resolves({ rows: [] });

      const result = await records.getContactIdsWithChangedRecords(new Date('2025-01-01'));

      expect(result).to.deep.equal([]);
      // Should not make the second query
      expect(queryStub.callCount).to.equal(1);
    });

    it('should return empty array when all changed records have null subjects', async () => {
      const queryStub = sinon.stub(db, 'query');
      sinon.stub(db, 'getSchema').returns('v1');

      queryStub.onFirstCall().resolves({
        rows: [{ subject_id: null }, { subject_id: null }],
      });

      const result = await records.getContactIdsWithChangedRecords(new Date('2025-01-01'));

      expect(result).to.deep.equal([]);
      expect(queryStub.callCount).to.equal(1);
    });
  });

  describe('getRecordsForSubjects', () => {
    it('should return empty when no subject IDs provided', async () => {
      const result = await records.getRecordsForSubjects([]);
      expect(result).to.deep.equal({ reports: [], messages: [] });
    });

    it('should separate reports and messages', async () => {
      sinon.stub(db, 'query').resolves({
        rows: [
          { _id: 'r1', doc: { _id: 'r1', form: 'pregnancy', type: 'data_record' } },
          { _id: 'm1', doc: { _id: 'm1', type: 'data_record', sms_message: {} } },
        ],
      });
      sinon.stub(db, 'getSchema').returns('v1');

      const result = await records.getRecordsForSubjects(['patient1']);

      expect(result.reports).to.have.length(1);
      expect(result.reports[0]._id).to.equal('r1');
      expect(result.messages).to.have.length(1);
      expect(result.messages[0]._id).to.equal('m1');
    });
  });

  describe('getUnallocatedRecords', () => {
    it('should return records mapped with id and doc', async () => {
      sinon.stub(db, 'query').resolves({
        rows: [
          { _id: 'r1', doc: { _id: 'r1', type: 'data_record' } },
        ],
      });
      sinon.stub(db, 'getSchema').returns('v1');

      const result = await records.getUnallocatedRecords(100, 0);

      expect(result).to.have.length(1);
      expect(result[0]).to.deep.equal({ id: 'r1', doc: { _id: 'r1', type: 'data_record' } });
    });
  });
});
