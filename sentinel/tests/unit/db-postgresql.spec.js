const sinon = require('sinon');
const { expect } = require('chai');
const rewire = require('rewire');

describe('db-postgresql', () => {
  let dbPg;
  let mockPool;
  let mockClient;

  // Capture query calls for assertion
  const queryLog = [];

  beforeEach(() => {
    queryLog.length = 0;

    mockClient = {
      query: sinon.stub().callsFake(async (sql, params) => {
        queryLog.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }),
      release: sinon.stub(),
    };

    mockPool = {
      query: sinon.stub().callsFake(async (sql, params) => {
        queryLog.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }),
      connect: sinon.stub().resolves(mockClient),
      on: sinon.stub(),
    };

    // Set env before requiring module
    process.env.CHT_DB_BACKEND = 'postgresql';

    // Mock pg module
    const mockPg = { Pool: sinon.stub().returns(mockPool) };
    dbPg = rewire('../../src/db-postgresql');
    dbPg.__set__('pool', mockPool);
  });

  afterEach(() => {
    sinon.restore();
    delete process.env.CHT_DB_BACKEND;
  });

  describe('_rev optimistic locking', () => {

    describe('put', () => {

      it('inserts new doc without _rev using upsert', async () => {
        mockPool.query.resolves({ rows: [], rowCount: 1 });
        const doc = { _id: 'doc-1', type: 'data_record', form: 'pregnancy' };
        const result = await dbPg.medic.put(doc);

        expect(result.ok).to.equal(true);
        expect(result.id).to.equal('doc-1');
        expect(result.rev).to.match(/^1-pg/);

        // Should use ON CONFLICT upsert (no _rev check)
        const insertCall = mockPool.query.args.find(
          args => typeof args[0] === 'string' && args[0].includes('ON CONFLICT')
        );
        expect(insertCall).to.exist;
      });

      it('updates doc with matching _rev', async () => {
        // First query: UPDATE WHERE _rev matches → rowCount=1 (success)
        mockPool.query.resolves({ rows: [], rowCount: 1 });

        const doc = { _id: 'doc-1', _rev: '1-pgabc123', type: 'data_record' };
        const result = await dbPg.medic.put(doc);

        expect(result.ok).to.equal(true);
        expect(result.id).to.equal('doc-1');
        expect(result.rev).to.match(/^2-pg/);

        // Should include _rev check in WHERE clause
        const updateCall = mockPool.query.args.find(
          args => typeof args[0] === 'string' && args[0].includes("doc->>'_rev'")
        );
        expect(updateCall).to.exist;
      });

      it('throws 409 conflict when _rev does not match and doc exists', async () => {
        // First query: UPDATE WHERE _rev matches → rowCount=0 (mismatch)
        mockPool.query.onFirstCall().resolves({ rows: [], rowCount: 0 });
        // Second query: SELECT to check if doc exists → found with different rev
        mockPool.query.onSecondCall().resolves({
          rows: [{ current_rev: '2-pgother' }],
          rowCount: 1
        });

        const doc = { _id: 'doc-1', _rev: '1-pgstale', type: 'data_record' };
        try {
          await dbPg.medic.put(doc);
          expect.fail('should have thrown');
        } catch (err) {
          expect(err.status).to.equal(409);
          expect(err.name).to.equal('conflict');
          expect(err.docId).to.equal('doc-1');
        }
      });

      it('inserts when _rev provided but doc does not exist', async () => {
        // First query: UPDATE → rowCount=0
        mockPool.query.onFirstCall().resolves({ rows: [], rowCount: 0 });
        // Second query: SELECT existence check → not found
        mockPool.query.onSecondCall().resolves({ rows: [], rowCount: 0 });
        // Third query: INSERT
        mockPool.query.onThirdCall().resolves({ rows: [], rowCount: 1 });

        const doc = { _id: 'new-doc', _rev: '1-pgold', type: 'data_record' };
        const result = await dbPg.medic.put(doc);

        expect(result.ok).to.equal(true);
        expect(result.id).to.equal('new-doc');
        // Third call should be INSERT (not ON CONFLICT)
        const thirdSql = mockPool.query.args[2][0];
        expect(thirdSql).to.include('INSERT INTO');
        expect(thirdSql).to.not.include('ON CONFLICT');
      });

      it('handles deletion with _rev optimistic locking', async () => {
        // UPDATE with _rev check succeeds
        mockPool.query.resolves({ rows: [], rowCount: 1 });

        const doc = { _id: 'doc-1', _rev: '1-pgabc', _deleted: true };
        const result = await dbPg.medic.put(doc);

        expect(result.ok).to.equal(true);
        expect(result.rev).to.match(/^2-pg/);

        // Should check _rev in UPDATE
        const updateSql = mockPool.query.args[0][0];
        expect(updateSql).to.include("doc->>'_rev'");
        expect(updateSql).to.include('_deleted = true');
      });

      it('throws 409 on deletion with stale _rev', async () => {
        // UPDATE fails (rev mismatch)
        mockPool.query.onFirstCall().resolves({ rows: [], rowCount: 0 });
        // Doc exists with different rev
        mockPool.query.onSecondCall().resolves({
          rows: [{ current_rev: '3-pgnewer' }],
          rowCount: 1
        });

        const doc = { _id: 'doc-1', _rev: '1-pgold', _deleted: true };
        try {
          await dbPg.medic.put(doc);
          expect.fail('should have thrown');
        } catch (err) {
          expect(err.status).to.equal(409);
        }
      });

      it('deletes without _rev using upsert', async () => {
        mockPool.query.resolves({ rows: [], rowCount: 1 });

        const doc = { _id: 'doc-1', _deleted: true };
        const result = await dbPg.medic.put(doc);

        expect(result.ok).to.equal(true);
        const sql = mockPool.query.args[0][0];
        expect(sql).to.include('ON CONFLICT');
      });
    });

    describe('bulkDocs', () => {

      it('applies _rev check for docs with _rev', async () => {
        // BEGIN
        mockClient.query.onCall(0).resolves();
        // UPDATE with _rev check → success
        mockClient.query.onCall(1).resolves({ rows: [], rowCount: 1 });
        // COMMIT
        mockClient.query.onCall(2).resolves();

        const docs = [{ _id: 'doc-1', _rev: '1-pgabc', type: 'data_record' }];
        const results = await dbPg.medic.bulkDocs(docs);

        expect(results).to.have.lengthOf(1);
        expect(results[0].ok).to.equal(true);

        // Second call should be UPDATE with _rev check
        const updateSql = mockClient.query.args[1][0];
        expect(updateSql).to.include("doc->>'_rev'");
      });

      it('throws 409 and rolls back on conflict in batch', async () => {
        // BEGIN
        mockClient.query.onCall(0).resolves();
        // UPDATE with _rev → rowCount=0
        mockClient.query.onCall(1).resolves({ rows: [], rowCount: 0 });
        // SELECT existence → doc exists with different rev
        mockClient.query.onCall(2).resolves({
          rows: [{ current_rev: '2-pgother' }],
          rowCount: 1
        });
        // ROLLBACK
        mockClient.query.onCall(3).resolves();

        const docs = [{ _id: 'doc-1', _rev: '1-pgstale', type: 'data_record' }];
        try {
          await dbPg.medic.bulkDocs(docs);
          expect.fail('should have thrown');
        } catch (err) {
          expect(err.status).to.equal(409);
          // Should have rolled back
          const rollbackCall = mockClient.query.args.find(
            args => typeof args[0] === 'string' && args[0] === 'ROLLBACK'
          );
          expect(rollbackCall).to.exist;
        }
      });

      it('uses upsert for docs without _rev', async () => {
        // BEGIN
        mockClient.query.onCall(0).resolves();
        // INSERT ON CONFLICT → success
        mockClient.query.onCall(1).resolves({ rows: [], rowCount: 1 });
        // COMMIT
        mockClient.query.onCall(2).resolves();

        const docs = [{ _id: 'doc-new', type: 'data_record' }];
        const results = await dbPg.medic.bulkDocs(docs);

        expect(results).to.have.lengthOf(1);
        const insertSql = mockClient.query.args[1][0];
        expect(insertSql).to.include('ON CONFLICT');
      });
    });
  });

  describe('callback support', () => {

    it('put supports PouchDB-style callback on success', (done) => {
      mockPool.query.resolves({ rows: [], rowCount: 1 });

      const doc = { _id: 'doc-1', type: 'data_record' };
      dbPg.medic.put(doc, (err, result) => {
        expect(err).to.be.null;
        expect(result.ok).to.equal(true);
        expect(result.id).to.equal('doc-1');
        done();
      });
    });

    it('put supports PouchDB-style callback on error', (done) => {
      mockPool.query.rejects(new Error('connection lost'));

      const doc = { _id: 'doc-1', type: 'data_record' };
      dbPg.medic.put(doc, (err) => {
        expect(err).to.exist;
        expect(err.message).to.equal('connection lost');
        done();
      });
    });

    it('put returns promise when no callback', async () => {
      mockPool.query.resolves({ rows: [], rowCount: 1 });
      const doc = { _id: 'doc-1', type: 'data_record' };
      const result = await dbPg.medic.put(doc);
      expect(result.ok).to.equal(true);
    });

    it('get supports PouchDB-style callback on success', (done) => {
      const testDoc = { _id: 'doc-1', _rev: '1-abc', type: 'person' };
      mockPool.query.resolves({
        rows: [{ _id: 'doc-1', doc: testDoc, _deleted: false }],
        rowCount: 1
      });

      dbPg.medic.get('doc-1', (err, result) => {
        expect(err).to.be.null;
        expect(result._id).to.equal('doc-1');
        expect(result.type).to.equal('person');
        done();
      });
    });

    it('get supports PouchDB-style callback on 404', (done) => {
      mockPool.query.resolves({ rows: [], rowCount: 0 });

      dbPg.medic.get('missing-doc', (err) => {
        expect(err).to.exist;
        expect(err.status).to.equal(404);
        done();
      });
    });

    it('put calls callback with 409 conflict error', (done) => {
      // UPDATE fails
      mockPool.query.onFirstCall().resolves({ rows: [], rowCount: 0 });
      // Doc exists with different rev
      mockPool.query.onSecondCall().resolves({
        rows: [{ current_rev: '2-pgother' }],
        rowCount: 1
      });

      const doc = { _id: 'doc-1', _rev: '1-pgstale', type: 'data_record' };
      dbPg.medic.put(doc, (err) => {
        expect(err).to.exist;
        expect(err.status).to.equal(409);
        expect(err.name).to.equal('conflict');
        done();
      });
    });
  });

  describe('revision generation', () => {

    it('generates rev starting at 1 for new docs', async () => {
      mockPool.query.resolves({ rows: [], rowCount: 1 });
      const result = await dbPg.medic.put({ _id: 'new', type: 'test' });
      expect(result.rev).to.match(/^1-pg[a-z0-9]+$/);
    });

    it('increments rev number from existing rev', async () => {
      mockPool.query.resolves({ rows: [], rowCount: 1 });
      const result = await dbPg.medic.put({ _id: 'doc', _rev: '3-pgabc123', type: 'test' });
      expect(result.rev).to.match(/^4-pg[a-z0-9]+$/);
    });
  });

  describe('data-context', () => {

    it('exports getPostgresDataContext in PG mode', () => {
      // data-context.js should use getPostgresDataContext when CHT_DB_BACKEND=postgresql
      process.env.CHT_DB_BACKEND = 'postgresql';
      // Just verify the module can be required without error
      // (actual PostgreSQL connection is mocked at the pool level)
      expect(dbPg._pool).to.exist;
    });
  });
});
