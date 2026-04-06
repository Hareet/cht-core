'use strict';

const contacts = require('./contacts');
const records = require('./records');
const purgeStatus = require('./purge-status');
const rolesService = require('./roles');

const CONTACT_BATCH_SIZE = parseInt(process.env.PURGE_CONTACT_BATCH_SIZE || '500', 10);
const MAX_RECORDS_PER_CONTACT = parseInt(process.env.PURGE_MAX_RECORDS || '20000', 10);

// Parse the purge function from app_settings config stored in PostgreSQL.
const getPurgeFn = async (db) => {
  const result = await db.query(`
    SELECT doc->'purge'->>'fn' AS fn
    FROM couchdb
    WHERE doc_id = 'settings'
      AND doc->>'_id' = 'settings'
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
      idsToPurge = purgeFn(
        { roles: rolesList },
        group.contact,
        group.reports,
        group.messages
      );
    } catch {
      // Purge function errors are non-fatal; treat as "purge nothing"
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
const processUnallocatedRecords = async (purgeFn, rolesByHash, stats) => {
  let offset = 0;
  const batchSize = CONTACT_BATCH_SIZE;

  while (true) {
    const batch = await records.getUnallocatedRecords(batchSize, offset);
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

// Full purge evaluation run.
const run = async (options = {}) => {
  const db = require('./db');
  const incremental = options.incremental !== false;

  const purgeFn = await getPurgeFn(db);
  if (!purgeFn) {
    console.log('No purge function configured. Skipping.');
    return;
  }

  const rolesByHash = await rolesService.getRoles();
  if (!Object.keys(rolesByHash).length) {
    console.log('No offline roles found. Skipping.');
    return;
  }

  await rolesService.saveRoles(rolesByHash);

  const runId = await purgeStatus.startRunLog();
  const stats = {
    contactsProcessed: 0,
    docsEvaluated: 0,
    docsPurged: 0,
    docsUnpurged: 0,
    skippedContacts: [],
  };

  try {
    let contactIds = null;

    // Incremental: only process contacts that changed since last run
    if (incremental) {
      const lastRun = await purgeStatus.getLastRunTimestamp();
      if (lastRun) {
        const changedContacts = await contacts.getChangedContactIds(lastRun);
        const contactsWithChangedRecords = await records.getContactIdsWithChangedRecords(lastRun);
        contactIds = [...new Set([...changedContacts, ...contactsWithChangedRecords])];
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

    // Process unallocated records
    await processUnallocatedRecords(purgeFn, rolesByHash, stats);

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
};
