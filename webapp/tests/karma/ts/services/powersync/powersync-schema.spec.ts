import { expect } from 'chai';

import { ChtPowerSyncSchema } from '@mm-services/powersync/powersync-schema';

describe('PowerSync Schema', () => {
  it('should define all required tables', () => {
    const tableNames = Object.keys(ChtPowerSyncSchema.tables);
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
      const contacts = ChtPowerSyncSchema.tables.contacts;
      expect(contacts).to.exist;
      const columnNames = Object.keys(contacts.columns);
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

    it('should have index on contact_type for type queries', () => {
      const contacts = ChtPowerSyncSchema.tables.contacts;
      expect((contacts as any).options?.indexes || (contacts as any).indexes).to.have.property('by_contact_type');
    });
  });

  describe('reports table', () => {
    it('should define required columns including place_id and from', () => {
      const reports = ChtPowerSyncSchema.tables.reports;
      expect(reports).to.exist;
      const columnNames = Object.keys(reports.columns);
      expect(columnNames).to.include.members([
        'type', 'form', 'content_type', 'from',
        'contact_id', 'patient_id', 'patient_uuid', 'place_id',
        'reported_date', 'fields',
        'verified', 'is_private',
      ]);
    });

    it('should have index on place_id', () => {
      const reports = ChtPowerSyncSchema.tables.reports;
      expect((reports as any).options?.indexes || (reports as any).indexes).to.have.property('by_place');
    });
  });

  it('should define tasks table with required columns', () => {
    const tasks = ChtPowerSyncSchema.tables.tasks;
    expect(tasks).to.exist;
    const columnNames = Object.keys(tasks.columns);
    expect(columnNames).to.include.members([
      'type', 'user', 'owner', 'state', 'emission', 'due_date',
      'requester', 'state_reason', 'state_history',
      'start_date', 'end_date', 'reported_date',
    ]);
  });

  it('should define targets table with required columns', () => {
    const targets = ChtPowerSyncSchema.tables.targets;
    expect(targets).to.exist;
    const columnNames = Object.keys(targets.columns);
    expect(columnNames).to.include.members([
      'type', 'owner', 'reporting_period', 'targets',
    ]);
  });

  it('should define settings table for global system docs', () => {
    const settings = ChtPowerSyncSchema.tables.settings;
    expect(settings).to.exist;
    const columnNames = Object.keys(settings.columns);
    expect(columnNames).to.include.members(['type', 'doc', 'updated_date']);
  });

  it('should define feedback as local-only table', () => {
    const feedback = ChtPowerSyncSchema.tables.feedback;
    expect(feedback).to.exist;
    expect((feedback as any).options?.localOnly ?? (feedback as any).localOnly).to.be.true;
  });

  it('should define telemetry as local-only insert-only table', () => {
    const telemetry = ChtPowerSyncSchema.tables.telemetry;
    expect(telemetry).to.exist;
    expect((telemetry as any).options?.localOnly ?? (telemetry as any).localOnly).to.be.true;
    expect((telemetry as any).options?.insertOnly ?? (telemetry as any).insertOnly).to.be.true;
  });

  it('should define read_status as local-only with doc_type for unread grouping', () => {
    const readStatus = ChtPowerSyncSchema.tables.read_status;
    expect(readStatus).to.exist;
    expect((readStatus as any).options?.localOnly ?? (readStatus as any).localOnly).to.be.true;
    const columnNames = Object.keys(readStatus.columns);
    expect(columnNames).to.include.members(['doc_id', 'doc_type', 'read_at']);
  });
});
