/**
 * @module powersync-adapter
 *
 * Data provider for the rules engine using PowerSync's client-side SQLite database.
 * Translates CouchDB view queries into SQL equivalents for the PowerSync schema.
 *
 * PowerSync table schema assumptions (synced from server via Sync Streams):
 *   - contacts: id, type, contact_type, name, parent_id, patient_id, place_id, date_of_death, muted, doc (JSONB text)
 *   - reports: id, type, form, patient_id, place_id, case_id, subject_id, reported_date, fields (JSON text), doc (JSONB)
 *   - tasks: id, type, state, owner, requester, emission (JSON text), user, authored_on, state_history (JSON text), doc
 *   - targets: id, type, owner, user, reporting_period, targets (JSON text), updated_date
 *   - rules_state_store: local-only table, id, data (JSON text)
 *
 * Notes on CouchDB view parity:
 *   - The CouchDB reports_by_subject view indexes case_id, but registrationUtils.getSubjectIds()
 *     does NOT include case_id for contacts. Reports matched solely by case_id would not appear
 *     in the PouchDB adapter either (subject IDs come from contacts, which lack case_id).
 *   - For owner-prefix task queries, CouchDB uses `doc.owner || '_unassigned'` — tasks with
 *     NULL owner are treated as '_unassigned' and included. NULL state is non-terminal.
 *   - SQLite has a default limit of 999 bound parameters. For contact lists exceeding ~300,
 *     queries with triple-expanded placeholders (reports query) may need chunking.
 */

/* eslint-disable no-console */
const moment = require('moment');
const registrationUtils = require('@medic/registration-utils');
const uniqBy = require('lodash/uniqBy');

const RULES_STATE_DOCID = 'local';
const LOCAL_STATE_TABLE = 'rules_state_store';

/**
 * Maximum number of items to use in a single SQL IN clause.
 * SQLite has a default limit of 999 bound parameters (SQLITE_MAX_VARIABLE_NUMBER).
 * Some queries expand items into multiple IN clauses (e.g., taskDataFor uses 3x),
 * so we use a conservative limit to stay well within bounds.
 * The PouchDB adapter has a similar limit (MAX_QUERY_KEYS = 500).
 */
const MAX_SQL_ITEMS = 300;

/**
 * Parse a JSON doc column, returning the parsed object or the row itself as fallback.
 * PowerSync stores full documents as JSON text in a `doc` column.
 */
const parseDoc = (row) => {
  if (!row) {
    return null;
  }
  if (row.doc) {
    try {
      return typeof row.doc === 'string' ? JSON.parse(row.doc) : row.doc;
    } catch (e) {
      return row;
    }
  }
  return row;
};

const parseDocs = (rows) => {
  return uniqBy(rows, 'id')
    .map(parseDoc)
    .filter(Boolean);
};

/**
 * Build SQL placeholders for an array of values: (?, ?, ?)
 */
const placeholders = (arr) => arr.map(() => '?').join(', ');

/**
 * Execute a query function in chunks when the item list would exceed SQLite's parameter limit.
 * Concatenates results from all chunks. Callers must deduplicate if needed (parseDocs handles this).
 *
 * @param {Array} items The full list of items to query for
 * @param {Function} queryFn Async function that takes a chunk of items and returns rows
 * @returns {Promise<Array>} Concatenated rows from all chunks
 */
const chunkedQuery = async (items, queryFn) => {
  if (items.length <= MAX_SQL_ITEMS) {
    return queryFn(items);
  }
  const results = [];
  for (let i = 0; i < items.length; i += MAX_SQL_ITEMS) {
    const chunk = items.slice(i, i + MAX_SQL_ITEMS);
    const rows = await queryFn(chunk);
    results.push(...rows);
  }
  return results;
};

const powersyncProvider = (db) => {
  const self = {
    /**
     * Fetch all task documents matching a relation prefix (owner or requester).
     * Equivalent to CouchDB view: medic-client/tasks_by_contact with startkey/endkey on prefix.
     *
     * The CouchDB view emits:
     *   - 'owner-{ownerId}' for non-terminal tasks
     *   - 'requester-{requesterId}' for all tasks with a requester
     *
     * For 'owner': returns all non-terminal tasks (Draft, Ready states)
     *   PLUS tasks that have the owner field set (regardless of state for the 'all' emit)
     *   Actually the startkey/endkey 'owner-' prefix catches the 'owner-{id}' emit which excludes terminal states.
     * For 'requester': returns all tasks that have a requester field set.
     */
    allTasks: async (prefix) => {
      let sql;
      if (prefix === 'owner') {
        // CouchDB view emits 'owner-{ownerId}' for non-terminal tasks, where ownerId = doc.owner || '_unassigned'.
        // Tasks with NULL owner become '_unassigned' and are still emitted.
        // Tasks with NULL/undefined state are NOT terminal (indexOf(undefined) === -1).
        // SQL NOT IN excludes NULLs, so we explicitly handle NULL state.
        sql = `SELECT doc FROM tasks
               WHERE type = 'task'
                 AND (state IS NULL OR state NOT IN ('Cancelled', 'Completed', 'Failed'))`;
      } else {
        // 'requester' prefix: emitted for all tasks with a requester, regardless of state
        sql = `SELECT doc FROM tasks
               WHERE type = 'task'
                 AND requester IS NOT NULL`;
      }
      const rows = await db.getAll(sql);
      return parseDocs(rows);
    },

    /**
     * Fetch all data needed for a full rules refresh: all contacts, all reports, all requester-tasks.
     * Equivalent to calling contacts_by_type + reports_by_subject + allTasks('requester').
     */
    allTaskData: async (userSettingsDoc) => {
      const userSettingsId = userSettingsDoc?._id;
      const [contactDocs, reportDocs, taskDocs] = await Promise.all([
        // contacts_by_type: all contacts (person, clinic, health_center, district_hospital, or contact_type)
        db.getAll(`SELECT doc FROM contacts WHERE type = 'contact' OR type IN ('district_hospital', 'health_center', 'clinic', 'person')`)
          .then(parseDocs),
        // reports_by_subject: all reports (data_records with a form) that have at least one subject identifier.
        // The CouchDB view only emits rows for reports with subject fields (patient_id, place_id,
        // patient_uuid, place_uuid, case_id). Reports with none of these produce zero view emissions
        // and are excluded. We mirror this by requiring at least one denormalized column to be non-NULL.
        db.getAll(`SELECT doc FROM reports WHERE type = 'data_record' AND form IS NOT NULL
                   AND (patient_id IS NOT NULL OR place_id IS NOT NULL OR subject_id IS NOT NULL OR case_id IS NOT NULL)`)
          .then(parseDocs),
        self.allTasks('requester'),
      ]);
      return { contactDocs, reportDocs, taskDocs, userSettingsId };
    },

    /**
     * Resolve subject IDs (shortcodes like patient_id) to contact document _ids.
     * Equivalent to CouchDB view: medic-client/contacts_by_reference with keys [['shortcode', id], ...]
     *
     * The view indexes contacts by their patient_id and place_id as shortcodes.
     * If a subjectId matches a shortcode, return the contact's _id.
     * If it doesn't match any shortcode, return the subjectId as-is (it may already be a UUID).
     */
    contactsBySubjectId: async (subjectIds) => {
      if (!subjectIds || subjectIds.length === 0) {
        return [];
      }

      // Uses 2x params (patient_id IN + place_id IN), so chunk to stay within SQLite limits
      const rows = await chunkedQuery(subjectIds, async (chunk) => {
        const sql = `SELECT id, patient_id, place_id FROM contacts
                     WHERE patient_id IN (${placeholders(chunk)})
                        OR place_id IN (${placeholders(chunk)})`;
        return db.getAll(sql, [...chunk, ...chunk]);
      });

      // Track which input IDs matched shortcodes so the rest pass through as UUIDs
      const matchedShortcodes = new Set();
      for (const row of rows) {
        if (row.patient_id && subjectIds.includes(row.patient_id)) {
          matchedShortcodes.add(row.patient_id);
        }
        if (row.place_id && subjectIds.includes(row.place_id)) {
          matchedShortcodes.add(row.place_id);
        }
      }

      const resolvedIds = rows.map(row => row.id);

      // IDs that weren't shortcodes pass through as-is (they may be UUIDs)
      const passthroughIds = subjectIds.filter(id => !matchedShortcodes.has(id));
      return [...resolvedIds, ...passthroughIds];
    },

    /**
     * Callback to persist rules state store changes.
     * Uses a local-only PowerSync table (not synced to server).
     */
    stateChangeCallback: (() => {
      let previousResult = Promise.resolve();
      return (baseDoc, assigned) => {
        Object.assign(baseDoc, assigned);
        const data = JSON.stringify(baseDoc);

        previousResult = previousResult
          .then(() => db.execute(
            `INSERT OR REPLACE INTO ${LOCAL_STATE_TABLE} (id, data) VALUES (?, ?)`,
            [RULES_STATE_DOCID, data]
          ))
          .catch(err => console.error(`Error updating rules state store: ${err}`))
          .then(() => {
            previousResult = Promise.resolve();
          });

        return previousResult;
      };
    })(),

    /**
     * Write or update a target document.
     * Equivalent to PouchDB get + put pattern for target docs.
     */
    commitTargetDoc: async (targets, docTag, { userContactDoc, userSettingsDoc }, updatedTargets) => {
      const userContactId = userContactDoc?._id;
      const userSettingsId = userSettingsDoc?._id;
      const _id = `target~${docTag}~${userContactId}~${userSettingsId}`;

      const existing = await db.getOptional('SELECT doc FROM targets WHERE id = ?', [_id]);
      const existingDoc = existing ? parseDoc(existing) : null;

      if (existingDoc) {
        if (!updatedTargets) {
          return false;
        }
        existingDoc.targets = targets;
        existingDoc.updated_date = moment().startOf('day').valueOf();
        await db.execute(
          `UPDATE targets SET doc = ?, targets = ?, updated_date = ? WHERE id = ?`,
          [JSON.stringify(existingDoc), JSON.stringify(targets), existingDoc.updated_date, _id]
        );
      } else {
        const newDoc = {
          _id,
          type: 'target',
          user: userSettingsId,
          owner: userContactId,
          reporting_period: docTag,
          targets,
          updated_date: moment().startOf('day').valueOf(),
        };
        await db.execute(
          `INSERT INTO targets (id, type, owner, user, reporting_period, targets, updated_date, doc)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [_id, 'target', userContactId, userSettingsId, docTag,
            JSON.stringify(targets), newDoc.updated_date, JSON.stringify(newDoc)]
        );
      }
    },

    /**
     * Batch write task documents.
     * Uses PowerSync writeTransaction for atomicity.
     */
    commitTaskDocs: async (taskDocs) => {
      if (!taskDocs || taskDocs.length === 0) {
        return [];
      }

      console.debug(`Committing ${taskDocs.length} task document updates`);
      try {
        await db.writeTransaction(async (tx) => {
          for (const taskDoc of taskDocs) {
            const id = taskDoc._id;
            const doc = JSON.stringify(taskDoc);
            await tx.execute(
              `INSERT OR REPLACE INTO tasks (id, type, state, owner, requester, user, authored_on, doc)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [id, 'task', taskDoc.state, taskDoc.owner || null, taskDoc.requester || null,
                taskDoc.user || null, taskDoc.authoredOn || null, doc]
            );
          }
        });
      } catch (err) {
        console.error('Error committing task documents', err);
      }
    },

    /**
     * Load existing rules state store from local-only table.
     */
    existingRulesStateStore: async () => {
      const row = await db.getOptional(
        `SELECT data FROM ${LOCAL_STATE_TABLE} WHERE id = ?`,
        [RULES_STATE_DOCID]
      );
      if (row?.data) {
        try {
          return JSON.parse(row.data);
        } catch (e) {
          return { _id: RULES_STATE_DOCID };
        }
      }
      return { _id: RULES_STATE_DOCID };
    },

    /**
     * Fetch tasks related to specific contacts by a relation prefix (owner or requester).
     * Equivalent to CouchDB view: tasks_by_contact with specific keys like 'requester-{id}'.
     *
     * For 'requester': all tasks where requester is in contactIds
     * For 'owner': non-terminal tasks where owner is in contactIds
     */
    tasksByRelation: async (contactIds, prefix) => {
      if (!contactIds || contactIds.length === 0) {
        return [];
      }

      const rows = await chunkedQuery(contactIds, async (chunk) => {
        let sql;
        if (prefix === 'owner') {
          // CouchDB view emits 'owner-{id}' only for non-terminal tasks.
          // NULL/undefined state is non-terminal in CouchDB (indexOf(undefined) === -1).
          // SQL NOT IN excludes NULLs, so we explicitly handle NULL state.
          sql = `SELECT doc FROM tasks
                 WHERE type = 'task'
                   AND (state IS NULL OR state NOT IN ('Cancelled', 'Completed', 'Failed'))
                   AND owner IN (${placeholders(chunk)})`;
        } else {
          sql = `SELECT doc FROM tasks
                 WHERE type = 'task'
                   AND requester IN (${placeholders(chunk)})`;
        }
        return db.getAll(sql, chunk);
      });
      return parseDocs(rows);
    },

    /**
     * Fetch task rows (id, key, value) for contacts by owner.
     * Returns rows matching the CouchDB view output format: { id, key: ['owner', 'all', ownerId], value: { state } }
     * This includes ALL tasks (including terminal states) since the view emits ['owner', 'all', id] for all tasks.
     */
    allTaskRowsByOwner: async (contactIds) => {
      if (!contactIds || contactIds.length === 0) {
        return [];
      }

      const rows = await chunkedQuery(contactIds, async (chunk) => {
        const sql = `SELECT id, owner, state FROM tasks
                     WHERE type = 'task'
                       AND owner IN (${placeholders(chunk)})`;
        return db.getAll(sql, chunk);
      });

      return uniqBy(rows, 'id').map(row => ({
        id: row.id,
        key: ['owner', 'all', row.owner || '_unassigned'],
        value: row.state ? { state: row.state } : {},
      }));
    },

    /**
     * Fetch all task rows (id, key, value) for all contacts.
     * Returns rows matching CouchDB view output: { id, key: ['owner', 'all', ownerId], value: { state } }
     */
    allTaskRows: async () => {
      const sql = `SELECT id, owner, state FROM tasks WHERE type = 'task'`;
      const rows = await db.getAll(sql);

      return uniqBy(rows, 'id').map(row => ({
        id: row.id,
        key: ['owner', 'all', row.owner || '_unassigned'],
        value: row.state ? { state: row.state } : {},
      }));
    },

    /**
     * Fetch task data (contacts, reports, tasks) for a specific set of contact IDs.
     * This is the targeted refresh path — only fetches data for dirty contacts.
     */
    taskDataFor: async (contactIds, userSettingsDoc) => {
      if (!contactIds || contactIds.length === 0) {
        return {};
      }

      // Fetch contact documents (1x params)
      const contactRows = await chunkedQuery(contactIds, async (chunk) => {
        return db.getAll(
          `SELECT doc FROM contacts WHERE id IN (${placeholders(chunk)})`,
          chunk
        );
      });
      const contactDocs = parseDocs(contactRows);

      // Build the set of subject IDs from contacts (includes UUIDs + shortcodes like patient_id)
      const subjectIds = contactDocs.reduce((agg, contactDoc) => {
        registrationUtils.getSubjectIds(contactDoc).forEach(subjectId => agg.add(subjectId));
        return agg;
      }, new Set(contactIds));

      const subjectIdArray = Array.from(subjectIds);

      // Fetch reports by subject (3x params — most critical for chunking).
      // The CouchDB view indexes by patient_id, place_id, case_id,
      // fields.patient_id, fields.place_id, fields.case_id, fields.patient_uuid, fields.place_uuid.
      // However, registrationUtils.getSubjectIds uses only: _id, patient_id, place_id (contacts)
      // and patient_id, patient_uuid, place_id, place_uuid (reports). case_id is NOT a subject
      // property, so contact subject IDs never include case_id values. Reports matched solely
      // by case_id would not appear in PouchDB either. subject_id column covers patient_uuid/place_uuid.
      const [reportRows, taskDocs] = await Promise.all([
        chunkedQuery(subjectIdArray, async (chunk) => {
          const sql = `SELECT doc FROM reports
                       WHERE type = 'data_record' AND form IS NOT NULL
                         AND (patient_id IN (${placeholders(chunk)})
                           OR place_id IN (${placeholders(chunk)})
                           OR subject_id IN (${placeholders(chunk)}))`;
          return db.getAll(sql, [...chunk, ...chunk, ...chunk]);
        }),
        self.tasksByRelation(contactIds, 'requester'),
      ]);

      const reportDocs = parseDocs(reportRows);

      // Filter reports to only include those whose primary subject is in our set
      const relevantReportDocs = reportDocs.filter(report => {
        const subjectId = registrationUtils.getSubjectId(report);
        return subjectIds.has(subjectId);
      });

      return {
        userSettingsId: userSettingsDoc?._id,
        contactDocs,
        reportDocs: relevantReportDocs,
        taskDocs,
      };
    },
  };

  return self;
};

powersyncProvider.RULES_STATE_DOCID = RULES_STATE_DOCID;
powersyncProvider.MAX_SQL_ITEMS = MAX_SQL_ITEMS;

module.exports = powersyncProvider;
