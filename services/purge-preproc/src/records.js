'use strict';

const db = require('./db');
const registrationUtils = require('@medic/registration-utils');

const tbl = () => `${db.getSchema()}.couchdb`;

// Given a contact document, extract its subject IDs for matching reports/messages.
const getSubjectIds = (contact) => {
  return registrationUtils.getSubjectIds(contact);
};

// Fetch all reports and messages for a set of subject IDs from the couchdb table.
// Reports are data_records with a form field; messages are data_records without.
//
// Subject matching mirrors the getSubject() function in the docs_by_replication_key Nouveau index:
//   For reports: patient_id → place_id → patient_uuid → contact._id
//   For SMS incoming: contact._id
//   For SMS outgoing: tasks[0].messages[0].contact._id
// We also match contact._id to catch reports with error fallbacks and incoming SMS.
const getRecordsForSubjects = async (subjectIds) => {
  if (!subjectIds.length) {
    return { reports: [], messages: [] };
  }

  const result = await db.query(`
    SELECT _id, doc
    FROM ${tbl()}
    WHERE doc->>'type' = 'data_record'
      AND (_deleted IS NOT TRUE)
      AND (
        doc->>'patient_id' = ANY($1)
        OR doc->>'place_id' = ANY($1)
        OR doc->>'patient_uuid' = ANY($1)
        OR doc->>'place_uuid' = ANY($1)
        OR doc->'fields'->>'patient_id' = ANY($1)
        OR doc->'fields'->>'place_id' = ANY($1)
        OR doc->'fields'->>'patient_uuid' = ANY($1)
        OR doc->'fields'->>'place_uuid' = ANY($1)
        OR doc->'contact'->>'_id' = ANY($1)
      )
  `, [subjectIds]);

  const reports = [];
  const messages = [];

  for (const row of result.rows) {
    const doc = row.doc;
    if (doc.form) {
      reports.push(doc);
    } else {
      messages.push(doc);
    }
  }

  return { reports, messages };
};

// Fetch unallocated records (data_records that map to _unassigned in replication key).
// A record is "unassigned" when getSubject() in the Nouveau index returns falsy.
// getSubject() checks: patient_id, place_id, patient_uuid (top-level & fields),
// contact._id (for error fallback reports and SMS messages).
const getUnallocatedRecords = async (limit, offset) => {
  const result = await db.query(`
    SELECT _id, doc
    FROM ${tbl()}
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
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  return result.rows.map(row => ({
    id: row._id,
    doc: row.doc,
  }));
};

// Find contacts whose associated reports/messages have changed since a timestamp.
// Returns contact _ids that need re-evaluation.
// IMPORTANT: We intentionally include deleted records (_deleted = true) here.
// When a report is deleted, its parent contact must be re-evaluated because the
// purge function may produce different results without that report in the group.
// The deleted record won't appear in the contact's group (getRecordsForSubjects
// filters _deleted), so the purge function correctly evaluates the new state.
const getContactIdsWithChangedRecords = async (since) => {
  const result = await db.query(`
    SELECT DISTINCT
      COALESCE(
        NULLIF(doc->>'patient_id', ''),
        NULLIF(doc->>'place_id', ''),
        NULLIF(doc->>'patient_uuid', ''),
        NULLIF(doc->>'place_uuid', ''),
        NULLIF(doc->'fields'->>'patient_id', ''),
        NULLIF(doc->'fields'->>'place_id', ''),
        NULLIF(doc->'fields'->>'patient_uuid', ''),
        NULLIF(doc->'fields'->>'place_uuid', ''),
        NULLIF(doc->'contact'->>'_id', '')
      ) AS subject_id
    FROM ${tbl()}
    WHERE doc->>'type' = 'data_record'
      AND saved_timestamp > $1
  `, [since]);

  const subjectIds = result.rows
    .map(row => row.subject_id)
    .filter(Boolean);

  if (!subjectIds.length) {
    return [];
  }

  // Find contacts that have these subject IDs.
  // Match by _id (contact._id), patient_id, or place_id — the fields in
  // registrationUtils CONTACT_SUBJECT_PROPERTIES: ['_id', 'patient_id', 'place_id'].
  const contactResult = await db.query(`
    SELECT _id
    FROM ${tbl()}
    WHERE (
      doc->>'type' IN ('district_hospital', 'health_center', 'clinic', 'person')
      OR (doc->>'type' = 'contact' AND doc->>'contact_type' IS NOT NULL)
    )
    AND (_deleted IS NOT TRUE)
    AND (
      _id = ANY($1)
      OR doc->>'patient_id' = ANY($1)
      OR doc->>'place_id' = ANY($1)
    )
  `, [subjectIds]);

  return contactResult.rows.map(row => row._id);
};

module.exports = {
  getSubjectIds,
  getRecordsForSubjects,
  getUnallocatedRecords,
  getContactIdsWithChangedRecords,
};
