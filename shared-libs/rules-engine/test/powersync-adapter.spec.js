const chai = require('chai');
const chaiAsPromised = require('chai-as-promised');
const sinon = require('sinon');
const moment = require('moment');

const powersyncProvider = require('../src/adapters/powersync-adapter');
const { chtDocs } = require('./mocks');
const { expect } = chai;
chai.use(chaiAsPromised);

const mockUserSettingsDoc = { _id: 'org.couchdb.user:username' };

const contactDoc = {
  _id: 'patient',
  name: 'cht_mock_contact',
  type: 'contact',
  contact_type: 'person',
  patient_id: 'patient_id',
};

const placeDoc = {
  _id: 'place',
  name: 'cht_mock_place',
  type: 'health_center',
  place_id: 'place_id',
};

const pregnancyReport = {
  _id: 'pregReport',
  type: 'data_record',
  form: 'pregnancy',
  fields: { patient_uuid: 'patient', patient_id: 'patient_id' },
  patient_id: 'patient_id',
  reported_date: 1,
};

const reportConnectedByPlace = {
  _id: 'reportByPlace',
  type: 'data_record',
  form: 'form',
  place_id: 'patient',
  reported_date: 2000,
};

// Report linked to patient by patient_id AND to place by place_uuid.
// getSubjectId returns 'patient' (patient_id takes priority).
// This report should appear for 'patient' contact but NOT for 'place' contact after post-filtering.
const reportConnectedByPatientAndPlaceUuid = {
  _id: 'reportByPatientAndPlaceUuid',
  type: 'data_record',
  form: 'form',
  fields: {
    place_uuid: 'place',
  },
  patient_id: 'patient',
};

// Report linked only to place by place_uuid.
// getSubjectId returns 'place' (fields.place_uuid).
const reportConnectedByPlaceUuid = {
  _id: 'reportByPlaceUuid',
  type: 'data_record',
  form: 'form',
  fields: {
    place_uuid: 'place',
  },
};

const taskOwnedByChtContact = {
  _id: 'taskOwnedBy',
  type: 'task',
  owner: 'patient',
};

const taskRequestedByChtContact = {
  _id: 'taskRequestedBy',
  type: 'task',
  requester: 'patient',
};

const cancelledTask = {
  _id: 'cancelledTask',
  type: 'task',
  requester: 'patient',
  owner: 'patient',
  state: 'Cancelled',
};

const readyTask = {
  _id: 'readyTask',
  type: 'task',
  requester: 'patient',
  owner: 'patient',
  state: 'Ready',
};

const draftTask = {
  _id: 'draftTask',
  type: 'task',
  requester: 'patient',
  owner: 'patient',
  state: 'Draft',
};

const completedTask = {
  _id: 'completedTask',
  type: 'task',
  requester: 'patient',
  owner: 'patient',
  state: 'Completed',
};

const failedTask = {
  _id: 'failedTask',
  type: 'task',
  requester: 'patient',
  owner: 'patient',
  state: 'Failed',
};

const taskRequestedByChtPlace = {
  _id: 'taskRequestedByPlace',
  type: 'task',
  requester: 'place',
};

const readyTaskForPlace = {
  _id: 'readyPlaceTask',
  type: 'task',
  requester: 'place',
  owner: 'place',
  state: 'Ready',
};

const cancelledTaskForPlace = {
  _id: 'cancelledPlaceTask',
  type: 'task',
  requester: 'place',
  owner: 'place',
  state: 'Cancelled',
};

/**
 * Creates a mock PowerSync database that stores data in memory.
 * Implements the subset of the PowerSync API used by the adapter:
 *   - getAll(sql, params)
 *   - getOptional(sql, params)
 *   - execute(sql, params)
 *   - writeTransaction(callback)
 */
const createMockDb = () => {
  // In-memory tables
  const tables = {
    contacts: [],
    reports: [],
    tasks: [],
    targets: [],
    rules_state_store: [],
  };

  const matchesCondition = (row, sql, params) => {
    // Simple SQL parser for our test queries - handles IN, =, NOT IN, AND, OR
    // This is intentionally minimal, covering only the patterns used by the adapter
    return true; // We'll use a more targeted approach below
  };

  const db = {
    _tables: tables,

    getAll: sinon.stub().callsFake(async (sql, params = []) => {
      const tableName = extractTableName(sql);
      const table = tables[tableName] || [];
      const filtered = filterRows(table, sql, params);
      return filtered.map(row => ({ ...row, doc: JSON.stringify(row._doc || row) }));
    }),

    getOptional: sinon.stub().callsFake(async (sql, params = []) => {
      const tableName = extractTableName(sql);
      const table = tables[tableName] || [];
      const filtered = filterRows(table, sql, params);
      if (filtered.length === 0) {
        return null;
      }
      const row = filtered[0];
      if (tableName === 'rules_state_store') {
        return row;
      }
      return { ...row, doc: JSON.stringify(row._doc || row) };
    }),

    execute: sinon.stub().callsFake(async (sql, params = []) => {
      const tableName = extractTableName(sql);
      if (sql.includes('INSERT OR REPLACE') || sql.includes('INSERT INTO')) {
        const existing = tables[tableName].findIndex(r => r.id === params[0]);
        if (existing >= 0) {
          tables[tableName].splice(existing, 1);
        }
        if (tableName === 'rules_state_store') {
          tables[tableName].push({ id: params[0], data: params[1] });
        } else if (tableName === 'tasks') {
          tables[tableName].push({
            id: params[0], type: params[1], state: params[2],
            owner: params[3], requester: params[4], user: params[5],
            authored_on: params[6], _doc: JSON.parse(params[7]),
          });
        } else if (tableName === 'targets') {
          tables[tableName].push({
            id: params[0], type: params[1], owner: params[2], user: params[3],
            reporting_period: params[4], targets: params[5], updated_date: params[6],
            _doc: JSON.parse(params[7]),
          });
        }
      } else if (sql.includes('UPDATE')) {
        const row = tables[tableName].find(r => r.id === params[params.length - 1]);
        if (row && tableName === 'targets') {
          row._doc = JSON.parse(params[0]);
          row.targets = params[1];
          row.updated_date = params[2];
        }
      }
    }),

    writeTransaction: sinon.stub().callsFake(async (callback) => {
      // The transaction object exposes execute just like db
      const tx = {
        execute: async (sql, params = []) => db.execute(sql, params),
      };
      await callback(tx);
    }),
  };

  return db;
};

/**
 * Extract the primary table name from a SQL query.
 */
const extractTableName = (sql) => {
  const fromMatch = sql.match(/FROM\s+(\w+)/i);
  if (fromMatch) {
    return fromMatch[1];
  }
  const insertMatch = sql.match(/INTO\s+(\w+)/i);
  if (insertMatch) {
    return insertMatch[1];
  }
  const updateMatch = sql.match(/UPDATE\s+(\w+)/i);
  if (updateMatch) {
    return updateMatch[1];
  }
  return '';
};

/**
 * Simple row filtering based on SQL WHERE clause patterns used in the adapter.
 */
const filterRows = (rows, sql, params) => {
  // Extract WHERE clause
  const whereMatch = sql.match(/WHERE\s+(.*?)(?:ORDER|GROUP|LIMIT|$)/is);
  if (!whereMatch) {
    return rows;
  }

  const where = whereMatch[1].trim();
  let paramIdx = 0;

  return rows.filter(row => {
    // Reset param index for each row evaluation
    let localParamIdx = paramIdx;
    const result = evaluateWhere(row, where, params, { idx: 0 });
    return result;
  });
};

/**
 * Evaluate a WHERE clause against a row.
 * Handles: field = ?, field IN (?, ...), field NOT IN ('a', 'b'), field IS NOT NULL, AND, OR
 */
const evaluateWhere = (row, where, params, state) => {
  // Split by OR (top level)
  const orParts = splitTopLevel(where, ' OR ');
  if (orParts.length > 1) {
    return orParts.some(part => evaluateWhere(row, part.trim(), params, state));
  }

  // Split by AND
  const andParts = splitTopLevel(where, ' AND ');
  if (andParts.length > 1) {
    return andParts.every(part => evaluateWhere(row, part.trim(), params, state));
  }

  // Handle parenthesized expressions
  const trimmed = where.trim();
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    return evaluateWhere(row, trimmed.slice(1, -1).trim(), params, state);
  }

  // Handle NOT IN with literal strings: field NOT IN ('a', 'b', 'c')
  const notInLitMatch = trimmed.match(/^(\w+)\s+NOT\s+IN\s+\(([^)]+)\)/i);
  if (notInLitMatch) {
    const field = notInLitMatch[1];
    const inner = notInLitMatch[2];
    // Check for literal strings
    const literals = inner.match(/'([^']*)'/g);
    if (literals) {
      const values = literals.map(l => l.replace(/'/g, ''));
      return !values.includes(row[field]);
    }
    // Else placeholders
    const placeholderCount = (inner.match(/\?/g) || []).length;
    const values = params.slice(state.idx, state.idx + placeholderCount);
    state.idx += placeholderCount;
    return !values.includes(row[field]);
  }

  // Handle IN with placeholders: field IN (?, ?, ?)
  const inMatch = trimmed.match(/^(\w+)\s+IN\s+\(([^)]+)\)/i);
  if (inMatch) {
    const field = inMatch[1];
    const inner = inMatch[2];
    // Check for literal strings first
    const literals = inner.match(/'([^']*)'/g);
    if (literals) {
      const values = literals.map(l => l.replace(/'/g, ''));
      return values.includes(row[field]);
    }
    const placeholderCount = (inner.match(/\?/g) || []).length;
    const values = params.slice(state.idx, state.idx + placeholderCount);
    state.idx += placeholderCount;
    return values.includes(row[field]);
  }

  // Handle IS NULL
  const isNullMatch = trimmed.match(/^(\w+)\s+IS\s+NULL$/i);
  if (isNullMatch) {
    return row[isNullMatch[1]] == null;
  }

  // Handle IS NOT NULL
  const isNotNullMatch = trimmed.match(/^(\w+)\s+IS\s+NOT\s+NULL/i);
  if (isNotNullMatch) {
    return row[isNotNullMatch[1]] != null;
  }

  // Handle = ?
  const eqMatch = trimmed.match(/^(\w+)\s*=\s*\?/);
  if (eqMatch) {
    const val = params[state.idx];
    state.idx += 1;
    return row[eqMatch[1]] === val;
  }

  // Handle != 'literal' (SQL semantics: NULL != 'x' → NULL → falsy)
  const neqLitMatch = trimmed.match(/^(\w+)\s*!=\s*'([^']*)'/);
  if (neqLitMatch) {
    const val = row[neqLitMatch[1]];
    if (val == null) {
      return false; // SQL: NULL != anything → NULL → falsy
    }
    return val !== neqLitMatch[2];
  }

  // Handle = 'literal'
  const eqLitMatch = trimmed.match(/^(\w+)\s*=\s*'([^']*)'/);
  if (eqLitMatch) {
    return row[eqLitMatch[1]] === eqLitMatch[2];
  }

  return true;
};

/**
 * Split a string by a delimiter, but only at the top level (not inside parentheses).
 */
const splitTopLevel = (str, delim) => {
  const parts = [];
  let depth = 0;
  let current = '';
  const upperStr = str.toUpperCase();
  const upperDelim = delim.toUpperCase();

  for (let i = 0; i < str.length; i++) {
    if (str[i] === '(') {
      depth++;
    }
    if (str[i] === ')') {
      depth--;
    }
    if (depth === 0 && upperStr.substring(i, i + upperDelim.length) === upperDelim) {
      parts.push(current);
      current = '';
      i += upperDelim.length - 1;
      continue;
    }
    current += str[i];
  }
  parts.push(current);
  return parts;
};

// Seed helper: add documents to mock db tables
const seedContacts = (db, contacts) => {
  for (const c of contacts) {
    db._tables.contacts.push({
      id: c._id,
      type: c.type,
      contact_type: c.contact_type,
      name: c.name,
      patient_id: c.patient_id,
      place_id: c.place_id,
      _doc: c,
    });
  }
};

const seedReports = (db, reports) => {
  for (const r of reports) {
    db._tables.reports.push({
      id: r._id,
      type: r.type,
      form: r.form,
      patient_id: r.patient_id || (r.fields && r.fields.patient_id),
      place_id: r.place_id || (r.fields && r.fields.place_id),
      case_id: r.case_id || (r.fields && r.fields.case_id),
      subject_id: r.fields?.patient_uuid || r.fields?.place_uuid,
      reported_date: r.reported_date,
      _doc: r,
    });
  }
};

const seedTasks = (db, tasks) => {
  for (const t of tasks) {
    db._tables.tasks.push({
      id: t._id,
      type: t.type || 'task',
      state: t.state,
      owner: t.owner,
      requester: t.requester,
      user: t.user,
      authored_on: t.authoredOn,
      _doc: t,
    });
  }
};

describe('powersync-adapter', () => {
  let db;
  let clock;

  beforeEach(() => {
    db = createMockDb();
    clock = sinon.useFakeTimers({ now: 100000000, toFake: ['Date'] });
  });

  afterEach(() => {
    clock.restore();
    sinon.restore();
  });

  describe('allTasks', () => {
    const taskNoOwnerNoState = {
      _id: 'taskNoOwnerNoState',
      type: 'task',
      requester: 'patient',
      // owner: undefined, state: undefined — CouchDB treats as '_unassigned' and non-terminal
    };

    beforeEach(() => {
      seedTasks(db, [
        taskOwnedByChtContact,
        taskRequestedByChtContact,
        cancelledTask,
        completedTask,
        failedTask,
        readyTask,
        draftTask,
        taskNoOwnerNoState,
      ]);
    });

    it('for owner returns non-terminal tasks including NULL state and NULL owner', async () => {
      const result = await powersyncProvider(db).allTasks('owner');
      const ids = result.map(d => d._id);
      // Non-terminal tasks: taskOwnedByChtContact (no state), readyTask (Ready), draftTask (Draft)
      // NULL owner/state tasks are included (CouchDB uses doc.owner || '_unassigned', undefined is non-terminal)
      expect(ids).to.include('taskOwnedBy');
      expect(ids).to.include('readyTask');
      expect(ids).to.include('draftTask');
      expect(ids).to.include('taskRequestedBy'); // no owner, no state — included as '_unassigned'
      expect(ids).to.include('taskNoOwnerNoState'); // no owner, no state — included
      // Excluded: cancelledTask, completedTask, failedTask (terminal states)
      expect(ids).to.not.include('cancelledTask');
      expect(ids).to.not.include('completedTask');
      expect(ids).to.not.include('failedTask');
    });

    it('for requester returns all tasks with requester', async () => {
      const result = await powersyncProvider(db).allTasks('requester');
      const ids = result.map(d => d._id);
      // All tasks with a requester field, regardless of state
      expect(ids).to.include('taskRequestedBy');
      expect(ids).to.include('cancelledTask');
      expect(ids).to.include('completedTask');
      expect(ids).to.include('failedTask');
      expect(ids).to.include('readyTask');
      expect(ids).to.include('draftTask');
      expect(ids).to.include('taskNoOwnerNoState');
    });

    it('for requester excludes tasks with empty-string requester (PouchDB parity)', async () => {
      // CouchDB view uses `if (doc.requester)` — empty strings are falsy in JS,
      // so tasks with requester='' should NOT be emitted. SQL IS NOT NULL alone
      // would include them; the adapter must also check != ''.
      const taskWithEmptyRequester = {
        _id: 'taskEmptyRequester',
        type: 'task',
        requester: '',
        owner: 'patient',
      };
      seedTasks(db, [taskRequestedByChtContact, taskWithEmptyRequester]);

      const result = await powersyncProvider(db).allTasks('requester');
      const ids = result.map(d => d._id);
      expect(ids).to.include('taskRequestedBy');
      expect(ids).to.not.include('taskEmptyRequester');
    });
  });

  describe('allTaskData', () => {
    it('returns contacts, reports, and requester tasks', async () => {
      seedContacts(db, [contactDoc, placeDoc]);
      seedReports(db, [pregnancyReport, reportConnectedByPlace]);
      seedTasks(db, [taskRequestedByChtContact, cancelledTask]);

      const result = await powersyncProvider(db).allTaskData(mockUserSettingsDoc);
      expect(result.userSettingsId).to.equal('org.couchdb.user:username');
      expect(result.contactDocs).to.have.length(2);
      expect(result.reportDocs).to.have.length(2);
      expect(result.taskDocs).to.have.length(2);
    });

    it('excludes reports without any subject identifiers (parity with CouchDB reports_by_subject view)', async () => {
      // CouchDB's reports_by_subject view only emits rows for reports that have at least one
      // subject identifier. Reports with no patient_id, place_id, patient_uuid, place_uuid,
      // or case_id produce zero emissions and are excluded.
      const reportWithSubject = {
        _id: 'reportWithSubject',
        type: 'data_record',
        form: 'pregnancy',
        patient_id: 'patient_id',
        reported_date: 100,
      };
      const reportWithoutSubject = {
        _id: 'reportNoSubject',
        type: 'data_record',
        form: 'facility_report',
        // No patient_id, place_id, subject_id, or case_id
        reported_date: 200,
      };
      seedReports(db, [reportWithSubject, reportWithoutSubject]);

      const result = await powersyncProvider(db).allTaskData(mockUserSettingsDoc);
      const ids = result.reportDocs.map(d => d._id);
      expect(ids).to.include('reportWithSubject');
      expect(ids).to.not.include('reportNoSubject');
    });

    it('includes reports matched only by case_id (parity with CouchDB view)', async () => {
      // The CouchDB view also indexes case_id. A report with only case_id should be included.
      const reportWithCaseIdOnly = {
        _id: 'reportCaseOnly',
        type: 'data_record',
        form: 'case_follow_up',
        fields: { case_id: 'case-123' },
        reported_date: 300,
      };
      seedReports(db, [reportWithCaseIdOnly]);

      const result = await powersyncProvider(db).allTaskData(mockUserSettingsDoc);
      const ids = result.reportDocs.map(d => d._id);
      expect(ids).to.include('reportCaseOnly');
    });

    it('includes headless reports — reports whose subject has no contact doc (PouchDB parity)', async () => {
      // In PouchDB, allTaskData returns ALL reports from reports_by_subject, including
      // "headless" reports whose patient_id doesn't match any contact. These are used by
      // refreshForAllContacts to compute headlessSubjectIds for the state store.
      const headlessReport = {
        _id: 'headlessReport',
        type: 'data_record',
        form: 'form',
        patient_id: 'headless', // no contact has this as _id or shortcode
        reported_date: 1000,
      };
      seedContacts(db, [contactDoc]);
      seedReports(db, [pregnancyReport, headlessReport]);

      const result = await powersyncProvider(db).allTaskData(mockUserSettingsDoc);
      const ids = result.reportDocs.map(d => d._id);
      expect(ids).to.include('headlessReport');
      expect(ids).to.include('pregReport');
    });

    it('includes headless tasks — tasks whose requester has no contact doc (PouchDB parity)', async () => {
      const headlessTask = {
        _id: 'headlessTask',
        type: 'task',
        requester: 'headless',
        owner: 'headless',
      };
      seedTasks(db, [taskRequestedByChtContact, headlessTask]);

      const result = await powersyncProvider(db).allTaskData(mockUserSettingsDoc);
      const ids = result.taskDocs.map(d => d._id);
      expect(ids).to.include('headlessTask');
      expect(ids).to.include('taskRequestedBy');
    });

    it('excludes reports with empty-string form (PouchDB parity)', async () => {
      // CouchDB reports_by_subject view uses `if (doc.form)` — empty string is falsy in JS.
      // SQL `form IS NOT NULL` alone would accept empty strings. The adapter must also
      // check `form != ''` to match CouchDB view behavior.
      const reportWithEmptyForm = {
        _id: 'emptyFormReport',
        type: 'data_record',
        form: '',
        patient_id: 'patient_id',
        reported_date: 500,
      };
      const reportWithValidForm = {
        _id: 'validFormReport',
        type: 'data_record',
        form: 'pregnancy',
        patient_id: 'patient_id',
        reported_date: 600,
      };
      seedReports(db, [reportWithEmptyForm, reportWithValidForm]);

      const result = await powersyncProvider(db).allTaskData(mockUserSettingsDoc);
      const ids = result.reportDocs.map(d => d._id);
      expect(ids).to.include('validFormReport');
      expect(ids).to.not.include('emptyFormReport');
    });

    it('excludes reports with empty-string subject identifiers (PouchDB parity)', async () => {
      // CouchDB view uses `if (obj[field])` for each subject field — empty strings are falsy.
      // A report where all subject columns are empty strings should be excluded, just like
      // a report where all are NULL. The SQL must check both IS NOT NULL and != ''.
      const reportEmptySubjects = {
        _id: 'emptySubjectReport',
        type: 'data_record',
        form: 'visit',
        patient_id: '',
        place_id: '',
        reported_date: 700,
      };
      seedReports(db, [reportEmptySubjects]);

      const result = await powersyncProvider(db).allTaskData(mockUserSettingsDoc);
      const ids = result.reportDocs.map(d => d._id);
      expect(ids).to.not.include('emptySubjectReport');
    });

    it('includes reports where at least one subject is non-empty (mixed empty/non-empty)', async () => {
      // If patient_id is empty but place_id is valid, the report should still be included.
      const reportMixedSubjects = {
        _id: 'mixedSubjectReport',
        type: 'data_record',
        form: 'visit',
        patient_id: '',
        place_id: 'place_id',
        reported_date: 800,
      };
      seedReports(db, [reportMixedSubjects]);

      const result = await powersyncProvider(db).allTaskData(mockUserSettingsDoc);
      const ids = result.reportDocs.map(d => d._id);
      expect(ids).to.include('mixedSubjectReport');
    });

    it('excludes tasks with empty-string requester from allTaskData (PouchDB parity)', async () => {
      // allTaskData calls allTasks('requester') internally. Tasks with requester=''
      // should be excluded because the CouchDB view checks `if (doc.requester)`.
      const taskWithEmptyRequester = {
        _id: 'emptyRequesterTask',
        type: 'task',
        requester: '',
        owner: 'patient',
      };
      const taskWithValidRequester = {
        _id: 'validRequesterTask',
        type: 'task',
        requester: 'patient',
        owner: 'patient',
      };
      seedTasks(db, [taskWithEmptyRequester, taskWithValidRequester]);

      const result = await powersyncProvider(db).allTaskData(mockUserSettingsDoc);
      const ids = result.taskDocs.map(d => d._id);
      expect(ids).to.include('validRequesterTask');
      expect(ids).to.not.include('emptyRequesterTask');
    });
  });

  describe('contactsBySubjectId', () => {
    beforeEach(() => {
      seedContacts(db, [contactDoc, placeDoc]);
    });

    it('empty yields empty', async () => {
      expect(await powersyncProvider(db).contactsBySubjectId([])).to.be.empty;
    });

    it('patient_id shortcode yields contact id', async () => {
      const result = await powersyncProvider(db).contactsBySubjectId(['patient_id']);
      expect(result).to.include('patient');
    });

    it('uuid passes through when not a shortcode', async () => {
      const result = await powersyncProvider(db).contactsBySubjectId(['unknown_uuid']);
      expect(result).to.include('unknown_uuid');
    });

    it('resolves mixed shortcodes and uuids', async () => {
      const result = await powersyncProvider(db).contactsBySubjectId(['patient_id', 'some_uuid']);
      expect(result).to.include('patient');
      expect(result).to.include('some_uuid');
    });

    it('place_id shortcode yields contact id (PouchDB parity)', async () => {
      const result = await powersyncProvider(db).contactsBySubjectId(['place_id']);
      expect(result).to.include('place');
    });

    it('uuid and patient_id for same contact (PouchDB parity)', async () => {
      // PouchDB returns duplicates: ['patient', 'patient'] — uuid resolves as shortcode match
      // then also passes through. The duplication is harmless (downstream deduplicates).
      const result = await powersyncProvider(db).contactsBySubjectId(['patient', 'patient_id']);
      expect(result).to.include('patient');
      expect(result.filter(id => id === 'patient')).to.have.length(2);
    });
  });

  describe('existingRulesStateStore', () => {
    it('returns empty store by default', async () => {
      const result = await powersyncProvider(db).existingRulesStateStore();
      expect(result).to.deep.equal({ _id: 'local' });
    });

    it('returns stored state', async () => {
      db._tables.rules_state_store.push({
        id: 'local',
        data: JSON.stringify({ _id: 'local', rulesStateStore: { contactState: {} } }),
      });

      const result = await powersyncProvider(db).existingRulesStateStore();
      expect(result).to.have.property('rulesStateStore');
      expect(result.rulesStateStore).to.deep.equal({ contactState: {} });
    });
  });

  describe('stateChangeCallback', () => {
    it('persists state changes to local table', async () => {
      const provider = powersyncProvider(db);
      const baseDoc = { _id: 'local' };
      await provider.stateChangeCallback(baseDoc, { rulesStateStore: { test: true } });

      expect(db.execute.called).to.be.true;
      const args = db.execute.firstCall.args;
      expect(args[0]).to.include('INSERT OR REPLACE');
      expect(args[0]).to.include('rules_state_store');
    });

    it('serializes baseDoc at write-time, not call-time (PouchDB parity)', async () => {
      // PouchDB's db.put(baseDoc) reads the object at execution time.
      // If two stateChangeCallback calls queue synchronously, PouchDB's first write
      // sees the LATEST baseDoc mutations (because put reads at execution time).
      // The PowerSync adapter must match: JSON.stringify inside the promise chain.
      const provider = powersyncProvider(db);
      const baseDoc = { _id: 'local' };

      // Call twice synchronously — second overwrites first's assigned value
      const p1 = provider.stateChangeCallback(baseDoc, { rulesStateStore: { contact1: 'fresh' } });
      const p2 = provider.stateChangeCallback(baseDoc, { rulesStateStore: { contact1: 'fresh', contact2: 'fresh' } });

      await p1;
      await p2;

      // Both writes should see the LATEST baseDoc state (with contact2).
      // The first write executes after both Object.assign calls have run synchronously,
      // so baseDoc already has { contact1, contact2 } when the first write serializes.
      const calls = db.execute.getCalls().filter(c => c.args[0].includes('rules_state_store'));
      expect(calls).to.have.length(2);

      // Both writes should contain the final state (contact1 + contact2)
      const firstWriteData = JSON.parse(calls[0].args[1][1]);
      const secondWriteData = JSON.parse(calls[1].args[1][1]);
      expect(firstWriteData.rulesStateStore).to.deep.equal({ contact1: 'fresh', contact2: 'fresh' });
      expect(secondWriteData.rulesStateStore).to.deep.equal({ contact1: 'fresh', contact2: 'fresh' });
    });

    it('chains sequential writes without conflicts', async () => {
      const provider = powersyncProvider(db);
      const baseDoc = { _id: 'local' };

      await provider.stateChangeCallback(baseDoc, { rulesStateStore: { step: 1 } });
      await provider.stateChangeCallback(baseDoc, { rulesStateStore: { step: 2 } });
      await provider.stateChangeCallback(baseDoc, { rulesStateStore: { step: 3 } });

      // The final write should contain step: 3
      const calls = db.execute.getCalls().filter(c => c.args[0].includes('rules_state_store'));
      expect(calls).to.have.length(3);
      const finalData = JSON.parse(calls[2].args[1][1]);
      expect(finalData.rulesStateStore).to.deep.equal({ step: 3 });
    });
  });

  describe('commitTargetDoc', () => {
    const targets = [{ id: 'target' }];
    const userContactDoc = { _id: 'user' };
    const userSettingsDoc = { _id: 'org.couchdb.user:username' };

    it('creates a new target doc when none exists', async () => {
      await powersyncProvider(db).commitTargetDoc(targets, '2019-07', { userContactDoc, userSettingsDoc });

      expect(db._tables.targets).to.have.length(1);
      expect(db._tables.targets[0].id).to.equal('target~2019-07~user~org.couchdb.user:username');
      expect(db._tables.targets[0].type).to.equal('target');
    });

    it('does not update existing target doc when updatedTargets is falsy', async () => {
      // Seed an existing target
      db._tables.targets.push({
        id: 'target~2019-07~user~org.couchdb.user:username',
        type: 'target',
        _doc: { _id: 'target~2019-07~user~org.couchdb.user:username', type: 'target', targets: [{ id: 'old' }] },
      });

      const result = await powersyncProvider(db).commitTargetDoc(
        targets, '2019-07', { userContactDoc, userSettingsDoc }
      );
      expect(result).to.equal(false);
    });

    it('updates existing target doc when updatedTargets is true', async () => {
      db._tables.targets.push({
        id: 'target~2019-07~user~org.couchdb.user:username',
        type: 'target',
        _doc: { _id: 'target~2019-07~user~org.couchdb.user:username', type: 'target', targets: [{ id: 'old' }] },
      });

      await powersyncProvider(db).commitTargetDoc(
        targets, '2019-07', { userContactDoc, userSettingsDoc }, true
      );

      // Should have called execute with UPDATE
      const updateCall = db.execute.getCalls().find(c => c.args[0].includes('UPDATE'));
      expect(updateCall).to.exist;
    });

    it('create → skip → update round-trip preserves all fields (PouchDB parity)', async () => {
      // Matches PouchDB pouchdb-provider.spec.js: "create and update a doc"
      const docTag = '2019-07';
      const provider = powersyncProvider(db);

      // Step 1: Create
      await provider.commitTargetDoc(targets, docTag, { userContactDoc, userSettingsDoc });

      expect(db._tables.targets).to.have.length(1);
      const created = db._tables.targets[0]._doc;
      expect(created).to.deep.include({
        _id: 'target~2019-07~user~org.couchdb.user:username',
        type: 'target',
        owner: 'user',
        user: 'org.couchdb.user:username',
        reporting_period: '2019-07',
      });
      expect(created.targets).to.deep.equal(targets);
      expect(created.updated_date).to.be.a('number');

      // Step 2: No-update when updatedTargets is falsy (matches PouchDB _rev check)
      const nextTargets = [{ id: 'target', score: 1 }];
      const skipResult = await provider.commitTargetDoc(
        nextTargets, docTag, { userContactDoc, userSettingsDoc }
      );
      expect(skipResult).to.equal(false);
      // Data unchanged
      expect(db._tables.targets[0]._doc.targets).to.deep.equal(targets);

      // Step 3: Update with updatedTargets=true
      await provider.commitTargetDoc(
        nextTargets, docTag, { userContactDoc, userSettingsDoc }, true
      );
      const updated = db._tables.targets[0]._doc;
      expect(updated.targets).to.deep.equal(nextTargets);
      expect(updated.type).to.equal('target');
      expect(updated.owner).to.equal('user');
      expect(updated.user).to.equal('org.couchdb.user:username');
      expect(updated.reporting_period).to.equal('2019-07');
    });
  });

  describe('commitTaskDocs', () => {
    it('writes task docs via writeTransaction', async () => {
      const taskDocs = [
        { _id: 'task1', type: 'task', state: 'Ready', owner: 'p1', requester: 'p1', user: 'u1', authoredOn: 123 },
        { _id: 'task2', type: 'task', state: 'Draft', owner: 'p2', requester: null, user: 'u1', authoredOn: 456 },
      ];

      await powersyncProvider(db).commitTaskDocs(taskDocs);
      expect(db.writeTransaction.calledOnce).to.be.true;
      expect(db._tables.tasks).to.have.length(2);
    });

    it('returns empty for null/empty input', async () => {
      const result = await powersyncProvider(db).commitTaskDocs([]);
      expect(result).to.deep.equal([]);
      expect(db.writeTransaction.called).to.be.false;
    });

    it('handles errors gracefully', async () => {
      db.writeTransaction = sinon.stub().rejects(new Error('write error'));
      // Should not throw
      await powersyncProvider(db).commitTaskDocs([{ _id: 'task1', type: 'task' }]);
    });
  });

  describe('tasksByRelation', () => {
    beforeEach(() => {
      seedTasks(db, [
        taskOwnedByChtContact, // owner: 'patient', state: undefined (non-terminal)
        taskRequestedByChtContact,
        cancelledTask,
        readyTask,
        draftTask,
      ]);
    });

    it('by requester returns all tasks for contact', async () => {
      const result = await powersyncProvider(db).tasksByRelation(['patient'], 'requester');
      const ids = result.map(d => d._id);
      expect(ids).to.include('taskRequestedBy');
      expect(ids).to.include('cancelledTask');
      expect(ids).to.include('readyTask');
      expect(ids).to.include('draftTask');
    });

    it('by owner returns non-terminal tasks for contact including NULL state', async () => {
      const result = await powersyncProvider(db).tasksByRelation(['patient'], 'owner');
      const ids = result.map(d => d._id);
      // taskOwnedByChtContact has owner='patient' but state=undefined — should be included
      // (CouchDB: undefined state is non-terminal since indexOf(undefined) === -1)
      expect(ids).to.include('taskOwnedBy');
      expect(ids).to.include('readyTask');
      expect(ids).to.include('draftTask');
      expect(ids).to.not.include('cancelledTask');
    });

    it('empty contactIds yields empty', async () => {
      expect(await powersyncProvider(db).tasksByRelation([], 'owner')).to.be.empty;
    });
  });

  describe('allTaskRowsByOwner', () => {
    beforeEach(() => {
      seedTasks(db, [cancelledTask, completedTask, failedTask, readyTask, draftTask, taskOwnedByChtContact]);
    });

    it('returns task rows for specified contacts', async () => {
      const rows = await powersyncProvider(db).allTaskRowsByOwner(['patient']);
      expect(rows).to.have.length(6);
      rows.forEach(row => {
        expect(row.key).to.deep.equal(['owner', 'all', 'patient']);
      });
    });

    it('includes state in value', async () => {
      const rows = await powersyncProvider(db).allTaskRowsByOwner(['patient']);
      const readyRow = rows.find(r => r.id === 'readyTask');
      expect(readyRow.value).to.deep.equal({ state: 'Ready' });
    });

    it('returns empty value for tasks without state', async () => {
      const rows = await powersyncProvider(db).allTaskRowsByOwner(['patient']);
      const ownerRow = rows.find(r => r.id === 'taskOwnedBy');
      expect(ownerRow.value).to.deep.equal({});
    });

    it('empty contactIds yields empty', async () => {
      expect(await powersyncProvider(db).allTaskRowsByOwner([])).to.be.empty;
    });
  });

  describe('allTaskRows', () => {
    it('returns all task rows with correct _unassigned mapping (PouchDB parity)', async () => {
      seedTasks(db, [
        cancelledTask, readyTask, taskOwnedByChtContact,
        taskRequestedByChtContact, taskRequestedByChtPlace,
        readyTaskForPlace, cancelledTaskForPlace,
      ]);

      const rows = await powersyncProvider(db).allTaskRows();
      expect(rows).to.have.length(7);
      expect(rows).to.have.deep.members([
        { id: 'cancelledTask', key: ['owner', 'all', 'patient'], value: { state: 'Cancelled' } },
        { id: 'readyTask', key: ['owner', 'all', 'patient'], value: { state: 'Ready' } },
        { id: 'taskOwnedBy', key: ['owner', 'all', 'patient'], value: {} },
        // Tasks without owner map to '_unassigned' (PouchDB parity: view uses doc.owner || '_unassigned')
        { id: 'taskRequestedBy', key: ['owner', 'all', '_unassigned'], value: {} },
        { id: 'taskRequestedByPlace', key: ['owner', 'all', '_unassigned'], value: {} },
        { id: 'readyPlaceTask', key: ['owner', 'all', 'place'], value: { state: 'Ready' } },
        { id: 'cancelledPlaceTask', key: ['owner', 'all', 'place'], value: { state: 'Cancelled' } },
      ]);
    });
  });

  describe('taskDataFor', () => {
    beforeEach(() => {
      seedContacts(db, [contactDoc, placeDoc]);
      seedReports(db, [
        pregnancyReport,
        reportConnectedByPlace,
        reportConnectedByPatientAndPlaceUuid,
        reportConnectedByPlaceUuid,
      ]);
      seedTasks(db, [
        taskRequestedByChtContact,
        cancelledTask,
        completedTask,
        failedTask,
        readyTask,
        draftTask,
        taskRequestedByChtPlace,
        readyTaskForPlace,
        cancelledTaskForPlace,
      ]);
    });

    it('empty contacts yields empty', async () => {
      expect(await powersyncProvider(db).taskDataFor([])).to.be.empty;
    });

    it('returns exact contact docs, reports, and tasks for patient contact (PouchDB parity)', async () => {
      // Subject IDs for 'patient' contact: { 'patient', 'patient_id' }
      // pregnancyReport: patient_id='patient_id' → matched. getSubjectId='patient_id' → in set ✓
      // reportByPlace: place_id='patient' → matched. getSubjectId='patient' (place_id) → in set ✓
      // reportByPatientAndPlaceUuid: patient_id='patient' → matched. getSubjectId='patient' → in set ✓
      // reportByPlaceUuid: subject_id='place' → NOT in set → not matched by SQL
      const result = await powersyncProvider(db).taskDataFor(['patient'], mockUserSettingsDoc);
      expect(result.contactDocs).to.have.length(1);
      expect(result.contactDocs[0]._id).to.equal('patient');

      const reportIds = result.reportDocs.map(d => d._id).sort();
      expect(reportIds).to.deep.equal([
        'pregReport',
        'reportByPatientAndPlaceUuid',
        'reportByPlace',
      ]);

      const taskIds = result.taskDocs.map(d => d._id).sort();
      expect(taskIds).to.deep.equal([
        'cancelledTask',
        'completedTask',
        'draftTask',
        'failedTask',
        'readyTask',
        'taskRequestedBy',
      ]);

      expect(result.userSettingsId).to.equal('org.couchdb.user:username');
    });

    it('should exclude multi-subject reports whose primary subject is another contact (PouchDB parity)', async () => {
      // For the 'place' contact: subject IDs = { 'place', 'place_id' }
      // reportByPatientAndPlaceUuid: subject_id='place' → matched by SQL.
      //   BUT getSubjectId returns 'patient' (patient_id takes priority) → NOT in set → filtered OUT
      // reportByPlaceUuid: subject_id='place' → matched. getSubjectId='place' → in set ✓
      // pregnancyReport: patient_id='patient_id' → NOT in set
      // reportByPlace: place_id='patient' → NOT in set
      const result = await powersyncProvider(db).taskDataFor(['place'], mockUserSettingsDoc);
      expect(result.contactDocs).to.have.length(1);
      expect(result.contactDocs[0]._id).to.equal('place');

      const reportIds = result.reportDocs.map(d => d._id);
      expect(reportIds).to.deep.equal(['reportByPlaceUuid']);

      const taskIds = result.taskDocs.map(d => d._id).sort();
      expect(taskIds).to.deep.equal([
        'cancelledPlaceTask',
        'readyPlaceTask',
        'taskRequestedByPlace',
      ]);
    });

    it('should include all reports and tasks for both contacts', async () => {
      const result = await powersyncProvider(db).taskDataFor(
        [contactDoc._id, placeDoc._id], mockUserSettingsDoc
      );
      expect(result.contactDocs).to.have.length(2);

      const reportIds = result.reportDocs.map(d => d._id).sort();
      // Subject IDs combined: { 'patient', 'place', 'patient_id', 'place_id' }
      // All reports with matching subjects included after post-filter:
      //   pregnancyReport: getSubjectId='patient_id' → in set ✓
      //   reportByPlace: getSubjectId='patient' (place_id='patient') → in set ✓
      //   reportByPatientAndPlaceUuid: getSubjectId='patient' → in set ✓
      //   reportByPlaceUuid: getSubjectId='place' → in set ✓
      expect(reportIds).to.deep.equal([
        'pregReport',
        'reportByPatientAndPlaceUuid',
        'reportByPlace',
        'reportByPlaceUuid',
      ]);

      const taskIds = result.taskDocs.map(d => d._id).sort();
      expect(taskIds).to.deep.equal([
        'cancelledPlaceTask',
        'cancelledTask',
        'completedTask',
        'draftTask',
        'failedTask',
        'readyPlaceTask',
        'readyTask',
        'taskRequestedBy',
        'taskRequestedByPlace',
      ]);
    });

    it('returns empty docs for unrecognized contact', async () => {
      const result = await powersyncProvider(db).taskDataFor(['unknown'], mockUserSettingsDoc);
      expect(result.contactDocs).to.be.empty;
      expect(result.reportDocs).to.be.empty;
      expect(result.taskDocs).to.be.empty;
      expect(result.userSettingsId).to.equal('org.couchdb.user:username');
    });

    it('excludes reports with empty-string form in taskDataFor (PouchDB parity)', async () => {
      // CouchDB reports_by_subject view requires `doc.form` to be truthy.
      // Reports with form='' should not be returned even if they match subject IDs.
      const emptyFormReport = {
        _id: 'emptyFormReport',
        type: 'data_record',
        form: '',
        patient_id: 'patient_id',
        reported_date: 500,
      };
      seedReports(db, [emptyFormReport, pregnancyReport]);

      const result = await powersyncProvider(db).taskDataFor(['patient'], mockUserSettingsDoc);
      const reportIds = result.reportDocs.map(d => d._id);
      expect(reportIds).to.include('pregReport');
      expect(reportIds).to.not.include('emptyFormReport');
    });
  });

  describe('SQL parameter chunking', () => {
    const { MAX_SQL_ITEMS } = powersyncProvider;

    it('should not chunk when item count is within limit', async () => {
      const contacts = [];
      for (let i = 0; i < 10; i++) {
        contacts.push({
          _id: `contact-${i}`,
          type: 'contact',
          contact_type: 'person',
          name: `Contact ${i}`,
          patient_id: `shortcode-${i}`,
        });
      }
      seedContacts(db, contacts);

      const result = await powersyncProvider(db).contactsBySubjectId(
        contacts.map(c => c.patient_id)
      );
      // Each shortcode should resolve to its contact ID
      expect(result).to.have.length(10);
      contacts.forEach(c => {
        expect(result).to.include(c._id);
      });

      // getAll should have been called once (no chunking)
      expect(db.getAll.callCount).to.equal(1);
    });

    it('should chunk contactsBySubjectId when exceeding MAX_SQL_ITEMS', async () => {
      const count = MAX_SQL_ITEMS + 50;
      const contacts = [];
      for (let i = 0; i < count; i++) {
        contacts.push({
          _id: `contact-${i}`,
          type: 'contact',
          contact_type: 'person',
          name: `Contact ${i}`,
          patient_id: `shortcode-${i}`,
        });
      }
      seedContacts(db, contacts);

      const subjectIds = contacts.map(c => c.patient_id);
      const result = await powersyncProvider(db).contactsBySubjectId(subjectIds);

      // All shortcodes should resolve (chunked into 2 queries)
      expect(result).to.have.length(count);
      contacts.forEach(c => {
        expect(result).to.include(c._id);
      });

      // Should have been called twice (chunked)
      expect(db.getAll.callCount).to.equal(2);
    });

    it('should chunk tasksByRelation for large contact lists', async () => {
      const count = MAX_SQL_ITEMS + 100;
      const tasks = [];
      for (let i = 0; i < count; i++) {
        tasks.push({
          _id: `task-${i}`,
          type: 'task',
          owner: `contact-${i}`,
          requester: `contact-${i}`,
          state: 'Ready',
        });
      }
      seedTasks(db, tasks);

      const contactIds = tasks.map(t => t.owner);
      const result = await powersyncProvider(db).tasksByRelation(contactIds, 'owner');

      expect(result).to.have.length(count);
      // Should have been chunked into 2 calls
      expect(db.getAll.callCount).to.equal(2);
    });

    it('should chunk allTaskRowsByOwner for large contact lists', async () => {
      const count = MAX_SQL_ITEMS + 100;
      const tasks = [];
      for (let i = 0; i < count; i++) {
        tasks.push({
          _id: `task-${i}`,
          type: 'task',
          owner: `contact-${i}`,
          state: 'Draft',
        });
      }
      seedTasks(db, tasks);

      const contactIds = tasks.map(t => t.owner);
      const rows = await powersyncProvider(db).allTaskRowsByOwner(contactIds);

      expect(rows).to.have.length(count);
      rows.forEach(row => {
        expect(row.key[0]).to.equal('owner');
        expect(row.key[1]).to.equal('all');
        expect(row.value).to.deep.equal({ state: 'Draft' });
      });
      // Should have been chunked into 2 calls
      expect(db.getAll.callCount).to.equal(2);
    });

    it('should chunk taskDataFor contacts and reports queries', async () => {
      const count = MAX_SQL_ITEMS + 50;
      const contacts = [];
      const reports = [];
      for (let i = 0; i < count; i++) {
        const contact = {
          _id: `contact-${i}`,
          type: 'contact',
          contact_type: 'person',
          name: `Contact ${i}`,
          patient_id: `pid-${i}`,
        };
        contacts.push(contact);
        reports.push({
          _id: `report-${i}`,
          type: 'data_record',
          form: 'pregnancy',
          patient_id: `pid-${i}`,
          reported_date: i,
        });
      }
      seedContacts(db, contacts);
      seedReports(db, reports);

      const contactIds = contacts.map(c => c._id);
      const result = await powersyncProvider(db).taskDataFor(contactIds, { _id: 'user' });

      expect(result.contactDocs).to.have.length(count);
      expect(result.reportDocs).to.have.length(count);
      // contacts query chunked (2 calls) + reports query chunked (2 calls) + tasksByRelation (1 call, empty)
      // Total getAll calls >= 4
      expect(db.getAll.callCount).to.be.at.least(4);
    });

    it('should deduplicate results across chunks when a doc matches multiple chunks', async () => {
      // A report that matches subject IDs in different chunks should only appear once
      const count = MAX_SQL_ITEMS + 10;
      const contacts = [];
      for (let i = 0; i < count; i++) {
        contacts.push({
          _id: `contact-${i}`,
          type: 'contact',
          contact_type: 'person',
          name: `Contact ${i}`,
          patient_id: `pid-${i}`,
        });
      }
      seedContacts(db, contacts);

      // This report matches patient_id from chunk 1 AND place_id from chunk 2
      const crossChunkReport = {
        _id: 'cross-chunk-report',
        type: 'data_record',
        form: 'visit',
        patient_id: 'pid-0',
        place_id: `pid-${MAX_SQL_ITEMS + 5}`,
        reported_date: 999,
      };
      seedReports(db, [crossChunkReport]);

      const contactIds = contacts.map(c => c._id);
      const result = await powersyncProvider(db).taskDataFor(contactIds, { _id: 'user' });

      // The cross-chunk report should appear exactly once (deduplicated by parseDocs)
      const crossChunkResults = result.reportDocs.filter(r => r._id === 'cross-chunk-report');
      expect(crossChunkResults).to.have.length(1);
    });
  });

  describe('adapter factory', () => {
    it('creates powersync provider via adapters index', () => {
      const adapters = require('../src/adapters');
      const provider = adapters.create('powersync', db);
      expect(provider).to.have.property('allTasks');
      expect(provider).to.have.property('allTaskData');
      expect(provider).to.have.property('taskDataFor');
      expect(provider).to.have.property('commitTaskDocs');
      expect(provider).to.have.property('commitTargetDoc');
      expect(provider).to.have.property('existingRulesStateStore');
      expect(provider).to.have.property('stateChangeCallback');
      expect(provider).to.have.property('contactsBySubjectId');
      expect(provider).to.have.property('tasksByRelation');
      expect(provider).to.have.property('allTaskRowsByOwner');
      expect(provider).to.have.property('allTaskRows');
    });

    it('falls back to pouchdb provider by default', () => {
      const adapters = require('../src/adapters');
      // This would need a PouchDB-compatible db, just test it doesn't throw on creation
      const provider = adapters.create('pouchdb', {});
      expect(provider).to.have.property('allTasks');
    });
  });

  describe('index.js adapter selection', () => {
    it('accepts adapter option for powersync', () => {
      const rulesEngine = require('../src/index');
      const engine = rulesEngine(db, { adapter: 'powersync' });
      expect(engine).to.have.property('initialize');
      expect(engine).to.have.property('fetchTasksFor');
      expect(engine).to.have.property('fetchTargets');
    });

    it('defaults to pouchdb adapter', () => {
      const rulesEngine = require('../src/index');
      const engine = rulesEngine({});
      expect(engine).to.have.property('initialize');
    });
  });
});
