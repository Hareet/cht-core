/**
 * PowerSync client-side schema for CHT document types.
 *
 * Plain JS port of webapp/src/ts/services/powersync/powersync-schema.ts.
 * Column definitions must match the Sync Streams queries in
 * .devcontainer/powersync-config/powersync.yaml.
 *
 * Only synced tables are included (no localOnly tables) since benchmarks
 * measure sync performance, not local-only writes.
 */
import { column, Schema, Table } from '@powersync/node';

const contacts = new Table(
  {
    name: column.text,
    contact_type: column.text,
    parent_id: column.text,
    patient_id: column.text,
    place_id: column.text,
    phone: column.text,
    date_of_birth: column.text,
    sex: column.text,
    reported_date: column.text,
    doc: column.text,
  },
  {
    indexes: {
      by_contact_type: ['contact_type'],
      by_parent: ['parent_id', 'contact_type'],
      by_patient_id: ['patient_id'],
    },
  }
);

const reports = new Table(
  {
    form: column.text,
    patient_id: column.text,
    submitter_id: column.text,
    reported_date: column.text,
    is_private: column.text,
    needs_signoff: column.text,
    fields: column.text,
    doc: column.text,
  },
  {
    indexes: {
      by_form: ['form'],
      by_patient: ['patient_id'],
      by_reported_date: ['reported_date'],
    },
  }
);

const tasks = new Table(
  {
    task_user: column.text,
    owner: column.text,
    requester: column.text,
    state: column.text,
    emission_id: column.text,
    due_date: column.text,
    start_date: column.text,
    end_date: column.text,
    doc: column.text,
  },
  {
    indexes: {
      by_state: ['state'],
      by_owner: ['owner'],
    },
  }
);

const targets = new Table(
  {
    owner: column.text,
    reporting_period: column.text,
    targets_data: column.text,
    doc: column.text,
  },
  {
    indexes: {
      by_owner: ['owner'],
      by_period: ['reporting_period'],
    },
  }
);

const global_config = new Table({
  doc_type: column.text,
  doc: column.text,
});

const user_settings_doc = new Table({
  doc_type: column.text,
  doc: column.text,
});

const user_meta = new Table({
  meta_type: column.text,
  user_id: column.text,
  doc: column.text,
});

const sms_messages = new Table({
  contact_id: column.text,
  reported_date: column.text,
  is_outgoing: column.text,
  doc: column.text,
});

export const ChtPowerSyncSchema = new Schema({
  contacts,
  reports,
  tasks,
  targets,
  global_config,
  user_settings_doc,
  user_meta,
  sms_messages,
});
