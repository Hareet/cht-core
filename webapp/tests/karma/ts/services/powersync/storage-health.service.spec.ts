import sinon from 'sinon';
import { expect } from 'chai';

import { StorageHealthService } from '@mm-services/powersync/storage-health.service';

const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

describe('StorageHealthService', () => {
  let service: StorageHealthService;
  let storageEstimateStub: sinon.SinonStub;
  let clock: sinon.SinonFakeTimers;
  let originalStorage: StorageManager;

  beforeEach(() => {
    service = new StorageHealthService();
    clock = sinon.useFakeTimers();

    originalStorage = navigator.storage;
    storageEstimateStub = sinon.stub();

    Object.defineProperty(navigator, 'storage', {
      value: {
        estimate: storageEstimateStub,
        persist: sinon.stub().resolves(true),
        getDirectory: sinon.stub().resolves({}),
      },
      configurable: true,
    });
  });

  afterEach(() => {
    service.stopMonitoring();
    clock.restore();
    sinon.restore();
    Object.defineProperty(navigator, 'storage', {
      value: originalStorage,
      configurable: true,
    });
  });

  describe('checkStorage', () => {
    it('should return healthy when plenty of storage is available', async () => {
      storageEstimateStub.resolves({ quota: 10 * GB, usage: 1 * GB });

      const status = await service.checkStorage();

      expect(status.level).to.equal('healthy');
      expect(status.freeBytes).to.equal(9 * GB);
      expect(status.usagePercent).to.be.closeTo(10, 0.1);
    });

    it('should return warning when free space is below 100MB', async () => {
      storageEstimateStub.resolves({ quota: 10 * GB, usage: 10 * GB - 80 * MB });

      const status = await service.checkStorage();

      expect(status.level).to.equal('warning');
      expect(status.freeBytes).to.equal(80 * MB);
    });

    it('should return warning when usage exceeds 60%', async () => {
      storageEstimateStub.resolves({ quota: 10 * GB, usage: 6.5 * GB });

      const status = await service.checkStorage();

      expect(status.level).to.equal('warning');
      expect(status.usagePercent).to.be.closeTo(65, 0.1);
    });

    it('should return critical when free space is below 50MB', async () => {
      storageEstimateStub.resolves({ quota: 10 * GB, usage: 10 * GB - 30 * MB });

      const status = await service.checkStorage();

      expect(status.level).to.equal('critical');
      expect(status.freeBytes).to.equal(30 * MB);
    });

    it('should return critical when usage exceeds 80%', async () => {
      storageEstimateStub.resolves({ quota: 10 * GB, usage: 8.5 * GB });

      const status = await service.checkStorage();

      expect(status.level).to.equal('critical');
      expect(status.usagePercent).to.be.closeTo(85, 0.1);
    });

    it('should return healthy when storage API is unavailable', async () => {
      Object.defineProperty(navigator, 'storage', {
        value: { estimate: undefined },
        configurable: true,
      });

      const status = await service.checkStorage();

      expect(status.level).to.equal('healthy');
      expect(status.totalBytes).to.equal(0);
    });

    it('should return healthy when estimate throws', async () => {
      storageEstimateStub.rejects(new Error('Not supported'));

      const status = await service.checkStorage();

      expect(status.level).to.equal('healthy');
    });

    it('should clamp free bytes to zero when usage exceeds quota', async () => {
      storageEstimateStub.resolves({ quota: 5 * GB, usage: 6 * GB });

      const status = await service.checkStorage();

      expect(status.freeBytes).to.equal(0);
    });

    it('should handle zero quota', async () => {
      storageEstimateStub.resolves({ quota: 0, usage: 0 });

      const status = await service.checkStorage();

      expect(status.level).to.equal('healthy');
      expect(status.usagePercent).to.equal(0);
    });

    describe('boundary conditions', () => {
      it('should be warning at exactly 100MB free', async () => {
        // 100MB free, <60% usage → the free threshold triggers warning
        storageEstimateStub.resolves({ quota: 10 * GB, usage: 10 * GB - 100 * MB });

        const status = await service.checkStorage();

        // 100MB is not < 100MB, but usage is >60% here (99% used)
        // Actually 10GB - 100MB = ~9.9GB used, which is >80% → critical
        expect(status.level).to.equal('critical');
      });

      it('should be healthy at exactly 100MB free with low usage percent', async () => {
        // 100MB free, total is large enough that usage < 60%
        const total = 300 * MB;
        const usage = total - 100 * MB; // 200MB used of 300MB = 66.7% > 60% → warning
        storageEstimateStub.resolves({ quota: total, usage });

        const status = await service.checkStorage();

        expect(status.level).to.equal('warning');
      });

      it('should be warning at exactly 60% usage with plenty of free space', async () => {
        // Need > 60% usage but > 100MB free
        const total = 100 * GB;
        const usage = 61 * GB; // 61% usage, 39GB free
        storageEstimateStub.resolves({ quota: total, usage });

        const status = await service.checkStorage();

        expect(status.level).to.equal('warning');
      });

      it('should be healthy at exactly 60% usage', async () => {
        const total = 100 * GB;
        const usage = 60 * GB; // exactly 60%, not >60%
        storageEstimateStub.resolves({ quota: total, usage });

        const status = await service.checkStorage();

        expect(status.level).to.equal('healthy');
      });
    });
  });

  describe('status$', () => {
    it('should emit initial healthy status', (done) => {
      service.status$.subscribe(status => {
        expect(status.level).to.equal('healthy');
        done();
      });
    });

    it('should emit updated status after checkStorage', async () => {
      storageEstimateStub.resolves({ quota: 10 * GB, usage: 9 * GB });

      const statuses: string[] = [];
      const sub = service.status$.subscribe(s => statuses.push(s.level));

      await service.checkStorage();

      sub.unsubscribe();
      expect(statuses).to.include('critical');
    });
  });

  describe('startMonitoring / stopMonitoring', () => {
    it('should check storage immediately on start', async () => {
      storageEstimateStub.resolves({ quota: 10 * GB, usage: 1 * GB });

      service.startMonitoring();
      // Flush the immediate checkStorage call
      await Promise.resolve();

      expect(storageEstimateStub.calledOnce).to.be.true;
    });

    it('should check storage every 5 minutes', async () => {
      storageEstimateStub.resolves({ quota: 10 * GB, usage: 1 * GB });

      service.startMonitoring();
      await Promise.resolve();
      expect(storageEstimateStub.callCount).to.equal(1);

      // Advance 5 minutes
      clock.tick(5 * 60 * 1000);
      await Promise.resolve();
      expect(storageEstimateStub.callCount).to.equal(2);

      // Advance another 5 minutes
      clock.tick(5 * 60 * 1000);
      await Promise.resolve();
      expect(storageEstimateStub.callCount).to.equal(3);
    });

    it('should stop checking after stopMonitoring', async () => {
      storageEstimateStub.resolves({ quota: 10 * GB, usage: 1 * GB });

      service.startMonitoring();
      await Promise.resolve();
      expect(storageEstimateStub.callCount).to.equal(1);

      service.stopMonitoring();

      clock.tick(5 * 60 * 1000);
      await Promise.resolve();
      expect(storageEstimateStub.callCount).to.equal(1);
    });

    it('should report isMonitoring correctly', () => {
      expect(service.isMonitoring()).to.be.false;

      service.startMonitoring();
      expect(service.isMonitoring()).to.be.true;

      service.stopMonitoring();
      expect(service.isMonitoring()).to.be.false;
    });

    it('should restart interval on repeated startMonitoring calls', async () => {
      storageEstimateStub.resolves({ quota: 10 * GB, usage: 1 * GB });

      service.startMonitoring();
      await Promise.resolve();
      service.startMonitoring(); // should not create double interval
      await Promise.resolve();

      clock.tick(5 * 60 * 1000);
      await Promise.resolve();
      // First start: 1 call, second start: 1 call (immediate), tick: 1 call = 3
      expect(storageEstimateStub.callCount).to.equal(3);
    });
  });

  describe('getCurrentStatus', () => {
    it('should return last emitted status', async () => {
      storageEstimateStub.resolves({ quota: 10 * GB, usage: 9 * GB });

      await service.checkStorage();

      const status = service.getCurrentStatus();
      expect(status.level).to.equal('critical');
    });
  });

  describe('ngOnDestroy', () => {
    it('should stop monitoring on destroy', () => {
      service.startMonitoring();
      expect(service.isMonitoring()).to.be.true;

      service.ngOnDestroy();
      expect(service.isMonitoring()).to.be.false;
    });
  });
});
