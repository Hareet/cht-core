'use strict';

const db = require('./db');

// Contact type matching condition used across queries.
// Handles both legacy types (type = 'district_hospital'|'health_center'|'clinic'|'person')
// and configurable contact types (type = 'contact' with contact_type field set).
// Mirrors the contacts_by_type CouchDB view in ddocs/medic-db/medic-client/views/contacts_by_type/map.js.
const CONTACT_TYPE_CONDITION = `(
  doc->>'type' IN ('district_hospital', 'health_center', 'clinic', 'person')
  OR (doc->>'type' = 'contact' AND doc->>'contact_type' IS NOT NULL)
)`;

const tbl = () => `${db.getSchema()}.couchdb`;

// Fetch contacts in batches from the cht-sync couchdb table.
const getContactsBatch = async (limit, offset) => {
  const result = await db.query(`
    SELECT _id, doc
    FROM ${tbl()}
    WHERE ${CONTACT_TYPE_CONDITION}
    AND (_deleted IS NOT TRUE)
    ORDER BY _id
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  return result.rows.map(row => ({
    id: row._id,
    doc: row.doc,
  }));
};

// Get contacts changed since a given timestamp (for incremental mode).
const getChangedContactIds = async (since) => {
  const result = await db.query(`
    SELECT _id
    FROM ${tbl()}
    WHERE ${CONTACT_TYPE_CONDITION}
    AND (_deleted IS NOT TRUE)
    AND saved_timestamp > $1
    ORDER BY _id
  `, [since]);

  return result.rows.map(row => row._id);
};

// Fetch a single contact by _id.
const getContact = async (docId) => {
  const result = await db.query(`
    SELECT _id, doc
    FROM ${tbl()}
    WHERE _id = $1
  `, [docId]);

  if (!result.rows.length) {
    return null;
  }

  return { id: result.rows[0]._id, doc: result.rows[0].doc };
};

module.exports = {
  getContactsBatch,
  getChangedContactIds,
  getContact,
  CONTACT_TYPE_CONDITION,
};
