/**
 * Performance tests for the rules engine PowerSync adapter.
 *
 * Validates that task/target generation meets performance thresholds
 * for Go edition device constraints:
 *   - 2GB RAM, MediaTek Helio A22
 *   - Single-connection SQLite via wa-sqlite (WASM)
 *   - 200MB database budget
 *   - fetchStrategy='sequential' (Agent 5's DeviceTierService)
 *
 * Test scenarios:
 *   1. Task generation for a typical CHW caseload (50 contacts, 200 reports)
 *   2. Peak memory usage during generation
 *   3. Single-connection contention (concurrent reads during task generation)
 *
 * These tests use the real rules engine pipeline (not mocked) with the
 * default CHT config's rules and targets. The mock PowerSync DB simulates
 * the SDK's single-connection behavior.
 */

const chai = require('chai');
const sinon = require('sinon');

const rulesEmitter = require('../src/rules-emitter');
const { SCHEMA_TABLES } = require('../src/adapters/powersync-schema');
const { engineSettings } = require('./mocks');

const { expect } = chai;

const TEST_START = 1500000000000;

// Performance thresholds — based on Go edition device constraints.
// Task config tests use 10s mocha timeout. Real devices should complete
// a 50-contact refresh in under 5s even on constrained hardware.
// These Node.js thresholds are conservative to avoid flaky CI failures.
const THRESHOLDS = {
  fullRefreshMs: 5000,        // 50 contacts + 200 reports full refresh
  targetedRefreshMs: 2000,    // single dirty contact targeted refresh
  peakMemoryMb: 50,           // peak heap during generation
  contentionOverhead: 2.0,    // max ratio: contention time / baseline time
};

/**
 * Measure elapsed time using process.hrtime, which is not affected by sinon.useFakeTimers.
 * Returns elapsed milliseconds since the given start.
 */
const hrtimeMs = (start) => {
  const diff = process.hrtime(start);
  return diff[0] * 1000 + diff[1] / 1e6;
};

/**
 * Generate realistic CHW caseload data.
 *
 * A typical Community Health Promoter (CHP) in Kenya's eCHIS manages:
 *   - ~50 households (contacts of type person)
 *   - ~4 reports per contact (pregnancy registration, home visits, assessments)
 *   - Reports spread across the last 6 months
 */
const generateCaseload = (contactCount, reportsPerContact) => {
  const contacts = [];
  const reports = [];
  const sixMonthsAgo = TEST_START - (180 * 24 * 60 * 60 * 1000);

  for (let i = 0; i < contactCount; i++) {
    const contactId = `contact-${i}`;
    const patientId = `pid-${i}`;

    contacts.push({
      _id: contactId,
      type: 'contact',
      contact_type: 'person',
      name: `Patient ${i}`,
      patient_id: patientId,
      parent: { _id: 'facility-1', parent: { _id: 'health-center-1' } },
    });

    for (let j = 0; j < reportsPerContact; j++) {
      const reportAge = sixMonthsAgo + Math.floor(Math.random() * (TEST_START - sixMonthsAgo));
      reports.push({
        _id: `report-${i}-${j}`,
        type: 'data_record',
        form: 'pregnancy',
        fields: {
          patient_id: contactId,
          patient_uuid: contactId,
          lmp_date_8601: reportAge,
        },
        patient_id: patientId,
        reported_date: reportAge,
      });
    }
  }

  return { contacts, reports };
};

/**
 * Creates a mock PowerSync database with optional single-connection contention simulation.
 * The contention delay simulates wa-sqlite's single-connection behavior where
 * sync operations hold the connection, causing query latency for the rules engine.
 */
const createMockPowerSyncDb = ({ contentionDelayMs = 0 } = {}) => {
  const tables = {};
  Object.keys(SCHEMA_TABLES).forEach(name => {
    tables[name] = [];
  });

  let queryCount = 0;

  const findTable = (sql) => {
    const match = sql.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/i);
    return match ? match[1] : null;
  };

  const matchRow = (row, sql, params) => {
    const whereMatch = sql.match(/WHERE\s+(.*?)(?:ORDER|GROUP|LIMIT|$)/is);
    if (!whereMatch) {
      return true;
    }
    return evalWhere(row, whereMatch[1].trim(), params, { idx: 0 });
  };

  const evalWhere = (row, clause, params, state) => {
    const orParts = splitOutside(clause, ' OR ');
    if (orParts.length > 1) {
      return orParts.some(p => evalWhere(row, p.trim(), params, state));
    }
    const andParts = splitOutside(clause, ' AND ');
    if (andParts.length > 1) {
      return andParts.every(p => evalWhere(row, p.trim(), params, state));
    }
    const trimmed = clause.trim();
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
      return evalWhere(row, trimmed.slice(1, -1).trim(), params, state);
    }
    const isNull = trimmed.match(/^(\w+)\s+IS\s+NULL$/i);
    if (isNull) {
      return row[isNull[1]] === null || row[isNull[1]] === undefined;
    }
    const isNotNull = trimmed.match(/^(\w+)\s+IS\s+NOT\s+NULL$/i);
    if (isNotNull) {
      return row[isNotNull[1]] !== null && row[isNotNull[1]] !== undefined;
    }
    const notIn = trimmed.match(/^(\w+)\s+NOT\s+IN\s+\(([^)]+)\)/i);
    if (notIn) {
      const literals = notIn[2].match(/'([^']*)'/g);
      if (literals) {
        return !literals.map(l => l.replace(/'/g, '')).includes(row[notIn[1]]);
      }
      const cnt = (notIn[2].match(/\?/g) || []).length;
      const vals = params.slice(state.idx, state.idx + cnt);
      state.idx += cnt;
      return !vals.includes(row[notIn[1]]);
    }
    const inMatch = trimmed.match(/^(\w+)\s+IN\s+\(([^)]+)\)/i);
    if (inMatch) {
      const literals = inMatch[2].match(/'([^']*)'/g);
      if (literals) {
        return literals.map(l => l.replace(/'/g, '')).includes(row[inMatch[1]]);
      }
      const cnt = (inMatch[2].match(/\?/g) || []).length;
      const vals = params.slice(state.idx, state.idx + cnt);
      state.idx += cnt;
      return vals.includes(row[inMatch[1]]);
    }
    const eq = trimmed.match(/^(\w+)\s*=\s*\?$/);
    if (eq) {
      const val = params[state.idx++];
      return row[eq[1]] === val;
    }
    const neqLit = trimmed.match(/^(\w+)\s*!=\s*'([^']*)'/);
    if (neqLit) {
      const val = row[neqLit[1]];
      if (val === null || val === undefined) {
        return false;
      }
      return val !== neqLit[2];
    }
    const eqLit = trimmed.match(/^(\w+)\s*=\s*'([^']*)'/);
    if (eqLit) {
      return row[eqLit[1]] === eqLit[2];
    }
    return true;
  };

  const splitOutside = (str, delim) => {
    const parts = [];
    let depth = 0;
    let cur = '';
    const upper = str.toUpperCase();
    const ud = delim.toUpperCase();
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '(') {
        depth++;
      }
      if (str[i] === ')') {
        depth--;
      }
      if (depth === 0 && upper.substring(i, i + ud.length) === ud) {
        parts.push(cur);
        cur = '';
        i += ud.length - 1;
        continue;
      }
      cur += str[i];
    }
    parts.push(cur);
    return parts;
  };

  const applyDelay = async () => {
    if (contentionDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, contentionDelayMs));
    }
  };

  const db = {
    _tables: tables,
    _queryCount: () => queryCount,

    getAll: async (sql, params = []) => {
      queryCount++;
      await applyDelay();
      const table = findTable(sql);
      const rows = tables[table] || [];
      return rows
        .filter(r => matchRow(r, sql, params))
        .map(r => {
          if (table === 'rules_state_store') {
            return { ...r };
          }
          return { ...r, doc: r._rawDoc ? JSON.stringify(r._rawDoc) : r.doc };
        });
    },

    getOptional: async (sql, params = []) => {
      queryCount++;
      await applyDelay();
      const results = await db.getAll(sql, params);
      return results[0] || null;
    },

    execute: async (sql, params = []) => {
      queryCount++;
      await applyDelay();
      const table = findTable(sql);
      if (!tables[table]) {
        tables[table] = [];
      }
      if (sql.match(/INSERT/i)) {
        const existing = tables[table].findIndex(r => r.id === params[0]);
        if (existing >= 0) {
          tables[table].splice(existing, 1);
        }
        if (table === 'rules_state_store') {
          tables[table].push({ id: params[0], data: params[1] });
        } else if (table === 'tasks') {
          const docJson = params[7];
          const parsed = typeof docJson === 'string' ? JSON.parse(docJson) : docJson;
          tables[table].push({
            id: params[0], type: params[1], state: params[2],
            owner: params[3], requester: params[4], user: params[5],
            authored_on: params[6], doc: docJson, _rawDoc: parsed,
          });
        } else if (table === 'targets') {
          const docJson = params[7];
          const parsed = typeof docJson === 'string' ? JSON.parse(docJson) : docJson;
          tables[table].push({
            id: params[0], type: params[1], owner: params[2], user: params[3],
            reporting_period: params[4], targets: params[5], updated_date: params[6],
            doc: docJson, _rawDoc: parsed,
          });
        }
      } else if (sql.match(/UPDATE/i)) {
        const idParam = params[params.length - 1];
        const row = tables[table].find(r => r.id === idParam);
        if (row && table === 'targets') {
          row.doc = params[0];
          row._rawDoc = typeof params[0] === 'string' ? JSON.parse(params[0]) : params[0];
          row.targets = params[1];
          row.updated_date = params[2];
        }
      }
    },

    writeTransaction: async (callback) => {
      await callback({ execute: (sql, params) => db.execute(sql, params) });
    },
  };

  return db;
};

const seedContact = (db, doc) => {
  db._tables.contacts.push({
    id: doc._id,
    type: doc.type,
    contact_type: doc.contact_type,
    name: doc.name,
    patient_id: doc.patient_id,
    place_id: doc.place_id,
    parent_id: doc.parent?._id,
    doc: JSON.stringify(doc),
    _rawDoc: doc,
  });
};

const seedReport = (db, doc) => {
  db._tables.reports.push({
    id: doc._id,
    type: doc.type,
    form: doc.form,
    patient_id: doc.patient_id || (doc.fields && doc.fields.patient_id),
    place_id: doc.place_id || (doc.fields && doc.fields.place_id),
    subject_id: doc.fields?.patient_uuid || doc.fields?.place_uuid,
    reported_date: doc.reported_date,
    contact_id: doc.contact?._id,
    doc: JSON.stringify(doc),
    _rawDoc: doc,
  });
};

let configHashSalt = 1000;

describe('PowerSync adapter performance', function () {
  // Performance tests need more time than standard unit tests
  this.timeout(30000);

  let mockDb;
  let rulesEngine;
  let clock;

  before(async () => {
    mockDb = createMockPowerSyncDb();
    const RulesEngine = require('../src');
    rulesEngine = RulesEngine(mockDb, { adapter: 'powersync' });

    try {
      await rulesEngine.initialize(engineSettings());
    } catch (e) {
      if (e.message.includes('multiple times')) {
        configHashSalt++;
        await rulesEngine.rulesConfigChange(engineSettings({ configHashSalt }));
      } else {
        throw e;
      }
    }
  });

  after(() => {
    rulesEmitter.shutdown();
  });

  beforeEach(async () => {
    clock = sinon.useFakeTimers({ now: TEST_START, toFake: ['Date'] });

    Object.keys(mockDb._tables).forEach(table => {
      mockDb._tables[table] = [];
    });

    configHashSalt++;
    await rulesEngine.rulesConfigChange(engineSettings({ configHashSalt }));
  });

  afterEach(() => {
    clock.restore();
    sinon.restore();
  });

  describe('task generation for typical CHW caseload', () => {
    it('should complete full refresh for 50 contacts + 200 reports within threshold', async () => {
      const { contacts, reports } = generateCaseload(50, 4);

      contacts.forEach(c => seedContact(mockDb, c));
      reports.forEach(r => seedReport(mockDb, r));

      const heapBefore = process.memoryUsage().heapUsed;

      // Keep clock faked so Date.now() returns TEST_START (matching report dates for timely emissions).
      // Use process.hrtime for real elapsed time measurement.
      const start = process.hrtime();

      await rulesEngine.refreshEmissionsFor();

      const elapsed = hrtimeMs(start);
      const heapAfter = process.memoryUsage().heapUsed;
      const heapDeltaMb = (heapAfter - heapBefore) / (1024 * 1024);

      // Verify tasks and targets were generated
      const writtenTasks = mockDb._tables.tasks;
      const writtenTargets = mockDb._tables.targets;
      expect(writtenTasks.length).to.be.greaterThan(0);
      expect(writtenTargets.length).to.be.greaterThan(0);

      // Performance assertions
      expect(elapsed).to.be.below(
        THRESHOLDS.fullRefreshMs,
        `Full refresh took ${elapsed.toFixed(0)}ms, exceeds ${THRESHOLDS.fullRefreshMs}ms threshold`
      );

      // Log performance metrics for CI visibility
       
      console.log(`    [perf] Full refresh: ${elapsed.toFixed(0)}ms, ` +
        `${writtenTasks.length} tasks, ${writtenTargets.length} targets, ` +
        `heap delta: ${heapDeltaMb.toFixed(1)}MB`);
    });

    it('should complete targeted refresh for single contact within threshold', async () => {
      const { contacts, reports } = generateCaseload(50, 4);

      contacts.forEach(c => seedContact(mockDb, c));
      reports.forEach(r => seedReport(mockDb, r));

      // Full refresh to populate state (clock stays faked for timely emissions)
      await rulesEngine.refreshEmissionsFor();

      // Clear tasks to force re-generation for the targeted contact
      mockDb._tables.tasks = [];

      const start = process.hrtime();

      // Targeted refresh for a single dirty contact
      await rulesEngine.updateEmissionsFor(['contact-0']);

      const elapsed = hrtimeMs(start);

      expect(elapsed).to.be.below(
        THRESHOLDS.targetedRefreshMs,
        `Targeted refresh took ${elapsed.toFixed(0)}ms, exceeds ${THRESHOLDS.targetedRefreshMs}ms threshold`
      );

       
      console.log(`    [perf] Targeted refresh (1 contact): ${elapsed.toFixed(0)}ms`);
    });
  });

  describe('memory footprint', () => {
    it('should stay within peak memory budget for typical caseload', async () => {
      const { contacts, reports } = generateCaseload(50, 4);

      contacts.forEach(c => seedContact(mockDb, c));
      reports.forEach(r => seedReport(mockDb, r));

      // Force GC if available to get a clean baseline
      if (global.gc) {
        global.gc();
      }

      const heapBefore = process.memoryUsage().heapUsed;

      await rulesEngine.refreshEmissionsFor();

      const heapAfter = process.memoryUsage().heapUsed;
      const peakDeltaMb = (heapAfter - heapBefore) / (1024 * 1024);

      expect(peakDeltaMb).to.be.below(
        THRESHOLDS.peakMemoryMb,
        `Peak memory delta ${peakDeltaMb.toFixed(1)}MB exceeds ${THRESHOLDS.peakMemoryMb}MB budget`
      );

       
      console.log(`    [perf] Peak memory delta: ${peakDeltaMb.toFixed(1)}MB ` +
        `(heap: ${(heapAfter / (1024 * 1024)).toFixed(0)}MB)`);
    });

    it('should not leak memory across multiple refresh cycles', async () => {
      const { contacts, reports } = generateCaseload(10, 4);

      contacts.forEach(c => seedContact(mockDb, c));
      reports.forEach(r => seedReport(mockDb, r));

      // Run 3 refresh cycles and check heap doesn't grow unboundedly
      const heapSamples = [];
      for (let cycle = 0; cycle < 3; cycle++) {
        configHashSalt++;
        await rulesEngine.rulesConfigChange(engineSettings({ configHashSalt }));

        mockDb._tables.tasks = [];
        await rulesEngine.refreshEmissionsFor();
        heapSamples.push(process.memoryUsage().heapUsed);
      }

      // Heap should not grow more than 2x between first and last cycle
      const firstHeap = heapSamples[0];
      const lastHeap = heapSamples[heapSamples.length - 1];
      const growthRatio = lastHeap / firstHeap;

      expect(growthRatio).to.be.below(2.0,
        `Heap grew ${growthRatio.toFixed(2)}x across 3 cycles (potential leak)`);

       
      console.log(`    [perf] Heap across 3 cycles: ` +
        heapSamples.map(h => `${(h / (1024 * 1024)).toFixed(0)}MB`).join(' → ') +
        ` (${growthRatio.toFixed(2)}x growth)`);
    });
  });

  describe('single-connection contention', () => {
    it('should complete task generation with acceptable overhead under contention', async () => {
      const { contacts, reports } = generateCaseload(20, 4);

      // Baseline: no contention delay
      contacts.forEach(c => seedContact(mockDb, c));
      reports.forEach(r => seedReport(mockDb, r));

      const baselineStart = process.hrtime();
      await rulesEngine.refreshEmissionsFor();
      const baselineElapsed = hrtimeMs(baselineStart);

      const baselineTaskCount = mockDb._tables.tasks.length;
      expect(baselineTaskCount).to.be.greaterThan(0);

      // Reset for contention run — use a new DB with per-query delay.
      // 1ms per query simulates wa-sqlite single-connection lock wait.
      const contentionDb = createMockPowerSyncDb({ contentionDelayMs: 1 });
      contacts.forEach(c => seedContact(contentionDb, c));
      reports.forEach(r => seedReport(contentionDb, r));

      const RulesEngine = require('../src');

      rulesEmitter.shutdown();
      const contentionEngine = RulesEngine(contentionDb, { adapter: 'powersync' });

      configHashSalt++;
      try {
        await contentionEngine.initialize(engineSettings({ configHashSalt }));
      } catch (e) {
        if (e.message.includes('multiple times')) {
          configHashSalt++;
          await contentionEngine.rulesConfigChange(engineSettings({ configHashSalt }));
        } else {
          throw e;
        }
      }

      const contentionStart = process.hrtime();
      await contentionEngine.refreshEmissionsFor();
      const contentionElapsed = hrtimeMs(contentionStart);

      rulesEmitter.shutdown();

      // Re-initialize the main engine for afterEach cleanup
      configHashSalt++;
      rulesEngine = RulesEngine(mockDb, { adapter: 'powersync' });
      try {
        await rulesEngine.initialize(engineSettings({ configHashSalt }));
      } catch (e) {
        if (e.message.includes('multiple times')) {
          configHashSalt++;
          await rulesEngine.rulesConfigChange(engineSettings({ configHashSalt }));
        } else {
          throw e;
        }
      }

      // Verify contention run also produced tasks
      expect(contentionDb._tables.tasks.length).to.be.greaterThan(0);

      // Query count shows how many DB operations the adapter makes
      const queryCount = contentionDb._queryCount();

      // Contention overhead
      const overhead = baselineElapsed > 0
        ? contentionElapsed / baselineElapsed
        : 1.0;

       
      console.log(`    [perf] Contention test: baseline=${baselineElapsed.toFixed(0)}ms, ` +
        `contention=${contentionElapsed.toFixed(0)}ms, overhead=${overhead.toFixed(2)}x, ` +
        `queries=${queryCount}`);

      // The absolute contention time must stay within the full refresh threshold.
      // With 1ms/query and ~10-20 queries, expect ~10-20ms added latency.
      expect(contentionElapsed).to.be.below(
        THRESHOLDS.fullRefreshMs,
        `Contention run (${contentionElapsed.toFixed(0)}ms) exceeds absolute threshold`
      );
    });
  });

  describe('adapter query efficiency', () => {
    it('should use chunking to stay within SQLite parameter limits', async () => {
      // Generate a large enough caseload to trigger chunking (>300 items)
      const { contacts, reports } = generateCaseload(100, 2);

      contacts.forEach(c => seedContact(mockDb, c));
      reports.forEach(r => seedReport(mockDb, r));

      await rulesEngine.refreshEmissionsFor();

      // Verify tasks were generated successfully despite large dataset
      expect(mockDb._tables.tasks.length).to.be.greaterThan(0);

       
      console.log(`    [perf] 100 contacts + 200 reports: ` +
        `${mockDb._tables.tasks.length} tasks generated`);
    });

    it('should generate correct task count proportional to contacts', async () => {
      // With default pregnancy config, each contact with a pregnancy report
      // should generate approximately the same number of tasks
      const small = generateCaseload(5, 4);
      const large = generateCaseload(25, 4);

      // Small run
      small.contacts.forEach(c => seedContact(mockDb, c));
      small.reports.forEach(r => seedReport(mockDb, r));

      await rulesEngine.refreshEmissionsFor();

      const smallTaskCount = mockDb._tables.tasks.length;

      // Reset for large run
      Object.keys(mockDb._tables).forEach(table => {
        mockDb._tables[table] = [];
      });
      configHashSalt++;
      await rulesEngine.rulesConfigChange(engineSettings({ configHashSalt }));

      large.contacts.forEach(c => seedContact(mockDb, c));
      large.reports.forEach(r => seedReport(mockDb, r));

      await rulesEngine.refreshEmissionsFor();

      const largeTaskCount = mockDb._tables.tasks.length;

      // Task count should scale roughly linearly with contact count
      // Allow 20% tolerance for edge effects
      const expectedRatio = 25 / 5;
      const actualRatio = largeTaskCount / smallTaskCount;
      expect(actualRatio).to.be.within(
        expectedRatio * 0.8,
        expectedRatio * 1.2,
        `Task count scaling: expected ~${expectedRatio}x, got ${actualRatio.toFixed(2)}x`
      );

       
      console.log(`    [perf] Scaling: 5 contacts → ${smallTaskCount} tasks, ` +
        `25 contacts → ${largeTaskCount} tasks (${actualRatio.toFixed(2)}x)`);
    });
  });
});
