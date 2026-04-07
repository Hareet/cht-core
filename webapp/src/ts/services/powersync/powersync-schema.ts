/**
 * PowerSync client-side schema for CHT document types.
 *
 * Mirrors the PostgreSQL tables that PowerSync Sync Streams will replicate.
 * Column types are limited to text, integer, and real per PowerSync constraints.
 * The 'id' column is auto-created by PowerSync as TEXT PRIMARY KEY.
 *
 * JSON fields (e.g. parent hierarchy, fields) are stored as text and parsed at read time.
 * Booleans are stored as integer (0/1). Dates as ISO text strings.
 *
 * Schema aligned with:
 * - CHT CouchDB document schema (medic/cht-core database-schema docs)
 * - cht-sync dbt models (contacts.sql, reports.sql)
 * - CHT v3.7+ configurable contact hierarchy (type='contact', contact_type='person'/'clinic'/etc.)
 */
import { column, Schema, Table } from '@powersync/web';

// Contacts: persons, clinics, health_centers, districts
// Hierarchical via parent field (stored as JSON text)
//
// CHT v3.7+ uses type='contact' with contact_type for the specific type.
// Older versions use type directly as the contact type.
// The `contact_type` column holds the resolved type via COALESCE(contact_type, type)
// matching the cht-sync dbt model pattern.
const contacts = new Table(
  {
    // Type fields: CHT v3.7+ stores 'contact' in `type` and specific type in `contact_type`.
    // Older versions put the specific type directly in `type`.
    type: column.text,              // raw CouchDB 'type' field ('contact', 'person', 'clinic', etc.)
    contact_type: column.text,      // resolved contact type: COALESCE(contact_type, type)
    name: column.text,
    phone: column.text,
    alternative_phone: column.text, // secondary phone (phone2 in cht-sync)
    date_of_birth: column.text,     // ISO date string (persons only)
    sex: column.text,               // gender (persons only)
    parent_id: column.text,         // denormalized from parent._id for efficient querying
    parent: column.text,            // full parent hierarchy as JSON text
    contact_id: column.text,        // primary contact person for places
    reported_date: column.text,     // ISO timestamp (epoch ms or ISO string)
    notes: column.text,
    muted: column.text,             // ISO timestamp when muted, or empty
    patient_id: column.text,        // shortcode identifier for persons
    place_id: column.text,          // shortcode identifier for places (clinics, facilities)
    active: column.text,            // is_active status from CouchDB
    date_of_death: column.text,     // ISO date string, if deceased
    geolocation: column.text,       // JSON text {latitude, longitude}
  },
  {
    indexes: {
      by_contact_type: ['contact_type'],
      by_parent: ['parent_id', 'contact_type'],
      by_patient_id: ['patient_id'],
      by_place_id: ['place_id'],
    },
  }
);

// Reports: form submissions (pregnancy registration, home visits, assessments)
// Also includes messages (data_record without form field)
// Matches cht-sync reports dbt model field extraction
const reports = new Table(
  {
    type: column.text,            // always 'data_record'
    form: column.text,            // form code (e.g. 'pregnancy', 'home_visit'); null for messages
    content_type: column.text,    // e.g. 'xml'
    from: column.text,            // reporter's phone number (present on SMS reports)
    contact_id: column.text,      // who submitted (doc.contact._id)
    // Patient/subject resolution uses cht-sync COALESCE pattern:
    // COALESCE(doc.patient_id, doc.fields.patient_id, doc.fields.patient_uuid)
    patient_id: column.text,      // resolved patient/subject identifier
    patient_uuid: column.text,    // resolved patient UUID (if different from patient_id)
    // Place targeting uses cht-sync COALESCE pattern:
    // COALESCE(doc.place_id, doc.fields.place_id)
    place_id: column.text,        // place-targeted report subject
    parent_id: column.text,       // facility/place context
    reported_date: column.text,   // ISO timestamp (epoch ms)
    fields: column.text,          // JSON text - form field values
    geolocation: column.text,     // JSON text
    verified: column.integer,     // 0/1 boolean
    is_private: column.integer,   // 0/1 - fields.private === 'yes'
    needs_signoff: column.integer, // 0/1
  },
  {
    indexes: {
      by_form: ['form'],
      by_contact: ['contact_id'],
      by_patient: ['patient_id'],
      by_place: ['place_id'],
      by_reported_date: ['reported_date'],
    },
  }
);

// Tasks: generated client-side by rules engine, synced via PowerSync
// Task state machine: Draft → Ready → Completed/Failed/Cancelled
// See: shared-libs/rules-engine/src/task-states.js
const tasks = new Table(
  {
    type: column.text,              // 'task'
    user: column.text,              // user settings ID (e.g. 'org.couchdb.user:agatha')
    requester: column.text,         // contact ID whose data triggered the task
    owner: column.text,             // contact ID whose profile the task appears on
    state: column.text,             // 'Draft', 'Ready', 'Cancelled', 'Completed', 'Failed'
    state_reason: column.text,
    state_history: column.text,     // JSON array of {state, timestamp} entries
    emission: column.text,          // JSON - minified task emission data
                                    //   emission.forId, emission.title, emission.contact.name,
                                    //   emission.startDate, emission.endDate, emission.dueDate
    due_date: column.text,          // ISO date (from emission.dueDate)
    start_date: column.text,        // ISO date (from emission.startDate)
    end_date: column.text,          // ISO date (from emission.endDate)
    reported_date: column.text,     // ISO timestamp
  },
  {
    indexes: {
      by_state: ['state'],
      by_owner: ['owner'],
      by_due_date: ['due_date'],
    },
  }
);

// Targets: performance indicators per reporting period
// Generated by rules engine, aggregated per contact per period
const targets = new Table(
  {
    type: column.text,              // 'target'
    owner: column.text,             // contact ID
    reporting_period: column.text,  // e.g. '2026-04'
    targets: column.text,           // JSON array of {id, value: {pass, total, percent}}
    date_updated: column.text,      // ISO timestamp
  },
  {
    indexes: {
      by_owner: ['owner'],
      by_period: ['reporting_period'],
    },
  }
);

// Settings: global app configuration synced to ALL users
// Includes: resources, branding, partners, service-worker-meta, zscore-charts,
// settings (app_settings), privacy-policies, form:* docs, translations docs
// These are indexed under '_all' replication key in CouchDB (docs_by_replication_key)
// and are read-only on the client (filtered out of upward replication)
const settings = new Table(
  {
    type: column.text,              // 'settings', 'form', 'translations', etc.
    doc: column.text,               // full document as JSON text
    updated_date: column.text,      // ISO timestamp
  },
  {
    indexes: {
      by_type: ['type'],
    },
  }
);

// User feedback - local-only, uploaded via CHT API /api/v1/feedback
// Replaces per-user meta database feedback docs
const feedback = new Table(
  {
    type: column.text,
    message: column.text,
    info: column.text,              // JSON text - error/context info
    url: column.text,
    reported_date: column.text,
  },
  { localOnly: true }
);

// Telemetry - local-only, uploaded via CHT API
// Replaces per-user meta database telemetry docs
const telemetry = new Table(
  {
    type: column.text,
    metrics: column.text,           // JSON text
    device: column.text,            // JSON text - device info
    reported_date: column.text,
    aggregated_date: column.text,   // date range this covers
  },
  { localOnly: true, insertOnly: true }
);

// Read status tracking - local-only
// Replaces per-user meta DB 'read:{docId}' documents
// In CouchDB: doc IDs are 'read:report:{uuid}' or 'read:message:{uuid}'
// Here we store structured data instead
const read_status = new Table(
  {
    doc_id: column.text,            // the document that was read
    doc_type: column.text,          // 'report' or 'message' (for unread count grouping)
    read_at: column.text,           // ISO timestamp
  },
  { localOnly: true }
);

export const ChtPowerSyncSchema = new Schema({
  contacts,
  reports,
  tasks,
  targets,
  settings,
  feedback,
  telemetry,
  read_status,
});

export type ChtDatabase = (typeof ChtPowerSyncSchema)['types'];
export type ContactRow = ChtDatabase['contacts'];
export type ReportRow = ChtDatabase['reports'];
export type TaskRow = ChtDatabase['tasks'];
export type TargetRow = ChtDatabase['targets'];
export type SettingsRow = ChtDatabase['settings'];
