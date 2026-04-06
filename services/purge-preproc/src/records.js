'use strict';

const db = require('./db');
const registrationUtils = require('@medic/registration-utils');

// Given a contact document, extract its subject IDs for matching reports/messages.
const getSubjectIds = (contact) => {
  return registrationUtils.getSubjectIds(contact);
};

// Fetch all reports and messages for a set of subject IDs from the couchdb table.
// Reports are data_records with a form field; messages are data_records without.
const getRecordsForSubjects = async (subjectIds) => {
  if (!subjectIds.length) {
    return { reports: [], messages: [] };
  }

  // Build a query that finds data_records whose subject matches any of the given IDs.
  // Subject can be in: patient_id, place_id, patient_uuid, place_uuid (top-level or in fields).
  const result = await db.query(`
    SELECT doc_id, doc
    FROM couchdb
    WHERE doc->>'type' = 'data_record'
      AND doc->>'_deleted' IS DISTINCT FROM 'true'
      AND (
        doc->>'patient_id' = ANY($1)
        OR doc->>'place_id' = ANY($1)
        OR doc->>'patient_uuid' = ANY($1)
        OR doc->>'place_uuid' = ANY($1)
        OR doc->'fields'->>'patient_id' = ANY($1)
        OR doc->'fields'->>'place_id' = ANY($1)
        OR doc->'fields'->>'patient_uuid' = ANY($1)
        OR doc->'fields'->>'place_uuid' = ANY($1)
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

// Fetch unallocated records (data_records that don't belong to any contact).
// These are records where no subject ID fields are set.
const getUnallocatedRecords = async (limit, offset) => {
  const result = await db.query(`
    SELECT doc_id, doc
    FROM couchdb
    WHERE doc->>'type' = 'data_record'
      AND doc->>'_deleted' IS DISTINCT FROM 'true'
      AND COALESCE(doc->>'patient_id', '') = ''
      AND COALESCE(doc->>'place_id', '') = ''
      AND COALESCE(doc->>'patient_uuid', '') = ''
      AND COALESCE(doc->>'place_uuid', '') = ''
      AND COALESCE(doc->'fields'->>'patient_id', '') = ''
      AND COALESCE(doc->'fields'->>'place_id', '') = ''
      AND COALESCE(doc->'fields'->>'patient_uuid', '') = ''
      AND COALESCE(doc->'fields'->>'place_uuid', '') = ''
    ORDER BY doc_id
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  return result.rows.map(row => ({
    id: row.doc_id,
    doc: row.doc,
  }));
};

// Find contacts whose associated reports/messages have changed since a timestamp.
// Returns contact doc_ids that need re-evaluation.
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
        NULLIF(doc->'fields'->>'place_uuid', '')
      ) AS subject_id
    FROM couchdb
    WHERE doc->>'type' = 'data_record'
      AND doc->>'_deleted' IS DISTINCT FROM 'true'
      AND saved_timestamp > $1
  `, [since]);

  const subjectIds = result.rows
    .map(row => row.subject_id)
    .filter(Boolean);

  if (!subjectIds.length) {
    return [];
  }

  // Find contacts that have these subject IDs
  const contactResult = await db.query(`
    SELECT doc_id
    FROM couchdb
    WHERE (
      doc->>'type' IN ('district_hospital', 'health_center', 'clinic', 'person')
      OR doc->>'contact_type' IS NOT NULL
    )
    AND doc->>'_deleted' IS DISTINCT FROM 'true'
    AND (
      doc_id = ANY($1)
      OR doc->>'patient_id' = ANY($1)
      OR doc->>'place_id' = ANY($1)
    )
  `, [subjectIds]);

  return contactResult.rows.map(row => row.doc_id);
};

module.exports = {
  getSubjectIds,
  getRecordsForSubjects,
  getUnallocatedRecords,
  getContactIdsWithChangedRecords,
};
