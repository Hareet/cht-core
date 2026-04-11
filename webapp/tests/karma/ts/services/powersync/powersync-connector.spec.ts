import sinon from 'sinon';
import { expect } from 'chai';

import { ChtPowerSyncConnector } from '@mm-services/powersync/powersync-connector';

describe('PowerSync Connector', () => {
  let connector: ChtPowerSyncConnector;
  let fetchStub: sinon.SinonStub;

  beforeEach(() => {
    connector = new ChtPowerSyncConnector({
      apiBaseUrl: 'http://localhost:5988/medic',
      powerSyncUrl: 'http://localhost:8080',
    });

    fetchStub = sinon.stub(globalThis, 'fetch');
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('fetchCredentials', () => {
    it('should fetch JWT token from CHT API', async () => {
      const mockToken = {
        token: 'jwt-token-123',
        expiresAt: '2026-04-08T00:00:00Z',
      };

      fetchStub.resolves(new Response(JSON.stringify(mockToken), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      const credentials = await connector.fetchCredentials();

      expect(credentials.endpoint).to.equal('http://localhost:8080');
      expect(credentials.token).to.equal('jwt-token-123');
      expect(credentials.expiresAt).to.be.an.instanceOf(Date);

      expect(fetchStub.calledOnce).to.be.true;
      const [url, opts] = fetchStub.firstCall.args;
      expect(url).to.equal('http://localhost:5988/medic/api/v1/powersync-token');
      expect(opts.credentials).to.equal('same-origin');
    });

    it('should throw on non-OK response', async () => {
      fetchStub.resolves(new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }));

      try {
        await connector.fetchCredentials();
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('401');
        expect(err.message).to.include('Unauthorized');
      }
    });

    it('should handle missing expiresAt', async () => {
      fetchStub.resolves(new Response(JSON.stringify({ token: 'abc' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

      const credentials = await connector.fetchCredentials();
      expect(credentials.token).to.equal('abc');
      expect(credentials.expiresAt).to.be.undefined;
    });

    it('should throw on network error', async () => {
      fetchStub.rejects(new TypeError('Failed to fetch'));

      try {
        await connector.fetchCredentials();
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('Failed to fetch');
      }
    });
  });

  describe('uploadData', () => {
    let mockDb: any;

    const createMockTransaction = (crud: any[]) => ({
      crud,
      complete: sinon.stub().resolves(),
    });

    beforeEach(() => {
      mockDb = {
        getNextCrudTransaction: sinon.stub(),
        execute: sinon.stub().resolves(),
      };
    });

    it('should no-op when no pending transactions', async () => {
      mockDb.getNextCrudTransaction.resolves(null);

      await connector.uploadData(mockDb);
      expect(fetchStub.called).to.be.false;
    });

    // -------------------------------------------------------------------------
    // PUT operations
    // -------------------------------------------------------------------------
    describe('PUT operations', () => {
      describe('contact routing: persons vs places', () => {
        it('should route person contacts to /api/v1/people', async () => {
          const tx = createMockTransaction([{
            op: 'PUT',
            table: 'contacts',
            id: 'person-1',
            opData: { name: 'John', contact_type: 'person' },
          }]);
          mockDb.getNextCrudTransaction.resolves(tx);
          fetchStub.resolves(new Response('{}', { status: 200 }));

          await connector.uploadData(mockDb);

          expect(fetchStub.calledOnce).to.be.true;
          const [url, opts] = fetchStub.firstCall.args;
          expect(url).to.equal('http://localhost:5988/medic/api/v1/people');
          expect(opts.method).to.equal('POST');
          expect(tx.complete.calledOnce).to.be.true;
        });

        it('should route clinic contacts to /api/v1/places', async () => {
          const tx = createMockTransaction([{
            op: 'PUT',
            table: 'contacts',
            id: 'clinic-1',
            opData: { name: 'Test Clinic', contact_type: 'clinic' },
          }]);
          mockDb.getNextCrudTransaction.resolves(tx);
          fetchStub.resolves(new Response('{}', { status: 200 }));

          await connector.uploadData(mockDb);

          expect(fetchStub.calledOnce).to.be.true;
          const [url] = fetchStub.firstCall.args;
          expect(url).to.equal('http://localhost:5988/medic/api/v1/places');
        });

        it('should route health_center contacts to /api/v1/places', async () => {
          const tx = createMockTransaction([{
            op: 'PUT',
            table: 'contacts',
            id: 'hc-1',
            opData: { name: 'Health Center', contact_type: 'health_center' },
          }]);
          mockDb.getNextCrudTransaction.resolves(tx);
          fetchStub.resolves(new Response('{}', { status: 200 }));

          await connector.uploadData(mockDb);

          const [url] = fetchStub.firstCall.args;
          expect(url).to.equal('http://localhost:5988/medic/api/v1/places');
        });

        it('should fall back to type field when contact_type is missing (pre-v3.7)', async () => {
          const tx = createMockTransaction([{
            op: 'PUT',
            table: 'contacts',
            id: 'person-1',
            opData: { name: 'Old Person', type: 'person' },
          }]);
          mockDb.getNextCrudTransaction.resolves(tx);
          fetchStub.resolves(new Response('{}', { status: 200 }));

          await connector.uploadData(mockDb);

          const [url] = fetchStub.firstCall.args;
          expect(url).to.equal('http://localhost:5988/medic/api/v1/people');
        });

        it('should default to /api/v1/places for unknown contact types', async () => {
          const tx = createMockTransaction([{
            op: 'PUT',
            table: 'contacts',
            id: 'custom-1',
            opData: { name: 'Custom Place', contact_type: 'custom_facility' },
          }]);
          mockDb.getNextCrudTransaction.resolves(tx);
          fetchStub.resolves(new Response('{}', { status: 200 }));

          await connector.uploadData(mockDb);

          const [url] = fetchStub.firstCall.args;
          expect(url).to.equal('http://localhost:5988/medic/api/v1/places');
        });
      });

      it('should upload reports to /api/v1/records', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'reports',
          id: 'report-1',
          opData: { form: 'pregnancy', fields: '{"patient_name":"Jane"}' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        const [url] = fetchStub.firstCall.args;
        expect(url).to.equal('http://localhost:5988/medic/api/v1/records');
        expect(tx.complete.calledOnce).to.be.true;
      });

      it('should upload feedback to /api/v1/feedback', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'feedback',
          id: 'fb-1',
          opData: { type: 'bug', message: 'Something broke', info: '{"url":"/contacts"}' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        const [url, opts] = fetchStub.firstCall.args;
        expect(url).to.equal('http://localhost:5988/medic/api/v1/feedback');
        expect(opts.method).to.equal('POST');
      });

      it('should include id in request body', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'contacts',
          id: 'person-1',
          opData: { name: 'John', contact_type: 'person' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        const body = JSON.parse(fetchStub.firstCall.args[1].body);
        expect(body.id).to.equal('person-1');
        expect(body.name).to.equal('John');
      });
    });

    // -------------------------------------------------------------------------
    // PATCH operations
    // -------------------------------------------------------------------------
    describe('PATCH operations', () => {
      it('should send PUT request to URL with id appended', async () => {
        const tx = createMockTransaction([{
          op: 'PATCH',
          table: 'contacts',
          id: 'person-1',
          opData: { name: 'Updated Name', contact_type: 'person' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        expect(fetchStub.calledOnce).to.be.true;
        const [url, opts] = fetchStub.firstCall.args;
        expect(url).to.equal('http://localhost:5988/medic/api/v1/people/person-1');
        expect(opts.method).to.equal('PUT');
        expect(tx.complete.calledOnce).to.be.true;
      });

      it('should send correct body for PATCH', async () => {
        const tx = createMockTransaction([{
          op: 'PATCH',
          table: 'reports',
          id: 'report-1',
          opData: { form: 'visit', verified: 1 },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        const [url, opts] = fetchStub.firstCall.args;
        expect(url).to.equal('http://localhost:5988/medic/api/v1/records/report-1');
        expect(opts.method).to.equal('PUT');

        const body = JSON.parse(opts.body);
        expect(body.id).to.equal('report-1');
        expect(body.verified).to.equal(true); // converted from integer
      });

      it('should route PATCH for places to /api/v1/places', async () => {
        const tx = createMockTransaction([{
          op: 'PATCH',
          table: 'contacts',
          id: 'clinic-1',
          opData: { name: 'Updated Clinic', contact_type: 'clinic' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        const [url] = fetchStub.firstCall.args;
        expect(url).to.equal('http://localhost:5988/medic/api/v1/places/clinic-1');
      });
    });

    // -------------------------------------------------------------------------
    // DELETE operations
    // -------------------------------------------------------------------------
    describe('DELETE operations', () => {
      it('should send DELETE request to URL with id appended', async () => {
        const tx = createMockTransaction([{
          op: 'DELETE',
          table: 'contacts',
          id: 'person-1',
          opData: { contact_type: 'person' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        expect(fetchStub.calledOnce).to.be.true;
        const [url, opts] = fetchStub.firstCall.args;
        expect(url).to.equal('http://localhost:5988/medic/api/v1/people/person-1');
        expect(opts.method).to.equal('DELETE');
        expect(tx.complete.calledOnce).to.be.true;
      });

      it('should not send a request body for DELETE', async () => {
        const tx = createMockTransaction([{
          op: 'DELETE',
          table: 'reports',
          id: 'report-1',
          opData: {},
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        const [url, opts] = fetchStub.firstCall.args;
        expect(url).to.equal('http://localhost:5988/medic/api/v1/records/report-1');
        expect(opts.method).to.equal('DELETE');
        expect(opts.body).to.be.undefined;
      });

      it('should route DELETE for places correctly', async () => {
        const tx = createMockTransaction([{
          op: 'DELETE',
          table: 'contacts',
          id: 'clinic-1',
          opData: { contact_type: 'clinic' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        const [url] = fetchStub.firstCall.args;
        expect(url).to.equal('http://localhost:5988/medic/api/v1/places/clinic-1');
      });
    });

    // -------------------------------------------------------------------------
    // Skipped tables (no upload endpoint)
    // -------------------------------------------------------------------------
    describe('skipped tables', () => {
      it('should skip tasks (no upload endpoint - rules engine generated)', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'tasks',
          id: 'task-1',
          opData: { state: 'Ready', owner: 'contact-1' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);

        await connector.uploadData(mockDb);

        expect(fetchStub.called).to.be.false;
        expect(tx.complete.calledOnce).to.be.true;
      });

      it('should skip targets (no upload endpoint - rules engine generated)', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'targets',
          id: 'target-1',
          opData: { owner: 'contact-1' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);

        await connector.uploadData(mockDb);

        expect(fetchStub.called).to.be.false;
        expect(tx.complete.calledOnce).to.be.true;
      });

      it('should skip settings (read-only on client)', async () => {
        const tx = createMockTransaction([{
          op: 'PATCH',
          table: 'settings',
          id: 'settings',
          opData: { doc: '{}' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);

        await connector.uploadData(mockDb);

        expect(fetchStub.called).to.be.false;
        expect(tx.complete.calledOnce).to.be.true;
      });

      it('should skip telemetry (local-only)', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'telemetry',
          id: 'telem-1',
          opData: { metrics: '{}' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);

        await connector.uploadData(mockDb);

        expect(fetchStub.called).to.be.false;
        expect(tx.complete.calledOnce).to.be.true;
      });

      it('should skip read_status (local-only)', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'read_status',
          id: 'rs-1',
          opData: { doc_id: 'report-1', doc_type: 'report' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);

        await connector.uploadData(mockDb);

        expect(fetchStub.called).to.be.false;
        expect(tx.complete.calledOnce).to.be.true;
      });

      it('should skip unknown tables', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'unknown_table',
          id: 'u-1',
          opData: { data: 'test' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);

        await connector.uploadData(mockDb);

        expect(fetchStub.called).to.be.false;
        expect(tx.complete.calledOnce).to.be.true;
      });
    });

    // -------------------------------------------------------------------------
    // Error handling
    // -------------------------------------------------------------------------
    describe('error handling', () => {
      it('should throw on 5xx errors to trigger retry', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'contacts',
          id: 'contact-1',
          opData: { name: 'John', contact_type: 'person' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('Internal Server Error', { status: 500 }));

        try {
          await connector.uploadData(mockDb);
          expect.fail('should have thrown');
        } catch (err: any) {
          expect(err.message).to.include('500');
        }

        expect(tx.complete.called).to.be.false;
      });

      it('should throw on 502 Bad Gateway', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'contacts',
          id: 'c1',
          opData: { name: 'John', contact_type: 'person' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('Bad Gateway', { status: 502 }));

        try {
          await connector.uploadData(mockDb);
          expect.fail('should have thrown');
        } catch (err: any) {
          expect(err.message).to.include('502');
        }

        expect(tx.complete.called).to.be.false;
      });

      it('should log 4xx validation errors without blocking queue', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'contacts',
          id: 'contact-1',
          opData: { name: 'John', contact_type: 'person' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('Bad Request', { status: 400 }));

        await connector.uploadData(mockDb);

        expect(mockDb.execute.calledOnce).to.be.true;
        const [sql, params] = mockDb.execute.firstCall.args;
        expect(sql).to.include('INSERT INTO feedback');
        expect(params).to.include('upload_error');
        expect(tx.complete.calledOnce).to.be.true;
      });

      it('should include operation details in feedback entry', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'reports',
          id: 'r1',
          opData: { form: 'visit' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('Invalid form', { status: 422 }));

        await connector.uploadData(mockDb);

        const [, params] = mockDb.execute.firstCall.args;
        const infoJson = JSON.parse(params[2]); // info is the 3rd parameter
        expect(infoJson.table).to.equal('reports');
        expect(infoJson.id).to.equal('r1');
        expect(infoJson.error).to.include('Invalid form');
      });

      it('should not throw when feedback table write fails', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'contacts',
          id: 'c1',
          opData: { name: 'John', contact_type: 'person' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('Bad Request', { status: 400 }));
        mockDb.execute.rejects(new Error('SQLite table full'));

        // Should not throw despite feedback write failure
        await connector.uploadData(mockDb);

        expect(tx.complete.calledOnce).to.be.true;
      });

      it('should throw on network error (fetch rejects) to trigger retry', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'contacts',
          id: 'person-1',
          opData: { name: 'John', contact_type: 'person' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.rejects(new TypeError('Failed to fetch'));

        try {
          await connector.uploadData(mockDb);
          expect.fail('should have thrown');
        } catch (err: any) {
          expect(err.message).to.include('Failed to fetch');
        }

        expect(tx.complete.called).to.be.false;
      });

      it('should not call complete when 5xx occurs mid-transaction', async () => {
        const tx = createMockTransaction([
          { op: 'PUT', table: 'contacts', id: 'c1', opData: { name: 'A', contact_type: 'person' } },
          { op: 'PUT', table: 'contacts', id: 'c2', opData: { name: 'B', contact_type: 'person' } },
        ]);
        mockDb.getNextCrudTransaction.resolves(tx);
        // First call succeeds, second fails with 500
        fetchStub.onFirstCall().resolves(new Response('{}', { status: 200 }));
        fetchStub.onSecondCall().resolves(new Response('Server Error', { status: 500 }));

        try {
          await connector.uploadData(mockDb);
          expect.fail('should have thrown');
        } catch (err: any) {
          expect(err.message).to.include('500');
        }

        // Transaction should not be completed since second op failed
        expect(tx.complete.called).to.be.false;
      });
    });

    // -------------------------------------------------------------------------
    // Multi-operation transactions
    // -------------------------------------------------------------------------
    describe('multi-operation transactions', () => {
      it('should handle multiple operations in a transaction', async () => {
        const tx = createMockTransaction([
          { op: 'PUT', table: 'contacts', id: 'c1', opData: { name: 'A', contact_type: 'person' } },
          { op: 'PUT', table: 'reports', id: 'r1', opData: { form: 'visit' } },
        ]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        expect(fetchStub.callCount).to.equal(2);
        expect(fetchStub.firstCall.args[0]).to.include('/people');
        expect(fetchStub.secondCall.args[0]).to.include('/records');
        expect(tx.complete.calledOnce).to.be.true;
      });

      it('should handle mixed uploadable and skipped ops in one transaction', async () => {
        const tx = createMockTransaction([
          { op: 'PUT', table: 'contacts', id: 'c1', opData: { name: 'A', contact_type: 'person' } },
          { op: 'PUT', table: 'tasks', id: 't1', opData: { state: 'Ready' } },
          { op: 'PUT', table: 'reports', id: 'r1', opData: { form: 'visit' } },
        ]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        // Only contacts and reports should trigger fetch; tasks skipped
        expect(fetchStub.callCount).to.equal(2);
        expect(tx.complete.calledOnce).to.be.true;
      });

      it('should complete transaction when all ops are skipped', async () => {
        const tx = createMockTransaction([
          { op: 'PUT', table: 'tasks', id: 't1', opData: { state: 'Ready' } },
          { op: 'PUT', table: 'targets', id: 'tgt1', opData: { owner: 'c1' } },
        ]);
        mockDb.getNextCrudTransaction.resolves(tx);

        await connector.uploadData(mockDb);

        expect(fetchStub.called).to.be.false;
        expect(tx.complete.calledOnce).to.be.true;
      });
    });

    // -------------------------------------------------------------------------
    // Data transformation
    // -------------------------------------------------------------------------
    describe('data transformation', () => {
      it('should parse JSON fields when transforming for API', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'contacts',
          id: 'c1',
          opData: {
            name: 'John',
            contact_type: 'person',
            parent: '{"_id":"parent-1","type":"clinic"}',
            geolocation: '{"latitude":1.5,"longitude":36.8}',
          },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        const body = JSON.parse(fetchStub.firstCall.args[1].body);
        expect(body.parent).to.deep.equal({ _id: 'parent-1', type: 'clinic' });
        expect(body.geolocation).to.deep.equal({ latitude: 1.5, longitude: 36.8 });
      });

      it('should keep invalid JSON as string', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'contacts',
          id: 'c1',
          opData: {
            name: 'John',
            contact_type: 'person',
            parent: 'not-valid-json',
          },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        const body = JSON.parse(fetchStub.firstCall.args[1].body);
        expect(body.parent).to.equal('not-valid-json');
      });

      it('should convert integer booleans for reports', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'reports',
          id: 'r1',
          opData: {
            form: 'visit',
            verified: 1,
            is_private: 0,
            needs_signoff: 1,
          },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        const body = JSON.parse(fetchStub.firstCall.args[1].body);
        expect(body.verified).to.equal(true);
        expect(body.is_private).to.equal(false);
        expect(body.needs_signoff).to.equal(true);
      });

      it('should parse report fields JSON', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'reports',
          id: 'r1',
          opData: {
            form: 'pregnancy',
            fields: '{"patient_name":"Jane","edd":"2026-12-01"}',
            geolocation: '{"latitude":-1.2,"longitude":36.8}',
          },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        const body = JSON.parse(fetchStub.firstCall.args[1].body);
        expect(body.fields).to.deep.equal({ patient_name: 'Jane', edd: '2026-12-01' });
        expect(body.geolocation).to.deep.equal({ latitude: -1.2, longitude: 36.8 });
      });

      it('should parse task JSON fields', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'feedback',
          id: 'fb-1',
          opData: {
            type: 'bug',
            message: 'Error occurred',
            info: '{"url":"/contacts","stack":"Error at line 42"}',
          },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        const body = JSON.parse(fetchStub.firstCall.args[1].body);
        expect(body.info).to.deep.equal({ url: '/contacts', stack: 'Error at line 42' });
      });

      it('should not convert booleans for non-report tables', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'contacts',
          id: 'c1',
          opData: {
            name: 'John',
            contact_type: 'person',
            verified: 1, // This is not a boolean field on contacts
          },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        const body = JSON.parse(fetchStub.firstCall.args[1].body);
        // Should remain as integer since contacts don't have boolean conversions
        expect(body.verified).to.equal(1);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Fetch timeout
  // ---------------------------------------------------------------------------
  describe('fetch timeout', () => {
    let mockDb: any;

    const createMockTransaction = (crud: any[]) => ({
      crud,
      complete: sinon.stub().resolves(),
    });

    beforeEach(() => {
      mockDb = {
        getNextCrudTransaction: sinon.stub(),
        execute: sinon.stub().resolves(),
      };
    });

    /**
     * Helper: creates a fetch stub that respects the AbortSignal on the request.
     * The fetch never resolves on its own — it only settles when the signal aborts.
     * This simulates a hung server that accepts the connection but never responds.
     */
    function stubHungFetch() {
      fetchStub.callsFake((_url: string, init: any) => {
        return new Promise((_resolve, reject) => {
          if (init?.signal) {
            if (init.signal.aborted) {
              reject(init.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
              return;
            }
            init.signal.addEventListener('abort', () => {
              reject(init.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
            });
          }
          // Never resolves — simulates a hung server
        });
      });
    }

    describe('signal presence', () => {
      it('should pass AbortSignal to credential fetch', async () => {
        fetchStub.resolves(new Response(JSON.stringify({ token: 'test' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));

        await connector.fetchCredentials();

        const [, opts] = fetchStub.firstCall.args;
        expect(opts.signal).to.be.instanceOf(AbortSignal);
      });

      it('should pass AbortSignal to PUT upload fetch', async () => {
        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'contacts',
          id: 'c1',
          opData: { name: 'John', contact_type: 'person' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        const [, opts] = fetchStub.firstCall.args;
        expect(opts.signal).to.be.instanceOf(AbortSignal);
      });

      it('should pass AbortSignal to PATCH upload fetch', async () => {
        const tx = createMockTransaction([{
          op: 'PATCH',
          table: 'contacts',
          id: 'c1',
          opData: { name: 'Updated', contact_type: 'person' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        const [, opts] = fetchStub.firstCall.args;
        expect(opts.signal).to.be.instanceOf(AbortSignal);
      });

      it('should pass AbortSignal to DELETE upload fetch', async () => {
        const tx = createMockTransaction([{
          op: 'DELETE',
          table: 'contacts',
          id: 'c1',
          opData: { contact_type: 'person' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        fetchStub.resolves(new Response('{}', { status: 200 }));

        await connector.uploadData(mockDb);

        const [, opts] = fetchStub.firstCall.args;
        expect(opts.signal).to.be.instanceOf(AbortSignal);
      });
    });

    describe('timeout behavior', () => {
      it('should reject credentials fetch when request times out', async () => {
        const shortTimeout = new ChtPowerSyncConnector({
          apiBaseUrl: 'http://localhost:5988/medic',
          powerSyncUrl: 'http://localhost:8080',
          fetchTimeoutMs: 50,
        });
        stubHungFetch();

        try {
          await shortTimeout.fetchCredentials();
          expect.fail('should have thrown');
        } catch (err: any) {
          expect(err.name).to.equal('TimeoutError');
        }
      });

      it('should reject upload when request times out', async () => {
        const shortTimeout = new ChtPowerSyncConnector({
          apiBaseUrl: 'http://localhost:5988/medic',
          powerSyncUrl: 'http://localhost:8080',
          fetchTimeoutMs: 50,
        });

        const tx = createMockTransaction([{
          op: 'PUT',
          table: 'contacts',
          id: 'c1',
          opData: { name: 'John', contact_type: 'person' },
        }]);
        mockDb.getNextCrudTransaction.resolves(tx);
        stubHungFetch();

        try {
          await shortTimeout.uploadData(mockDb);
          expect.fail('should have thrown');
        } catch (err: any) {
          expect(err.name).to.equal('TimeoutError');
        }

        // Transaction should NOT be completed on timeout — triggers PowerSync retry
        expect(tx.complete.called).to.be.false;
      });

      it('should not complete transaction when second op in batch times out', async () => {
        const shortTimeout = new ChtPowerSyncConnector({
          apiBaseUrl: 'http://localhost:5988/medic',
          powerSyncUrl: 'http://localhost:8080',
          fetchTimeoutMs: 50,
        });

        const tx = createMockTransaction([
          { op: 'PUT', table: 'contacts', id: 'c1', opData: { name: 'A', contact_type: 'person' } },
          { op: 'PUT', table: 'contacts', id: 'c2', opData: { name: 'B', contact_type: 'person' } },
        ]);
        mockDb.getNextCrudTransaction.resolves(tx);

        // First call succeeds, second hangs until timeout
        fetchStub.onFirstCall().resolves(new Response('{}', { status: 200 }));
        fetchStub.onSecondCall().callsFake((_url: string, init: any) => {
          return new Promise((_resolve, reject) => {
            if (init?.signal) {
              init.signal.addEventListener('abort', () => {
                reject(init.signal.reason ?? new DOMException('Aborted', 'AbortError'));
              });
            }
          });
        });

        try {
          await shortTimeout.uploadData(mockDb);
          expect.fail('should have thrown');
        } catch (err: any) {
          // Timeout on second op
          expect(err).to.be.instanceOf(DOMException);
        }

        expect(tx.complete.called).to.be.false;
      });

      it('should use custom fetchTimeoutMs when provided', async () => {
        const customTimeout = new ChtPowerSyncConnector({
          apiBaseUrl: 'http://localhost:5988/medic',
          powerSyncUrl: 'http://localhost:8080',
          fetchTimeoutMs: 5000,
        });

        fetchStub.resolves(new Response(JSON.stringify({ token: 'test' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));

        await customTimeout.fetchCredentials();

        // Signal should be present (we can't directly read the timeout value
        // from the signal, but we verify it's there)
        const [, opts] = fetchStub.firstCall.args;
        expect(opts.signal).to.be.instanceOf(AbortSignal);
        expect(opts.signal.aborted).to.be.false;
      });

      it('should use default timeout when fetchTimeoutMs is not configured', async () => {
        // connector uses default config (no fetchTimeoutMs)
        fetchStub.resolves(new Response(JSON.stringify({ token: 'test' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));

        await connector.fetchCredentials();

        const [, opts] = fetchStub.firstCall.args;
        expect(opts.signal).to.be.instanceOf(AbortSignal);
        expect(opts.signal.aborted).to.be.false;
      });
    });
  });
});
