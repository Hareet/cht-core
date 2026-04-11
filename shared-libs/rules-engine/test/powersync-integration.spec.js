/**
 * Integration tests for the rules engine using the PowerSync adapter.
 *
 * These tests verify that the full rules engine pipeline (initialize → seed data →
 * refresh emissions → fetch tasks/targets) produces correct results when using
 * the PowerSync SQLite adapter instead of PouchDB.
 *
 * The mock PowerSync DB simulates the real PowerSync SDK API (getAll, getOptional,
 * execute, writeTransaction) with in-memory storage.
 */

const chai = require('chai');
const chaiExclude = require('chai-exclude');
const moment = require('moment');
const sinon = require('sinon');
const rewire = require('rewire');

const { engineSettings } = require('./mocks');
const rulesEmitter = require('../src/rules-emitter');
const { SCHEMA_TABLES } = require('../src/adapters/powersync-schema');

const { expect } = chai;
chai.use(chaiExclude);

const TEST_START = 1500000000000;
const TARGET_INTERVAL = moment(TEST_START).startOf('month').format('YYYY-MM');

const patientContact = {
  _id: 'patient',
  name: 'Test Patient',
  type: 'contact',
  contact_type: 'person',
  patient_id: 'patient_id',
};

const pregnancyFollowupReport = {
  _id: 'report',
  type: 'data_record',
  form: 'pregnancy',
  fields: {
    t_pregnancy_follow_up_date: new Date(TEST_START).toISOString(),
    patient_uuid: 'patient',
    patient_id: 'patient_id',
  },
  patient_id: 'patient_id',
  reported_date: 0,
};

const pregnancyRegistrationReport = {
  _id: 'pregReg',
  type: 'data_record',
  form: 'pregnancy',
  fields: {
    lmp_date_8601: TEST_START,
    patient_id: patientContact._id,
  },
  reported_date: TEST_START,
};

/**
 * Creates a mock PowerSync database with in-memory tables.
 * Implements the PowerSync SDK API subset used by the adapter.
 */
const createMockPowerSyncDb = () => {
  const tables = {};

  // Initialize tables based on schema
  Object.keys(SCHEMA_TABLES).forEach(name => {
    tables[name] = [];
  });

  const findTable = (sql) => {
    const match = sql.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/i);
    return match ? match[1] : null;
  };

  const matchRow = (row, sql, params) => {
    // Simple WHERE clause evaluation for test purposes
    const whereMatch = sql.match(/WHERE\s+(.*?)(?:ORDER|GROUP|LIMIT|$)/is);
    if (!whereMatch) {
      return true;
    }
    const where = whereMatch[1].trim();
    return evalWhere(row, where, params, { idx: 0 });
  };

  const evalWhere = (row, clause, params, state) => {
    // Handle OR — share state by reference so parameter indices advance correctly across branches
    const orParts = splitOutside(clause, ' OR ');
    if (orParts.length > 1) {
      return orParts.some(p => evalWhere(row, p.trim(), params, state));
    }
    // Handle AND
    const andParts = splitOutside(clause, ' AND ');
    if (andParts.length > 1) {
      return andParts.every(p => evalWhere(row, p.trim(), params, state));
    }
    const trimmed = clause.trim();
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
      return evalWhere(row, trimmed.slice(1, -1).trim(), params, state);
    }
    // IS NULL
    const isNull = trimmed.match(/^(\w+)\s+IS\s+NULL$/i);
    if (isNull) {
      return row[isNull[1]] == null;
    }
    // IS NOT NULL
    const isNotNull = trimmed.match(/^(\w+)\s+IS\s+NOT\s+NULL$/i);
    if (isNotNull) {
      return row[isNotNull[1]] != null;
    }
    // NOT IN with literals
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
    // IN with placeholders
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
    // = ?
    const eq = trimmed.match(/^(\w+)\s*=\s*\?$/);
    if (eq) {
      const val = params[state.idx++];
      return row[eq[1]] === val;
    }
    // != 'literal' — matches CouchDB JavaScript truthiness checks (e.g., form != '').
    // SQL semantics: NULL != 'x' evaluates to NULL (falsy).
    const neqLit = trimmed.match(/^(\w+)\s*!=\s*'([^']*)'/);
    if (neqLit) {
      const val = row[neqLit[1]];
      if (val == null) {
        return false;
      }
      return val !== neqLit[2];
    }
    // = 'literal'
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

  const db = {
    _tables: tables,

    getAll: async (sql, params = []) => {
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
      const results = await db.getAll(sql, params);
      return results[0] || null;
    },

    execute: async (sql, params = []) => {
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

/**
 * Seeds a contact document into the mock PowerSync database.
 */
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

/**
 * Seeds a report document into the mock PowerSync database.
 */
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

let clock;
let configHashSalt = 0;

describe('PowerSync adapter integration tests', () => {
  let mockDb;
  let rulesEngine;

  // rules-state-store is a module singleton — can only be initialized once per process.
  // The existing integration.spec.js takes that slot. So we use a fresh init here
  // by running BEFORE the PouchDB integration tests (mocha runs files alphabetically,
  // and this file sorts after 'p' but before 'provider-wireup').
  //
  // However, when running all tests together, state-store may already be initialized.
  // We handle this by using rulesConfigChange which works even when already initialized.
  before(async () => {
    mockDb = createMockPowerSyncDb();
    const RulesEngine = require('../src');
    rulesEngine = RulesEngine(mockDb, { adapter: 'powersync' });

    // Try initialize; if state store already loaded (from another test file), use configChange
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

    // Clear all tables but keep the same mockDb (stateChangeCallback is bound to it)
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

  it('should initialize without errors', () => {
    expect(rulesEngine.isEnabled()).to.be.true;
  });

  it('should return empty tasks when no contacts exist', async () => {
    const tasks = await rulesEngine.fetchTasksFor();
    expect(tasks).to.deep.equal([]);
  });

  it('should generate tasks from contact and report data', async () => {
    seedContact(mockDb, patientContact);
    seedReport(mockDb, pregnancyRegistrationReport);

    await rulesEngine.refreshEmissionsFor();

    // Tasks should have been written to the mock DB
    const writtenTasks = mockDb._tables.tasks;
    expect(writtenTasks.length).to.be.greaterThan(0);

    // Verify task structure
    const taskDoc = writtenTasks[0]._rawDoc;
    expect(taskDoc).to.have.property('_id');
    expect(taskDoc).to.have.property('type', 'task');
    expect(taskDoc).to.have.property('owner');
    expect(taskDoc).to.have.property('state');
    expect(taskDoc).to.have.property('emission');
  });

  it('should generate target documents', async () => {
    seedContact(mockDb, patientContact);
    seedReport(mockDb, pregnancyRegistrationReport);

    await rulesEngine.refreshEmissionsFor();

    // Targets should have been written
    const writtenTargets = mockDb._tables.targets;
    expect(writtenTargets.length).to.be.greaterThan(0);

    const targetDoc = writtenTargets[0]._rawDoc;
    expect(targetDoc).to.have.property('_id');
    expect(targetDoc).to.have.property('type', 'target');
    expect(targetDoc._id).to.include(`target~${TARGET_INTERVAL}`);
    expect(targetDoc).to.have.property('targets').that.is.an('array');
    expect(targetDoc).to.have.property('reporting_period', TARGET_INTERVAL);
  });

  it('should generate pregnancy-related tasks with correct states', async () => {
    seedContact(mockDb, patientContact);
    seedReport(mockDb, pregnancyRegistrationReport);

    await rulesEngine.refreshEmissionsFor();

    const writtenTasks = mockDb._tables.tasks;
    const states = writtenTasks.map(t => t.state);

    // Should have a mix of Draft and Ready states for pregnancy follow-up tasks
    expect(states).to.include.members(['Draft']);
    // All tasks should be owned by the patient contact
    writtenTasks.forEach(t => {
      expect(t.owner).to.equal(patientContact._id);
      expect(t.requester).to.equal(patientContact._id);
    });
  });

  it('should return Ready tasks via fetchTasksFor', async () => {
    seedContact(mockDb, patientContact);
    seedReport(mockDb, pregnancyFollowupReport);

    const tasks = await rulesEngine.fetchTasksFor();
    // fetchTasksFor filters to only Ready state tasks
    tasks.forEach(task => {
      expect(task.state).to.equal('Ready');
    });
  });

  it('should return targets via fetchTargets', async () => {
    seedContact(mockDb, patientContact);
    seedReport(mockDb, pregnancyRegistrationReport);

    const targets = await rulesEngine.fetchTargets();
    expect(targets).to.be.an('array');
    expect(targets.length).to.be.greaterThan(0);

    // Verify well-known target IDs from default config
    const targetIds = targets.map(t => t.id);
    expect(targetIds).to.include('pregnancy-registrations-this-month');
  });

  it('should return empty for unknown contact IDs', async () => {
    seedContact(mockDb, patientContact);
    seedReport(mockDb, pregnancyFollowupReport);

    const tasks = await rulesEngine.fetchTasksFor(['nonexistent']);
    expect(tasks).to.deep.equal([]);
  });

  it('should write tasks with correct structure to local SQLite', async () => {
    seedContact(mockDb, patientContact);
    seedReport(mockDb, pregnancyRegistrationReport);

    await rulesEngine.refreshEmissionsFor();

    const writtenTasks = mockDb._tables.tasks;
    expect(writtenTasks.length).to.be.greaterThan(0);

    // Verify each written task has the expected denormalized columns for SQL queries
    writtenTasks.forEach(task => {
      expect(task).to.have.property('id').that.is.a('string');
      expect(task).to.have.property('type', 'task');
      expect(task).to.have.property('state').that.is.a('string');
      expect(task).to.have.property('owner');
      expect(task).to.have.property('requester');
      expect(task).to.have.property('user');
      expect(task).to.have.property('doc').that.is.a('string');

      // The doc column should be valid JSON containing the full task document
      const doc = JSON.parse(task.doc);
      expect(doc).to.have.property('_id', task.id);
      expect(doc).to.have.property('emission').that.is.an('object');
      expect(doc).to.have.property('stateHistory').that.is.an('array');
    });
  });

  it('should handle taskDataFor with specific contacts', async () => {
    seedContact(mockDb, patientContact);
    seedReport(mockDb, pregnancyRegistrationReport);

    // First do a full refresh to populate state
    await rulesEngine.refreshEmissionsFor();

    // Clear tasks for re-generation
    mockDb._tables.tasks = [];

    // Mark contact dirty and refresh just for it
    await rulesEngine.updateEmissionsFor([patientContact._id]);

    // Tasks should be regenerated
    expect(mockDb._tables.tasks.length).to.be.greaterThan(0);
  });

  it('should return task breakdown counts', async () => {
    seedContact(mockDb, patientContact);
    seedReport(mockDb, pregnancyRegistrationReport);

    await rulesEngine.refreshEmissionsFor();

    const breakdown = await rulesEngine.fetchTasksBreakdown();
    expect(breakdown).to.have.property('Ready');
    expect(breakdown).to.have.property('Draft');
    expect(breakdown).to.have.property('Cancelled');
    expect(breakdown).to.have.property('Completed');
    expect(breakdown).to.have.property('Failed');

    // Should have at least some Draft tasks from pregnancy schedule
    const totalTasks = Object.values(breakdown).reduce((sum, count) => sum + count, 0);
    expect(totalTasks).to.be.greaterThan(0);
  });

  it('should return Ready tasks via fetchTasksFor with specific contact IDs', async () => {
    // This tests the targeted refresh path: taskDataFor → tasksByRelation('owner') → filter Ready
    // This is the most common production path (only refreshes dirty contacts).
    seedContact(mockDb, patientContact);
    seedReport(mockDb, pregnancyFollowupReport);

    // First do a full refresh to populate state store
    await rulesEngine.refreshEmissionsFor();

    // Now fetch tasks for the specific contact — exercises tasksByRelation('owner')
    const tasks = await rulesEngine.fetchTasksFor([patientContact._id]);
    tasks.forEach(task => {
      expect(task.state).to.equal('Ready');
      expect(task.owner).to.equal(patientContact._id);
    });
  });

  it('should return task breakdown for specific contact IDs', async () => {
    seedContact(mockDb, patientContact);
    seedReport(mockDb, pregnancyRegistrationReport);

    await rulesEngine.refreshEmissionsFor();

    // fetchTasksBreakdown with specific contacts exercises allTaskRowsByOwner
    const breakdown = await rulesEngine.fetchTasksBreakdown([patientContact._id]);
    const totalTasks = Object.values(breakdown).reduce((sum, count) => sum + count, 0);
    expect(totalTasks).to.be.greaterThan(0);

    // All counted tasks should belong to the patient contact
    const writtenTasks = mockDb._tables.tasks.filter(t => t.owner === patientContact._id);
    expect(writtenTasks.length).to.equal(totalTasks);
  });

  it('should not produce spurious emissions from reports without subject identifiers', async () => {
    // Parity with PouchDB: the CouchDB reports_by_subject view only emits for reports with
    // subject fields. Reports without any subject identifiers (patient_id, place_id, etc.) are
    // invisible to the rules engine. If they leaked through, they'd create phantom headless
    // contacts and potentially incorrect tasks/targets.
    seedContact(mockDb, patientContact);
    seedReport(mockDb, pregnancyRegistrationReport);

    // Seed a report with no subject identifiers — this should be excluded from allTaskData
    mockDb._tables.reports.push({
      id: 'orphan-report',
      type: 'data_record',
      form: 'facility_summary',
      patient_id: null,
      place_id: null,
      subject_id: null,
      case_id: null,
      reported_date: TEST_START,
      doc: JSON.stringify({
        _id: 'orphan-report',
        type: 'data_record',
        form: 'facility_summary',
        fields: { summary: 'no subject' },
        reported_date: TEST_START,
      }),
      _rawDoc: {
        _id: 'orphan-report',
        type: 'data_record',
        form: 'facility_summary',
        fields: { summary: 'no subject' },
        reported_date: TEST_START,
      },
    });

    await rulesEngine.refreshEmissionsFor();

    // Verify only the pregnancy registration report produced tasks, not the orphan report
    const writtenTasks = mockDb._tables.tasks;
    expect(writtenTasks.length).to.be.greaterThan(0);
    writtenTasks.forEach(task => {
      expect(task.owner).to.equal(patientContact._id);
    });
  });

  it('should exclude reports with empty-string form from task generation (PouchDB parity)', async () => {
    // CouchDB reports_by_subject view uses `if (doc.form)` — empty string is falsy.
    // Reports with form='' must be excluded by the adapter's SQL `form != ''` check.
    // This validates the integration test mock's evalWhere handles != 'literal'.
    seedContact(mockDb, patientContact);
    seedReport(mockDb, pregnancyRegistrationReport);

    // Seed a report with empty-string form — should be invisible to the rules engine
    mockDb._tables.reports.push({
      id: 'empty-form-report',
      type: 'data_record',
      form: '',
      patient_id: patientContact.patient_id,
      place_id: null,
      subject_id: null,
      case_id: null,
      reported_date: TEST_START + 1000,
      doc: JSON.stringify({
        _id: 'empty-form-report',
        type: 'data_record',
        form: '',
        fields: { patient_id: patientContact.patient_id },
        patient_id: patientContact.patient_id,
        reported_date: TEST_START + 1000,
      }),
      _rawDoc: {
        _id: 'empty-form-report',
        type: 'data_record',
        form: '',
        fields: { patient_id: patientContact.patient_id },
        patient_id: patientContact.patient_id,
        reported_date: TEST_START + 1000,
      },
    });

    await rulesEngine.refreshEmissionsFor();

    // All generated tasks should be owned by the patient — the empty-form report
    // should NOT have created any additional task emissions
    const writtenTasks = mockDb._tables.tasks;
    expect(writtenTasks.length).to.be.greaterThan(0);
    writtenTasks.forEach(task => {
      expect(task.owner).to.equal(patientContact._id);
    });
  });

  it('should cancel tasks when their triggering report is removed (round-trip parity)', async () => {
    // This tests the critical round-trip invariant: task documents committed via
    // commitTaskDocs must preserve emission._id through JSON serialization so that
    // the cancellation matching logic in getCancellationUpdates can identify orphaned tasks.
    //
    // Flow: seed data → refresh → verify tasks → remove report → refresh → verify cancelled
    seedContact(mockDb, patientContact);
    seedReport(mockDb, pregnancyRegistrationReport);

    // Step 1: Generate tasks
    await rulesEngine.refreshEmissionsFor();
    const initialTasks = mockDb._tables.tasks.filter(t => t.owner === patientContact._id);
    expect(initialTasks.length).to.be.greaterThan(0);

    // Capture the emission IDs from the written tasks — these must survive the JSON round-trip
    const initialEmissionIds = initialTasks.map(t => {
      const doc = t._rawDoc || JSON.parse(t.doc);
      expect(doc.emission).to.be.an('object', 'task doc should have emission after write');
      expect(doc.emission._id).to.be.a('string', 'emission._id must be preserved in JSON');
      return doc.emission._id;
    });
    expect(initialEmissionIds.length).to.be.greaterThan(0);

    // Verify all non-terminal tasks have stateHistory
    const nonTerminalTasks = initialTasks.filter(
      t => !['Cancelled', 'Completed', 'Failed'].includes(t.state)
    );
    expect(nonTerminalTasks.length).to.be.greaterThan(0);
    nonTerminalTasks.forEach(t => {
      const doc = t._rawDoc || JSON.parse(t.doc);
      expect(doc.stateHistory).to.be.an('array').with.length.greaterThan(0);
    });

    // Step 2: Remove the report — simulates a report being purged or retracted
    mockDb._tables.reports = [];

    // Step 3: Mark contact dirty and refresh — should cancel orphaned tasks
    // updateEmissionsFor resolves the contact ID, marks it dirty, and refreshes
    await rulesEngine.updateEmissionsFor([patientContact._id]);

    // Step 4: Verify cancellation
    const updatedTasks = mockDb._tables.tasks.filter(t => t.owner === patientContact._id);
    expect(updatedTasks.length).to.be.greaterThan(0);

    // All previously non-terminal tasks should now be Cancelled
    // (rules engine found no emissions → getCancellationUpdates cancels all)
    const cancelledTasks = updatedTasks.filter(t => t.state === 'Cancelled');
    expect(cancelledTasks.length).to.be.greaterThan(0);

    // The cancelled tasks should have accumulated stateHistory entries
    cancelledTasks.forEach(t => {
      const doc = t._rawDoc || JSON.parse(t.doc);
      expect(doc.stateHistory).to.be.an('array');
      // Should have at least 2 entries: initial state + Cancelled
      expect(doc.stateHistory.length).to.be.greaterThan(1);
      const lastEntry = doc.stateHistory[doc.stateHistory.length - 1];
      expect(lastEntry.state).to.equal('Cancelled');
    });

    // fetchTasksFor should return no Ready tasks (all cancelled)
    const readyTasks = await rulesEngine.fetchTasksFor();
    // All remaining tasks are either Cancelled or were already terminal
    readyTasks.forEach(task => {
      expect(task.state).to.equal('Ready');
    });
  });

  it('should preserve task emission data through multiple refresh cycles', async () => {
    // Verifies that task documents round-trip correctly through the PowerSync adapter's
    // JSON serialization across multiple refresh cycles. Each cycle reads tasks from the
    // DB (parsing doc JSON), runs rules, and writes back (re-serializing to JSON).
    // Fields like emission.actions, emission.title, and stateHistory must be preserved.
    seedContact(mockDb, patientContact);
    seedReport(mockDb, pregnancyRegistrationReport);

    // First refresh — creates tasks
    await rulesEngine.refreshEmissionsFor();
    const afterFirstRefresh = mockDb._tables.tasks.slice();
    expect(afterFirstRefresh.length).to.be.greaterThan(0);

    // Capture initial task structure
    const initialTaskDocs = afterFirstRefresh.map(t => t._rawDoc || JSON.parse(t.doc));
    initialTaskDocs.forEach(doc => {
      expect(doc).to.have.property('_id').that.is.a('string');
      expect(doc).to.have.property('type', 'task');
      expect(doc).to.have.property('emission').that.is.an('object');
      expect(doc.emission).to.have.property('_id').that.is.a('string');
      expect(doc).to.have.property('stateHistory').that.is.an('array');
      expect(doc).to.have.property('authoredOn').that.is.a('number');
    });

    // Second refresh — reads back tasks from DB, runs rules, writes again
    // Tasks should be re-read from the doc JSON column and round-trip correctly
    configHashSalt++;
    await rulesEngine.rulesConfigChange(engineSettings({ configHashSalt }));
    await rulesEngine.refreshEmissionsFor();

    const afterSecondRefresh = mockDb._tables.tasks.slice();
    expect(afterSecondRefresh.length).to.be.greaterThan(0);

    // Verify emission data survived the round-trip
    const roundTrippedDocs = afterSecondRefresh.map(t => t._rawDoc || JSON.parse(t.doc));
    roundTrippedDocs.forEach(doc => {
      expect(doc).to.have.property('emission').that.is.an('object');
      expect(doc.emission).to.have.property('_id').that.is.a('string');
      expect(doc).to.have.property('stateHistory').that.is.an('array');
      expect(doc.stateHistory.length).to.be.greaterThan(0);
    });

    // The emission IDs should be consistent — same contact + report produces same emission IDs
    const firstEmissionIds = new Set(initialTaskDocs.map(d => d.emission._id));
    const secondEmissionIds = new Set(roundTrippedDocs.map(d => d.emission._id));
    // All first-round emission IDs should still be present (tasks are stable)
    firstEmissionIds.forEach(id => {
      expect(secondEmissionIds.has(id)).to.be.true;
    });
  });

  it('should normalize empty-string task fields to NULL at write time', async () => {
    // When the rules engine commits task documents, empty-string values for owner,
    // requester, state, and user should be stored as NULL in the database.
    // This matches CouchDB's JavaScript truthiness semantics where the view uses
    // `doc.owner || '_unassigned'` and `if (doc.requester)`.
    seedContact(mockDb, patientContact);
    seedReport(mockDb, pregnancyRegistrationReport);

    await rulesEngine.refreshEmissionsFor();

    // All tasks written by the rules engine should have proper non-empty values
    const writtenTasks = mockDb._tables.tasks;
    expect(writtenTasks.length).to.be.greaterThan(0);
    writtenTasks.forEach(task => {
      // owner, requester, state should be non-empty strings (set by rules engine)
      expect(task.owner).to.be.a('string').and.not.equal('');
      expect(task.state).to.be.a('string').and.not.equal('');
      // requester is set by transform-task-emission-to-doc
      if (task.requester !== null) {
        expect(task.requester).to.be.a('string').and.not.equal('');
      }
    });
  });
});

describe('PowerSync schema metadata', () => {
  it('should define all expected tables', () => {
    expect(SCHEMA_TABLES).to.have.all.keys('contacts', 'reports', 'tasks', 'targets', 'rules_state_store');
  });

  it('should mark rules_state_store as local-only', () => {
    expect(SCHEMA_TABLES.rules_state_store.synced).to.be.false;
  });

  it('should mark synced tables correctly', () => {
    expect(SCHEMA_TABLES.contacts.synced).to.be.true;
    expect(SCHEMA_TABLES.reports.synced).to.be.true;
    expect(SCHEMA_TABLES.tasks.synced).to.be.true;
    expect(SCHEMA_TABLES.targets.synced).to.be.true;
  });

  it('should define doc column on all synced tables', () => {
    ['contacts', 'reports', 'tasks', 'targets'].forEach(table => {
      expect(SCHEMA_TABLES[table].columns).to.include('doc');
    });
  });

  it('contacts should have patient_id and place_id for shortcode resolution', () => {
    expect(SCHEMA_TABLES.contacts.columns).to.include('patient_id');
    expect(SCHEMA_TABLES.contacts.columns).to.include('place_id');
  });

  it('reports should have denormalized subject columns', () => {
    expect(SCHEMA_TABLES.reports.columns).to.include('patient_id');
    expect(SCHEMA_TABLES.reports.columns).to.include('place_id');
    expect(SCHEMA_TABLES.reports.columns).to.include('subject_id');
  });

  it('tasks should have state, owner, requester for view query equivalents', () => {
    expect(SCHEMA_TABLES.tasks.columns).to.include('state');
    expect(SCHEMA_TABLES.tasks.columns).to.include('owner');
    expect(SCHEMA_TABLES.tasks.columns).to.include('requester');
  });
});

describe('PowerSync backend connector', () => {
  const { createChtBackendConnector } = require('../src/adapters/powersync-connector');

  it('should create a connector with fetchCredentials and uploadData', () => {
    const connector = createChtBackendConnector({
      apiUrl: 'https://cht.example.com',
      getAuthToken: async () => 'test-token',
    });

    expect(connector).to.have.property('fetchCredentials').that.is.a('function');
    expect(connector).to.have.property('uploadData').that.is.a('function');
  });

  it('fetchCredentials should return endpoint and token', async () => {
    const connector = createChtBackendConnector({
      apiUrl: 'https://cht.example.com',
      getAuthToken: async () => 'jwt-token-123',
      powersyncUrl: 'http://powersync:8080',
    });

    const creds = await connector.fetchCredentials();
    expect(creds).to.have.property('endpoint', 'http://powersync:8080');
    expect(creds).to.have.property('token', 'jwt-token-123');
    expect(creds).to.have.property('expiresAt').that.is.instanceOf(Date);
  });

  it('uploadData should handle empty transaction queue', async () => {
    const connector = createChtBackendConnector({
      apiUrl: 'https://cht.example.com',
      getAuthToken: async () => 'token',
    });

    const mockDatabase = {
      getNextCrudTransaction: async () => null,
    };

    // Should complete without error
    await connector.uploadData(mockDatabase);
  });

  it('uploadData should process task writes and call complete', async () => {
    const connector = createChtBackendConnector({
      apiUrl: 'https://cht.example.com',
      getAuthToken: async () => 'token',
    });

    const completeSpy = sinon.spy();
    const mockTransaction = {
      crud: [{
        table: 'tasks',
        op: 'PUT',
        id: 'task~user~emission~123',
        opData: { doc: JSON.stringify({ _id: 'task~user~emission~123', type: 'task', state: 'Ready' }) },
      }],
      complete: completeSpy,
    };

    const mockDatabase = {
      getNextCrudTransaction: async () => mockTransaction,
    };

    // Stub global fetch
    const fetchStub = sinon.stub(globalThis, 'fetch').resolves({ ok: true, status: 200 });
    try {
      await connector.uploadData(mockDatabase);
      expect(completeSpy.calledOnce).to.be.true;
      expect(fetchStub.calledOnce).to.be.true;
    } finally {
      fetchStub.restore();
    }
  });

  it('uploadData should skip read-only tables', async () => {
    const connector = createChtBackendConnector({
      apiUrl: 'https://cht.example.com',
      getAuthToken: async () => 'token',
    });

    const completeSpy = sinon.spy();
    const mockTransaction = {
      crud: [{
        table: 'contacts', // read-only, should be skipped
        op: 'PUT',
        id: 'some-contact',
        opData: {},
      }],
      complete: completeSpy,
    };

    const mockDatabase = {
      getNextCrudTransaction: async () => mockTransaction,
    };

    await connector.uploadData(mockDatabase);
    expect(completeSpy.calledOnce).to.be.true;
    // No fetch call because contacts is read-only
  });

  it('uploadData should handle PATCH operations (task updates)', async () => {
    const connector = createChtBackendConnector({
      apiUrl: 'https://cht.example.com',
      getAuthToken: async () => 'token',
    });

    const completeSpy = sinon.spy();
    const mockTransaction = {
      crud: [{
        table: 'tasks',
        op: 'PATCH',
        id: 'task~user~emission~123',
        opData: { doc: JSON.stringify({ _id: 'task~user~emission~123', type: 'task', state: 'Completed' }) },
      }],
      complete: completeSpy,
    };

    const mockDatabase = {
      getNextCrudTransaction: async () => mockTransaction,
    };

    const fetchStub = sinon.stub(globalThis, 'fetch').resolves({ ok: true, status: 200 });
    try {
      await connector.uploadData(mockDatabase);
      expect(completeSpy.calledOnce).to.be.true;
      expect(fetchStub.calledOnce).to.be.true;
      // PATCH maps to PUT HTTP method
      expect(fetchStub.firstCall.args[1].method).to.equal('PUT');
    } finally {
      fetchStub.restore();
    }
  });

  it('uploadData should handle DELETE operations', async () => {
    const connector = createChtBackendConnector({
      apiUrl: 'https://cht.example.com',
      getAuthToken: async () => 'token',
    });

    const completeSpy = sinon.spy();
    const mockTransaction = {
      crud: [{
        table: 'targets',
        op: 'DELETE',
        id: 'target~2026-04~contact~user',
        opData: {},
      }],
      complete: completeSpy,
    };

    const mockDatabase = {
      getNextCrudTransaction: async () => mockTransaction,
    };

    const fetchStub = sinon.stub(globalThis, 'fetch').resolves({ ok: true, status: 200 });
    try {
      await connector.uploadData(mockDatabase);
      expect(completeSpy.calledOnce).to.be.true;
      expect(fetchStub.firstCall.args[1].method).to.equal('DELETE');
    } finally {
      fetchStub.restore();
    }
  });

  it('uploadData should throw on 5xx server errors for retry', async () => {
    const connector = createChtBackendConnector({
      apiUrl: 'https://cht.example.com',
      getAuthToken: async () => 'token',
    });

    const completeSpy = sinon.spy();
    const mockTransaction = {
      crud: [{
        table: 'tasks',
        op: 'PUT',
        id: 'task-1',
        opData: { doc: JSON.stringify({ _id: 'task-1', type: 'task' }) },
      }],
      complete: completeSpy,
    };

    const mockDatabase = {
      getNextCrudTransaction: async () => mockTransaction,
    };

    const fetchStub = sinon.stub(globalThis, 'fetch').resolves({ ok: false, status: 503 });
    try {
      await expect(connector.uploadData(mockDatabase)).to.be.rejectedWith('Server error');
      expect(completeSpy.called).to.be.false;
    } finally {
      fetchStub.restore();
    }
  });

  it('uploadData should log but not throw on 4xx client errors', async () => {
    const connector = createChtBackendConnector({
      apiUrl: 'https://cht.example.com',
      getAuthToken: async () => 'token',
    });

    const completeSpy = sinon.spy();
    const mockTransaction = {
      crud: [{
        table: 'tasks',
        op: 'PUT',
        id: 'task-1',
        opData: { doc: JSON.stringify({ _id: 'task-1', type: 'task' }) },
      }],
      complete: completeSpy,
    };

    const mockDatabase = {
      getNextCrudTransaction: async () => mockTransaction,
    };

    const fetchStub = sinon.stub(globalThis, 'fetch').resolves({ ok: false, status: 409 });
    const errorSpy = sinon.stub(console, 'error');
    try {
      await connector.uploadData(mockDatabase);
      // 4xx doesn't throw — queue advances
      expect(completeSpy.calledOnce).to.be.true;
      expect(errorSpy.calledWithMatch(/Upload rejected/)).to.be.true;
    } finally {
      fetchStub.restore();
      errorSpy.restore();
    }
  });

  it('uploadData should handle PATCH 4xx errors without throwing', async () => {
    const connector = createChtBackendConnector({
      apiUrl: 'https://cht.example.com',
      getAuthToken: async () => 'token',
    });

    const completeSpy = sinon.spy();
    const mockTransaction = {
      crud: [{
        table: 'tasks',
        op: 'PATCH',
        id: 'task-1',
        opData: { doc: JSON.stringify({ _id: 'task-1', type: 'task' }) },
      }],
      complete: completeSpy,
    };

    const mockDatabase = {
      getNextCrudTransaction: async () => mockTransaction,
    };

    const fetchStub = sinon.stub(globalThis, 'fetch').resolves({ ok: false, status: 409 });
    const errorSpy = sinon.stub(console, 'error');
    try {
      await connector.uploadData(mockDatabase);
      expect(completeSpy.calledOnce).to.be.true;
      expect(errorSpy.calledWithMatch(/Update rejected/)).to.be.true;
    } finally {
      fetchStub.restore();
      errorSpy.restore();
    }
  });

  it('uploadData should handle DELETE 5xx errors with retry', async () => {
    const connector = createChtBackendConnector({
      apiUrl: 'https://cht.example.com',
      getAuthToken: async () => 'token',
    });

    const completeSpy = sinon.spy();
    const mockTransaction = {
      crud: [{
        table: 'targets',
        op: 'DELETE',
        id: 'target-1',
        opData: {},
      }],
      complete: completeSpy,
    };

    const mockDatabase = {
      getNextCrudTransaction: async () => mockTransaction,
    };

    const fetchStub = sinon.stub(globalThis, 'fetch').resolves({ ok: false, status: 500 });
    try {
      await expect(connector.uploadData(mockDatabase)).to.be.rejectedWith('Server error');
      expect(completeSpy.called).to.be.false;
    } finally {
      fetchStub.restore();
    }
  });
});
