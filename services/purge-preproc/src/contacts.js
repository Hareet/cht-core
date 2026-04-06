'use strict';

const db = require('./db');

const CONTACT_TYPES = ['district_hospital', 'health_center', 'clinic', 'person'];

// Fetch contacts in batches from the cht-sync couchdb table.
// Contacts are documents where type is one of the standard contact types,
// or contact_type is set (configurable contact types).
const getContactsBatch = async (limit, offset) => {
  const result = await db.query(`
    SELECT doc_id, doc
    FROM couchdb
    WHERE (
      doc->>'type' IN ('district_hospital', 'health_center', 'clinic', 'person')
      OR doc->>'contact_type' IS NOT NULL
    )
    AND doc->>'_deleted' IS DISTINCT FROM 'true'
    ORDER BY doc_id
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  return result.rows.map(row => ({
    id: row.doc_id,
    doc: row.doc,
  }));
};

// Get contacts changed since a given timestamp (for incremental mode).
const getChangedContactIds = async (since) => {
  const result = await db.query(`
    SELECT doc_id
    FROM couchdb
    WHERE (
      doc->>'type' IN ('district_hospital', 'health_center', 'clinic', 'person')
      OR doc->>'contact_type' IS NOT NULL
    )
    AND doc->>'_deleted' IS DISTINCT FROM 'true'
    AND saved_timestamp > $1
    ORDER BY doc_id
  `, [since]);

  return result.rows.map(row => row.doc_id);
};

// Fetch a single contact by doc_id.
const getContact = async (docId) => {
  const result = await db.query(`
    SELECT doc_id, doc
    FROM couchdb
    WHERE doc_id = $1
  `, [docId]);

  if (!result.rows.length) {
    return null;
  }

  return { id: result.rows[0].doc_id, doc: result.rows[0].doc };
};

module.exports = {
  getContactsBatch,
  getChangedContactIds,
  getContact,
  CONTACT_TYPES,
};
