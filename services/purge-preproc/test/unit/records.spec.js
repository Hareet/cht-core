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

    it('should use UNNEST to capture all subject IDs per record', async () => {
      const queryStub = sinon.stub(db, 'query');
      sinon.stub(db, 'getSchema').returns('v1');

      // UNNEST returns all non-null subject IDs from each changed record.
      // A report with patient_id=A and place_id=B returns both A and B.
      queryStub.onFirstCall().resolves({
        rows: [
          { subject_id: 'patient_A' },
          { subject_id: 'place_B' },
          { subject_id: 'patient_C' },
        ],
      });

      queryStub.onSecondCall().resolves({
        rows: [
          { _id: 'contact_for_A' },
          { _id: 'contact_for_B' },
          { _id: 'contact_for_C' },
        ],
      });

      const result = await records.getContactIdsWithChangedRecords(new Date('2025-06-01'));

      expect(result).to.deep.equal(['contact_for_A', 'contact_for_B', 'contact_for_C']);

      // Verify the SQL uses UNNEST (not COALESCE which only returns the first non-null)
      const firstQuery = queryStub.args[0][0];
      expect(firstQuery).to.include('UNNEST');
      expect(firstQuery).to.not.include('COALESCE');

      // All three subject IDs should be passed to the contact lookup query
      expect(queryStub.args[1][1][0]).to.deep.equal(['patient_A', 'place_B', 'patient_C']);
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

    it('should deduplicate subject IDs across records', async () => {
      const queryStub = sinon.stub(db, 'query');
      sinon.stub(db, 'getSchema').returns('v1');

      // UNNEST + DISTINCT in SQL deduplicates; DB returns unique rows
      queryStub.onFirstCall().resolves({
        rows: [
          { subject_id: 'patient1' },
          // SQL DISTINCT already removed duplicates
        ],
      });

      queryStub.onSecondCall().resolves({
        rows: [{ _id: 'patient1' }],
      });

      const result = await records.getContactIdsWithChangedRecords(new Date('2025-01-01'));

      expect(result).to.deep.equal(['patient1']);
      expect(queryStub.args[1][1][0]).to.deep.equal(['patient1']);
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

    it('should not include saved_timestamp filter when since is not provided', async () => {
      const queryStub = sinon.stub(db, 'query').resolves({ rows: [] });
      sinon.stub(db, 'getSchema').returns('v1');

      await records.getUnallocatedRecords(100, 0);

      const sql = queryStub.args[0][0];
      expect(sql).to.not.include('saved_timestamp');
      expect(queryStub.args[0][1]).to.deep.equal([100, 0]);
    });

    it('should filter by saved_timestamp when since is provided', async () => {
      const queryStub = sinon.stub(db, 'query').resolves({ rows: [] });
      sinon.stub(db, 'getSchema').returns('v1');

      const since = new Date('2025-06-01');
      await records.getUnallocatedRecords(100, 0, since);

      const sql = queryStub.args[0][0];
      expect(sql).to.include('saved_timestamp > $3');
      expect(queryStub.args[0][1]).to.deep.equal([100, 0, since]);
    });
  });
});
