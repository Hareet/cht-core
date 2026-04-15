'use strict';

const { expect } = require('chai');
const request = require('supertest');
const db = require('../../src/db');
const engine = require('../../src/engine');
const apiHandler = require('../../src/api-handler');
const { createRouter } = require('../../src/server');
const express = require('express');

// Integration tests require a live PostgreSQL instance.
// Set POSTGRESQL_URL to run: POSTGRESQL_URL=postgresql://cht:pgpass@postgres:5432/cht npm run test:integration
const SKIP = !process.env.POSTGRESQL_URL;

(SKIP ? describe.skip : describe)('Storage Budget API Integration', () => {
  let app;
  const schema = db.getSchema();

  before(async () => {
    // Add new columns to purge_status if missing
    await db.query(`
      ALTER TABLE purge_status ADD COLUMN IF NOT EXISTS aggressive BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE purge_status ADD COLUMN IF NOT EXISTS requested_by TEXT;
      ALTER TABLE purge_status ADD COLUMN IF NOT EXISTS reason TEXT;
    `);

    // Ensure purge_roles and purge_run_log exist
    await db.query(`
      CREATE TABLE IF NOT EXISTS purge_roles (
        role_hash TEXT PRIMARY KEY,
        roles JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS purge_run_log (
        id SERIAL PRIMARY KEY,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'running',
        contacts_processed INTEGER DEFAULT 0,
        docs_evaluated INTEGER DEFAULT 0,
        docs_purged INTEGER DEFAULT 0,
        docs_unpurged INTEGER DEFAULT 0,
        skipped_contacts JSONB,
        error TEXT,
        seq_start TEXT,
        seq_end TEXT,
        purge_fn_hash TEXT,
        role_hashes JSONB
      );
    `);

    // Set up express test app
    app = express();
    app.use(createRouter());
  });

  beforeEach(async () => {
    // Clean test data
    await db.query('DELETE FROM purge_status');
    await db.query('DELETE FROM purge_roles');

    // Keep existing couchdb rows but clean any test-specific ones
    await db.query(`DELETE FROM ${schema}.couchdb WHERE _id LIKE 'test-%' OR _id LIKE '%~test-%'`);
  });

  after(async () => {
    await db.query(`DELETE FROM ${schema}.couchdb WHERE _id LIKE 'test-%' OR _id LIKE '%~test-%'`);
    await db.end();
  });

  const insertDoc = async (docId, doc) => {
    await db.query(
      `INSERT INTO ${schema}.couchdb (_id, doc, _deleted)
       VALUES ($1, $2::jsonb, false)
       ON CONFLICT (_id) DO UPDATE SET doc = $2::jsonb, _deleted = false`,
      [docId, JSON.stringify({ _id: docId, ...doc })]
    );
  };

  describe('POST /api/v1/purge/request', () => {
    it('should return 400 for missing body fields', async () => {
      const res = await request(app)
        .post('/api/v1/purge/request')
        .send({})
        .expect(400);

      expect(res.body.error).to.be.a('string');
      expect(res.body.error).to.include('user_id');
    });

    it('should return 200 with zero purge when within budget', async () => {
      const res = await request(app)
        .post('/api/v1/purge/request')
        .send({
          user_id: 'test-user-chw1',
          facility_id: 'test-facility-1',
          current_db_size_mb: 100,
          tier_budget_mb: 200,
        })
        .expect(200);

      expect(res.body.purged_count).to.equal(0);
      expect(res.body.message).to.include('within storage budget');
    });

    it('should return 404 when user has no offline role', async () => {
      const res = await request(app)
        .post('/api/v1/purge/request')
        .send({
          user_id: 'test-nonexistent-user',
          facility_id: 'test-facility-1',
          current_db_size_mb: 500,
          tier_budget_mb: 400,
        })
        .expect(404);

      expect(res.body.error).to.include('No offline role');
    });

    it('should purge terminal tasks aggressively and write to purge_status', async () => {
      // Set up user with CHW role
      await insertDoc('test-user-chw1', {
        type: 'user-settings',
        roles: ['chw'],
      });

      // Insert terminal tasks (no endDate filter in aggressive mode)
      await insertDoc('test-task-completed', {
        type: 'task',
        state: 'Completed',
        emission: { endDate: new Date().toISOString() },
      });
      await insertDoc('test-task-cancelled', {
        type: 'task',
        state: 'Cancelled',
        emission: { endDate: new Date().toISOString() },
      });

      // Insert a non-terminal task (should NOT be purged)
      await insertDoc('test-task-active', {
        type: 'task',
        state: 'Ready',
        emission: {},
      });

      const res = await request(app)
        .post('/api/v1/purge/request')
        .send({
          user_id: 'test-user-chw1',
          facility_id: 'test-facility-1',
          current_db_size_mb: 500,
          tier_budget_mb: 400,
        })
        .expect(200);

      expect(res.body.purged_count).to.be.at.least(2);
      expect(res.body.estimated_reduction_mb).to.be.a('number');
      expect(res.body.breakdown.tasks).to.be.at.least(2);

      // Verify purge_status entries were written with aggressive=true
      const statusResult = await db.query(`
        SELECT doc_id, purged, aggressive, requested_by, reason
        FROM purge_status
        WHERE aggressive = true AND requested_by = 'test-user-chw1'
        ORDER BY doc_id
      `);

      const purgedIds = statusResult.rows.map(r => r.doc_id);
      expect(purgedIds).to.include('test-task-completed');
      expect(purgedIds).to.include('test-task-cancelled');
      expect(purgedIds).to.not.include('test-task-active');

      // Verify metadata
      for (const row of statusResult.rows) {
        expect(row.purged).to.be.true;
        expect(row.aggressive).to.be.true;
        expect(row.requested_by).to.equal('test-user-chw1');
        expect(row.reason).to.equal('storage_budget');
      }
    });

    it('should purge old targets with aggressive 1-month cutoff', async () => {
      await insertDoc('test-user-chw2', {
        type: 'user-settings',
        roles: ['chw'],
      });

      // Insert a target from 3 months ago (should be purged aggressively but not normally)
      // Target IDs must start with 'target~' to match the engine query
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      const tag = `${threeMonthsAgo.getFullYear()}-${String(threeMonthsAgo.getMonth() + 1).padStart(2, '0')}`;
      const oldTargetId = `target~${tag}~test-owner1~abc`;

      await insertDoc(oldTargetId, {
        type: 'target',
      });

      // Insert a target from this month (should NOT be purged)
      const now = new Date();
      const currentTag = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const newTargetId = `target~${currentTag}~test-owner1~def`;

      await insertDoc(newTargetId, {
        type: 'target',
      });

      const res = await request(app)
        .post('/api/v1/purge/request')
        .send({
          user_id: 'test-user-chw2',
          facility_id: 'test-facility-2',
          current_db_size_mb: 600,
          tier_budget_mb: 400,
        })
        .expect(200);

      expect(res.body.breakdown.targets).to.be.at.least(1);

      // Verify the old target was purged
      const statusResult = await db.query(`
        SELECT doc_id FROM purge_status
        WHERE aggressive = true AND doc_id = $1
      `, [oldTargetId]);
      expect(statusResult.rows.length).to.equal(1);

      // Verify current-month target was NOT purged
      const currentResult = await db.query(`
        SELECT doc_id FROM purge_status
        WHERE aggressive = true AND doc_id = $1
      `, [newTargetId]);
      expect(currentResult.rows.length).to.equal(0);
    });

    it('should purge old reports with no active follow-up', async () => {
      await insertDoc('test-user-chw3', {
        type: 'user-settings',
        roles: ['chw'],
      });

      // Insert a contact at the test facility
      await insertDoc('test-patient-1', {
        type: 'person',
        parent: { _id: 'test-facility-3' },
      });

      // Insert an old report (>90 days) under the facility hierarchy
      const oldDate = Date.now() - 120 * 24 * 60 * 60 * 1000;
      await insertDoc('test-old-report-1', {
        type: 'data_record',
        form: 'pregnancy',
        reported_date: oldDate,
        contact: { _id: 'test-patient-1', parent: { _id: 'test-facility-3' } },
      });

      // Insert a recent report (should NOT be purged)
      await insertDoc('test-new-report-1', {
        type: 'data_record',
        form: 'pregnancy',
        reported_date: Date.now(),
        contact: { _id: 'test-patient-1', parent: { _id: 'test-facility-3' } },
      });

      const res = await request(app)
        .post('/api/v1/purge/request')
        .send({
          user_id: 'test-user-chw3',
          facility_id: 'test-facility-3',
          current_db_size_mb: 700,
          tier_budget_mb: 400,
        })
        .expect(200);

      expect(res.body.breakdown.reports).to.be.at.least(1);

      // Verify old report purged, new report not
      const statusResult = await db.query(`
        SELECT doc_id FROM purge_status
        WHERE aggressive = true AND doc_id IN ('test-old-report-1', 'test-new-report-1')
      `);

      const purgedIds = statusResult.rows.map(r => r.doc_id);
      expect(purgedIds).to.include('test-old-report-1');
      expect(purgedIds).to.not.include('test-new-report-1');
    });
  });

  describe('handlePurgeRequest direct', () => {
    it('should return complete breakdown', async () => {
      await insertDoc('test-user-direct', {
        type: 'user-settings',
        roles: ['chw'],
      });

      await insertDoc('test-task-direct', {
        type: 'task',
        state: 'Failed',
        emission: {},
      });

      const result = await apiHandler.handlePurgeRequest({
        user_id: 'test-user-direct',
        facility_id: 'test-facility-direct',
        current_db_size_mb: 500,
        tier_budget_mb: 400,
      });

      expect(result.status).to.equal(200);
      expect(result.body).to.have.property('purged_count');
      expect(result.body).to.have.property('estimated_reduction_mb');
      expect(result.body).to.have.property('breakdown');
      expect(result.body.breakdown).to.have.property('tasks');
      expect(result.body.breakdown).to.have.property('targets');
      expect(result.body.breakdown).to.have.property('reports');
    });
  });
});
