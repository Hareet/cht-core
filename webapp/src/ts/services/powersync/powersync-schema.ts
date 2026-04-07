/**
 * PowerSync client-side schema for CHT document types.
 *
 * Mirrors the PostgreSQL tables that PowerSync Sync Streams will replicate.
 * Column types are limited to text, integer, and real per PowerSync constraints.
 * The 'id' column is auto-created by PowerSync as TEXT PRIMARY KEY.
 *
 * JSON fields (e.g. parent hierarchy, fields) are stored as text and parsed at read time.
 * Booleans are stored as integer (0/1). Dates as ISO text strings.
 */
import { column, Schema, Table } from '@powersync/web';

// Contacts: persons, clinics, health_centers, districts
// Hierarchical via parent field (stored as JSON text)
const contacts = new Table(
  {
    type: column.text,           // e.g. 'person', 'clinic', 'health_center', 'district_hospital'
    name: column.text,
    phone: column.text,
    date_of_birth: column.text,  // ISO date string
    sex: column.text,
    parent_id: column.text,      // denormalized from parent._id for efficient querying
    parent: column.text,         // full parent hierarchy as JSON text
    contact_id: column.text,     // primary contact person for places
    reported_date: column.text,  // ISO timestamp
    notes: column.text,
    muted: column.text,          // ISO timestamp when muted, or empty
    patient_id: column.text,     // shortcode identifier
    // CouchDB metadata preserved for compatibility
    doc_type: column.text,       // original CouchDB type field
    geolocation: column.text,    // JSON text {latitude, longitude}
  },
  {
    indexes: {
      by_type: ['type'],
      by_parent: ['parent_id', 'type'],
      by_patient_id: ['patient_id'],
    },
  }
);

// Reports: form submissions (pregnancy registration, home visits, assessments)
const reports = new Table(
  {
    type: column.text,            // always 'data_record'
    form: column.text,            // form code (e.g. 'pregnancy', 'home_visit')
    content_type: column.text,    // e.g. 'xml'
    contact_id: column.text,      // who submitted
    patient_id: column.text,      // subject of report (shortcode or uuid)
    patient_uuid: column.text,    // resolved patient UUID
    parent_id: column.text,       // facility/place context
    reported_date: column.text,   // ISO timestamp
    fields: column.text,          // JSON text - form field values
    geolocation: column.text,     // JSON text
    verified: column.integer,     // 0/1 boolean
    is_private: column.integer,   // 0/1 - fields.private === 'yes'
    needs_signoff: column.integer, // 0/1
    doc_type: column.text,
  },
  {
    indexes: {
      by_form: ['form'],
      by_contact: ['contact_id'],
      by_patient: ['patient_uuid'],
      by_reported_date: ['reported_date'],
    },
  }
);

// Tasks: generated client-side by rules engine
const tasks = new Table(
  {
    type: column.text,              // 'task'
    user: column.text,              // owner user
    requester: column.text,         // contact ID that generated the task
    owner: column.text,             // contact ID that owns the task
    state: column.text,             // 'Draft', 'Ready', 'Cancelled', 'Completed', 'Failed'
    state_reason: column.text,
    state_history: column.text,     // JSON array
    emission: column.text,          // JSON - task emission data
    due_date: column.text,          // ISO date
    start_date: column.text,        // ISO date
    end_date: column.text,          // ISO date
    reported_date: column.text,     // ISO timestamp
    doc_type: column.text,
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
const targets = new Table(
  {
    type: column.text,              // 'target'
    owner: column.text,             // contact ID
    reporting_period: column.text,  // e.g. '2026-04'
    targets: column.text,           // JSON array of target values
    date_updated: column.text,      // ISO timestamp
    doc_type: column.text,
  },
  {
    indexes: {
      by_owner: ['owner'],
      by_period: ['reporting_period'],
    },
  }
);

// Settings: global app configuration (app_settings, forms, translations)
// Synced to ALL users via a dedicated global Sync Stream
const settings = new Table(
  {
    type: column.text,              // 'settings', 'form', 'translations'
    key: column.text,               // settings key or form ID
    doc: column.text,               // full document as JSON text
    updated_date: column.text,      // ISO timestamp
  },
  {
    indexes: {
      by_type: ['type'],
      by_key: ['key'],
    },
  }
);

// User feedback and telemetry - local-only, uploaded via CHT API
// Replaces the per-user meta database pattern
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

// Read status tracking - replaces per-user meta DB read tracking
const read_status = new Table(
  {
    doc_id: column.text,
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
