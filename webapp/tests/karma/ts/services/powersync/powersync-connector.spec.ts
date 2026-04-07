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

    it('should upload PUT operations as POST requests', async () => {
      const tx = createMockTransaction([{
        op: 'PUT',
        table: 'contacts',
        id: 'contact-1',
        opData: { name: 'John', type: 'person' },
      }]);
      mockDb.getNextCrudTransaction.resolves(tx);

      fetchStub.resolves(new Response('{}', { status: 200 }));

      await connector.uploadData(mockDb);

      expect(fetchStub.calledOnce).to.be.true;
      const [url, opts] = fetchStub.firstCall.args;
      expect(url).to.equal('http://localhost:5988/medic/api/v1/people');
      expect(opts.method).to.equal('POST');
      expect(JSON.parse(opts.body)).to.deep.include({ name: 'John', type: 'person', id: 'contact-1' });
      expect(tx.complete.calledOnce).to.be.true;
    });

    it('should upload PATCH operations as PUT requests', async () => {
      const tx = createMockTransaction([{
        op: 'PATCH',
        table: 'contacts',
        id: 'contact-1',
        opData: { name: 'Jane' },
      }]);
      mockDb.getNextCrudTransaction.resolves(tx);

      fetchStub.resolves(new Response('{}', { status: 200 }));

      await connector.uploadData(mockDb);

      expect(fetchStub.calledOnce).to.be.true;
      const [url, opts] = fetchStub.firstCall.args;
      expect(url).to.equal('http://localhost:5988/medic/api/v1/people/contact-1');
      expect(opts.method).to.equal('PUT');
      expect(tx.complete.calledOnce).to.be.true;
    });

    it('should upload DELETE operations', async () => {
      const tx = createMockTransaction([{
        op: 'DELETE',
        table: 'contacts',
        id: 'contact-1',
      }]);
      mockDb.getNextCrudTransaction.resolves(tx);

      fetchStub.resolves(new Response('{}', { status: 200 }));

      await connector.uploadData(mockDb);

      expect(fetchStub.calledOnce).to.be.true;
      const [url, opts] = fetchStub.firstCall.args;
      expect(url).to.equal('http://localhost:5988/medic/api/v1/people/contact-1');
      expect(opts.method).to.equal('DELETE');
      expect(tx.complete.calledOnce).to.be.true;
    });

    it('should skip unmapped tables', async () => {
      const tx = createMockTransaction([{
        op: 'PUT',
        table: 'unknown_table',
        id: 'doc-1',
        opData: { data: 'test' },
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
        opData: { name: 'John' },
      }]);
      mockDb.getNextCrudTransaction.resolves(tx);

      fetchStub.resolves(new Response('Internal Server Error', { status: 500 }));

      try {
        await connector.uploadData(mockDb);
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('500');
      }

      // transaction.complete() should NOT have been called
      expect(tx.complete.called).to.be.false;
    });

    it('should log 4xx validation errors without blocking queue', async () => {
      const tx = createMockTransaction([{
        op: 'PUT',
        table: 'contacts',
        id: 'contact-1',
        opData: { name: 'John' },
      }]);
      mockDb.getNextCrudTransaction.resolves(tx);

      fetchStub.resolves(new Response('Bad Request', { status: 400 }));

      await connector.uploadData(mockDb);

      // Should have logged to feedback table
      expect(mockDb.execute.calledOnce).to.be.true;
      const [sql, params] = mockDb.execute.firstCall.args;
      expect(sql).to.include('INSERT INTO feedback');
      expect(params).to.include('upload_error');

      // transaction.complete() should still be called
      expect(tx.complete.calledOnce).to.be.true;
    });

    it('should handle multiple operations in a transaction', async () => {
      const tx = createMockTransaction([
        { op: 'PUT', table: 'contacts', id: 'c1', opData: { name: 'A' } },
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
