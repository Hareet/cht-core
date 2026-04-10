'use strict';

const { expect } = require('chai');
const sinon = require('sinon');

const contacts = require('../../src/contacts');
const records = require('../../src/records');
const purgeStatus = require('../../src/purge-status');
const rolesService = require('../../src/roles');
const db = require('../../src/db');

const engine = require('../../src/engine');

describe('Purge Engine', () => {
  afterEach(() => sinon.restore());

  describe('evaluateGroup', () => {
    const rolesByHash = {
      hash_a: ['chw'],
      hash_b: ['chw_supervisor'],
    };

    it('should call purge function with correct arguments per role', () => {
      const purgeFn = sinon.stub().returns([]);
      const group = {
        contact: { _id: 'contact1', type: 'person' },
        reports: [{ _id: 'report1', type: 'data_record', form: 'pregnancy' }],
        messages: [{ _id: 'msg1', type: 'data_record', sms_message: 'hello' }],
        ids: ['contact1', 'report1', 'msg1'],
      };

      engine._evaluateGroup(purgeFn, group, rolesByHash);

      expect(purgeFn.callCount).to.equal(2);
      expect(purgeFn.args[0][0]).to.deep.equal({ roles: ['chw'] });
      expect(purgeFn.args[0][1]).to.deep.equal(group.contact);
      expect(purgeFn.args[0][2]).to.deep.equal(group.reports);
      expect(purgeFn.args[0][3]).to.deep.equal(group.messages);
      expect(purgeFn.args[1][0]).to.deep.equal({ roles: ['chw_supervisor'] });
    });

    it('should mark returned IDs as purged', () => {
      const purgeFn = sinon.stub();
      // CHW role purges the report, supervisor role purges nothing
      purgeFn.withArgs(sinon.match({ roles: ['chw'] })).returns(['report1']);
      purgeFn.withArgs(sinon.match({ roles: ['chw_supervisor'] })).returns([]);

      const group = {
        contact: { _id: 'contact1', type: 'person' },
        reports: [{ _id: 'report1', type: 'data_record', form: 'a' }],
        messages: [],
        ids: ['contact1', 'report1'],
      };

      const result = engine._evaluateGroup(purgeFn, group, rolesByHash);

      expect(result.hash_a.report1).to.be.true;
      expect(result.hash_a.contact1).to.be.false;
      expect(result.hash_b.report1).to.be.false;
      expect(result.hash_b.contact1).to.be.false;
    });

    it('should ignore IDs not in the group', () => {
      const purgeFn = sinon.stub().returns(['rogue_id', 'report1']);

      const group = {
        contact: { _id: 'contact1', type: 'person' },
        reports: [{ _id: 'report1', type: 'data_record', form: 'a' }],
        messages: [],
        ids: ['contact1', 'report1'],
      };

      const result = engine._evaluateGroup(purgeFn, group, { hash_a: ['chw'] });

      expect(result.hash_a.report1).to.be.true;
      expect(result.hash_a.rogue_id).to.be.undefined;
    });

    it('should handle purge function returning non-array', () => {
      const purgeFn = sinon.stub().returns('invalid');

      const group = {
        contact: { _id: 'c1' },
        reports: [],
        messages: [],
        ids: ['c1'],
      };

      const result = engine._evaluateGroup(purgeFn, group, { hash_a: ['chw'] });

      // Should have no purged entries since result was invalid
      expect(result.hash_a).to.deep.equal({});
    });

    it('should handle purge function throwing an error', () => {
      const purgeFn = sinon.stub().throws(new Error('boom'));

      const group = {
        contact: { _id: 'c1' },
        reports: [],
        messages: [],
        ids: ['c1'],
      };

      const result = engine._evaluateGroup(purgeFn, group, { hash_a: ['chw'] });

      expect(result.hash_a).to.deep.equal({});
    });

    it('should handle empty group (no ids means no evaluation)', () => {
      const purgeFn = sinon.stub().returns([]);

      const group = {
        contact: { _id: 'c1' },
        reports: [],
        messages: [],
        ids: [],
      };

      const result = engine._evaluateGroup(purgeFn, group, { hash_a: ['chw'] });

      // Empty ids → skips purge function call
      expect(purgeFn.callCount).to.equal(0);
      expect(result.hash_a).to.deep.equal({});
    });

    it('should purge reports from multiple roles independently', () => {
      const purgeFn = sinon.stub();
      // Both roles purge different things
      purgeFn.withArgs(sinon.match({ roles: ['chw'] })).returns(['report1']);
      purgeFn.withArgs(sinon.match({ roles: ['chw_supervisor'] })).returns(['report2']);

      const group = {
        contact: { _id: 'c1', type: 'person' },
        reports: [
          { _id: 'report1', type: 'data_record', form: 'a' },
          { _id: 'report2', type: 'data_record', form: 'b' },
        ],
        messages: [],
        ids: ['c1', 'report1', 'report2'],
      };

      const result = engine._evaluateGroup(purgeFn, group, rolesByHash);

      expect(result.hash_a.report1).to.be.true;
      expect(result.hash_a.report2).to.be.false;
      expect(result.hash_b.report1).to.be.false;
      expect(result.hash_b.report2).to.be.true;
    });
  });

  describe('run', () => {
    let queryStub;

    beforeEach(() => {
      queryStub = sinon.stub(db, 'query');
      // Default: return empty rows for any unmatched query (task/target auto-purge)
      queryStub.resolves({ rows: [] });
    });

    it('should skip when no purge function configured', async () => {
      queryStub.resolves({ rows: [] }); // no settings doc
      sinon.stub(console, 'log');

      await engine.run({ incremental: false });

      expect(console.log.calledWith('No purge function configured. Skipping.')).to.be.true;
    });

    it('should skip when no offline roles found', async () => {
      // settings query returns a purge fn
      queryStub.onFirstCall().resolves({
        rows: [{ fn: 'function() { return []; }' }],
      });
      sinon.stub(rolesService, 'getRoles').resolves({});
      sinon.stub(console, 'log');

      await engine.run({ incremental: false });

      expect(console.log.calledWith('No offline roles found. Skipping.')).to.be.true;
    });

    it('should process contacts and write purge results in full mode', async () => {
      const purgeFn = function(userCtx, contact, reports) {
        // Purge reports older than 1 year
        const oneYearAgo = Date.now() - (365 * 24 * 60 * 60 * 1000);
        return reports.filter(r => r.reported_date < oneYearAgo).map(r => r._id);
      };

      // Settings query
      queryStub.onFirstCall().resolves({
        rows: [{ fn: purgeFn.toString() }],
      });

      sinon.stub(rolesService, 'getRoles').resolves({ hash_chw: ['chw'] });
      sinon.stub(rolesService, 'saveRoles').resolves();
      sinon.stub(purgeStatus, 'startRunLog').resolves(1);
      sinon.stub(purgeStatus, 'completeRunLog').resolves();
      sinon.stub(purgeStatus, 'writePurgeResults').resolves();

      const oldReport = {
        _id: 'old_report',
        type: 'data_record',
        form: 'pregnancy',
        reported_date: Date.now() - (400 * 24 * 60 * 60 * 1000),
      };
      const newReport = {
        _id: 'new_report',
        type: 'data_record',
        form: 'pregnancy',
        reported_date: Date.now(),
      };

      sinon.stub(contacts, 'getContactsBatch')
        .onFirstCall().resolves([{
          id: 'patient1',
          doc: { _id: 'patient1', type: 'person', patient_id: 'p1' },
        }])
        .onSecondCall().resolves([]);

      sinon.stub(records, 'getSubjectIds').returns(['patient1', 'p1']);
      sinon.stub(records, 'getRecordsForSubjects').resolves({
        reports: [oldReport, newReport],
        messages: [],
      });
      sinon.stub(records, 'getUnallocatedRecords').resolves([]);

      await engine.run({ incremental: false });

      expect(purgeStatus.writePurgeResults.callCount).to.be.greaterThan(0);

      // Check the first write - should purge old_report but not new_report
      const firstWrite = purgeStatus.writePurgeResults.args[0][0];
      expect(firstWrite.hash_chw.old_report).to.be.true;
      expect(firstWrite.hash_chw.new_report).to.be.false;

      expect(purgeStatus.completeRunLog.calledOnce).to.be.true;
      const stats = purgeStatus.completeRunLog.args[0][1];
      expect(stats.contactsProcessed).to.equal(1);
    });

    it('should run incrementally when last run exists', async () => {
      const purgeFn = function() { return []; };

      queryStub.onFirstCall().resolves({
        rows: [{ fn: purgeFn.toString() }],
      });

      sinon.stub(rolesService, 'getRoles').resolves({ hash_chw: ['chw'] });
      sinon.stub(rolesService, 'saveRoles').resolves();
      sinon.stub(purgeStatus, 'startRunLog').resolves(1);
      sinon.stub(purgeStatus, 'completeRunLog').resolves();
      sinon.stub(purgeStatus, 'getLastRunTimestamp').resolves(new Date('2025-01-01'));
      sinon.stub(purgeStatus, 'writePurgeResults').resolves();

      sinon.stub(contacts, 'getChangedContactIds').resolves(['c1']);
      sinon.stub(records, 'getContactIdsWithChangedRecords').resolves(['c2']);

      sinon.stub(contacts, 'getContact')
        .withArgs('c1').resolves({ id: 'c1', doc: { _id: 'c1', type: 'person' } })
        .withArgs('c2').resolves({ id: 'c2', doc: { _id: 'c2', type: 'person' } });

      sinon.stub(records, 'getSubjectIds').returns([]);
      sinon.stub(records, 'getRecordsForSubjects').resolves({ reports: [], messages: [] });
      sinon.stub(records, 'getUnallocatedRecords').resolves([]);

      sinon.stub(console, 'log');

      await engine.run({ incremental: true });

      expect(contacts.getChangedContactIds.calledWith(new Date('2025-01-01'))).to.be.true;
      expect(contacts.getContact.callCount).to.equal(2);
      expect(purgeStatus.completeRunLog.calledOnce).to.be.true;
    });

    it('should call cleanupDeletedDocs during run', async () => {
      const purgeFn = function() { return []; };

      queryStub.onFirstCall().resolves({
        rows: [{ fn: purgeFn.toString() }],
      });

      sinon.stub(rolesService, 'getRoles').resolves({ hash_chw: ['chw'] });
      sinon.stub(rolesService, 'saveRoles').resolves();
      sinon.stub(purgeStatus, 'startRunLog').resolves(1);
      sinon.stub(purgeStatus, 'completeRunLog').resolves();
      sinon.stub(purgeStatus, 'writePurgeResults').resolves();
      sinon.stub(purgeStatus, 'cleanupDeletedDocs').resolves(3);

      sinon.stub(contacts, 'getContactsBatch')
        .onFirstCall().resolves([])
        ;

      sinon.stub(records, 'getUnallocatedRecords').resolves([]);

      sinon.stub(console, 'log');

      await engine.run({ incremental: false });

      expect(purgeStatus.cleanupDeletedDocs.calledOnce).to.be.true;
      const stats = purgeStatus.completeRunLog.args[0][1];
      expect(stats.deletedDocsCleaned).to.equal(3);
    });

    it('should skip contacts with too many records', async () => {
      const purgeFn = function() { return []; };

      queryStub.onFirstCall().resolves({
        rows: [{ fn: purgeFn.toString() }],
      });

      sinon.stub(rolesService, 'getRoles').resolves({ hash_chw: ['chw'] });
      sinon.stub(rolesService, 'saveRoles').resolves();
      sinon.stub(purgeStatus, 'startRunLog').resolves(1);
      sinon.stub(purgeStatus, 'completeRunLog').resolves();
      sinon.stub(purgeStatus, 'writePurgeResults').resolves();

      // Create a contact with too many records
      const manyReports = Array.from({ length: 25000 }, (_, i) => ({
        _id: `r${i}`, type: 'data_record', form: 'a',
      }));

      sinon.stub(contacts, 'getContactsBatch')
        .onFirstCall().resolves([{
          id: 'big_contact',
          doc: { _id: 'big_contact', type: 'person' },
        }])
        .onSecondCall().resolves([]);

      sinon.stub(records, 'getSubjectIds').returns(['big_contact']);
      sinon.stub(records, 'getRecordsForSubjects').resolves({
        reports: manyReports,
        messages: [],
      });
      sinon.stub(records, 'getUnallocatedRecords').resolves([]);

      sinon.stub(console, 'warn');
      sinon.stub(console, 'log');

      await engine.run({ incremental: false });

      const stats = purgeStatus.completeRunLog.args[0][1];
      expect(stats.skippedContacts).to.include('big_contact');
      expect(stats.contactsProcessed).to.equal(0);
    });
  });

  describe('purgeExpiredTasks', () => {
    it('should purge tasks in terminal state older than 60 days', async () => {
      const queryStub = sinon.stub(db, 'query');
      const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      queryStub.resolves({
        rows: [
          { _id: 'task1', doc: { _id: 'task1', type: 'task', state: 'Completed' } },
          { _id: 'task2', doc: { _id: 'task2', type: 'task', state: 'Failed' } },
        ],
      });

      sinon.stub(purgeStatus, 'writePurgeResults').resolves();
      sinon.stub(console, 'log');

      const rolesByHash = { hash_a: ['chw'], hash_b: ['chw_supervisor'] };
      const stats = { docsEvaluated: 0, docsPurged: 0, docsUnpurged: 0 };

      await engine._purgeExpiredTasks(rolesByHash, stats);

      expect(purgeStatus.writePurgeResults.calledOnce).to.be.true;
      const result = purgeStatus.writePurgeResults.args[0][0];
      // Both tasks purged for both roles
      expect(result.hash_a.task1).to.be.true;
      expect(result.hash_a.task2).to.be.true;
      expect(result.hash_b.task1).to.be.true;
      expect(result.hash_b.task2).to.be.true;
      expect(stats.docsEvaluated).to.equal(2);
    });

    it('should skip when no expired tasks', async () => {
      sinon.stub(db, 'query').resolves({ rows: [] });
      sinon.stub(purgeStatus, 'writePurgeResults').resolves();

      const stats = { docsEvaluated: 0, docsPurged: 0, docsUnpurged: 0 };
      await engine._purgeExpiredTasks({ hash_a: ['chw'] }, stats);

      expect(purgeStatus.writePurgeResults.callCount).to.equal(0);
    });
  });

  describe('purgeExpiredTargets', () => {
    it('should purge target documents older than 6 months', async () => {
      const queryStub = sinon.stub(db, 'query');

      queryStub.resolves({
        rows: [
          { _id: 'target~2024-01~owner1~12345' },
          { _id: 'target~2024-03~owner2~67890' },
        ],
      });

      sinon.stub(purgeStatus, 'writePurgeResults').resolves();
      sinon.stub(console, 'log');

      const rolesByHash = { hash_a: ['chw'] };
      const stats = { docsEvaluated: 0, docsPurged: 0, docsUnpurged: 0 };

      await engine._purgeExpiredTargets(rolesByHash, stats);

      expect(purgeStatus.writePurgeResults.calledOnce).to.be.true;
      const result = purgeStatus.writePurgeResults.args[0][0];
      expect(result.hash_a['target~2024-01~owner1~12345']).to.be.true;
      expect(result.hash_a['target~2024-03~owner2~67890']).to.be.true;
      expect(stats.docsEvaluated).to.equal(2);
    });
  });

  describe('hashPurgeFn', () => {
    it('should produce consistent hashes for the same function', () => {
      const fn = function(userCtx, contact, reports) { return []; };
      const hash1 = engine._hashPurgeFn(fn);
      const hash2 = engine._hashPurgeFn(fn);
      expect(hash1).to.equal(hash2);
      expect(hash1).to.be.a('string').with.length(64); // sha256 hex
    });

    it('should produce different hashes for different functions', () => {
      const fn1 = function(userCtx, contact, reports) { return []; };
      const fn2 = function(userCtx, contact, reports) { return reports.map(r => r._id); };
      expect(engine._hashPurgeFn(fn1)).to.not.equal(engine._hashPurgeFn(fn2));
    });
  });

  describe('purge function change detection', () => {
    let queryStub;

    beforeEach(() => {
      queryStub = sinon.stub(db, 'query');
      queryStub.resolves({ rows: [] });
    });

    it('should force full run when purge function changes between runs', async () => {
      const oldFn = 'function() { return []; }';
      const newFn = 'function(userCtx, contact, reports) { return reports.map(r => r._id); }';

      // Settings query returns the new purge fn
      queryStub.onFirstCall().resolves({ rows: [{ fn: newFn }] });

      sinon.stub(rolesService, 'getRoles').resolves({ hash_chw: ['chw'] });
      sinon.stub(rolesService, 'saveRoles').resolves();
      sinon.stub(purgeStatus, 'startRunLog').resolves(1);
      sinon.stub(purgeStatus, 'completeRunLog').resolves();
      sinon.stub(purgeStatus, 'writePurgeResults').resolves();
      sinon.stub(purgeStatus, 'cleanupDeletedDocs').resolves(0);

      // Last run used the old function hash
      const oldHash = engine._hashPurgeFn(eval(`(${oldFn})`));
      sinon.stub(purgeStatus, 'getLastPurgeFnHash').resolves(oldHash);

      // These should NOT be called if full run is forced
      const getChangedStub = sinon.stub(contacts, 'getChangedContactIds');
      const getContactStub = sinon.stub(contacts, 'getContact');

      // Full mode will call getContactsBatch
      sinon.stub(contacts, 'getContactsBatch').resolves([]);
      sinon.stub(records, 'getUnallocatedRecords').resolves([]);

      sinon.stub(console, 'log');

      await engine.run({ incremental: true });

      // Should log the force message
      expect(console.log.calledWith('Purge function changed since last run. Forcing full re-evaluation.')).to.be.true;

      // Should NOT have called incremental-specific methods
      expect(getChangedStub.callCount).to.equal(0);
      expect(getContactStub.callCount).to.equal(0);

      // Should have called full-mode getContactsBatch
      expect(contacts.getContactsBatch.callCount).to.be.greaterThan(0);

      // Should store the new hash in stats
      const stats = purgeStatus.completeRunLog.args[0][1];
      expect(stats.purgeFnHash).to.be.a('string').with.length(64);
    });

    it('should proceed incrementally when purge function has not changed', async () => {
      const fn = 'function() { return []; }';

      queryStub.onFirstCall().resolves({ rows: [{ fn }] });

      sinon.stub(rolesService, 'getRoles').resolves({ hash_chw: ['chw'] });
      sinon.stub(rolesService, 'saveRoles').resolves();
      sinon.stub(purgeStatus, 'startRunLog').resolves(1);
      sinon.stub(purgeStatus, 'completeRunLog').resolves();
      sinon.stub(purgeStatus, 'writePurgeResults').resolves();
      sinon.stub(purgeStatus, 'cleanupDeletedDocs').resolves(0);

      // Same hash as current function
      const currentHash = engine._hashPurgeFn(eval(`(${fn})`));
      sinon.stub(purgeStatus, 'getLastPurgeFnHash').resolves(currentHash);
      sinon.stub(purgeStatus, 'getLastRunTimestamp').resolves(new Date('2025-01-01'));

      sinon.stub(contacts, 'getChangedContactIds').resolves([]);
      sinon.stub(records, 'getContactIdsWithChangedRecords').resolves([]);
      sinon.stub(records, 'getUnallocatedRecords').resolves([]);

      sinon.stub(console, 'log');

      await engine.run({ incremental: true });

      // Should NOT force full run
      expect(console.log.calledWith('Purge function changed since last run. Forcing full re-evaluation.')).to.be.false;

      // Should have called incremental methods
      expect(contacts.getChangedContactIds.calledOnce).to.be.true;
    });

    it('should not check hash on first run (no previous hash)', async () => {
      const fn = 'function() { return []; }';

      queryStub.onFirstCall().resolves({ rows: [{ fn }] });

      sinon.stub(rolesService, 'getRoles').resolves({ hash_chw: ['chw'] });
      sinon.stub(rolesService, 'saveRoles').resolves();
      sinon.stub(purgeStatus, 'startRunLog').resolves(1);
      sinon.stub(purgeStatus, 'completeRunLog').resolves();
      sinon.stub(purgeStatus, 'writePurgeResults').resolves();
      sinon.stub(purgeStatus, 'cleanupDeletedDocs').resolves(0);

      // No previous run → null hash
      sinon.stub(purgeStatus, 'getLastPurgeFnHash').resolves(null);
      sinon.stub(purgeStatus, 'getLastRunTimestamp').resolves(null);

      sinon.stub(contacts, 'getContactsBatch').resolves([]);
      sinon.stub(records, 'getUnallocatedRecords').resolves([]);

      sinon.stub(console, 'log');

      await engine.run({ incremental: true });

      // Should not force full, but also no lastRun so falls through to full mode naturally
      expect(console.log.calledWith('Purge function changed since last run. Forcing full re-evaluation.')).to.be.false;
    });

    it('should store purge function hash in completed run log', async () => {
      const fn = 'function() { return []; }';

      queryStub.onFirstCall().resolves({ rows: [{ fn }] });

      sinon.stub(rolesService, 'getRoles').resolves({ hash_chw: ['chw'] });
      sinon.stub(rolesService, 'saveRoles').resolves();
      sinon.stub(purgeStatus, 'startRunLog').resolves(1);
      sinon.stub(purgeStatus, 'completeRunLog').resolves();
      sinon.stub(purgeStatus, 'writePurgeResults').resolves();
      sinon.stub(purgeStatus, 'cleanupDeletedDocs').resolves(0);

      sinon.stub(contacts, 'getContactsBatch').resolves([]);
      sinon.stub(records, 'getUnallocatedRecords').resolves([]);

      sinon.stub(console, 'log');

      await engine.run({ incremental: false });

      const stats = purgeStatus.completeRunLog.args[0][1];
      expect(stats.purgeFnHash).to.be.a('string').with.length(64);
    });
  });

  describe('real purge function scenarios', () => {
    it('should purge reports older than 1 year', () => {
      const purgeFn = function(userCtx, contact, reports, messages) {
        const oneYearAgo = Date.now() - (1000 * 60 * 60 * 24 * 365);
        return reports
          .filter(r => r.reported_date < oneYearAgo)
          .map(r => r._id);
      };

      const now = Date.now();
      const group = {
        contact: { _id: 'patient1', type: 'person' },
        reports: [
          { _id: 'r1', reported_date: now - (400 * 24 * 60 * 60 * 1000) }, // >1yr
          { _id: 'r2', reported_date: now - (100 * 24 * 60 * 60 * 1000) }, // <1yr
          { _id: 'r3', reported_date: now }, // today
        ],
        messages: [],
        ids: ['patient1', 'r1', 'r2', 'r3'],
      };

      const result = engine._evaluateGroup(purgeFn, group, { h1: ['chw'] });

      expect(result.h1.r1).to.be.true;
      expect(result.h1.r2).to.be.false;
      expect(result.h1.r3).to.be.false;
      expect(result.h1.patient1).to.be.false;
    });

    it('should purge differently by role', () => {
      const purgeFn = function(userCtx, contact, reports) {
        if (userCtx.roles.includes('chw')) {
          // CHWs: purge all reports older than 90 days
          const cutoff = Date.now() - (90 * 24 * 60 * 60 * 1000);
          return reports.filter(r => r.reported_date < cutoff).map(r => r._id);
        }
        // Supervisors: never purge
        return [];
      };

      const now = Date.now();
      const group = {
        contact: { _id: 'p1', type: 'person' },
        reports: [
          { _id: 'r1', reported_date: now - (100 * 24 * 60 * 60 * 1000) },
        ],
        messages: [],
        ids: ['p1', 'r1'],
      };

      const roles = {
        chw_hash: ['chw'],
        sup_hash: ['chw_supervisor'],
      };

      const result = engine._evaluateGroup(purgeFn, group, roles);

      expect(result.chw_hash.r1).to.be.true;
      expect(result.sup_hash.r1).to.be.false;
    });

    it('should handle purge of messages', () => {
      const purgeFn = function(userCtx, contact, reports, messages) {
        const cutoff = Date.now() - (90 * 24 * 60 * 60 * 1000);
        return [
          ...reports.filter(r => r.reported_date < cutoff).map(r => r._id),
          ...messages.filter(m => m.reported_date < cutoff).map(m => m._id),
        ];
      };

      const now = Date.now();
      const group = {
        contact: { _id: 'c1', type: 'clinic' },
        reports: [],
        messages: [
          { _id: 'm1', reported_date: now - (100 * 24 * 60 * 60 * 1000) },
          { _id: 'm2', reported_date: now },
        ],
        ids: ['c1', 'm1', 'm2'],
      };

      const result = engine._evaluateGroup(purgeFn, group, { h1: ['chw'] });

      expect(result.h1.m1).to.be.true;
      expect(result.h1.m2).to.be.false;
    });

    it('should handle deleted contact (empty object)', () => {
      const purgeFn = function(userCtx, contact, reports) {
        if (contact._deleted) {
          return reports.map(r => r._id);
        }
        return [];
      };

      const group = {
        contact: { _deleted: true },
        reports: [{ _id: 'r1' }, { _id: 'r2' }],
        messages: [],
        ids: ['r1', 'r2'],
      };

      const result = engine._evaluateGroup(purgeFn, group, { h1: ['chw'] });

      expect(result.h1.r1).to.be.true;
      expect(result.h1.r2).to.be.true;
    });
  });
});
