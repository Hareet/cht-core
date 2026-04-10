/**
 * @module powersync-schema
 *
 * PowerSync client-side SQLite schema for the CHT rules engine.
 * Defines the table structures that PowerSync syncs from the server
 * and that the rules engine queries locally.
 *
 * Usage:
 *   const { ChtSchema } = require('./powersync-schema');
 *   const db = new PowerSyncDatabase({ schema: ChtSchema, ... });
 *
 * These table definitions use PowerSync's Schema/Table/column API.
 * PowerSync auto-creates an `id TEXT PRIMARY KEY` on every table.
 * Column types: column.text, column.integer, column.real only.
 *
 * Tables are divided into:
 *   - Server-synced tables (contacts, reports): read-only on client, synced from PostgreSQL via Sync Streams
 *   - Bidirectional tables (tasks, targets): written client-side by rules engine, uploaded via CRUD queue
 *   - Local-only tables (rules_state_store): never synced, persists across restarts
 */

// The actual imports would be:
//   import { column, Schema, Table } from '@powersync/web';
// But this module is designed to be compatible with both CJS (test/Node) and ESM (browser).
// When used in the CHT webapp, the real PowerSync SDK is imported. For testing, these
// definitions serve as documentation and are used to validate the schema structure.

/**
 * Returns the CHT rules engine PowerSync schema definition.
 *
 * @param {Object} deps - PowerSync SDK dependencies
 * @param {Function} deps.Table - PowerSync Table constructor
 * @param {Object} deps.column - PowerSync column type definitions (column.text, column.integer, column.real)
 * @param {Function} deps.Schema - PowerSync Schema constructor
 * @returns {Object} The PowerSync Schema instance
 */
const createChtSchema = ({ Table, column, Schema }) => {
  /**
   * Contacts: persons, clinics, health_centers, district_hospitals.
   * Synced from server. Read-only on client.
   *
   * Maps to CouchDB views:
   *   - medic-client/contacts_by_type (type/contact_type columns)
   *   - medic-client/contacts_by_reference (patient_id/place_id columns)
   *
   * The `doc` column stores the full CouchDB document as JSON text,
   * preserving all fields the rules engine needs (parent hierarchy, etc).
   */
  const contacts = new Table(
    {
      type: column.text,           // 'contact', 'person', 'clinic', 'health_center', 'district_hospital'
      contact_type: column.text,   // Custom contact type when type='contact'
      name: column.text,
      parent_id: column.text,      // Parent contact ID (facility, area, etc)
      patient_id: column.text,     // Shortcode for persons (used by contacts_by_reference)
      place_id: column.text,       // Shortcode for places (used by contacts_by_reference)
      date_of_death: column.text,  // ISO date string or null
      muted: column.text,          // Muted timestamp or null
      doc: column.text,            // Full CouchDB document as JSON
    },
    {
      indexes: {
        by_type: ['type'],
        by_contact_type: ['contact_type'],
        by_patient_id: ['patient_id'],
        by_place_id: ['place_id'],
        by_parent: ['parent_id'],
      },
    }
  );

  /**
   * Reports: data_record documents (form submissions).
   * Synced from server. Read-only on client.
   *
   * Maps to CouchDB view: medic-client/reports_by_subject
   * The view indexes by patient_id, place_id, case_id, and nested fields variants.
   *
   * Denormalized columns for efficient SQL queries:
   *   - patient_id: COALESCE(doc.patient_id, doc.fields.patient_id, doc.fields.patient_uuid)
   *   - place_id: COALESCE(doc.place_id, doc.fields.place_id)
   *   - subject_id: COALESCE(doc.fields.patient_uuid, doc.fields.place_uuid)
   *     Covers the UUID-based subject references that don't map to patient_id/place_id.
   */
  const reports = new Table(
    {
      type: column.text,           // Always 'data_record'
      form: column.text,           // Form name (e.g. 'pregnancy', 'visit')
      patient_id: column.text,     // Denormalized: coalesced from doc root + fields
      place_id: column.text,       // Denormalized: coalesced from doc root + fields
      case_id: column.text,        // Case tracking ID (indexed by CouchDB view but not used by getSubjectIds)
      subject_id: column.text,     // patient_uuid or place_uuid from fields
      reported_date: column.integer, // Epoch milliseconds
      contact_id: column.text,     // Submitting health worker's contact ID
      doc: column.text,            // Full CouchDB document as JSON
    },
    {
      indexes: {
        by_patient: ['patient_id'],
        by_place: ['place_id'],
        by_subject: ['subject_id'],
        by_form: ['form'],
      },
    }
  );

  /**
   * Tasks: generated client-side by the rules engine.
   * Bidirectional: written locally, uploaded to server via PowerSync CRUD queue.
   *
   * Maps to CouchDB view: medic-client/tasks_by_contact
   * The view indexes by:
   *   - 'owner-{ownerId}' for non-terminal tasks (owner column + state filter)
   *   - 'requester-{requesterId}' for all tasks (requester column)
   *   - ['owner', 'all', ownerId] for all tasks (used by allTaskRows/allTaskRowsByOwner)
   *
   * Note: NULL owner maps to '_unassigned' in CouchDB. NULL state is non-terminal.
   */
  const tasks = new Table(
    {
      type: column.text,           // Always 'task'
      state: column.text,          // 'Draft', 'Ready', 'Completed', 'Failed', 'Cancelled', or NULL
      owner: column.text,          // Contact ID that owns this task (NULL = '_unassigned')
      requester: column.text,      // Contact ID that requested this task
      user: column.text,           // User settings ID (org.couchdb.user:username)
      authored_on: column.integer, // Epoch when task was created
      doc: column.text,            // Full task document as JSON
    },
    {
      indexes: {
        by_owner_state: ['owner', 'state'],
        by_requester: ['requester'],
        by_state: ['state'],
      },
    }
  );

  /**
   * Targets: performance metric documents.
   * Bidirectional: written locally, uploaded to server via PowerSync CRUD queue.
   *
   * Target docs have IDs like: target~{YYYY-MM}~{userContactId}~{userSettingsId}
   */
  const targets = new Table(
    {
      type: column.text,             // Always 'target'
      owner: column.text,            // User contact ID
      user: column.text,             // User settings ID
      reporting_period: column.text,  // e.g. '2026-04'
      targets: column.text,          // JSON array of target scores
      updated_date: column.integer,  // Epoch of last update
      doc: column.text,              // Full target document as JSON
    },
    {
      indexes: {
        by_owner_period: ['owner', 'reporting_period'],
      },
    }
  );

  /**
   * Rules state store: local-only table for persisting rules calculation state.
   * NOT synced to server. NOT uploaded. Persists across browser restarts.
   *
   * Stores the in-memory rules-state-store as a single JSON blob.
   * Replaces PouchDB's _local/rulesStateStore document.
   */
  const rules_state_store = new Table(
    {
      data: column.text,  // JSON blob of the full rules state
    },
    {
      localOnly: true,
    }
  );

  return new Schema({
    contacts,
    reports,
    tasks,
    targets,
    rules_state_store,
  });
};

/**
 * Schema column/table metadata for documentation and test validation.
 * Describes what the PowerSync adapter expects without requiring the actual SDK.
 */
const SCHEMA_TABLES = {
  contacts: {
    columns: ['type', 'contact_type', 'name', 'parent_id', 'patient_id', 'place_id',
      'date_of_death', 'muted', 'doc'],
    synced: true,
  },
  reports: {
    columns: ['type', 'form', 'patient_id', 'place_id', 'case_id', 'subject_id',
      'reported_date', 'contact_id', 'doc'],
    synced: true,
  },
  tasks: {
    columns: ['type', 'state', 'owner', 'requester', 'user', 'authored_on', 'doc'],
    synced: true, // bidirectional
  },
  targets: {
    columns: ['type', 'owner', 'user', 'reporting_period', 'targets', 'updated_date', 'doc'],
    synced: true, // bidirectional
  },
  rules_state_store: {
    columns: ['data'],
    synced: false, // local-only
  },
};

module.exports = { createChtSchema, SCHEMA_TABLES };
