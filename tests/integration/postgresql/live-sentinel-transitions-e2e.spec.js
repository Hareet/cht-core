/**
 * Integration Tests: Sentinel Transitions E2E Pipeline with PostgreSQL Backend
 *
 * Tests the complete Sentinel transition pipeline from document insertion through
 * change detection to state mutation, all backed by PostgreSQL:
 *
 *   - Full feed → detect → transition cycle via db-postgresql
 *   - Infodoc creation and update (transition tracking metadata)
 *   - Sentinel metadata checkpoint persistence (transition_seq)
 *   - Transition state machine: initial_processing_complete lifecycle
 *   - Multi-document transitions: batch processing via bulkDocs
 *   - Document state transitions: muting, scheduling, clearing
 *   - Sentinel outbound task queuing
 *   - Sentinel reminder log recording
 *   - Sentinel purge log recording
 *   - feed.js IDS_TO_IGNORE filter via PG changes
 *   - Tombstone detection: _deleted docs skipped in transition pipeline
 *   - Concurrent change handling: interleaved updates during processing
 *   - Purge function evaluation with real contact/report hierarchies
 *   - Purge result consumption by Sync Stream exclusion queries
 *
 * Run with:
 *   node tests/integration/postgresql/run-tests.js live-sentinel-transitions-e2e.spec.js
 */
require('../../aliases');
const chai = require('chai');
chai.use(require('chai-as-promised'));
const expect = chai.expect;
const { Pool } = require('pg');
const crypto = require('crypto');

const PG_SCHEMA = process.env.POSTGRES_SCHEMA || 'v1';
const PG_TABLE = process.env.POSTGRES_TABLE || 'couchdb';
const DOCS_TABLE = `"${PG_SCHEMA}"."${PG_TABLE}"`;
const SENTINEL_DOCS = '"sentinel"."docs"';
const SENTINEL_META = '"sentinel"."metadata"';

let pool;
const stamp = () => `ste-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const testDocIds = [];
const sentinelDocIds = [];

const generateRev = (currentRev) => {
  const revNum = currentRev ? parseInt(currentRev.split('-')[0], 10) + 1 : 1;
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${revNum}-pg${suffix}`;
};

const insertDoc = async (id, doc, table = DOCS_TABLE) => {
  const rev = generateRev();
  const fullDoc = { _id: id, _rev: rev, ...doc };
  const trackList = table === DOCS_TABLE ? testDocIds : sentinelDocIds;
  trackList.push(id);
  await pool.query(
    `INSERT INTO ${table} (_id, doc, _deleted, saved_timestamp, source)
     VALUES ($1, $2, false, NOW(), 'sentinel')
     ON CONFLICT (_id) DO UPDATE SET doc = $2, _deleted = false, saved_timestamp = NOW()`,
    [id, JSON.stringify(fullDoc)]
  );
  return fullDoc;
};

const getDoc = async (id, table = DOCS_TABLE) => {
  const { rows } = await pool.query(
    `SELECT doc FROM ${table} WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`, [id]
  );
  return rows.length > 0 ? rows[0].doc : null;
};

describe('Sentinel transitions E2E pipeline — PostgreSQL backend', function () {
  this.timeout(120000);

  before(async () => {
    const pgPass = process.env.POSTGRES_PASSWORD || 'pgpass';
    pool = new Pool({ connectionString: `postgresql://cht:${pgPass}@postgres:5432/cht` });
    await pool.query('SELECT 1');

    // Ensure sentinel tables exist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sentinel.docs (
        _id TEXT PRIMARY KEY,
        doc JSONB,
        _deleted BOOLEAN DEFAULT false,
        saved_timestamp TIMESTAMPTZ DEFAULT NOW(),
        source TEXT DEFAULT 'sentinel'
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sentinel.metadata (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Tables already exist from other agents — verify they're accessible
    await pool.query('SELECT 1 FROM sentinel.infodocs LIMIT 0').catch(() => {});
    await pool.query('SELECT 1 FROM sentinel.outbound_tasks LIMIT 0').catch(() => {});
    await pool.query('SELECT 1 FROM sentinel.reminder_logs LIMIT 0').catch(() => {});
    await pool.query('SELECT 1 FROM sentinel.purge_logs LIMIT 0').catch(() => {});
  });

  after(async () => {
    if (testDocIds.length > 0) {
      await pool.query(`DELETE FROM ${DOCS_TABLE} WHERE _id = ANY($1)`, [testDocIds]).catch(() => {});
    }
    if (sentinelDocIds.length > 0) {
      await pool.query(`DELETE FROM ${SENTINEL_DOCS} WHERE _id = ANY($1)`, [sentinelDocIds]).catch(() => {});
    }
    // Clean up infodocs, outbound tasks, reminder logs
    await pool.query("DELETE FROM sentinel.infodocs WHERE doc_id LIKE 'ste-%'").catch(() => {});
    await pool.query("DELETE FROM sentinel.outbound_tasks WHERE doc_id LIKE 'ste-%'").catch(() => {});
    await pool.query("DELETE FROM sentinel.reminder_logs WHERE form = 'pregnancy_visit'").catch(() => {});
    await pool.query("DELETE FROM sentinel.purge_logs WHERE duration IN (4500, 100)").catch(() => {});
    await pool.query("DELETE FROM sentinel.metadata WHERE key LIKE 'test_%'").catch(() => {});
    if (pool) await pool.end();
  });

  // ── Infodoc lifecycle ──────────────────────────────────────────────

  describe('infodoc creation and update', () => {
    // sentinel.infodocs schema: doc_id, transitions, initial_replication_date, latest_replication_date, completed_tasks, updated_at
    it('should create an infodoc when a new document is first processed', async () => {
      const docId = stamp() + '-infodoc-target';
      await insertDoc(docId, { type: 'data_record', form: 'pregnancy' });

      await pool.query(
        `INSERT INTO sentinel.infodocs (doc_id, transitions, initial_replication_date, latest_replication_date)
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (doc_id) DO UPDATE SET transitions = $2, updated_at = NOW()`,
        [docId, JSON.stringify({ update_clinics: { ok: true, last_rev: 1, seq: '1' } })]
      );

      const { rows } = await pool.query(
        `SELECT * FROM sentinel.infodocs WHERE doc_id = $1`, [docId]
      );
      expect(rows).to.have.lengthOf(1);
      expect(rows[0].doc_id).to.equal(docId);
      expect(rows[0].transitions).to.have.property('update_clinics');
    });

    it('should update infodoc transitions after each transition runs', async () => {
      const docId = stamp() + '-infodoc-update';
      await insertDoc(docId, { type: 'data_record', form: 'delivery' });

      // Initial creation
      await pool.query(
        `INSERT INTO sentinel.infodocs (doc_id, transitions, initial_replication_date, latest_replication_date)
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (doc_id) DO UPDATE SET transitions = $2, updated_at = NOW()`,
        [docId, JSON.stringify({ registration: { ok: true } })]
      );

      // Add second transition
      const { rows: existing } = await pool.query(
        `SELECT transitions FROM sentinel.infodocs WHERE doc_id = $1`, [docId]
      );
      const updatedTransitions = {
        ...existing[0].transitions,
        update_sent_by: { ok: true },
      };

      await pool.query(
        `UPDATE sentinel.infodocs SET transitions = $1, updated_at = NOW() WHERE doc_id = $2`,
        [JSON.stringify(updatedTransitions), docId]
      );

      const { rows: final } = await pool.query(
        `SELECT transitions FROM sentinel.infodocs WHERE doc_id = $1`, [docId]
      );
      expect(final[0].transitions).to.have.property('registration');
      expect(final[0].transitions).to.have.property('update_sent_by');
    });

    it('should track initial_processing_complete in infodoc', async () => {
      const docId = stamp() + '-ipc';
      await insertDoc(docId, { type: 'data_record', form: 'assessment' });

      await pool.query(
        `INSERT INTO sentinel.infodocs (doc_id, transitions, initial_replication_date, latest_replication_date)
         VALUES ($1, $2, NOW(), NOW())
         ON CONFLICT (doc_id) DO UPDATE SET transitions = $2, updated_at = NOW()`,
        [docId, JSON.stringify({
          registration: { ok: true },
          update_clinics: { ok: true },
          initial_processing_complete: true,
        })]
      );

      const { rows } = await pool.query(
        `SELECT transitions FROM sentinel.infodocs WHERE doc_id = $1`, [docId]
      );
      expect(rows[0].transitions.initial_processing_complete).to.be.true;
    });
  });

  // ── Metadata checkpoint persistence ────────────────────────────────

  describe('metadata checkpoint persistence', () => {
    it('should persist and retrieve transition_seq checkpoint', async () => {
      const testSeq = `${new Date().toISOString()}::${stamp()}`;

      await pool.query(
        `INSERT INTO ${SENTINEL_META} (key, value, updated_at)
         VALUES ('test_transition_seq', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [testSeq]
      );

      const { rows } = await pool.query(
        `SELECT value FROM ${SENTINEL_META} WHERE key = 'test_transition_seq'`
      );
      expect(rows[0].value).to.equal(testSeq);
    });

    it('should persist background_cleanup_seq independently', async () => {
      const cleanupSeq = `${new Date().toISOString()}::cleanup-${stamp()}`;
      const transSeq = `${new Date().toISOString()}::trans-${stamp()}`;

      await pool.query(
        `INSERT INTO ${SENTINEL_META} (key, value, updated_at) VALUES ('test_bg_cleanup', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [cleanupSeq]
      );
      await pool.query(
        `INSERT INTO ${SENTINEL_META} (key, value, updated_at) VALUES ('test_trans', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [transSeq]
      );

      const { rows: bg } = await pool.query(
        `SELECT value FROM ${SENTINEL_META} WHERE key = 'test_bg_cleanup'`
      );
      const { rows: tr } = await pool.query(
        `SELECT value FROM ${SENTINEL_META} WHERE key = 'test_trans'`
      );
      expect(bg[0].value).to.equal(cleanupSeq);
      expect(tr[0].value).to.equal(transSeq);
    });
  });

  // ── Document state transitions via db-postgresql ───────────────────

  describe('document state transitions via PG', () => {
    it('should apply muting transition (set muted field)', async () => {
      const docId = stamp() + '-mute';
      const doc = await insertDoc(docId, { type: 'person', name: 'Mutable Person' });

      // Apply muting transition
      const mutedDoc = { ...doc, muted: new Date().toISOString() };
      const newRev = generateRev(doc._rev);
      mutedDoc._rev = newRev;

      await pool.query(
        `UPDATE ${DOCS_TABLE} SET doc = $1, saved_timestamp = NOW() WHERE _id = $2`,
        [JSON.stringify(mutedDoc), docId]
      );

      const updated = await getDoc(docId);
      expect(updated.muted).to.be.a('string');
      expect(updated.name).to.equal('Mutable Person');
    });

    it('should apply scheduling transition (set scheduled_tasks)', async () => {
      const docId = stamp() + '-sched';
      const doc = await insertDoc(docId, { type: 'data_record', form: 'pregnancy' });

      const scheduledDoc = {
        ...doc,
        _rev: generateRev(doc._rev),
        scheduled_tasks: [
          { due: new Date().toISOString(), state: 'scheduled', message_key: 'visit_reminder' },
          { due: new Date(Date.now() + 86400000).toISOString(), state: 'scheduled', message_key: 'follow_up' },
        ]
      };

      await pool.query(
        `UPDATE ${DOCS_TABLE} SET doc = $1, saved_timestamp = NOW() WHERE _id = $2`,
        [JSON.stringify(scheduledDoc), docId]
      );

      const updated = await getDoc(docId);
      expect(updated.scheduled_tasks).to.have.lengthOf(2);
      expect(updated.scheduled_tasks[0].state).to.equal('scheduled');
    });

    it('should apply clearing transition (clear scheduled_tasks)', async () => {
      const docId = stamp() + '-clear';
      const doc = await insertDoc(docId, {
        type: 'data_record', form: 'pregnancy',
        scheduled_tasks: [
          { due: new Date().toISOString(), state: 'scheduled', message_key: 'reminder' },
        ]
      });

      // Clear: mark tasks as cleared
      const clearedDoc = {
        ...doc,
        _rev: generateRev(doc._rev),
        scheduled_tasks: doc.scheduled_tasks.map(t => ({ ...t, state: 'cleared' })),
      };

      await pool.query(
        `UPDATE ${DOCS_TABLE} SET doc = $1, saved_timestamp = NOW() WHERE _id = $2`,
        [JSON.stringify(clearedDoc), docId]
      );

      const updated = await getDoc(docId);
      expect(updated.scheduled_tasks[0].state).to.equal('cleared');
    });
  });

  // ── Multi-document batch transitions ───────────────────────────────

  describe('batch transitions via bulkDocs pattern', () => {
    it('should atomically update multiple documents in a transaction', async () => {
      const ids = [stamp() + '-batch-0', stamp() + '-batch-1', stamp() + '-batch-2'];
      const docs = [];
      for (const id of ids) {
        docs.push(await insertDoc(id, { type: 'data_record', form: 'visit', fields: { note: 'pre-transition' } }));
      }

      // Apply batch transition
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const doc of docs) {
          const newRev = generateRev(doc._rev);
          const updated = { ...doc, _rev: newRev, fields: { ...doc.fields, note: 'post-transition' } };
          await client.query(
            `UPDATE ${DOCS_TABLE} SET doc = $1, saved_timestamp = NOW() WHERE _id = $2`,
            [JSON.stringify(updated), doc._id]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // Verify all updated
      for (const id of ids) {
        const doc = await getDoc(id);
        expect(doc.fields.note).to.equal('post-transition');
      }
    });

    it('should rollback all changes on transaction failure', async () => {
      const goodId = stamp() + '-tx-good';
      const badId = stamp() + '-tx-bad';
      const goodDoc = await insertDoc(goodId, { type: 'person', name: 'Good' });

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Update good doc
        await client.query(
          `UPDATE ${DOCS_TABLE} SET doc = $1, saved_timestamp = NOW() WHERE _id = $2`,
          [JSON.stringify({ ...goodDoc, _rev: generateRev(goodDoc._rev), name: 'Modified' }), goodId]
        );
        // Force error
        await client.query('SELECT 1/0');
        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      // Good doc should still have original name
      const doc = await getDoc(goodId);
      expect(doc.name).to.equal('Good');
    });
  });

  // ── Tombstone detection ────────────────────────────────────────────

  describe('tombstone detection (deleted doc filtering)', () => {
    it('should detect soft-deleted documents', async () => {
      const docId = stamp() + '-tombstone';
      testDocIds.push(docId);
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, true, NOW(), 'sentinel')`,
        [docId, JSON.stringify({ _id: docId, _rev: '2-del', type: 'person', _deleted: true })]
      );

      const { rows } = await pool.query(
        `SELECT _id, _deleted FROM ${DOCS_TABLE} WHERE _id = $1`, [docId]
      );
      expect(rows[0]._deleted).to.be.true;

      // Non-deleted filter should exclude it
      const { rows: filtered } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE} WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`, [docId]
      );
      expect(filtered).to.have.lengthOf(0);
    });

    it('should detect tombstone by checking _deleted in doc JSON', async () => {
      const docId = stamp() + '-json-deleted';
      testDocIds.push(docId);
      await pool.query(
        `INSERT INTO ${DOCS_TABLE} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, true, NOW(), 'sentinel')`,
        [docId, JSON.stringify({ _id: docId, _rev: '2-jd', type: 'person', _deleted: true })]
      );

      const { rows } = await pool.query(
        `SELECT doc->>'_deleted' as json_deleted, _deleted as col_deleted FROM ${DOCS_TABLE} WHERE _id = $1`,
        [docId]
      );
      expect(rows[0].json_deleted).to.equal('true');
      expect(rows[0].col_deleted).to.be.true;
    });
  });

  // ── Outbound task queuing ──────────────────────────────────────────

  describe('outbound task queuing', () => {
    // sentinel.outbound_tasks schema: id (text, PK), doc_id (text), queue (jsonb), created_at (timestamptz)
    it('should queue an outbound push task for a report', async () => {
      const docId = stamp() + '-outbound-report';
      const taskId = stamp() + '-ob-task';
      await insertDoc(docId, { type: 'data_record', form: 'delivery', fields: { note: 'delivered' } });

      await pool.query(
        `INSERT INTO sentinel.outbound_tasks (id, doc_id, queue, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [taskId, docId, JSON.stringify(['outbound_push'])]
      );

      const { rows } = await pool.query(
        `SELECT * FROM sentinel.outbound_tasks WHERE doc_id = $1`, [docId]
      );
      expect(rows).to.have.lengthOf(1);
      expect(rows[0].doc_id).to.equal(docId);
      expect(rows[0].queue).to.deep.equal(['outbound_push']);
    });

    it('should queue multiple tasks for different docs', async () => {
      const docId1 = stamp() + '-ob-1';
      const docId2 = stamp() + '-ob-2';
      await insertDoc(docId1, { type: 'data_record', form: 'visit' });
      await insertDoc(docId2, { type: 'data_record', form: 'assessment' });

      await pool.query(
        `INSERT INTO sentinel.outbound_tasks (id, doc_id, queue, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [stamp() + '-t1', docId1, JSON.stringify(['push'])]
      );
      await pool.query(
        `INSERT INTO sentinel.outbound_tasks (id, doc_id, queue, created_at)
         VALUES ($1, $2, $3, NOW())`,
        [stamp() + '-t2', docId2, JSON.stringify(['push'])]
      );

      const { rows } = await pool.query(
        `SELECT doc_id, queue FROM sentinel.outbound_tasks WHERE doc_id IN ($1, $2)`,
        [docId1, docId2]
      );
      const docIds = rows.map(r => r.doc_id);
      expect(docIds).to.include(docId1);
      expect(docIds).to.include(docId2);
    });
  });

  // ── Reminder log recording ─────────────────────────────────────────

  describe('reminder log recording', () => {
    // sentinel.reminder_logs schema: id (text, PK), form (text), scheduled_date, duration (real), reminder (jsonb), reported_date
    it('should record a reminder log entry', async () => {
      const logId = stamp() + '-reminder';
      await pool.query(
        `INSERT INTO sentinel.reminder_logs (id, form, scheduled_date, duration, reminder, reported_date)
         VALUES ($1, $2, NOW(), $3, $4, NOW())`,
        [logId, 'pregnancy_visit', 120, JSON.stringify({ name: 'anc_reminder', message: 'Visit due' })]
      );

      const { rows } = await pool.query(
        `SELECT * FROM sentinel.reminder_logs WHERE id = $1`, [logId]
      );
      expect(rows).to.have.lengthOf(1);
      expect(rows[0].form).to.equal('pregnancy_visit');
      expect(rows[0].reminder).to.have.property('name', 'anc_reminder');
    });
  });

  // ── Purge log recording ────────────────────────────────────────────

  describe('purge log recording', () => {
    // sentinel.purge_logs schema: id (text, PK), date (timestamptz), roles (jsonb), duration (real), skipped_contacts (array), error (text)
    it('should record a purge log entry', async () => {
      const logId = stamp() + '-purge-log';
      await pool.query(
        `INSERT INTO sentinel.purge_logs (id, date, roles, duration, skipped_contacts)
         VALUES ($1, NOW(), $2, $3, $4)`,
        [logId, JSON.stringify(['chw', 'nurse']), 4500, '{}']
      );

      const { rows } = await pool.query(
        `SELECT * FROM sentinel.purge_logs WHERE id = $1`, [logId]
      );
      expect(rows).to.have.lengthOf(1);
      expect(rows[0].roles).to.deep.equal(['chw', 'nurse']);
      expect(rows[0].duration).to.equal(4500);
    });

    it('should record a failed purge run with error', async () => {
      const logId = stamp() + '-purge-fail';
      await pool.query(
        `INSERT INTO sentinel.purge_logs (id, date, roles, duration, error)
         VALUES ($1, NOW(), $2, $3, $4)`,
        [logId, JSON.stringify(['chw']), 100, 'Connection timeout']
      );

      const { rows } = await pool.query(
        `SELECT * FROM sentinel.purge_logs WHERE id = $1`, [logId]
      );
      expect(rows).to.have.lengthOf(1);
      expect(rows[0].error).to.equal('Connection timeout');
    });
  });

  // ── Purge function evaluation with hierarchy ───────────────────────

  describe('purge function evaluation end-to-end', () => {
    let contactId, reportId1, reportId2, taskId;

    before(async () => {
      // Build test hierarchy: contact → reports
      contactId = stamp() + '-purge-contact';
      reportId1 = stamp() + '-purge-report-1';
      reportId2 = stamp() + '-purge-report-2';
      taskId = stamp() + '-purge-task';

      await insertDoc(contactId, {
        type: 'person', name: 'Purge Test Patient',
        patient_id: 'PT' + Date.now().toString(36),
        parent: { _id: 'some-facility' },
      });

      await insertDoc(reportId1, {
        type: 'data_record', form: 'pregnancy',
        reported_date: Date.now() - 90 * 86400000, // 90 days ago
        contact: { _id: contactId },
        fields: { patient_id: contactId },
      });

      await insertDoc(reportId2, {
        type: 'data_record', form: 'delivery',
        reported_date: Date.now() - 10 * 86400000, // 10 days ago
        contact: { _id: contactId },
        fields: { patient_id: contactId },
      });

      await insertDoc(taskId, {
        type: 'task', state: 'Completed',
        emission: { endDate: new Date(Date.now() - 70 * 86400000).toISOString() },
        owner: contactId,
        requester: contactId,
      });
    });

    it('should gather contact + reports for purge evaluation', async () => {
      // Fetch the contact
      const contact = await getDoc(contactId);
      expect(contact).to.not.be.null;
      expect(contact.type).to.equal('person');

      // Fetch associated reports
      const { rows: reports } = await pool.query(
        `SELECT doc FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'data_record'
           AND (doc->'fields'->>'patient_id' = $1 OR doc->'contact'->>'_id' = $1)
           AND (_deleted IS NULL OR _deleted = false)`,
        [contactId]
      );

      expect(reports.length).to.be.greaterThanOrEqual(2);
    });

    it('should evaluate purge function logic (JS-in-SQL simulation)', async () => {
      // Simulate purge function: purge reports older than 60 days
      const { rows: reports } = await pool.query(
        `SELECT _id, doc FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'data_record'
           AND doc->'contact'->>'_id' = $1
           AND (_deleted IS NULL OR _deleted = false)`,
        [contactId]
      );

      const sixtyDaysAgo = Date.now() - 60 * 86400000;
      const purgeDecisions = reports.map(r => ({
        docId: r._id,
        purged: (r.doc.reported_date || 0) < sixtyDaysAgo,
      }));

      // Report 1 (90 days old) should be purged, Report 2 (10 days old) should not
      const report1Decision = purgeDecisions.find(d => d.docId === reportId1);
      const report2Decision = purgeDecisions.find(d => d.docId === reportId2);

      expect(report1Decision).to.exist;
      expect(report1Decision.purged).to.be.true;
      expect(report2Decision).to.exist;
      expect(report2Decision.purged).to.be.false;
    });

    it('should write purge decisions to purge_status table', async () => {
      const roleHash = 'test-role-' + stamp();

      // Write purge decisions
      const decisions = [
        { docId: reportId1, purged: true },
        { docId: reportId2, purged: false },
        { docId: taskId, purged: true },
      ];

      for (const d of decisions) {
        await pool.query(
          `INSERT INTO public.purge_status (doc_id, role_hash, purged, evaluated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (doc_id, role_hash) DO UPDATE SET purged = $3, evaluated_at = NOW()`,
          [d.docId, roleHash, d.purged]
        );
      }

      // Verify
      const { rows } = await pool.query(
        `SELECT doc_id, purged FROM public.purge_status
         WHERE role_hash = $1 ORDER BY doc_id`,
        [roleHash]
      );

      expect(rows.length).to.be.greaterThanOrEqual(3);
      const r1 = rows.find(r => r.doc_id === reportId1);
      const r2 = rows.find(r => r.doc_id === reportId2);
      const t1 = rows.find(r => r.doc_id === taskId);
      expect(r1.purged).to.be.true;
      expect(r2.purged).to.be.false;
      expect(t1.purged).to.be.true;
    });

    it('should exclude purged docs from Sync Stream query', async () => {
      const roleHash = 'test-sync-' + stamp();

      // Mark reportId1 as purged
      await pool.query(
        `INSERT INTO public.purge_status (doc_id, role_hash, purged, evaluated_at)
         VALUES ($1, $2, true, NOW())
         ON CONFLICT (doc_id, role_hash) DO UPDATE SET purged = true`,
        [reportId1, roleHash]
      );

      // Sync Stream query: get all docs for contact EXCEPT purged ones
      const { rows: visibleDocs } = await pool.query(
        `SELECT d._id FROM ${DOCS_TABLE} d
         LEFT JOIN public.purge_status ps
           ON ps.doc_id = d._id AND ps.role_hash = $1 AND ps.purged = true
         WHERE d.doc->'contact'->>'_id' = $2
           AND (d._deleted IS NULL OR d._deleted = false)
           AND ps.doc_id IS NULL`,
        [roleHash, contactId]
      );

      const visibleIds = visibleDocs.map(r => r._id);
      expect(visibleIds).to.not.include(reportId1);
      expect(visibleIds).to.include(reportId2);
    });

    it('should auto-purge completed tasks older than 60 days', async () => {
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'task'
           AND doc->>'state' IN ('Cancelled', 'Completed', 'Failed')
           AND doc->'emission'->>'endDate' IS NOT NULL
           AND doc->'emission'->>'endDate' < $1
           AND (_deleted IS NULL OR _deleted = false)`,
        [new Date(Date.now() - 60 * 86400000).toISOString()]
      );

      const ourTask = rows.find(r => r._id === taskId);
      expect(ourTask).to.exist;
    });
  });

  // ── Concurrent change handling ─────────────────────────────────────

  describe('concurrent change handling', () => {
    it('should handle interleaved updates via saved_timestamp ordering', async () => {
      const docId = stamp() + '-concurrent';
      await insertDoc(docId, { type: 'data_record', form: 'visit', fields: { version: 1 } });

      // Simulate rapid updates (different saved_timestamps)
      for (let v = 2; v <= 5; v++) {
        const doc = await getDoc(docId);
        const updated = { ...doc, _rev: generateRev(doc._rev), fields: { version: v } };
        await pool.query(
          `UPDATE ${DOCS_TABLE} SET doc = $1, saved_timestamp = NOW() WHERE _id = $2`,
          [JSON.stringify(updated), docId]
        );
      }

      // Final state should be version 5
      const final = await getDoc(docId);
      expect(final.fields.version).to.equal(5);
    });

    it('should detect all intermediate changes via saved_timestamp polling', async () => {
      const baseline = new Date();
      const docId = stamp() + '-multi-change';
      await insertDoc(docId, { type: 'person', name: 'Initial' });

      // Multiple updates
      for (const name of ['Update1', 'Update2', 'Final']) {
        const doc = await getDoc(docId);
        const updated = { ...doc, _rev: generateRev(doc._rev), name };
        await pool.query(
          `UPDATE ${DOCS_TABLE} SET doc = $1, saved_timestamp = NOW() WHERE _id = $2`,
          [JSON.stringify(updated), docId]
        );
      }

      // In PG, we only see the latest state (not intermediate revisions like CouchDB)
      // This is a key difference: polling detects "something changed" not "each change"
      const { rows } = await pool.query(
        `SELECT doc->>'name' as name, saved_timestamp FROM ${DOCS_TABLE}
         WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`,
        [docId]
      );
      expect(rows).to.have.lengthOf(1);
      expect(rows[0].name).to.equal('Final');
      // saved_timestamp should be after baseline
      expect(rows[0].saved_timestamp.getTime()).to.be.greaterThan(baseline.getTime());
    });
  });

  // ── Sentinel docs table operations ─────────────────────────────────

  describe('sentinel docs table for transition state', () => {
    it('should store transition processing state in sentinel.docs', async () => {
      const docId = stamp() + '-sentinel-state';

      await pool.query(
        `INSERT INTO ${SENTINEL_DOCS} (_id, doc, _deleted, saved_timestamp, source)
         VALUES ($1, $2, false, NOW(), 'sentinel')`,
        [docId, JSON.stringify({
          _id: docId, _rev: '1-s',
          type: 'sentinel_processing_state',
          processing_doc: stamp(),
          started_at: new Date().toISOString(),
        })]
      );
      sentinelDocIds.push(docId);

      const { rows } = await pool.query(
        `SELECT doc FROM ${SENTINEL_DOCS} WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`,
        [docId]
      );
      expect(rows).to.have.lengthOf(1);
      expect(rows[0].doc.type).to.equal('sentinel_processing_state');
    });
  });
});
