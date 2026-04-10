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
        const [url] = fetchStub.firstCall.args;
        expect(url).to.equal('http://localhost:5988/medic/api/v1/people');
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
  });
});
