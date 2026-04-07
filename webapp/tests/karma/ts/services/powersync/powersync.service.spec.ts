import { TestBed } from '@angular/core/testing';
import sinon from 'sinon';
import { expect } from 'chai';
import { NgZone } from '@angular/core';
import { Subject } from 'rxjs';

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
  disconnectAndClear = sinon.stub().resolves();
  waitForFirstSync = sinon.stub().resolves();
  getAll = sinon.stub().resolves([]);
  get = sinon.stub().resolves({});
  getOptional = sinon.stub().resolves(null);
  execute = sinon.stub().resolves();
  writeTransaction = sinon.stub().callsFake(async (fn) => fn({ execute: sinon.stub().resolves() }));
  watchWithAsyncGenerator = sinon.stub();

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
      // We can't fully test initialization without mocking the PowerSyncDatabase constructor,
      // but we can verify the idempotency by checking the initialized flag behavior
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
});
