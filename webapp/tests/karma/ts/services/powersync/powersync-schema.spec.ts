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

  it('should define contacts table with required columns', () => {
    const contacts = ChtPowerSyncSchema.tables.contacts;
    expect(contacts).to.exist;
    const columnNames = Object.keys(contacts.columns);
    expect(columnNames).to.include.members([
      'type', 'name', 'phone', 'parent_id', 'parent',
      'contact_id', 'reported_date', 'patient_id', 'doc_type',
    ]);
  });

  it('should define reports table with required columns', () => {
    const reports = ChtPowerSyncSchema.tables.reports;
    expect(reports).to.exist;
    const columnNames = Object.keys(reports.columns);
    expect(columnNames).to.include.members([
      'type', 'form', 'contact_id', 'patient_id', 'patient_uuid',
      'reported_date', 'fields', 'verified', 'is_private',
    ]);
  });

  it('should define tasks table with required columns', () => {
    const tasks = ChtPowerSyncSchema.tables.tasks;
    expect(tasks).to.exist;
    const columnNames = Object.keys(tasks.columns);
    expect(columnNames).to.include.members([
      'type', 'user', 'owner', 'state', 'emission', 'due_date',
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

  it('should define feedback as local-only table', () => {
    const feedback = ChtPowerSyncSchema.tables.feedback;
    expect(feedback).to.exist;
    // Local-only tables are not synced from server
    expect((feedback as any).options?.localOnly ?? (feedback as any).localOnly).to.be.true;
  });

  it('should define telemetry as local-only insert-only table', () => {
    const telemetry = ChtPowerSyncSchema.tables.telemetry;
    expect(telemetry).to.exist;
    expect((telemetry as any).options?.localOnly ?? (telemetry as any).localOnly).to.be.true;
    expect((telemetry as any).options?.insertOnly ?? (telemetry as any).insertOnly).to.be.true;
  });

  it('should define read_status as local-only table', () => {
    const readStatus = ChtPowerSyncSchema.tables.read_status;
    expect(readStatus).to.exist;
    expect((readStatus as any).options?.localOnly ?? (readStatus as any).localOnly).to.be.true;
  });
});
