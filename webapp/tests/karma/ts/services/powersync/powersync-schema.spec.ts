import { expect } from 'chai';

import { ChtPowerSyncSchema } from '@mm-services/powersync/powersync-schema';

/**
 * Helper: find a table by name in the Schema.tables array.
 */
function findTable(name: string) {
  return ChtPowerSyncSchema.tables.find((t: any) => t.name === name);
}

/**
 * Helper: get column names from a table.
 */
function getColumnNames(table: any): string[] {
  return table.columns.map((c: any) => c.name);
}

describe('PowerSync Schema', () => {
  it('should define all required tables', () => {
    const tableNames = ChtPowerSyncSchema.tables.map((t: any) => t.name);
    expect(tableNames).to.include.members([
      'contacts',
      'reports',
      'tasks',
      'targets',
      'settings',
      'feedback',
      'telemetry',
      'read_status',
    ]);
  });

  describe('contacts table', () => {
    it('should define required columns including v3.7+ contact_type', () => {
      const contacts = findTable('contacts');
      expect(contacts).to.exist;
      const columnNames = getColumnNames(contacts);
      expect(columnNames).to.include.members([
        'type',              // raw CouchDB type field
        'contact_type',      // resolved type (COALESCE pattern)
        'name', 'phone', 'alternative_phone',
        'date_of_birth', 'sex',
        'parent_id', 'parent', 'contact_id',
        'reported_date', 'notes', 'muted',
        'patient_id', 'place_id',  // shortcodes for persons and places
        'active', 'date_of_death',
        'geolocation',
      ]);
    });

    it('should not be local-only', () => {
      const contacts = findTable('contacts');
      expect(contacts!.localOnly).to.be.false;
    });
  });

  describe('reports table', () => {
    it('should define required columns including place_id and from', () => {
      const reports = findTable('reports');
      expect(reports).to.exist;
      const columnNames = getColumnNames(reports);
      expect(columnNames).to.include.members([
        'type', 'form', 'content_type', 'from',
        'contact_id', 'patient_id', 'patient_uuid', 'place_id',
        'reported_date', 'fields',
        'verified', 'is_private',
      ]);
    });
  });

  it('should define tasks table with required columns', () => {
    const tasks = findTable('tasks');
    expect(tasks).to.exist;
    const columnNames = getColumnNames(tasks);
    expect(columnNames).to.include.members([
      'type', 'user', 'owner', 'state', 'emission', 'due_date',
      'requester', 'state_reason', 'state_history',
      'start_date', 'end_date', 'reported_date',
    ]);
  });

  it('should define targets table with required columns', () => {
    const targets = findTable('targets');
    expect(targets).to.exist;
    const columnNames = getColumnNames(targets);
    expect(columnNames).to.include.members([
      'type', 'owner', 'reporting_period', 'targets',
    ]);
  });

  it('should define settings table for global system docs', () => {
    const settings = findTable('settings');
    expect(settings).to.exist;
    const columnNames = getColumnNames(settings);
    expect(columnNames).to.include.members(['type', 'doc', 'updated_date']);
  });

  it('should define feedback as local-only table', () => {
    const feedback = findTable('feedback');
    expect(feedback).to.exist;
    expect(feedback!.localOnly).to.be.true;
  });

  it('should define telemetry as local-only insert-only table', () => {
    const telemetry = findTable('telemetry');
    expect(telemetry).to.exist;
    expect(telemetry!.localOnly).to.be.true;
    expect(telemetry!.insertOnly).to.be.true;
  });

  it('should define read_status as local-only with doc_type for unread grouping', () => {
    const readStatus = findTable('read_status');
    expect(readStatus).to.exist;
    expect(readStatus!.localOnly).to.be.true;
    const columnNames = getColumnNames(readStatus);
    expect(columnNames).to.include.members(['doc_id', 'doc_type', 'read_at']);
  });
});
