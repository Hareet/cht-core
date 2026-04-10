'use strict';

const crypto = require('crypto');
const vm = require('vm');
const contacts = require('./contacts');
const records = require('./records');
const purgeStatus = require('./purge-status');
const rolesService = require('./roles');

const CONTACT_BATCH_SIZE = parseInt(process.env.PURGE_CONTACT_BATCH_SIZE || '500', 10);
const MAX_RECORDS_PER_CONTACT = parseInt(process.env.PURGE_MAX_RECORDS || '20000', 10);
const PURGE_FN_TIMEOUT_MS = parseInt(process.env.PURGE_FN_TIMEOUT_MS || '5000', 10);
const TASK_EXPIRATION_DAYS = 60;
const TARGET_EXPIRATION_MONTHS = 6;

// Compute a hash of the purge function source for change detection.
const hashPurgeFn = (fn) => {
  return crypto.createHash('sha256').update(fn.toString()).digest('hex');
};

// Parse the purge function from app_settings config stored in PostgreSQL.
// Settings doc structure: { _id: 'settings', settings: { purge: { fn: '...' } } }
// Sentinel loads doc.settings into config, then config.get('purge') returns doc.settings.purge.
const getPurgeFn = async (db) => {
  const tbl = `${db.getSchema()}.couchdb`;
  const result = await db.query(`
    SELECT doc->'settings'->'purge'->>'fn' AS fn
    FROM ${tbl}
    WHERE _id = 'settings'
    LIMIT 1
  `);

  if (!result.rows.length || !result.rows[0].fn) {
    return null;
  }

  try {
    const fn = eval(`(${result.rows[0].fn})`);
    if (typeof fn !== 'function') {
      return null;
    }
    return fn;
  } catch {
    return null;
  }
};

// Build groups from contacts: each group has a contact and its associated reports/messages.
const buildGroupForContact = async (contactRow) => {
  const contact = contactRow.doc;
  const subjectIds = records.getSubjectIds(contact);
  const { reports, messages } = await records.getRecordsForSubjects(subjectIds);

  const ids = [contactRow.id];
  ids.push(...reports.map(r => r._id));
  ids.push(...messages.map(m => m._id));

  return { contact, reports, messages, ids };
};

// Evaluate purge function for a group across all role sets.
const evaluateGroup = (purgeFn, group, rolesByHash) => {
  const toPurge = {};

  for (const [hash, rolesList] of Object.entries(rolesByHash)) {
    toPurge[hash] = toPurge[hash] || {};

    if (!group.ids.length) {
      continue;
    }

    let idsToPurge;
    try {
      // Run the purge function inside a vm context with a timeout to prevent
      // infinite loops or excessively slow purge.js from hanging the service.
      const sandbox = vm.createContext({
        purgeFn,
        userCtx: { roles: rolesList },
        contact: group.contact,
        reports: group.reports,
        messages: group.messages,
      });
      idsToPurge = vm.runInNewContext(
        'purgeFn(userCtx, contact, reports, messages)',
        sandbox,
        { timeout: PURGE_FN_TIMEOUT_MS }
      );
    } catch (err) {
      // Purge function errors (including timeouts) are non-fatal; treat as "purge nothing".
      // vm timeout throws an ERR_SCRIPT_EXECUTION_TIMEOUT error.
      if (err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
        console.warn(`Purge function timed out after ${PURGE_FN_TIMEOUT_MS}ms for role ${rolesList.join(',')}`);
      }
      continue;
    }

    if (!Array.isArray(idsToPurge)) {
      continue;
    }

    for (const id of idsToPurge) {
      // Only allow purging IDs that were in the group
      if (group.ids.includes(id)) {
        toPurge[hash][id] = true;
      }
    }

    // Mark non-purged IDs explicitly as false
    for (const id of group.ids) {
      if (toPurge[hash][id] === undefined) {
        toPurge[hash][id] = false;
      }
    }
  }

  return toPurge;
};

// Process unallocated records (reports/messages not tied to any contact).
// When `since` is provided, only processes records changed after that timestamp (incremental mode).
const processUnallocatedRecords = async (purgeFn, rolesByHash, stats, since) => {
  let offset = 0;
  const batchSize = CONTACT_BATCH_SIZE;

  while (true) {
    const batch = await records.getUnallocatedRecords(batchSize, offset, since);
    if (!batch.length) {
      break;
    }

    for (const row of batch) {
      const doc = row.doc;
      const group = {
        contact: {},
        reports: doc.form ? [doc] : [],
        messages: doc.form ? [] : [doc],
        ids: [row.id],
      };

      const toPurge = evaluateGroup(purgeFn, group, rolesByHash);
      await purgeStatus.writePurgeResults(toPurge);
      stats.docsEvaluated++;

      for (const hash of Object.keys(toPurge)) {
        if (toPurge[hash][row.id]) {
          stats.docsPurged++;
        } else {
          stats.docsUnpurged++;
        }
      }
    }

    offset += batch.length;
    if (batch.length < batchSize) {
      break;
    }
  }
};

// Auto-purge tasks in terminal state older than TASK_EXPIRATION_DAYS.
// This mirrors sentinel/src/lib/purging.js purgeTasks() — automatic, not controlled by purge.js.
// Terminal states: Cancelled, Completed, Failed. Key field: emission.endDate.
const purgeExpiredTasks = async (rolesByHash, stats) => {
  const db = require('./db');
  const tbl = `${db.getSchema()}.couchdb`;
  const cutoffDate = new Date(Date.now() - TASK_EXPIRATION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10); // YYYY-MM-DD format

  const result = await db.query(`
    SELECT _id
    FROM ${tbl}
    WHERE doc->>'type' = 'task'
      AND (_deleted IS NOT TRUE)
      AND doc->>'state' IN ('Cancelled', 'Completed', 'Failed')
      AND doc->'emission'->>'endDate' IS NOT NULL
      AND doc->'emission'->>'endDate' <= $1
  `, [cutoffDate]);

  if (!result.rows.length) {
    return;
  }

  const toPurge = {};
  for (const hash of Object.keys(rolesByHash)) {
    toPurge[hash] = {};
    for (const row of result.rows) {
      toPurge[hash][row._id] = true;
    }
  }

  await purgeStatus.writePurgeResults(toPurge);
  stats.docsEvaluated += result.rows.length;
  stats.docsPurged += result.rows.length * Object.keys(rolesByHash).length;
  console.log(`Auto-purged ${result.rows.length} expired tasks`);
};

// Auto-purge target documents with reporting period older than TARGET_EXPIRATION_MONTHS.
// This mirrors sentinel/src/lib/purging.js purgeTargets(). Target IDs follow the pattern:
// target~YYYY-MM~<owner>~<other>. Targets older than 6 months are purged for all roles.
const purgeExpiredTargets = async (rolesByHash, stats) => {
  const db = require('./db');
  const tbl = `${db.getSchema()}.couchdb`;
  const cutoffPeriod = new Date(
    Date.now() - TARGET_EXPIRATION_MONTHS * 30 * 24 * 60 * 60 * 1000
  );
  const cutoffTag = `${cutoffPeriod.getFullYear()}-${String(cutoffPeriod.getMonth() + 1).padStart(2, '0')}`;

  const result = await db.query(`
    SELECT _id
    FROM ${tbl}
    WHERE _id LIKE 'target~%'
      AND (_deleted IS NOT TRUE)
      AND _id < $1
  `, [`target~${cutoffTag}~`]);

  if (!result.rows.length) {
    return;
  }

  const toPurge = {};
  for (const hash of Object.keys(rolesByHash)) {
    toPurge[hash] = {};
    for (const row of result.rows) {
      toPurge[hash][row._id] = true;
    }
  }

  await purgeStatus.writePurgeResults(toPurge);
  stats.docsEvaluated += result.rows.length;
  stats.docsPurged += result.rows.length * Object.keys(rolesByHash).length;
  console.log(`Auto-purged ${result.rows.length} expired targets`);
};

// Full purge evaluation run.
const run = async (options = {}) => {
  const db = require('./db');

  // Acquire advisory lock to prevent concurrent runs from corrupting purge_status.
  const lock = await purgeStatus.tryAcquireRunLock();
  if (!lock.acquired) {
    console.log('Another purge run is already in progress. Skipping.');
    return;
  }

  try {
    await _runWithLock(options, db);
  } finally {
    await purgeStatus.releaseRunLock(lock.client);
  }
};

const _runWithLock = async (options, db) => {
  let incremental = options.incremental !== false;

  const purgeFn = await getPurgeFn(db);
  if (!purgeFn) {
    console.log('No purge function configured. Skipping.');
    return;
  }

  const currentFnHash = hashPurgeFn(purgeFn);

  const rolesByHash = await rolesService.getRoles();
  if (!Object.keys(rolesByHash).length) {
    console.log('No offline roles found. Skipping.');
    return;
  }

  // Detect purge function changes: if the function source has changed since
  // the last completed run, force a full re-evaluation. Incremental mode would
  // only process recently-changed documents, leaving all other documents with
  // stale purge decisions from the old function.
  if (incremental) {
    const lastFnHash = await purgeStatus.getLastPurgeFnHash();
    if (lastFnHash && lastFnHash !== currentFnHash) {
      console.log('Purge function changed since last run. Forcing full re-evaluation.');
      incremental = false;
    }
  }

  // Detect role changes: if the set of offline roles has changed since the
  // last completed run, force a full re-evaluation. New roles need purge_status
  // entries for ALL contacts (not just recently-changed ones), and removed roles
  // leave orphaned entries that should be cleaned up.
  const currentRoleHashes = Object.keys(rolesByHash).sort();
  if (incremental) {
    const lastRoleHashes = await purgeStatus.getLastRoleHashes();
    if (lastRoleHashes) {
      const lastSorted = [...lastRoleHashes].sort();
      const rolesChanged = currentRoleHashes.length !== lastSorted.length ||
        currentRoleHashes.some((h, i) => h !== lastSorted[i]);
      if (rolesChanged) {
        console.log('Offline roles changed since last run. Forcing full re-evaluation.');
        incremental = false;
      }
    }
  }

  await rolesService.saveRoles(rolesByHash);

  const runId = await purgeStatus.startRunLog();
  const stats = {
    contactsProcessed: 0,
    docsEvaluated: 0,
    docsPurged: 0,
    docsUnpurged: 0,
    skippedContacts: [],
    purgeFnHash: currentFnHash,
    roleHashes: currentRoleHashes,
  };

  try {
    let contactIds = null;
    let lastRun = null;

    // Incremental: only process contacts that changed since last run
    if (incremental) {
      lastRun = await purgeStatus.getLastRunTimestamp();
      if (lastRun) {
        const changedContacts = await contacts.getChangedContactIds(lastRun);
        const contactsWithChangedRecords = await records.getContactIdsWithChangedRecords(lastRun);

        // Retry contacts that were skipped in the previous run due to transient errors.
        // Without this, skipped contacts would never be re-evaluated in incremental mode
        // because their saved_timestamp hasn't changed.
        const previouslySkipped = await purgeStatus.getLastRunSkippedContacts();

        contactIds = [...new Set([
          ...changedContacts,
          ...contactsWithChangedRecords,
          ...previouslySkipped,
        ])];
        if (previouslySkipped.length) {
          console.log(`Retrying ${previouslySkipped.length} previously skipped contacts`);
        }
        console.log(`Incremental mode: ${contactIds.length} contacts to re-evaluate`);
      }
    }

    if (contactIds) {
      // Incremental: process specific contacts
      for (const contactId of contactIds) {
        const contactRow = await contacts.getContact(contactId);
        if (!contactRow) {
          continue;
        }
        await processContact(contactRow, purgeFn, rolesByHash, stats);
      }
    } else {
      // Full: process all contacts in batches
      let offset = 0;
      while (true) {
        const batch = await contacts.getContactsBatch(CONTACT_BATCH_SIZE, offset);
        if (!batch.length) {
          break;
        }

        for (const contactRow of batch) {
          await processContact(contactRow, purgeFn, rolesByHash, stats);
        }

        offset += batch.length;
        if (batch.length < CONTACT_BATCH_SIZE) {
          break;
        }
      }
    }

    // Process unallocated records — in incremental mode, only those changed since last run
    await processUnallocatedRecords(purgeFn, rolesByHash, stats, lastRun);

    // Auto-purge expired tasks and targets (not controlled by purge.js)
    await purgeExpiredTasks(rolesByHash, stats);
    await purgeExpiredTargets(rolesByHash, stats);

    // Clean up stale purge_status entries for deleted documents
    const cleanedUp = await purgeStatus.cleanupDeletedDocs();
    stats.deletedDocsCleaned = cleanedUp;

    // Clean up orphaned purge_status entries for role hashes that no longer exist
    const orphanedCleaned = await purgeStatus.cleanupOrphanedRoles(currentRoleHashes);
    stats.orphanedRolesCleaned = orphanedCleaned;

    await purgeStatus.completeRunLog(runId, stats);
    console.log(`Purge run completed: ${stats.contactsProcessed} contacts, ` +
      `${stats.docsEvaluated} docs evaluated, ${stats.docsPurged} purged, ` +
      `${stats.docsUnpurged} not purged`);
  } catch (err) {
    await purgeStatus.failRunLog(runId, err.message || err);
    throw err;
  }
};

const processContact = async (contactRow, purgeFn, rolesByHash, stats) => {
  try {
    const group = await buildGroupForContact(contactRow);
    const totalRecords = group.reports.length + group.messages.length;

    if (totalRecords > MAX_RECORDS_PER_CONTACT) {
      console.warn(`Skipping contact ${contactRow.id}: ${totalRecords} records exceeds limit`);
      stats.skippedContacts.push(contactRow.id);
      return;
    }

    const toPurge = evaluateGroup(purgeFn, group, rolesByHash);
    await purgeStatus.writePurgeResults(toPurge);

    stats.contactsProcessed++;
    stats.docsEvaluated += group.ids.length;

    for (const hash of Object.keys(toPurge)) {
      for (const id of group.ids) {
        if (toPurge[hash][id]) {
          stats.docsPurged++;
        } else {
          stats.docsUnpurged++;
        }
      }
    }
  } catch (err) {
    console.error(`Error processing contact ${contactRow.id}: ${err.message}`);
    stats.skippedContacts.push(contactRow.id);
  }
};

module.exports = {
  run,
  // Exported for testing
  _getPurgeFn: getPurgeFn,
  _buildGroupForContact: buildGroupForContact,
  _evaluateGroup: evaluateGroup,
  _processUnallocatedRecords: processUnallocatedRecords,
  _purgeExpiredTasks: purgeExpiredTasks,
  _purgeExpiredTargets: purgeExpiredTargets,
  _hashPurgeFn: hashPurgeFn,
};
