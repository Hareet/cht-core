'use strict';

const { expect } = require('chai');
const db = require('../../src/db');
const engine = require('../../src/engine');
const purgeStatus = require('../../src/purge-status');
const fs = require('fs');
const path = require('path');

// Integration tests require a live PostgreSQL instance.
// Set POSTGRESQL_URL to run these tests.
// Example: POSTGRESQL_URL=postgresql://localhost:5432/cht_test npm run test:integration
const SKIP = !process.env.POSTGRESQL_URL;

(SKIP ? describe.skip : describe)('Purge Preprocessing Integration', () => {
  before(async () => {
    // Apply schema
    const schemaPath = path.join(__dirname, '../../sql/001-create-purge-status.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await db.query(schema);

    // Create a minimal couchdb table if it doesn't exist
    await db.query(`
      CREATE TABLE IF NOT EXISTS couchdb (
        uuid TEXT PRIMARY KEY,
        doc_id TEXT,
        doc JSONB,
        saved_timestamp TIMESTAMP DEFAULT NOW(),
        source VARCHAR,
        seq TEXT
      )
    `);
  });

  beforeEach(async () => {
    await db.query('DELETE FROM purge_status');
    await db.query('DELETE FROM purge_roles');
    await db.query('DELETE FROM purge_run_log');
    await db.query('DELETE FROM couchdb');
  });

  after(async () => {
    await db.end();
  });

  const insertDoc = async (docId, doc) => {
    await db.query(
      'INSERT INTO couchdb (uuid, doc_id, doc) VALUES ($1, $2, $3)',
      [docId, docId, JSON.stringify(doc)]
    );
  };

  it('should evaluate purge function and write results', async () => {
    // Insert settings with a purge function that purges reports older than 1 year
    const purgeFn = `function(userCtx, contact, reports) {
      var oneYearAgo = Date.now() - (365 * 24 * 60 * 60 * 1000);
      return reports.filter(function(r) { return r.reported_date < oneYearAgo; }).map(function(r) { return r._id; });
    }`;

    await insertDoc('settings', {
      _id: 'settings',
      settings: { purge: { fn: purgeFn } },
    });

    // Insert a user-settings doc with roles
    await insertDoc('user-settings-chw1', {
      _id: 'user-settings-chw1',
      type: 'user-settings',
      roles: ['chw'],
    });

    // Insert a contact
    await insertDoc('patient1', {
      _id: 'patient1',
      type: 'person',
      patient_id: 'p1',
      name: 'Test Patient',
    });

    // Insert an old report (should be purged)
    await insertDoc('old_report', {
      _id: 'old_report',
      type: 'data_record',
      form: 'pregnancy',
      patient_id: 'p1',
      reported_date: Date.now() - (400 * 24 * 60 * 60 * 1000),
    });

    // Insert a recent report (should NOT be purged)
    await insertDoc('new_report', {
      _id: 'new_report',
      type: 'data_record',
      form: 'pregnancy',
      patient_id: 'p1',
      reported_date: Date.now(),
    });

    await engine.run({ incremental: false });

    // Verify purge_status
    const result = await db.query('SELECT * FROM purge_status ORDER BY doc_id');
    const statusMap = {};
    for (const row of result.rows) {
      statusMap[row.doc_id] = row.purged;
    }

    expect(statusMap.old_report).to.be.true;
    expect(statusMap.new_report).to.be.false;

    // Verify run log
    const logResult = await db.query('SELECT * FROM purge_run_log WHERE status = $1', ['completed']);
    expect(logResult.rows).to.have.length(1);
    expect(logResult.rows[0].contacts_processed).to.be.greaterThan(0);
  });

  it('should handle multiple role sets independently', async () => {
    const purgeFn = `function(userCtx, contact, reports) {
      if (userCtx.roles.indexOf('chw') >= 0) {
        var cutoff = Date.now() - (90 * 24 * 60 * 60 * 1000);
        return reports.filter(function(r) { return r.reported_date < cutoff; }).map(function(r) { return r._id; });
      }
      return [];
    }`;

    await insertDoc('settings', { _id: 'settings', purge: { fn: purgeFn } });
    await insertDoc('user-chw', { _id: 'user-chw', type: 'user-settings', roles: ['chw'] });
    await insertDoc('user-sup', { _id: 'user-sup', type: 'user-settings', roles: ['chw_supervisor'] });

    await insertDoc('contact1', { _id: 'contact1', type: 'person' });
    await insertDoc('report1', {
      _id: 'report1',
      type: 'data_record',
      form: 'a',
      patient_id: 'contact1',
      reported_date: Date.now() - (100 * 24 * 60 * 60 * 1000),
    });

    await engine.run({ incremental: false });

    const result = await db.query(
      'SELECT doc_id, role_hash, purged FROM purge_status WHERE doc_id = $1',
      ['report1']
    );

    // Should have two entries (one per role hash)
    expect(result.rows).to.have.length(2);

    const purgedByRole = {};
    for (const row of result.rows) {
      purgedByRole[row.role_hash] = row.purged;
    }

    // One should be purged (chw), one should not (supervisor)
    const values = Object.values(purgedByRole);
    expect(values).to.include(true);
    expect(values).to.include(false);
  });

  it('should clean up purge_status entries when documents are deleted', async () => {
    const purgeFn = `function(userCtx, contact, reports) { return []; }`;

    await insertDoc('settings', {
      _id: 'settings',
      settings: { purge: { fn: purgeFn } },
    });
    await insertDoc('user-chw', { _id: 'user-chw', type: 'user-settings', roles: ['chw'] });
    await insertDoc('contact1', { _id: 'contact1', type: 'person' });
    await insertDoc('report1', {
      _id: 'report1',
      type: 'data_record',
      form: 'a',
      patient_id: 'contact1',
      reported_date: Date.now(),
    });

    // Full run — both contact1 and report1 get purge_status entries
    await engine.run({ incremental: false });

    const before = await db.query(
      'SELECT doc_id FROM purge_status WHERE doc_id IN ($1, $2)',
      ['contact1', 'report1']
    );
    expect(before.rows.length).to.be.greaterThan(0);

    // Mark report1 as deleted in couchdb
    await db.query(
      `UPDATE ${db.getSchema()}.couchdb SET _deleted = true WHERE _id = $1`,
      ['report1']
    );

    // Run again — cleanup should remove purge_status for report1
    await engine.run({ incremental: false });

    const after = await db.query(
      'SELECT doc_id, purged FROM purge_status WHERE doc_id = $1',
      ['report1']
    );
    expect(after.rows).to.have.length(0);

    // contact1 should still have entries
    const contact = await db.query(
      'SELECT doc_id FROM purge_status WHERE doc_id = $1',
      ['contact1']
    );
    expect(contact.rows.length).to.be.greaterThan(0);
  });

  it('should run incrementally after initial full run', async () => {
    const purgeFn = `function(userCtx, contact, reports) { return []; }`;

    await insertDoc('settings', { _id: 'settings', purge: { fn: purgeFn } });
    await insertDoc('user-chw', { _id: 'user-chw', type: 'user-settings', roles: ['chw'] });
    await insertDoc('contact1', { _id: 'contact1', type: 'person' });

    // Full run
    await engine.run({ incremental: false });

    const firstLog = await db.query(
      'SELECT * FROM purge_run_log WHERE status = $1',
      ['completed']
    );
    expect(firstLog.rows).to.have.length(1);

    // Incremental run (no changes, should still complete)
    await engine.run({ incremental: true });

    const allLogs = await db.query(
      'SELECT * FROM purge_run_log WHERE status = $1 ORDER BY id',
      ['completed']
    );
    expect(allLogs.rows).to.have.length(2);
  });
});
