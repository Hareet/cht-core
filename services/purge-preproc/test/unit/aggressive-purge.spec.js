'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const db = require('../../src/db');
const purgeStatus = require('../../src/purge-status');
const engine = require('../../src/engine');

describe('Aggressive Purge', () => {
  afterEach(() => sinon.restore());

  describe('aggressivePurgeTasks', () => {
    it('should purge all terminal-state tasks immediately (no 60-day wait)', async () => {
      const queryStub = sinon.stub(db, 'query').resolves({
        rows: [
          { _id: 'task-completed' },
          { _id: 'task-cancelled' },
          { _id: 'task-failed' },
        ],
      });

      const stats = {};
      const result = await engine._aggressivePurgeTasks('hash_chw', stats);

      expect(queryStub.calledOnce).to.be.true;
      const sql = queryStub.args[0][0];
      // Should NOT have any date cutoff — purge immediately
      expect(sql).to.include("doc->>'state' IN ('Cancelled', 'Completed', 'Failed')");
      expect(sql).to.not.include('endDate');

      expect(result.hash_chw['task-completed']).to.be.true;
      expect(result.hash_chw['task-cancelled']).to.be.true;
      expect(result.hash_chw['task-failed']).to.be.true;
      expect(stats.tasksPurged).to.equal(3);
    });

    it('should return empty object when no terminal tasks exist', async () => {
      sinon.stub(db, 'query').resolves({ rows: [] });

      const stats = {};
      const result = await engine._aggressivePurgeTasks('hash_chw', stats);

      expect(result).to.deep.equal({});
      expect(stats.tasksPurged).to.be.undefined;
    });
  });

  describe('aggressivePurgeTargets', () => {
    it('should purge targets older than 1 reporting period', async () => {
      sinon.stub(db, 'query').resolves({
        rows: [
          { _id: 'target~2025-01~owner1~abc' },
          { _id: 'target~2025-06~owner2~def' },
        ],
      });

      const stats = {};
      const result = await engine._aggressivePurgeTargets('hash_chw', stats);

      expect(result.hash_chw['target~2025-01~owner1~abc']).to.be.true;
      expect(result.hash_chw['target~2025-06~owner2~def']).to.be.true;
      expect(stats.targetsPurged).to.equal(2);
    });

    it('should use 1-month cutoff (not 6-month standard)', async () => {
      const queryStub = sinon.stub(db, 'query').resolves({ rows: [] });

      await engine._aggressivePurgeTargets('hash_chw', {});

      const param = queryStub.args[0][1][0];
      // The cutoff should be ~1 month ago, not 6 months
      const parts = param.match(/target~(\d{4})-(\d{2})~/);
      expect(parts).to.not.be.null;
      const cutoffDate = new Date(parseInt(parts[1]), parseInt(parts[2]) - 1);
      const oneMonthAgo = new Date();
      oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
      // Should be within ~2 months of now (not 6+ months)
      const diffMs = Math.abs(cutoffDate.getTime() - oneMonthAgo.getTime());
      expect(diffMs).to.be.below(62 * 24 * 60 * 60 * 1000); // within 2 months
    });

    it('should return empty object when no old targets', async () => {
      sinon.stub(db, 'query').resolves({ rows: [] });

      const stats = {};
      const result = await engine._aggressivePurgeTargets('hash_chw', stats);

      expect(result).to.deep.equal({});
    });
  });

  describe('aggressivePurgeReports', () => {
    it('should purge reports older than 90 days with no active follow-up', async () => {
      sinon.stub(db, 'query').resolves({
        rows: [
          { _id: 'old-report-1' },
          { _id: 'old-report-2' },
        ],
      });

      const stats = {};
      const result = await engine._aggressivePurgeReports('hash_chw', 'facility-123', stats);

      expect(result.hash_chw['old-report-1']).to.be.true;
      expect(result.hash_chw['old-report-2']).to.be.true;
      expect(stats.reportsPurged).to.equal(2);
    });

    it('should filter by facility hierarchy', async () => {
      const queryStub = sinon.stub(db, 'query').resolves({ rows: [] });

      await engine._aggressivePurgeReports('hash_chw', 'facility-abc', {});

      const sql = queryStub.args[0][0];
      // Should check parent hierarchy for facility
      expect(sql).to.include("parent'->>'_id' = $2");
      const params = queryStub.args[0][1];
      expect(params[1]).to.equal('facility-abc');
    });

    it('should exclude reports with active (non-terminal) follow-up tasks', async () => {
      const queryStub = sinon.stub(db, 'query').resolves({ rows: [] });

      await engine._aggressivePurgeReports('hash_chw', 'fac1', {});

      const sql = queryStub.args[0][0];
      expect(sql).to.include('NOT EXISTS');
      expect(sql).to.include("doc->>'state' NOT IN ('Cancelled', 'Completed', 'Failed')");
      expect(sql).to.include("emission'->>'forId'");
    });

    it('should use 90-day cutoff', async () => {
      const queryStub = sinon.stub(db, 'query').resolves({ rows: [] });

      await engine._aggressivePurgeReports('hash_chw', 'fac1', {});

      const cutoffMs = queryStub.args[0][1][0];
      const ninetyDaysAgoMs = Date.now() - 90 * 24 * 60 * 60 * 1000;
      // Should be within 1 second of 90 days ago
      expect(Math.abs(cutoffMs - ninetyDaysAgoMs)).to.be.below(1000);
    });

    it('should return empty object when no eligible reports', async () => {
      sinon.stub(db, 'query').resolves({ rows: [] });

      const stats = {};
      const result = await engine._aggressivePurgeReports('hash_chw', 'fac1', stats);

      expect(result).to.deep.equal({});
    });
  });

  describe('runAggressivePurge', () => {
    it('should orchestrate all aggressive purge strategies', async () => {
      sinon.stub(db, 'query')
        // aggressivePurgeTasks
        .onFirstCall().resolves({ rows: [{ _id: 'task1' }] })
        // aggressivePurgeTargets
        .onSecondCall().resolves({ rows: [{ _id: 'target1' }] })
        // aggressivePurgeReports
        .onThirdCall().resolves({ rows: [{ _id: 'report1' }, { _id: 'report2' }] });

      const writeStub = sinon.stub(purgeStatus, 'writePurgeResults').resolves();

      const result = await engine.runAggressivePurge('user-chw1', 'facility-123', 'hash_chw');

      expect(result.purged_count).to.equal(4);
      expect(result.breakdown.tasks).to.equal(1);
      expect(result.breakdown.targets).to.equal(1);
      expect(result.breakdown.reports).to.equal(2);
      expect(result.estimated_reduction_mb).to.be.a('number');
      expect(result.estimated_reduction_mb).to.be.above(0);

      // All writes should use aggressive options
      expect(writeStub.callCount).to.equal(3);
      for (const call of writeStub.args) {
        expect(call[1]).to.deep.include({
          aggressive: true,
          requestedBy: 'user-chw1',
          reason: 'storage_budget',
        });
      }
    });

    it('should handle case where no docs are eligible for aggressive purge', async () => {
      sinon.stub(db, 'query').resolves({ rows: [] });
      sinon.stub(purgeStatus, 'writePurgeResults').resolves();

      const result = await engine.runAggressivePurge('user1', 'fac1', 'hash_chw');

      expect(result.purged_count).to.equal(0);
      expect(result.estimated_reduction_mb).to.equal(0);
      expect(result.breakdown).to.deep.equal({ tasks: 0, targets: 0, reports: 0 });
      // No writes needed when nothing to purge
      expect(purgeStatus.writePurgeResults.callCount).to.equal(0);
    });

    it('should calculate estimated_reduction_mb from doc count', async () => {
      sinon.stub(db, 'query')
        .onFirstCall().resolves({ rows: Array.from({ length: 1000 }, (_, i) => ({ _id: `t${i}` })) })
        .onSecondCall().resolves({ rows: [] })
        .onThirdCall().resolves({ rows: [] });
      sinon.stub(purgeStatus, 'writePurgeResults').resolves();

      const result = await engine.runAggressivePurge('u1', 'f1', 'h1');

      // 1000 docs * 3KB avg = 3000KB ≈ 2.93MB
      expect(result.purged_count).to.equal(1000);
      expect(result.estimated_reduction_mb).to.be.closeTo(2.93, 0.1);
    });
  });
});
