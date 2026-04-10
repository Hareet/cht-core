'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const db = require('../../src/db');
const purgeStatus = require('../../src/purge-status');

describe('Purge Status', () => {
  afterEach(() => sinon.restore());

  describe('writePurgeResults', () => {
    it('should do nothing for empty results', async () => {
      const queryStub = sinon.stub(db, 'query');
      await purgeStatus.writePurgeResults({});
      expect(queryStub.callCount).to.equal(0);
    });

    it('should do nothing when all role hashes have empty docs', async () => {
      const queryStub = sinon.stub(db, 'query');
      await purgeStatus.writePurgeResults({ hash_a: {} });
      expect(queryStub.callCount).to.equal(0);
    });

    it('should upsert purge decisions', async () => {
      const queryStub = sinon.stub(db, 'query').resolves();

      await purgeStatus.writePurgeResults({
        hash_a: { doc1: true, doc2: false },
        hash_b: { doc1: false },
      });

      expect(queryStub.callCount).to.equal(1);
      const [sql, params] = queryStub.args[0];
      expect(sql).to.include('INSERT INTO purge_status');
      expect(sql).to.include('ON CONFLICT');
      // 3 rows x 3 params each = 9 params
      expect(params).to.have.length(9);
      expect(params).to.include('doc1');
      expect(params).to.include('hash_a');
    });
  });

  describe('getLastRunTimestamp', () => {
    it('should return null when no completed runs', async () => {
      sinon.stub(db, 'query').resolves({ rows: [] });
      const result = await purgeStatus.getLastRunTimestamp();
      expect(result).to.be.null;
    });

    it('should return the latest completed_at', async () => {
      const date = new Date('2025-06-01');
      sinon.stub(db, 'query').resolves({ rows: [{ completed_at: date }] });
      const result = await purgeStatus.getLastRunTimestamp();
      expect(result).to.deep.equal(date);
    });
  });

  describe('getLastPurgeFnHash', () => {
    it('should return null when no completed runs', async () => {
      sinon.stub(db, 'query').resolves({ rows: [] });
      const result = await purgeStatus.getLastPurgeFnHash();
      expect(result).to.be.null;
    });

    it('should return the hash from the latest completed run', async () => {
      sinon.stub(db, 'query').resolves({ rows: [{ purge_fn_hash: 'abc123' }] });
      const result = await purgeStatus.getLastPurgeFnHash();
      expect(result).to.equal('abc123');
    });

    it('should return null when last run had no hash stored', async () => {
      sinon.stub(db, 'query').resolves({ rows: [{ purge_fn_hash: null }] });
      const result = await purgeStatus.getLastPurgeFnHash();
      expect(result).to.be.null;
    });
  });

  describe('startRunLog', () => {
    it('should create a run log entry and return id', async () => {
      sinon.stub(db, 'query').resolves({ rows: [{ id: 42 }] });
      const id = await purgeStatus.startRunLog();
      expect(id).to.equal(42);
    });
  });

  describe('completeRunLog', () => {
    it('should update run log with stats and purge function hash', async () => {
      const queryStub = sinon.stub(db, 'query').resolves();

      await purgeStatus.completeRunLog(1, {
        contactsProcessed: 100,
        docsEvaluated: 5000,
        docsPurged: 200,
        docsUnpurged: 4800,
        skippedContacts: ['c1'],
        purgeFnHash: 'abc123hash',
      });

      expect(queryStub.calledOnce).to.be.true;
      const [sql, params] = queryStub.args[0];
      expect(sql).to.include('purge_fn_hash');
      expect(params[0]).to.equal(1);
      expect(params[1]).to.equal(100);
      expect(params[2]).to.equal(5000);
      expect(params[3]).to.equal(200);
      expect(params[4]).to.equal(4800);
      expect(params[6]).to.equal('abc123hash');
    });

    it('should store null hash when not provided', async () => {
      const queryStub = sinon.stub(db, 'query').resolves();

      await purgeStatus.completeRunLog(1, {
        contactsProcessed: 0,
        docsEvaluated: 0,
        docsPurged: 0,
        docsUnpurged: 0,
        skippedContacts: [],
      });

      const params = queryStub.args[0][1];
      expect(params[6]).to.be.null;
    });
  });

  describe('cleanupDeletedDocs', () => {
    it('should delete purge_status entries for deleted couchdb documents', async () => {
      const queryStub = sinon.stub(db, 'query').resolves({ rowCount: 5 });
      sinon.stub(console, 'log');

      const result = await purgeStatus.cleanupDeletedDocs();

      expect(result).to.equal(5);
      expect(queryStub.calledOnce).to.be.true;
      const sql = queryStub.args[0][0];
      expect(sql).to.include('DELETE FROM purge_status');
      expect(sql).to.include('_deleted IS TRUE');
      expect(console.log.calledWith('Cleaned up 5 purge_status entries for deleted documents')).to.be.true;
    });

    it('should return 0 and not log when no entries to clean', async () => {
      sinon.stub(db, 'query').resolves({ rowCount: 0 });
      sinon.stub(console, 'log');

      const result = await purgeStatus.cleanupDeletedDocs();

      expect(result).to.equal(0);
      expect(console.log.callCount).to.equal(0);
    });

    it('should handle undefined rowCount gracefully', async () => {
      sinon.stub(db, 'query').resolves({});

      const result = await purgeStatus.cleanupDeletedDocs();

      expect(result).to.equal(0);
    });
  });

  describe('failRunLog', () => {
    it('should mark run as failed', async () => {
      const queryStub = sinon.stub(db, 'query').resolves();

      await purgeStatus.failRunLog(1, 'something went wrong');

      expect(queryStub.calledOnce).to.be.true;
      const params = queryStub.args[0][1];
      expect(params[0]).to.equal(1);
      expect(params[1]).to.equal('something went wrong');
    });
  });
});
