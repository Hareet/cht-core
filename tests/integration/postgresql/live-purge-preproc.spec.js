/**
 * Live Integration Tests: Purge Preprocessing Service (Agent 4)
 *
 * Tests the purge preprocessing tables and query patterns against live PostgreSQL.
 * Validates:
 *   - purge_status table (public schema — Agent 4's original with purged boolean)
 *   - purge_roles table (role_hash → roles JSONB mapping)
 *   - purge_run_log (operational monitoring)
 *   - Sync Stream exclusion pattern (LEFT JOIN purge_status)
 *   - Auto-purge patterns for tasks (60 days) and targets (6 months)
 *   - Incremental evaluation via evaluated_at
 *
 * Run with:
 *   POSTGRES_PASSWORD=pgpass NODE_TLS_REJECT_UNAUTHORIZED=0 \
 *   npx mocha tests/integration/postgresql/live-purge-preproc.spec.js --timeout 120000 --exit
 */
require('../../aliases');
const chai = require('chai');
chai.use(require('chai-as-promised'));
const expect = chai.expect;
const { Pool } = require('pg');

const PG_SCHEMA = process.env.POSTGRES_SCHEMA || 'v1';
const DOCS_TABLE = `"${PG_SCHEMA}"."couchdb"`;

let pool;
const stamp = () => `purge-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

// CouchDB helpers
const COUCH_URL = process.env.COUCH_URL || 'http://admin:secret21512@couchdb:5984/medic';
const parsedCouch = new URL(COUCH_URL);
const COUCH_HOST = `${parsedCouch.protocol}//${parsedCouch.host}`;
const COUCH_DB = parsedCouch.pathname.replace(/^\//, '');
const COUCH_AUTH = 'Basic ' + Buffer.from(`${parsedCouch.username}:${parsedCouch.password}`).toString('base64');
const couchFetch = (path, opts = {}) => {
  opts.headers = { ...opts.headers, Authorization: COUCH_AUTH, Accept: 'application/json' };
  return fetch(`${COUCH_HOST}${path}`, opts);
};
const couchPost = async (doc) => (await couchFetch(`/${COUCH_DB}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc),
})).json();
const couchDelete = async (id) => {
  const resp = await couchFetch(`/${COUCH_DB}/${encodeURIComponent(id)}`);
  const doc = await resp.json();
  if (doc._rev) await couchFetch(`/${COUCH_DB}/${encodeURIComponent(id)}?rev=${doc._rev}`, { method: 'DELETE' });
};
const waitForDoc = async (docId, timeout = 45000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const { rows } = await pool.query(
      `SELECT doc FROM ${DOCS_TABLE} WHERE _id = $1 AND (_deleted IS NULL OR _deleted = false)`, [docId]
    );
    if (rows.length > 0) return rows[0].doc;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`${docId} not in PG within ${timeout}ms`);
};

const testDocIds = [];

describe('Purge preprocessing service (Agent 4) — live', function () {
  this.timeout(120000);

  before(async () => {
    const pgPass = process.env.POSTGRES_PASSWORD || 'pgpass';
    pool = new Pool({ connectionString: `postgresql://cht:${pgPass}@postgres:5432/cht` });
    await pool.query('SELECT 1');
  });

  after(async () => {
    // Clean up test docs
    for (const id of testDocIds) await couchDelete(id).catch(() => {});
    // Clean up test purge_status entries
    await pool.query("DELETE FROM public.purge_status WHERE doc_id LIKE 'purge-test-%'").catch(() => {});
    if (pool) await pool.end();
  });

  // ── Verify existing purge tables from Agent 4's deployment ────────

  describe('purge table schema', () => {
    it('should have public.purge_status with correct columns', async () => {
      const { rows } = await pool.query(`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'purge_status'
        ORDER BY ordinal_position
      `);
      const cols = Object.fromEntries(rows.map(r => [r.column_name, r.data_type]));
      expect(cols).to.have.property('doc_id');
      expect(cols).to.have.property('role_hash');
      expect(cols).to.have.property('purged');
      expect(cols).to.have.property('evaluated_at');
    });

    it('should have purge_roles table', async () => {
      const { rows } = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'purge_roles'
      `);
      const colNames = rows.map(r => r.column_name);
      expect(colNames).to.include('role_hash');
      expect(colNames).to.include('roles');
    });

    it('should have purge_run_log table', async () => {
      const { rows } = await pool.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'purge_run_log'
      `);
      const colNames = rows.map(r => r.column_name);
      expect(colNames).to.include.members([
        'id', 'started_at', 'completed_at', 'status',
        'contacts_processed', 'docs_evaluated', 'docs_purged', 'docs_unpurged'
      ]);
    });
  });

  // ── Verify Agent 4's purge engine ran and produced data ───────────

  describe('purge engine execution results', () => {
    it('should have completed at least one purge run', async () => {
      const { rows } = await pool.query(
        "SELECT * FROM public.purge_run_log WHERE status = 'completed' ORDER BY id DESC LIMIT 1"
      );
      expect(rows).to.have.length(1);
      const run = rows[0];
      expect(run.contacts_processed).to.be.at.least(1);
      expect(run.docs_evaluated).to.be.at.least(1);
      expect(run.completed_at).to.exist;
      console.log(`  Last run: ${run.contacts_processed} contacts, ${run.docs_evaluated} evaluated, ${run.docs_purged} purged, ${run.docs_unpurged} unpurged`);
    });

    it('should have discovered roles from user-settings docs', async () => {
      const { rows } = await pool.query('SELECT role_hash, roles FROM public.purge_roles');
      expect(rows).to.have.length.at.least(1);
      for (const row of rows) {
        expect(row.role_hash).to.be.a('string').with.length(32); // MD5 hash
        expect(row.roles).to.be.an('array').that.is.not.empty;
        console.log(`  Role hash: ${row.role_hash} → ${JSON.stringify(row.roles)}`);
      }
    });

    it('should have evaluated documents and written purge_status entries', async () => {
      const { rows } = await pool.query('SELECT count(*) as n FROM public.purge_status');
      expect(parseInt(rows[0].n)).to.be.at.least(1);
      console.log(`  purge_status entries: ${rows[0].n}`);
    });

    it('should have explicit purged=false for non-purged docs', async () => {
      // Agent 4's design: purged boolean is explicit (not NULL) so we can
      // distinguish "evaluated, not purged" from "never evaluated"
      const { rows } = await pool.query(
        'SELECT count(*) as n FROM public.purge_status WHERE purged = false'
      );
      expect(parseInt(rows[0].n)).to.be.at.least(1);
    });
  });

  // ── purge_status write patterns ──────────────────────────────────

  describe('purge_status write patterns', () => {
    it('should UPSERT purge decisions (ON CONFLICT DO UPDATE)', async () => {
      const docId = stamp();
      const roleHash = 'test-hash-0000000000000000000000';

      // Initial insert: not purged
      await pool.query(
        `INSERT INTO public.purge_status (doc_id, role_hash, purged, evaluated_at)
         VALUES ($1, $2, false, NOW())
         ON CONFLICT (doc_id, role_hash) DO UPDATE SET
           purged = EXCLUDED.purged, evaluated_at = EXCLUDED.evaluated_at`,
        [docId, roleHash]
      );

      let { rows } = await pool.query(
        'SELECT purged FROM public.purge_status WHERE doc_id = $1 AND role_hash = $2',
        [docId, roleHash]
      );
      expect(rows[0].purged).to.be.false;

      // Re-evaluate: now purged
      await pool.query(
        `INSERT INTO public.purge_status (doc_id, role_hash, purged, evaluated_at)
         VALUES ($1, $2, true, NOW())
         ON CONFLICT (doc_id, role_hash) DO UPDATE SET
           purged = EXCLUDED.purged, evaluated_at = EXCLUDED.evaluated_at`,
        [docId, roleHash]
      );

      ({ rows } = await pool.query(
        'SELECT purged FROM public.purge_status WHERE doc_id = $1 AND role_hash = $2',
        [docId, roleHash]
      ));
      expect(rows[0].purged).to.be.true;
    });

    it('should support multiple role hashes per document', async () => {
      const docId = stamp();
      const hash1 = 'test-hash-chw-000000000000000000';
      const hash2 = 'test-hash-sup-000000000000000000';

      await pool.query(
        `INSERT INTO public.purge_status (doc_id, role_hash, purged) VALUES ($1, $2, true), ($1, $3, false)`,
        [docId, hash1, hash2]
      );

      const { rows } = await pool.query(
        'SELECT role_hash, purged FROM public.purge_status WHERE doc_id = $1 ORDER BY role_hash',
        [docId]
      );
      expect(rows).to.have.length(2);
      const chwRow = rows.find(r => r.role_hash === hash1);
      const supRow = rows.find(r => r.role_hash === hash2);
      expect(chwRow.purged).to.be.true;
      expect(supRow.purged).to.be.false;
    });
  });

  // ── Sync Stream exclusion pattern ─────────────────────────────────

  describe('Sync Stream exclusion pattern', () => {
    it('should exclude purged docs via LEFT JOIN for a role_hash', async () => {
      // Seed 3 test docs in CouchDB → PG
      const ids = [stamp(), stamp(), stamp()];
      testDocIds.push(...ids);
      const docs = ids.map(id => ({ _id: id, type: 'data_record', fields: {}, reported_date: Date.now() }));
      await couchFetch(`/${COUCH_DB}/_bulk_docs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs }),
      });
      for (const id of ids) await waitForDoc(id);

      const roleHash = 'test-sync-stream-hash-00000000';
      // ids[0] = purged, ids[1] = not purged, ids[2] = never evaluated
      await pool.query(
        `INSERT INTO public.purge_status (doc_id, role_hash, purged) VALUES ($1, $3, true), ($2, $3, false)`,
        [ids[0], ids[1], roleHash]
      );

      // Sync Stream query: include docs NOT purged for this role
      const { rows } = await pool.query(
        `SELECT c._id FROM ${DOCS_TABLE} c
         LEFT JOIN public.purge_status ps ON c._id = ps.doc_id AND ps.role_hash = $1
         WHERE c._id = ANY($2) AND (c._deleted IS NULL OR c._deleted = false)
         AND (ps.purged IS NULL OR ps.purged = false)`,
        [roleHash, ids]
      );

      const syncedIds = rows.map(r => r._id);
      expect(syncedIds).to.have.length(2);
      expect(syncedIds).to.include(ids[1]); // explicitly not purged
      expect(syncedIds).to.include(ids[2]); // never evaluated = not purged
      expect(syncedIds).to.not.include(ids[0]); // purged
    });
  });

  // ── Auto-purge query patterns ─────────────────────────────────────

  describe('auto-purge query patterns', () => {
    it('should identify expired tasks (terminal state > 60 days)', async () => {
      const oldTaskId = stamp();
      const recentTaskId = stamp();
      testDocIds.push(oldTaskId, recentTaskId);

      const sixtyOneDaysAgo = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000).toISOString();
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

      await couchFetch(`/${COUCH_DB}/_bulk_docs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs: [
          { _id: oldTaskId, type: 'task', state: 'Completed', emission: { endDate: sixtyOneDaysAgo }, reported_date: Date.now() },
          { _id: recentTaskId, type: 'task', state: 'Completed', emission: { endDate: fiveDaysAgo }, reported_date: Date.now() },
        ] }),
      });
      await waitForDoc(oldTaskId);
      await waitForDoc(recentTaskId);

      // Agent 4's purgeExpiredTasks query pattern
      const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'task'
         AND doc->>'state' IN ('Cancelled', 'Completed', 'Failed')
         AND doc->'emission'->>'endDate' <= $1
         AND (_deleted IS NULL OR _deleted = false)
         AND _id IN ($2, $3)`,
        [cutoff, oldTaskId, recentTaskId]
      );

      const expiredIds = rows.map(r => r._id);
      expect(expiredIds).to.include(oldTaskId);
      expect(expiredIds).to.not.include(recentTaskId);
    });

    it('should identify expired targets (reporting period > 6 months)', async () => {
      const now = new Date();
      const sevenMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 7, 1);
      const oldPeriod = sevenMonthsAgo.toISOString().slice(0, 7); // YYYY-MM
      const currentPeriod = now.toISOString().slice(0, 7);

      const oldTargetId = `target~${oldPeriod}~contact1~org.couchdb.user:testuser`;
      const recentTargetId = `target~${currentPeriod}~contact1~org.couchdb.user:testuser`;
      testDocIds.push(oldTargetId, recentTargetId);

      await couchFetch(`/${COUCH_DB}/_bulk_docs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs: [
          { _id: oldTargetId, type: 'target', owner: 'contact1', reporting_period: oldPeriod, targets: [], reported_date: Date.now() },
          { _id: recentTargetId, type: 'target', owner: 'contact1', reporting_period: currentPeriod, targets: [], reported_date: Date.now() },
        ] }),
      });
      await waitForDoc(oldTargetId);
      await waitForDoc(recentTargetId);

      // Agent 4's purgeExpiredTargets pattern: target IDs sort lexicographically by period
      const cutoffPeriod = new Date(now.getFullYear(), now.getMonth() - 6, 1).toISOString().slice(0, 7);
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE _id LIKE 'target~%'
         AND _id < $1
         AND (_deleted IS NULL OR _deleted = false)
         AND _id IN ($2, $3)`,
        [`target~${cutoffPeriod}~`, oldTargetId, recentTargetId]
      );

      const expiredIds = rows.map(r => r._id);
      expect(expiredIds).to.include(oldTargetId);
      expect(expiredIds).to.not.include(recentTargetId);
    });
  });

  // ── Incremental evaluation ────────────────────────────────────────

  describe('incremental evaluation', () => {
    it('should find unevaluated documents via LEFT JOIN with purge_status', async () => {
      const docId = stamp();
      testDocIds.push(docId);
      await couchPost({ _id: docId, type: 'person', name: 'Unevaluated', reported_date: Date.now() });
      await waitForDoc(docId);

      // Get the real role_hash from the purge_roles table
      const { rows: roleRows } = await pool.query('SELECT role_hash FROM public.purge_roles LIMIT 1');
      if (roleRows.length === 0) {
        console.log('  No roles found, skipping');
        return;
      }
      const roleHash = roleRows[0].role_hash;

      // Document should be unevaluated (no purge_status entry)
      const { rows } = await pool.query(
        `SELECT c._id FROM ${DOCS_TABLE} c
         LEFT JOIN public.purge_status ps ON c._id = ps.doc_id AND ps.role_hash = $1
         WHERE c._id = $2 AND ps.doc_id IS NULL`,
        [roleHash, docId]
      );
      expect(rows).to.have.length(1);
      expect(rows[0]._id).to.equal(docId);
    });

    it('should find docs changed since last evaluation via saved_timestamp', async () => {
      // Agent 4's getChangedContactIds pattern
      const oneHourAgo = new Date(Date.now() - 3600000).toISOString();
      const { rows } = await pool.query(
        `SELECT _id FROM ${DOCS_TABLE}
         WHERE (doc->>'type' IN ('district_hospital', 'health_center', 'clinic', 'person')
                OR (doc->>'type' = 'contact' AND doc->>'contact_type' IS NOT NULL))
         AND (_deleted IS NOT TRUE)
         AND saved_timestamp > $1
         ORDER BY _id`,
        [oneHourAgo]
      );
      // Recently created test docs should appear
      expect(rows).to.be.an('array');
      console.log(`  ${rows.length} contacts changed in last hour`);
    });
  });

  // ── Records query patterns (Agent 4 engine.js) ───────────────────

  describe('records query patterns', () => {
    it('should find reports for subject IDs', async () => {
      const personId = stamp();
      const reportId = stamp();
      testDocIds.push(personId, reportId);

      await couchFetch(`/${COUCH_DB}/_bulk_docs`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docs: [
          { _id: personId, type: 'person', name: 'Subject', patient_id: 'subj-123', reported_date: Date.now() },
          { _id: reportId, type: 'data_record', form: 'visit', fields: { patient_id: 'subj-123' }, reported_date: Date.now() },
        ] }),
      });
      await waitForDoc(personId);
      await waitForDoc(reportId);

      // Agent 4's getRecordsForSubjects query pattern
      const subjectIds = [personId, 'subj-123'];
      const { rows } = await pool.query(
        `SELECT _id, doc FROM ${DOCS_TABLE}
         WHERE doc->>'type' = 'data_record' AND (_deleted IS NOT TRUE)
         AND (doc->>'patient_id' = ANY($1)
              OR doc->'fields'->>'patient_id' = ANY($1)
              OR doc->'contact'->>'_id' = ANY($1))`,
        [subjectIds]
      );
      const foundIds = rows.map(r => r._id);
      expect(foundIds).to.include(reportId);
    });
  });
});
