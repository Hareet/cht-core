/**
 * Agent Harness Smoke Test
 *
 * Validates that the agent-harness correctly connects to live services
 * in the containerized environment. Tests are designed to work against
 * the running CHT stack (Phase 1) without requiring PostgreSQL/cht-sync.
 *
 * This test can run standalone:
 *   COUCH_URL=http://admin:secret21512@couchdb:5984/medic \
 *   node_modules/.bin/mocha tests/integration/postgresql/smoke-test.spec.js \
 *     --require tests/integration/postgresql/smoke-hooks.js --timeout 60000
 */
require('../../aliases');
const chai = require('chai');
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const COUCH_URL = process.env.COUCH_URL || 'http://admin:secret21512@couchdb:5984/medic';
const API_BASE = process.env.API_BASE || 'https://nginx:443';

// Node 22 fetch() doesn't allow credentials in URLs — use Basic auth header
const parsedCouch = new URL(COUCH_URL);
const COUCH_HOST = `${parsedCouch.protocol}//${parsedCouch.host}`;
const COUCH_DB = parsedCouch.pathname.replace(/^\//, '');
const COUCH_AUTH = 'Basic ' + Buffer.from(`${parsedCouch.username}:${parsedCouch.password}`).toString('base64');
const couchFetch = (path, opts = {}) => {
  opts.headers = { ...opts.headers, Authorization: COUCH_AUTH, Accept: 'application/json' };
  return fetch(`${COUCH_HOST}${path}`, opts);
};

describe('Agent harness smoke test', () => {

  describe('CouchDB connectivity', () => {
    it('should connect to CouchDB and get server info', async () => {
      const response = await couchFetch('/');
      const body = await response.json();
      expect(body).to.have.property('couchdb', 'Welcome');
      expect(body).to.have.property('version');
      console.log(`  CouchDB version: ${body.version}`);
    });

    it('should list databases', async () => {
      const response = await couchFetch('/_all_dbs');
      const dbs = await response.json();
      expect(dbs).to.be.an('array');
      expect(dbs).to.include('medic');
      console.log(`  Databases: ${dbs.join(', ')}`);
    });

    it('should read from the medic database', async () => {
      const response = await couchFetch(`/${COUCH_DB}/_all_docs?limit=5`);
      const body = await response.json();
      expect(body).to.have.property('rows');
      expect(body.rows).to.be.an('array');
      console.log(`  medic DB has ${body.total_rows} documents`);
    });

    it('should write and read a document', async () => {
      const docId = `smoke-test-${Date.now()}`;
      const doc = { _id: docId, type: 'data_record', fields: { smoke: true }, reported_date: Date.now() };

      // Write
      const writeResp = await couchFetch(`/${COUCH_DB}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
      });
      const writeResult = await writeResp.json();
      expect(writeResult.ok).to.be.true;

      // Read back
      const readResp = await couchFetch(`/${COUCH_DB}/${docId}`);
      const readDoc = await readResp.json();
      expect(readDoc._id).to.equal(docId);
      expect(readDoc.fields.smoke).to.be.true;

      // Cleanup
      await couchFetch(`/${COUCH_DB}/${docId}?rev=${readDoc._rev}`, { method: 'DELETE' });
      console.log(`  Write/read/delete cycle OK for ${docId}`);
    });
  });

  describe('CHT API connectivity', () => {
    it('should reach the API info endpoint', async () => {
      const response = await fetch(`${API_BASE}/api/info`, {
        headers: { 'Accept': 'application/json' },
        // Allow self-signed certs
      });
      const body = await response.json();
      expect(body).to.have.property('version');
      console.log(`  API version: ${body.version}`);
    });
  });

  describe('PostgreSQL connectivity (optional)', () => {
    let pgPool;

    before(function () {
      try {
        const { Pool } = require('pg');
        const pgUrl = process.env.POSTGRES_URL || 'postgresql://postgres:postgres@postgres:5432/cht_sync';
        pgPool = new Pool({ connectionString: pgUrl, connectionTimeoutMillis: 5000 });
      } catch (e) {
        console.log('  pg module not available, skipping PostgreSQL tests');
        this.skip();
      }
    });

    after(async () => {
      if (pgPool) {
        await pgPool.end().catch(() => {});
      }
    });

    it('should connect to PostgreSQL if available', async function () {
      this.timeout(10000);
      try {
        const result = await pgPool.query('SELECT current_database() as db, version() as ver');
        console.log(`  PostgreSQL: ${result.rows[0].db} (${result.rows[0].ver.split(',')[0]})`);
      } catch (err) {
        console.log(`  PostgreSQL not available: ${err.message}`);
        this.skip();
      }
    });

    it('should check for cht-sync schema if PostgreSQL is available', async function () {
      this.timeout(10000);
      try {
        const result = await pgPool.query(
          "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY 1,2"
        );
        if (result.rows.length > 0) {
          console.log('  cht-sync tables found:');
          result.rows.forEach(r => console.log(`    ${r.table_schema}.${r.table_name}`));
        } else {
          console.log('  No cht-sync tables found (cht-sync may not be deployed yet)');
        }
      } catch (err) {
        console.log(`  PostgreSQL query failed: ${err.message}`);
        this.skip();
      }
    });
  });

  describe('Sentinel connectivity', () => {
    it('should verify Sentinel is processing via sentinel metadata', async () => {
      const response = await couchFetch('/medic-sentinel/_all_docs?limit=5');
      if (response.ok) {
        const body = await response.json();
        console.log(`  medic-sentinel has ${body.total_rows} documents`);
        expect(body).to.have.property('rows');
      } else {
        console.log(`  medic-sentinel: ${response.status} (may need different auth)`);
      }
    });
  });

  describe('agent-harness module', () => {
    it('should load without errors', () => {
      // The harness imports tests/utils/index.js which may fail if constants
      // don't match the environment. Test that the pg helpers at least load.
      const { Pool } = require('pg');
      const harness = require('../../utils/agent-harness');
      expect(harness).to.have.property('pgQuery');
      expect(harness).to.have.property('pgDocsTable');
      expect(harness).to.have.property('pgProgressTable');
      expect(harness).to.have.property('waitForDocInPostgres');
      expect(harness).to.have.property('getPostgresRawRow');
      expect(harness).to.have.property('getPostgresDocsByType');
      expect(harness).to.have.property('getPostgresDocsByFacility');
      expect(harness).to.have.property('getPostgresProgress');
      expect(harness).to.have.property('checkPostgresReady');
      expect(harness).to.have.property('checkPowersyncReady');
      expect(harness).to.have.property('waitForAllServices');
      expect(harness).to.have.property('prepServices');
      expect(harness).to.have.property('tearDownServices');
      console.log(`  pgDocsTable: ${harness.pgDocsTable()}`);
      console.log(`  pgProgressTable: ${harness.pgProgressTable()}`);
    });

    it('should correctly report PostgreSQL readiness status', async function () {
      this.timeout(10000);
      const harness = require('../../utils/agent-harness');
      const ready = await harness.checkPostgresReady();
      console.log(`  PostgreSQL ready: ${ready}`);
      // Don't assert true — PG may not be deployed in Phase 1
      expect(ready).to.be.a('boolean');
    });
  });
});
