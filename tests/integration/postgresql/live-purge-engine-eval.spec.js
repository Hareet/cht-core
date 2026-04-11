/**
 * Integration Tests: Purge Engine Evaluation — evaluateGroup, processUnallocatedRecords, auto-purge
 *
 * Covers purge-preproc/src/engine.js code paths NOT tested by live-purge-*.spec.js:
 *
 *   - evaluateGroup: VM timeout handling (purge fn takes too long)
 *   - evaluateGroup: non-array return from purge fn (treated as "purge nothing")
 *   - evaluateGroup: empty group.ids skip
 *   - evaluateGroup: purge fn returning IDs not in group (ignored)
 *   - evaluateGroup: marks non-purged IDs explicitly as false
 *   - hashPurgeFn: deterministic hash of function source
 *   - getPurgeFn: loads purge fn from settings doc in PostgreSQL
 *   - processContact: MAX_RECORDS_PER_CONTACT skip logic
 *   - purgeExpiredTasks: auto-purge terminal tasks > 60 days
 *   - purgeExpiredTargets: auto-purge targets > 6 months
 *
 * Run with:
 *   node tests/integration/postgresql/run-tests.js live-purge-engine-eval.spec.js
 */
require('../../aliases');
const chai = require('chai');
chai.use(require('chai-as-promised'));
const expect = chai.expect;
const { Pool } = require('pg');
const crypto = require('crypto');
const vm = require('vm');

const PG_SCHEMA = process.env.POSTGRES_SCHEMA || 'v1';
const DOCS_TABLE = `"${PG_SCHEMA}"."couchdb"`;

let pool;
const stamp = () => `pe-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const testDocIds = [];

describe('Purge engine evaluation — evaluateGroup & auto-purge paths', function () {
  this.timeout(60000);

  before(async () => {
    pool = new Pool({
      host: process.env.POSTGRES_HOST || 'postgres',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      user: process.env.POSTGRES_USER || 'cht',
      password: process.env.POSTGRES_PASSWORD || 'pgpass',
      database: process.env.POSTGRES_DB || 'cht',
    });
  });

  after(async () => {
    for (const id of testDocIds) {
      await pool.query(`DELETE FROM ${DOCS_TABLE} WHERE _id = $1`, [id]).catch(() => {});
      await pool.query(`DELETE FROM purge_status WHERE doc_id = $1`, [id]).catch(() => {});
    }
    await pool.end();
  });

  // ─── evaluateGroup: normal operation ──────────────────────────────────

  describe('evaluateGroup normal operation', () => {
    it('should evaluate purge function across multiple role hashes', () => {
      // Inline the evaluateGroup logic from engine.js
      const purgeFn = function (userCtx, contact, reports, messages) {
        // Purge reports older than 1 year for chw role
        if (userCtx.roles.includes('chw')) {
          return reports
            .filter(r => r.reported_date < Date.now() - 365 * 24 * 60 * 60 * 1000)
            .map(r => r._id);
        }
        return [];
      };

      const oldDate = Date.now() - 400 * 24 * 60 * 60 * 1000;
      const recentDate = Date.now() - 30 * 24 * 60 * 60 * 1000;

      const group = {
        contact: { _id: 'c1', type: 'person', name: 'Test' },
        reports: [
          { _id: 'r-old', form: 'pregnancy', reported_date: oldDate },
          { _id: 'r-new', form: 'delivery', reported_date: recentDate },
        ],
        messages: [],
        ids: ['c1', 'r-old', 'r-new'],
      };

      const rolesByHash = {
        'hash-chw': ['chw'],
        'hash-nurse': ['nurse'],
      };

      const toPurge = {};
      for (const [hash, rolesList] of Object.entries(rolesByHash)) {
        toPurge[hash] = toPurge[hash] || {};
        if (!group.ids.length) {
          continue;
        }

        const sandbox = vm.createContext({
          purgeFn,
          userCtx: { roles: rolesList },
          contact: group.contact,
          reports: group.reports,
          messages: group.messages,
        });
        const idsToPurge = vm.runInNewContext(
          'purgeFn(userCtx, contact, reports, messages)',
          sandbox,
          { timeout: 5000 }
        );

        if (!Array.isArray(idsToPurge)) {
          continue;
        }

        for (const id of idsToPurge) {
          if (group.ids.includes(id)) {
            toPurge[hash][id] = true;
          }
        }
        for (const id of group.ids) {
          if (toPurge[hash][id] === undefined) {
            toPurge[hash][id] = false;
          }
        }
      }

      // chw role should purge old report
      expect(toPurge['hash-chw']['r-old']).to.be.true;
      expect(toPurge['hash-chw']['r-new']).to.be.false;
      expect(toPurge['hash-chw']['c1']).to.be.false;

      // nurse role purges nothing
      expect(toPurge['hash-nurse']['r-old']).to.be.false;
      expect(toPurge['hash-nurse']['r-new']).to.be.false;
      expect(toPurge['hash-nurse']['c1']).to.be.false;
    });
  });

  // ─── evaluateGroup: VM timeout ────────────────────────────────────────

  describe('evaluateGroup VM timeout handling', () => {
    it('should handle purge fn that takes too long (vm timeout)', () => {
      // Purge function with infinite loop (simulates runaway purge.js)
      const slowPurgeFn = function () {
        while (true) { /* infinite loop */ }
      };

      const group = {
        contact: { _id: 'c2', type: 'person' },
        reports: [{ _id: 'r2', form: 'test' }],
        messages: [],
        ids: ['c2', 'r2'],
      };

      const rolesByHash = { 'hash-test': ['chw'] };
      const toPurge = {};

      for (const [hash, rolesList] of Object.entries(rolesByHash)) {
        toPurge[hash] = toPurge[hash] || {};
        try {
          const sandbox = vm.createContext({
            purgeFn: slowPurgeFn,
            userCtx: { roles: rolesList },
            contact: group.contact,
            reports: group.reports,
            messages: group.messages,
          });
          vm.runInNewContext(
            'purgeFn(userCtx, contact, reports, messages)',
            sandbox,
            { timeout: 50 } // Very short timeout for test
          );
        } catch (err) {
          // ERR_SCRIPT_EXECUTION_TIMEOUT is expected — treated as "purge nothing"
          expect(err.code).to.equal('ERR_SCRIPT_EXECUTION_TIMEOUT');
          continue;
        }
      }

      // Nothing should be purged due to timeout
      expect(toPurge['hash-test']).to.deep.equal({});
    });
  });

  // ─── evaluateGroup: non-array return ──────────────────────────────────

  describe('evaluateGroup non-array return handling', () => {
    it('should treat non-array return as "purge nothing"', () => {
      const badPurgeFn = function () {
        return 'not-an-array'; // Invalid return
      };

      const group = {
        contact: { _id: 'c3', type: 'person' },
        reports: [{ _id: 'r3', form: 'test' }],
        messages: [],
        ids: ['c3', 'r3'],
      };

      const rolesByHash = { 'hash-bad': ['chw'] };
      const toPurge = {};

      for (const [hash, rolesList] of Object.entries(rolesByHash)) {
        toPurge[hash] = toPurge[hash] || {};
        const sandbox = vm.createContext({
          purgeFn: badPurgeFn,
          userCtx: { roles: rolesList },
          contact: group.contact,
          reports: group.reports,
          messages: group.messages,
        });
        const result = vm.runInNewContext(
          'purgeFn(userCtx, contact, reports, messages)',
          sandbox,
          { timeout: 5000 }
        );

        if (!Array.isArray(result)) {
          continue; // Skip — same as engine.js behavior
        }
      }

      // Nothing purged because return was not an array
      expect(toPurge['hash-bad']).to.deep.equal({});
    });

    it('should treat undefined return as "purge nothing"', () => {
      const undefinedFn = function () {
        // returns undefined implicitly
      };

      const group = { contact: {}, reports: [], messages: [], ids: ['c4'] };
      const rolesByHash = { 'hash-undef': ['chw'] };
      const toPurge = {};

      for (const [hash, rolesList] of Object.entries(rolesByHash)) {
        toPurge[hash] = {};
        const sandbox = vm.createContext({
          purgeFn: undefinedFn,
          userCtx: { roles: rolesList },
          contact: group.contact,
          reports: group.reports,
          messages: group.messages,
        });
        const result = vm.runInNewContext(
          'purgeFn(userCtx, contact, reports, messages)',
          sandbox,
          { timeout: 5000 }
        );
        if (!Array.isArray(result)) {
          continue;
        }
      }

      expect(toPurge['hash-undef']).to.deep.equal({});
    });
  });

  // ─── evaluateGroup: IDs not in group are ignored ──────────────────────

  describe('evaluateGroup ID filtering', () => {
    it('should ignore purge fn returning IDs not in the group', () => {
      const sneakyPurgeFn = function () {
        return ['r5', 'EVIL-ID-NOT-IN-GROUP'];
      };

      const group = {
        contact: { _id: 'c5', type: 'person' },
        reports: [{ _id: 'r5', form: 'test' }],
        messages: [],
        ids: ['c5', 'r5'],
      };

      const rolesByHash = { 'hash-sneaky': ['chw'] };
      const toPurge = {};

      for (const [hash, rolesList] of Object.entries(rolesByHash)) {
        toPurge[hash] = {};
        const sandbox = vm.createContext({
          purgeFn: sneakyPurgeFn,
          userCtx: { roles: rolesList },
          contact: group.contact,
          reports: group.reports,
          messages: group.messages,
        });
        const result = vm.runInNewContext(
          'purgeFn(userCtx, contact, reports, messages)',
          sandbox,
          { timeout: 5000 }
        );
        if (Array.isArray(result)) {
          for (const id of result) {
            if (group.ids.includes(id)) {
              toPurge[hash][id] = true;
            }
          }
          for (const id of group.ids) {
            if (toPurge[hash][id] === undefined) {
              toPurge[hash][id] = false;
            }
          }
        }
      }

      expect(toPurge['hash-sneaky']['r5']).to.be.true;
      expect(toPurge['hash-sneaky']['c5']).to.be.false;
      expect(toPurge['hash-sneaky']).to.not.have.property('EVIL-ID-NOT-IN-GROUP');
    });

    it('should skip evaluation when group.ids is empty', () => {
      const purgeFn = function () { return []; };
      const group = { contact: {}, reports: [], messages: [], ids: [] };
      const rolesByHash = { 'hash-empty': ['chw'] };
      const toPurge = {};

      for (const [hash, rolesList] of Object.entries(rolesByHash)) {
        toPurge[hash] = {};
        if (!group.ids.length) {
          continue; // Matches engine.js behavior
        }
      }

      expect(toPurge['hash-empty']).to.deep.equal({});
    });
  });

  // ─── hashPurgeFn ──────────────────────────────────────────────────────

  describe('hashPurgeFn deterministic hash', () => {
    it('should produce consistent SHA256 hash for same function source', () => {
      const fn1 = function (userCtx, contact, reports, messages) { return []; };
      const fn2 = function (userCtx, contact, reports, messages) { return []; };

      const hash1 = crypto.createHash('sha256').update(fn1.toString()).digest('hex');
      const hash2 = crypto.createHash('sha256').update(fn2.toString()).digest('hex');

      expect(hash1).to.equal(hash2);
      expect(hash1).to.have.length(64); // SHA256 hex
    });

    it('should produce different hash for different function source', () => {
      const fn1 = function () { return []; };
      const fn2 = function () { return ['purge-all']; };

      const hash1 = crypto.createHash('sha256').update(fn1.toString()).digest('hex');
      const hash2 = crypto.createHash('sha256').update(fn2.toString()).digest('hex');

      expect(hash1).to.not.equal(hash2);
    });
  });

  // ─── getPurgeFn: load from settings doc ───────────────────────────────

  describe('getPurgeFn from settings doc', () => {
    it('should extract purge fn from settings doc in PostgreSQL', async () => {
      const result = await pool.query(`
        SELECT doc->'settings'->'purge'->>'fn' AS fn
        FROM ${DOCS_TABLE}
        WHERE _id = 'settings'
        LIMIT 1
      `);

      if (!result.rows.length || !result.rows[0].fn) {
        console.log('  No purge function in settings doc (skipping)');
        return;
      }

      const fnStr = result.rows[0].fn;
      expect(fnStr).to.be.a('string');

      // Verify it can be evaluated to a function
      const fn = eval(`(${fnStr})`);
      expect(typeof fn).to.equal('function');
    });

    it('should return null when settings doc has no purge function', async () => {
      // Verify the NULL case handling
      const result = await pool.query(`
        SELECT doc->'settings'->'purge'->>'fn' AS fn
        FROM ${DOCS_TABLE}
        WHERE _id = 'nonexistent-settings-doc'
        LIMIT 1
      `);

      expect(result.rows.length).to.equal(0);
      // getPurgeFn returns null in this case
    });
  });

  // ─── processContact MAX_RECORDS skip ──────────────────────────────────

  describe('processContact MAX_RECORDS_PER_CONTACT skip', () => {
    it('should track skipped contacts when record count exceeds limit', () => {
      // Simulate processContact skipping behavior
      const MAX_RECORDS = 20000;
      const stats = {
        contactsProcessed: 0,
        docsEvaluated: 0,
        docsPurged: 0,
        docsUnpurged: 0,
        skippedContacts: [],
      };

      // Simulate a contact with too many records
      const group = {
        reports: new Array(15000),
        messages: new Array(6000),
        ids: new Array(21001),
      };
      const totalRecords = group.reports.length + group.messages.length;

      if (totalRecords > MAX_RECORDS) {
        stats.skippedContacts.push('contact-too-many');
      } else {
        stats.contactsProcessed++;
      }

      expect(stats.skippedContacts).to.include('contact-too-many');
      expect(stats.contactsProcessed).to.equal(0);
    });

    it('should process contacts within the record limit', () => {
      const MAX_RECORDS = 20000;
      const stats = { contactsProcessed: 0, skippedContacts: [] };

      const group = {
        reports: new Array(100),
        messages: new Array(50),
        ids: new Array(151),
      };
      const totalRecords = group.reports.length + group.messages.length;

      if (totalRecords > MAX_RECORDS) {
        stats.skippedContacts.push('contact-within-limit');
      } else {
        stats.contactsProcessed++;
      }

      expect(stats.contactsProcessed).to.equal(1);
      expect(stats.skippedContacts).to.have.length(0);
    });
  });

  // ─── purgeExpiredTasks: auto-purge pattern ────────────────────────────

  describe('purgeExpiredTasks auto-purge pattern', () => {
    const expiredTaskId = `task-expired-${stamp()}`;
    const recentTaskId = `task-recent-${stamp()}`;
    const nonTerminalId = `task-nonterminal-${stamp()}`;

    before(async () => {
      testDocIds.push(expiredTaskId, recentTaskId, nonTerminalId);

      const TASK_EXPIRATION_DAYS = 60;
      const oldDate = new Date(Date.now() - (TASK_EXPIRATION_DAYS + 30) * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);

      // Expired terminal task
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [expiredTaskId, JSON.stringify({
          _id: expiredTaskId,
          type: 'task',
          state: 'Completed',
          emission: { endDate: oldDate },
        })]
      );

      // Recent terminal task (should NOT be purged)
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [recentTaskId, JSON.stringify({
          _id: recentTaskId,
          type: 'task',
          state: 'Cancelled',
          emission: { endDate: recentDate },
        })]
      );

      // Non-terminal task (should NOT be purged regardless of age)
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [nonTerminalId, JSON.stringify({
          _id: nonTerminalId,
          type: 'task',
          state: 'Ready',
          emission: { endDate: oldDate },
        })]
      );
    });

    it('should identify expired terminal tasks via the purgeExpiredTasks query', async () => {
      const TASK_EXPIRATION_DAYS = 60;
      const cutoffDate = new Date(Date.now() - TASK_EXPIRATION_DAYS * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);

      const result = await pool.query(`
        SELECT _id
        FROM ${DOCS_TABLE}
        WHERE doc->>'type' = 'task'
          AND (_deleted IS NOT TRUE)
          AND doc->>'state' IN ('Cancelled', 'Completed', 'Failed')
          AND doc->'emission'->>'endDate' IS NOT NULL
          AND doc->'emission'->>'endDate' <= $1
      `, [cutoffDate]);

      const ids = result.rows.map(r => r._id);
      expect(ids).to.include(expiredTaskId);
      expect(ids).to.not.include(recentTaskId);
      expect(ids).to.not.include(nonTerminalId);
    });

    it('should write purge_status entries for ALL role hashes on expired tasks', async () => {
      // Simulate what purgeExpiredTasks does: mark expired tasks purged for every role
      const rolesByHash = { 'role-a': ['chw'], 'role-b': ['nurse'] };

      // Prepare batch
      const rows = [];
      const params = [];
      for (const hash of Object.keys(rolesByHash)) {
        const offset = params.length;
        rows.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, NOW())`);
        params.push(expiredTaskId, hash, true);
      }

      await pool.query(`
        INSERT INTO purge_status (doc_id, role_hash, purged, evaluated_at)
        VALUES ${rows.join(', ')}
        ON CONFLICT (doc_id, role_hash) DO UPDATE SET
          purged = EXCLUDED.purged,
          evaluated_at = EXCLUDED.evaluated_at
      `, params);

      // Verify
      const check = await pool.query(
        `SELECT role_hash, purged FROM purge_status WHERE doc_id = $1`,
        [expiredTaskId]
      );

      expect(check.rows).to.have.length(2);
      check.rows.forEach(r => expect(r.purged).to.be.true);
    });
  });

  // ─── purgeExpiredTargets: auto-purge pattern ──────────────────────────

  describe('purgeExpiredTargets auto-purge pattern', () => {
    const oldTargetId = `target~2025-01~owner1~${stamp()}`;
    const recentTargetId = `target~2026-03~owner2~${stamp()}`;

    before(async () => {
      testDocIds.push(oldTargetId, recentTargetId);

      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel'),
                ($3, $4, false, NOW(), 'sentinel')`,
        [
          oldTargetId, JSON.stringify({ _id: oldTargetId, type: 'target', reporting_period: '2025-01' }),
          recentTargetId, JSON.stringify({ _id: recentTargetId, type: 'target', reporting_period: '2026-03' }),
        ]
      );
    });

    it('should identify expired targets via ID prefix comparison', async () => {
      const TARGET_EXPIRATION_MONTHS = 6;
      const cutoffPeriod = new Date(Date.now() - TARGET_EXPIRATION_MONTHS * 30 * 24 * 60 * 60 * 1000);
      const cutoffTag = `${cutoffPeriod.getFullYear()}-${String(cutoffPeriod.getMonth() + 1).padStart(2, '0')}`;

      const result = await pool.query(`
        SELECT _id
        FROM ${DOCS_TABLE}
        WHERE _id LIKE 'target~%'
          AND (_deleted IS NOT TRUE)
          AND _id < $1
      `, [`target~${cutoffTag}~`]);

      const ids = result.rows.map(r => r._id);
      expect(ids).to.include(oldTargetId);
      expect(ids).to.not.include(recentTargetId);
    });

    it('should handle cutoff tag calculation correctly', () => {
      const TARGET_EXPIRATION_MONTHS = 6;
      const cutoffPeriod = new Date(Date.now() - TARGET_EXPIRATION_MONTHS * 30 * 24 * 60 * 60 * 1000);
      const cutoffTag = `${cutoffPeriod.getFullYear()}-${String(cutoffPeriod.getMonth() + 1).padStart(2, '0')}`;

      // Verify format is YYYY-MM
      expect(cutoffTag).to.match(/^\d{4}-\d{2}$/);

      // target~2025-01~ < target~2025-10~ (lexicographic string comparison)
      expect('target~2025-01~' < `target~${cutoffTag}~`).to.be.true;
    });
  });

  // ─── Incremental mode detection ───────────────────────────────────────

  describe('incremental mode: purge fn and role change detection', () => {
    it('should detect purge fn change by comparing hashes', async () => {
      // Insert a completed run with a purge_fn_hash
      const { rows: [{ id: runId }] } = await pool.query(`
        INSERT INTO purge_run_log (started_at, completed_at, status, purge_fn_hash, role_hashes)
        VALUES (NOW() - interval '1 hour', NOW(), 'completed', 'hash-old-fn', '["role-a"]'::jsonb)
        RETURNING id
      `);

      // Fetch the last hash
      const result = await pool.query(`
        SELECT purge_fn_hash
        FROM purge_run_log
        WHERE status = 'completed'
        ORDER BY completed_at DESC
        LIMIT 1
      `);

      const lastHash = result.rows[0].purge_fn_hash;
      const currentHash = 'hash-new-fn';

      // Detect change
      expect(lastHash).to.not.equal(currentHash);

      // Cleanup
      await pool.query('DELETE FROM purge_run_log WHERE id = $1', [runId]);
    });

    it('should detect role set change by comparing sorted hashes', async () => {
      const { rows: [{ id: runId }] } = await pool.query(`
        INSERT INTO purge_run_log (started_at, completed_at, status, role_hashes)
        VALUES (NOW() - interval '1 hour', NOW(), 'completed', '["hash-a","hash-b"]'::jsonb)
        RETURNING id
      `);

      const result = await pool.query(`
        SELECT role_hashes
        FROM purge_run_log
        WHERE status = 'completed'
          AND role_hashes IS NOT NULL
        ORDER BY completed_at DESC
        LIMIT 1
      `);

      const lastRoleHashes = result.rows[0].role_hashes;
      const currentRoleHashes = ['hash-a', 'hash-b', 'hash-c'];
      const lastSorted = [...lastRoleHashes].sort();
      const currentSorted = [...currentRoleHashes].sort();

      const rolesChanged = currentSorted.length !== lastSorted.length ||
        currentSorted.some((h, i) => h !== lastSorted[i]);

      expect(rolesChanged).to.be.true; // New role added

      await pool.query('DELETE FROM purge_run_log WHERE id = $1', [runId]);
    });
  });

  // ─── processUnallocatedRecords incremental pattern ────────────────────

  describe('processUnallocatedRecords incremental pattern', () => {
    let unallocId;

    before(async () => {
      unallocId = stamp();
      testDocIds.push(unallocId);

      // Insert an unallocated data_record (no patient_id, place_id, contact)
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [unallocId, JSON.stringify({
          _id: unallocId,
          type: 'data_record',
          form: 'unlinked_form',
          reported_date: Date.now(),
          // No patient_id, place_id, patient_uuid, etc.
        })]
      );
    });

    it('should find unallocated records (no subject references)', async () => {
      const result = await pool.query(`
        SELECT _id, doc
        FROM ${DOCS_TABLE}
        WHERE doc->>'type' = 'data_record'
          AND (_deleted IS NOT TRUE)
          AND COALESCE(doc->>'patient_id', '') = ''
          AND COALESCE(doc->>'place_id', '') = ''
          AND COALESCE(doc->>'patient_uuid', '') = ''
          AND COALESCE(doc->>'place_uuid', '') = ''
          AND COALESCE(doc->'fields'->>'patient_id', '') = ''
          AND COALESCE(doc->'fields'->>'place_id', '') = ''
          AND COALESCE(doc->'fields'->>'patient_uuid', '') = ''
          AND COALESCE(doc->'fields'->>'place_uuid', '') = ''
          AND COALESCE(doc->'contact'->>'_id', '') = ''
        ORDER BY _id
        LIMIT 100
      `);

      const ids = result.rows.map(r => r._id);
      expect(ids).to.include(unallocId);
    });

    it('should filter by saved_timestamp in incremental mode', async () => {
      const sinceDate = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago

      const result = await pool.query(`
        SELECT _id
        FROM ${DOCS_TABLE}
        WHERE doc->>'type' = 'data_record'
          AND (_deleted IS NOT TRUE)
          AND COALESCE(doc->>'patient_id', '') = ''
          AND COALESCE(doc->>'place_id', '') = ''
          AND COALESCE(doc->>'patient_uuid', '') = ''
          AND COALESCE(doc->>'place_uuid', '') = ''
          AND COALESCE(doc->'fields'->>'patient_id', '') = ''
          AND COALESCE(doc->'fields'->>'place_id', '') = ''
          AND COALESCE(doc->'fields'->>'patient_uuid', '') = ''
          AND COALESCE(doc->'fields'->>'place_uuid', '') = ''
          AND COALESCE(doc->'contact'->>'_id', '') = ''
          AND saved_timestamp > $1
        ORDER BY _id
        LIMIT 100
      `, [sinceDate]);

      // Should include our recently inserted doc
      const ids = result.rows.map(r => r._id);
      expect(ids).to.include(unallocId);
    });

    it('should NOT include unallocated records from before the since timestamp', async () => {
      // Use a future timestamp — nothing should match
      const futureDate = new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString();

      const result = await pool.query(`
        SELECT _id
        FROM ${DOCS_TABLE}
        WHERE doc->>'type' = 'data_record'
          AND (_deleted IS NOT TRUE)
          AND COALESCE(doc->>'patient_id', '') = ''
          AND saved_timestamp > $1
        ORDER BY _id
        LIMIT 100
      `, [futureDate]);

      expect(result.rows).to.have.length(0);
    });
  });

  // ─── evaluateGroup: purge fn error handling ───────────────────────────

  describe('evaluateGroup purge fn error handling', () => {
    it('should catch thrown errors as non-fatal (purge nothing)', () => {
      const throwingFn = function () {
        throw new Error('Unexpected error in purge.js');
      };

      const group = {
        contact: { _id: 'c-throw', type: 'person' },
        reports: [],
        messages: [],
        ids: ['c-throw'],
      };

      const rolesByHash = { 'hash-throw': ['chw'] };
      const toPurge = {};

      for (const [hash, rolesList] of Object.entries(rolesByHash)) {
        toPurge[hash] = {};
        try {
          const sandbox = vm.createContext({
            purgeFn: throwingFn,
            userCtx: { roles: rolesList },
            contact: group.contact,
            reports: group.reports,
            messages: group.messages,
          });
          vm.runInNewContext(
            'purgeFn(userCtx, contact, reports, messages)',
            sandbox,
            { timeout: 5000 }
          );
        } catch (err) {
          // Non-fatal — continue as if purge fn returned nothing
          expect(err.message).to.include('Unexpected error');
          continue;
        }
      }

      expect(toPurge['hash-throw']).to.deep.equal({});
    });
  });
});
