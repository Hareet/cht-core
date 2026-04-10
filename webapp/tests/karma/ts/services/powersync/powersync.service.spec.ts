import { TestBed } from '@angular/core/testing';
import sinon from 'sinon';
import { expect } from 'chai';
import { NgZone } from '@angular/core';

import { PowerSyncService } from '@mm-services/powersync/powersync.service';
import { SessionService } from '@mm-services/session.service';
import { LocationService } from '@mm-services/location.service';

// Mock PowerSyncDatabase
class MockPowerSyncDatabase {
  private statusListeners: any[] = [];
  currentStatus = {
    connected: false,
    connecting: false,
    hasSynced: false,
    lastSyncedAt: null,
    dataFlowStatus: {
      uploading: false,
      downloading: false,
      uploadError: undefined,
      downloadError: undefined,
    },
  };

  connect = sinon.stub();
  disconnect = sinon.stub().resolves();
  disconnectAndClear = sinon.stub().resolves();
  waitForFirstSync = sinon.stub().resolves();
  getAll = sinon.stub().resolves([]);
  get = sinon.stub().resolves({});
  getOptional = sinon.stub().resolves(null);
  execute = sinon.stub().resolves();
  writeTransaction = sinon.stub().callsFake(async (fn) => fn({ execute: sinon.stub().resolves() }));
  getUploadQueueStats = sinon.stub().resolves({ count: 0 });

  registerListener(listener: any) {
    this.statusListeners.push(listener);
  }

  // Test helper: emit a status change
  _emitStatus(status: any) {
    this.currentStatus = { ...this.currentStatus, ...status };
    for (const listener of this.statusListeners) {
      if (listener.statusChanged) {
        listener.statusChanged(this.currentStatus);
      }
    }
  }
}

describe('PowerSync Service', () => {
  let service: PowerSyncService;
  let sessionService: any;
  let locationService: any;
  let mockDb: MockPowerSyncDatabase;

  beforeEach(() => {
    sessionService = {
      userCtx: sinon.stub().returns({ name: 'testuser', roles: ['chw'] }),
      isOnlineOnly: sinon.stub().returns(false),
    };
    locationService = {
      dbName: 'medic',
      url: 'http://localhost:5988/medic',
    };

    mockDb = new MockPowerSyncDatabase();

    TestBed.configureTestingModule({
      providers: [
        PowerSyncService,
        { provide: SessionService, useValue: sessionService },
        { provide: LocationService, useValue: locationService },
      ],
    });

    service = TestBed.inject(PowerSyncService);
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('initialize', () => {
    it('should skip initialization for online-only users', async () => {
      sessionService.isOnlineOnly.returns(true);
      await service.initialize();
      expect(service.getCurrentStatus().connected).to.equal(false);
    });

    it('should not initialize twice', async () => {
      sessionService.isOnlineOnly.returns(true);
      await service.initialize();
      await service.initialize(); // second call should no-op
      expect(service.getCurrentStatus().connected).to.equal(false);
    });
  });

  describe('getCurrentStatus', () => {
    it('should return default status before initialization', () => {
      const status = service.getCurrentStatus();
      expect(status.connected).to.equal(false);
      expect(status.connecting).to.equal(false);
      expect(status.hasSynced).to.equal(false);
      expect(status.lastSyncedAt).to.equal(null);
      expect(status.uploading).to.equal(false);
      expect(status.downloading).to.equal(false);
      expect(status.uploadError).to.equal(undefined);
      expect(status.downloadError).to.equal(undefined);
    });
  });

  describe('status$', () => {
    it('should emit initial status', (done) => {
      service.status$.subscribe(status => {
        expect(status.connected).to.equal(false);
        expect(status.hasSynced).to.equal(false);
        done();
      });
    });
  });

  describe('isReady', () => {
    it('should return false before initialization', () => {
      expect(service.isReady()).to.equal(false);
    });
  });

  describe('disconnectAndClear', () => {
    it('should reset status on disconnect', async () => {
      await service.disconnectAndClear();
      const status = service.getCurrentStatus();
      expect(status.connected).to.equal(false);
      expect(status.hasSynced).to.equal(false);
    });

    it('should handle disconnect when not initialized', async () => {
      // Should not throw
      await service.disconnectAndClear();
    });
  });

  describe('getDatabase', () => {
    it('should throw if not initialized', () => {
      expect(() => service.getDatabase()).to.throw('PowerSync not initialized');
    });
  });

  describe('query methods (not initialized)', () => {
    it('getAll should throw if not initialized', async () => {
      try {
        await service.getAll('SELECT 1');
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('not initialized');
      }
    });

    it('getOptional should throw if not initialized', async () => {
      try {
        await service.getOptional('SELECT 1');
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('not initialized');
      }
    });

    it('get should throw if not initialized', async () => {
      try {
        await service.get('SELECT 1');
        expect.fail('should have thrown');
      } catch (err: any) {
        expect(err.message).to.include('not initialized');
      }
    });
  });

  describe('watch', () => {
    it('should error if not initialized', (done) => {
      service.watch('SELECT 1').subscribe({
        error: (err) => {
          expect(err.message).to.include('not initialized');
          done();
        },
      });
    });
  });

  describe('getContactsByType', () => {
    it('should return empty array for empty types', async () => {
      const result = await service.getContactsByType([]);
      expect(result).to.deep.equal([]);
    });
  });

  describe('watchContactsByType', () => {
    it('should complete immediately for empty types', (done) => {
      service.watchContactsByType([]).subscribe({
        next: (result) => {
          expect(result).to.deep.equal([]);
        },
        complete: () => done(),
      });
    });
  });

  describe('getDocsByIds', () => {
    it('should return empty array for empty ids', async () => {
      const result = await service.getDocsByIds([]);
      expect(result).to.deep.equal([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests with initialized state (mock db injected)
  // ---------------------------------------------------------------------------
  describe('initialized state', () => {
    let mockConnector: any;

    beforeEach(() => {
      mockConnector = {
        fetchCredentials: sinon.stub().resolves({ endpoint: 'http://localhost:8080', token: 'test' }),
        uploadData: sinon.stub().resolves(),
      };

      // Inject mock db and connector to simulate initialized state
      (service as any).db = mockDb;
      (service as any).connector = mockConnector;
      (service as any).initialized = true;
    });

    describe('getDatabase', () => {
      it('should return the database instance', () => {
        const db = service.getDatabase();
        expect(db).to.equal(mockDb);
      });
    });

    describe('reconnect', () => {
      it('should disconnect and reconnect with the same connector', async () => {
        await service.reconnect();

        expect(mockDb.disconnect.calledOnce).to.be.true;
        expect(mockDb.connect.calledOnce).to.be.true;
        expect(mockDb.connect.calledWith(mockConnector)).to.be.true;
      });

      it('should call disconnect before connect', async () => {
        await service.reconnect();

        expect(mockDb.disconnect.calledBefore(mockDb.connect)).to.be.true;
      });

      it('should no-op when not initialized', async () => {
        (service as any).db = null;
        (service as any).connector = null;

        // Should not throw
        await service.reconnect();
      });

      it('should no-op when db exists but connector is null', async () => {
        (service as any).connector = null;

        await service.reconnect();

        expect(mockDb.disconnect.called).to.be.false;
      });
    });

    describe('getPendingUploadCount', () => {
      it('should return count from upload queue stats', async () => {
        mockDb.getUploadQueueStats.resolves({ count: 5 });

        const count = await service.getPendingUploadCount();

        expect(count).to.equal(5);
        expect(mockDb.getUploadQueueStats.calledOnce).to.be.true;
      });

      it('should return 0 when queue is empty', async () => {
        mockDb.getUploadQueueStats.resolves({ count: 0 });

        const count = await service.getPendingUploadCount();

        expect(count).to.equal(0);
      });

      it('should return 0 when not initialized', async () => {
        (service as any).db = null;

        const count = await service.getPendingUploadCount();

        expect(count).to.equal(0);
      });
    });

    describe('hasPendingWrites', () => {
      it('should return true when uploads are pending', async () => {
        mockDb.getUploadQueueStats.resolves({ count: 3 });

        expect(await service.hasPendingWrites()).to.be.true;
      });

      it('should return false when queue is empty', async () => {
        mockDb.getUploadQueueStats.resolves({ count: 0 });

        expect(await service.hasPendingWrites()).to.be.false;
      });
    });

    describe('query delegation', () => {
      it('getAll should delegate to db.getAll', async () => {
        const expected = [{ id: '1', name: 'Test' }];
        mockDb.getAll.resolves(expected);

        const results = await service.getAll('SELECT * FROM contacts');

        expect(mockDb.getAll.calledOnce).to.be.true;
        expect(mockDb.getAll.calledWith('SELECT * FROM contacts', [])).to.be.true;
        expect(results).to.deep.equal(expected);
      });

      it('getAll should pass parameters', async () => {
        mockDb.getAll.resolves([]);

        await service.getAll('SELECT * FROM contacts WHERE id = ?', ['c1']);

        expect(mockDb.getAll.calledWith('SELECT * FROM contacts WHERE id = ?', ['c1'])).to.be.true;
      });

      it('getOptional should delegate to db.getOptional', async () => {
        const expected = { id: '1', name: 'Test' };
        mockDb.getOptional.resolves(expected);

        const result = await service.getOptional('SELECT * FROM contacts WHERE id = ?', ['1']);

        expect(mockDb.getOptional.calledWith('SELECT * FROM contacts WHERE id = ?', ['1'])).to.be.true;
        expect(result).to.deep.equal(expected);
      });

      it('get should delegate to db.get', async () => {
        const expected = { id: '1', name: 'Test' };
        mockDb.get.resolves(expected);

        const result = await service.get('SELECT * FROM contacts WHERE id = ?', ['1']);

        expect(mockDb.get.calledWith('SELECT * FROM contacts WHERE id = ?', ['1'])).to.be.true;
        expect(result).to.deep.equal(expected);
      });

      it('execute should delegate to db.execute', async () => {
        await service.execute('INSERT INTO contacts (id, name) VALUES (?, ?)', ['1', 'Test']);

        expect(mockDb.execute.calledOnce).to.be.true;
        expect(mockDb.execute.calledWith(
          'INSERT INTO contacts (id, name) VALUES (?, ?)',
          ['1', 'Test']
        )).to.be.true;
      });

      it('writeTransaction should delegate to db.writeTransaction', async () => {
        const fn = async (tx: any) => { await tx.execute('SELECT 1'); };

        await service.writeTransaction(fn);

        expect(mockDb.writeTransaction.calledOnce).to.be.true;
      });
    });

    describe('getContactsByType', () => {
      it('should query contacts by type with correct SQL', async () => {
        const expected = [
          { id: 'c1', contact_type: 'person', name: 'Alice' },
          { id: 'c2', contact_type: 'person', name: 'Bob' },
        ];
        mockDb.getAll.resolves(expected);

        const results = await service.getContactsByType(['person']);

        expect(mockDb.getAll.calledOnce).to.be.true;
        const [sql, params] = mockDb.getAll.firstCall.args;
        expect(sql).to.include('contact_type IN (?)');
        expect(sql).to.include('ORDER BY name');
        expect(params).to.deep.equal(['person']);
        expect(results).to.deep.equal(expected);
      });

      it('should handle multiple types', async () => {
        mockDb.getAll.resolves([]);

        await service.getContactsByType(['person', 'clinic', 'health_center']);

        const [sql, params] = mockDb.getAll.firstCall.args;
        expect(sql).to.include('?, ?, ?');
        expect(params).to.deep.equal(['person', 'clinic', 'health_center']);
      });
    });

    describe('getContactsByParent', () => {
      it('should query by parent_id without type filter', async () => {
        mockDb.getAll.resolves([]);

        await service.getContactsByParent('parent-1');

        const [sql, params] = mockDb.getAll.firstCall.args;
        expect(sql).to.include('parent_id = ?');
        expect(sql).not.to.include('contact_type = ?');
        expect(params).to.deep.equal(['parent-1']);
      });

      it('should query by parent_id with type filter', async () => {
        mockDb.getAll.resolves([]);

        await service.getContactsByParent('parent-1', 'person');

        const [sql, params] = mockDb.getAll.firstCall.args;
        expect(sql).to.include('parent_id = ?');
        expect(sql).to.include('contact_type = ?');
        expect(params).to.deep.equal(['parent-1', 'person']);
      });
    });

    describe('getDoc', () => {
      it('should find document in contacts table', async () => {
        mockDb.getOptional.callsFake(async (sql: string) => {
          if (sql.includes('FROM contacts')) {
            return { id: 'doc-1', name: 'John', contact_type: 'person' };
          }
          return null;
        });

        const result = await service.getDoc('doc-1');

        expect(result).to.not.be.null;
        expect(result!._table).to.equal('contacts');
        expect(result!.name).to.equal('John');
      });

      it('should search subsequent tables when not found in contacts', async () => {
        mockDb.getOptional.callsFake(async (sql: string) => {
          if (sql.includes('FROM reports')) {
            return { id: 'doc-1', form: 'pregnancy' };
          }
          return null;
        });

        const result = await service.getDoc('doc-1');

        expect(result).to.not.be.null;
        expect(result!._table).to.equal('reports');
        expect(result!.form).to.equal('pregnancy');
      });

      it('should find documents in tasks table', async () => {
        mockDb.getOptional.callsFake(async (sql: string) => {
          if (sql.includes('FROM tasks')) {
            return { id: 'task-1', state: 'Ready' };
          }
          return null;
        });

        const result = await service.getDoc('task-1');

        expect(result).to.not.be.null;
        expect(result!._table).to.equal('tasks');
        expect(result!.state).to.equal('Ready');
      });

      it('should return null when document not found in any table', async () => {
        mockDb.getOptional.resolves(null);

        const result = await service.getDoc('nonexistent');

        expect(result).to.be.null;
        // Should have searched all 5 tables
        expect(mockDb.getOptional.callCount).to.equal(5);
      });

      it('should stop searching after finding the document', async () => {
        mockDb.getOptional.callsFake(async (sql: string) => {
          if (sql.includes('FROM contacts')) {
            return { id: 'doc-1', name: 'Found' };
          }
          return null;
        });

        await service.getDoc('doc-1');

        // Should stop after finding in contacts, not query reports/tasks/etc.
        expect(mockDb.getOptional.callCount).to.equal(1);
      });
    });

    describe('getDocsByIds', () => {
      it('should search all tables for matching documents', async () => {
        mockDb.getAll.callsFake(async (sql: string) => {
          if (sql.includes('FROM contacts')) {
            return [{ id: 'c1', name: 'Alice' }];
          }
          if (sql.includes('FROM reports')) {
            return [{ id: 'r1', form: 'visit' }];
          }
          return [];
        });

        const results = await service.getDocsByIds(['c1', 'r1']);

        expect(results).to.have.length(2);
        expect(results[0]).to.include({ _table: 'contacts' });
        expect(results[1]).to.include({ _table: 'reports' });
      });

      it('should annotate results with _table field', async () => {
        mockDb.getAll.callsFake(async (sql: string) => {
          if (sql.includes('FROM tasks')) {
            return [{ id: 't1', state: 'Ready' }];
          }
          return [];
        });

        const results = await service.getDocsByIds(['t1']);

        expect(results[0]._table).to.equal('tasks');
      });
    });

    describe('getReportsForPatient', () => {
      it('should query reports by patient_uuid ordered by reported_date DESC', async () => {
        const expected = [{ id: 'r1', form: 'visit', patient_uuid: 'p1', reported_date: '2026-04-10' }];
        mockDb.getAll.resolves(expected);

        const results = await service.getReportsForPatient('p1');

        const [sql, params] = mockDb.getAll.firstCall.args;
        expect(sql).to.include('patient_uuid = ?');
        expect(sql).to.include('ORDER BY reported_date DESC');
        expect(params).to.deep.equal(['p1']);
        expect(results).to.deep.equal(expected);
      });
    });

    describe('isReady', () => {
      it('should return true when initialized and has synced', () => {
        (service as any).statusSubject.next({
          ...service.getCurrentStatus(),
          hasSynced: true,
        });

        expect(service.isReady()).to.be.true;
      });

      it('should return false when initialized but not yet synced', () => {
        expect(service.isReady()).to.be.false;
      });
    });

    describe('waitForFirstSync', () => {
      it('should return true immediately if already synced', async () => {
        mockDb.currentStatus.hasSynced = true;

        const result = await service.waitForFirstSync();

        expect(result).to.be.true;
        expect(mockDb.waitForFirstSync.called).to.be.false;
      });

      it('should return true after sync completes', async () => {
        mockDb.currentStatus.hasSynced = false;
        mockDb.waitForFirstSync.resolves();

        const result = await service.waitForFirstSync();

        expect(result).to.be.true;
      });

      it('should return false on timeout', async () => {
        mockDb.currentStatus.hasSynced = false;
        mockDb.waitForFirstSync.callsFake(() => new Promise((_, reject) => {
          // Simulate abort signal rejection
          setTimeout(() => reject(new Error('Aborted')), 10);
        }));

        const result = await service.waitForFirstSync(50);

        expect(result).to.be.false;
      });

      it('should return false when not initialized', async () => {
        (service as any).db = null;

        const result = await service.waitForFirstSync();

        expect(result).to.be.false;
      });
    });

    describe('disconnectAndClear', () => {
      it('should call db.disconnectAndClear and reset all state', async () => {
        await service.disconnectAndClear();

        expect(mockDb.disconnectAndClear.calledOnce).to.be.true;
        expect((service as any).db).to.be.null;
        expect((service as any).connector).to.be.null;
        expect((service as any).initialized).to.be.false;

        const status = service.getCurrentStatus();
        expect(status.connected).to.be.false;
        expect(status.hasSynced).to.be.false;
        expect(status.uploading).to.be.false;
        expect(status.downloading).to.be.false;
      });

      it('should reset state even when db.disconnectAndClear throws', async () => {
        mockDb.disconnectAndClear.rejects(new Error('DB locked'));

        // Should not throw
        await service.disconnectAndClear();

        // State should still be reset
        expect((service as any).db).to.be.null;
        expect((service as any).connector).to.be.null;
        expect((service as any).initialized).to.be.false;
      });
    });
  });
});
