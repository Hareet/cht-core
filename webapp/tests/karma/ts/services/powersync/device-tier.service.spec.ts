import sinon from 'sinon';
import { expect } from 'chai';

import { DeviceTierService } from '@mm-services/powersync/device-tier.service';

const GB = 1024 * 1024 * 1024;

describe('DeviceTierService', () => {
  let service: DeviceTierService;
  let storageEstimateStub: sinon.SinonStub;
  let getDirectoryStub: sinon.SinonStub;
  let originalStorage: StorageManager;
  let originalNavigator: any;

  beforeEach(() => {
    service = new DeviceTierService();

    // Save originals
    originalStorage = navigator.storage;
    originalNavigator = navigator;

    storageEstimateStub = sinon.stub();
    getDirectoryStub = sinon.stub();

    // Mock navigator.storage
    Object.defineProperty(navigator, 'storage', {
      value: {
        estimate: storageEstimateStub,
        getDirectory: getDirectoryStub,
        persist: sinon.stub().resolves(true),
      },
      configurable: true,
    });
  });

  afterEach(() => {
    sinon.restore();
    // Restore original storage
    Object.defineProperty(navigator, 'storage', {
      value: originalStorage,
      configurable: true,
    });
  });

  describe('detect', () => {
    describe('tier classification', () => {
      it('should classify <16GB as go tier', async () => {
        storageEstimateStub.resolves({ quota: 11 * GB, usage: 1 * GB });
        getDirectoryStub.resolves({});

        const result = await service.detect();

        expect(result.tier).to.equal('go');
        expect(result.storageTotalGB).to.be.closeTo(11, 0.1);
        expect(result.storageFreeGB).to.be.closeTo(10, 0.1);
      });

      it('should classify 16-32GB as budget tier', async () => {
        storageEstimateStub.resolves({ quota: 24 * GB, usage: 4 * GB });
        getDirectoryStub.resolves({});

        const result = await service.detect();

        expect(result.tier).to.equal('budget');
      });

      it('should classify 32-128GB as standard tier', async () => {
        storageEstimateStub.resolves({ quota: 64 * GB, usage: 10 * GB });
        getDirectoryStub.resolves({});

        const result = await service.detect();

        expect(result.tier).to.equal('standard');
      });

      it('should classify 128GB+ as high tier', async () => {
        storageEstimateStub.resolves({ quota: 256 * GB, usage: 30 * GB });
        getDirectoryStub.resolves({});

        const result = await service.detect();

        expect(result.tier).to.equal('high');
      });

      it('should classify exactly 16GB boundary as budget (not go)', async () => {
        storageEstimateStub.resolves({ quota: 16 * GB, usage: 0 });
        getDirectoryStub.resolves({});

        const result = await service.detect();

        expect(result.tier).to.equal('budget');
      });

      it('should classify exactly 32GB boundary as standard (not budget)', async () => {
        storageEstimateStub.resolves({ quota: 32 * GB, usage: 0 });
        getDirectoryStub.resolves({});

        const result = await service.detect();

        expect(result.tier).to.equal('standard');
      });

      it('should classify exactly 128GB boundary as high (not standard)', async () => {
        storageEstimateStub.resolves({ quota: 128 * GB, usage: 0 });
        getDirectoryStub.resolves({});

        const result = await service.detect();

        expect(result.tier).to.equal('high');
      });
    });

    describe('OPFS detection', () => {
      it('should detect OPFS as available when getDirectory succeeds', async () => {
        storageEstimateStub.resolves({ quota: 64 * GB, usage: 0 });
        getDirectoryStub.resolves({});

        const result = await service.detect();

        expect(result.opfsAvailable).to.be.true;
      });

      it('should detect OPFS as unavailable when getDirectory throws', async () => {
        storageEstimateStub.resolves({ quota: 64 * GB, usage: 0 });
        getDirectoryStub.rejects(new Error('Not supported'));

        const result = await service.detect();

        expect(result.opfsAvailable).to.be.false;
      });

      it('should detect OPFS as unavailable when getDirectory is undefined', async () => {
        storageEstimateStub.resolves({ quota: 64 * GB, usage: 0 });
        Object.defineProperty(navigator, 'storage', {
          value: {
            estimate: storageEstimateStub,
            getDirectory: undefined,
          },
          configurable: true,
        });

        const result = await service.detect();

        expect(result.opfsAvailable).to.be.false;
      });
    });

    describe('storage estimation fallback', () => {
      it('should fallback when storage.estimate is unavailable', async () => {
        Object.defineProperty(navigator, 'storage', {
          value: {
            estimate: undefined,
            getDirectory: getDirectoryStub,
          },
          configurable: true,
        });
        getDirectoryStub.resolves({});

        const result = await service.detect();

        // Fallback: 16GB total, 8GB free → budget tier
        expect(result.tier).to.equal('budget');
        expect(result.storageTotalGB).to.equal(16);
        expect(result.storageFreeGB).to.equal(8);
      });

      it('should fallback when storage.estimate throws', async () => {
        storageEstimateStub.rejects(new Error('Permission denied'));
        getDirectoryStub.resolves({});

        const result = await service.detect();

        expect(result.tier).to.equal('budget');
      });

      it('should handle missing quota and usage fields', async () => {
        storageEstimateStub.resolves({});
        getDirectoryStub.resolves({});

        const result = await service.detect();

        // quota=0, usage=0 → 0 bytes total → go tier
        expect(result.tier).to.equal('go');
        expect(result.storageTotalGB).to.equal(0);
        expect(result.storageFreeGB).to.equal(0);
      });

      it('should clamp free storage to zero when usage exceeds quota', async () => {
        storageEstimateStub.resolves({ quota: 10 * GB, usage: 12 * GB });
        getDirectoryStub.resolves({});

        const result = await service.detect();

        expect(result.storageFreeGB).to.equal(0);
      });
    });

    describe('caching', () => {
      it('should cache result after first detect call', async () => {
        storageEstimateStub.resolves({ quota: 64 * GB, usage: 0 });
        getDirectoryStub.resolves({});

        const first = await service.detect();
        const second = await service.detect();

        expect(first).to.equal(second);
        expect(storageEstimateStub.callCount).to.equal(1);
      });

      it('should return null from getCachedTier before detect is called', () => {
        expect(service.getCachedTier()).to.be.null;
      });

      it('should return cached tier after detect is called', async () => {
        storageEstimateStub.resolves({ quota: 64 * GB, usage: 0 });
        getDirectoryStub.resolves({});

        await service.detect();

        expect(service.getCachedTier()).to.not.be.null;
        expect(service.getCachedTier()!.tier).to.equal('standard');
      });
    });

    describe('WebView version detection', () => {
      it('should extract Chrome version from user agent', async () => {
        storageEstimateStub.resolves({ quota: 64 * GB, usage: 0 });
        getDirectoryStub.resolves({});

        // Default test UA likely contains Chrome/NNN
        const result = await service.detect();
        expect(result.webviewMajor).to.be.a('number');
      });
    });
  });

  describe('getConfig', () => {
    it('should return go tier config', () => {
      const config = service.getConfig('go');
      expect(config.cacheSizeKb).to.equal(10240);
      expect(config.dbSizeBudgetMB).to.equal(200);
    });

    it('should return budget tier config', () => {
      const config = service.getConfig('budget');
      expect(config.cacheSizeKb).to.equal(25600);
      expect(config.dbSizeBudgetMB).to.equal(500);
    });

    it('should return standard tier config', () => {
      const config = service.getConfig('standard');
      expect(config.cacheSizeKb).to.equal(51200);
      expect(config.dbSizeBudgetMB).to.equal(1024);
    });

    it('should return high tier config', () => {
      const config = service.getConfig('high');
      expect(config.cacheSizeKb).to.equal(51200);
      expect(config.dbSizeBudgetMB).to.equal(2048);
    });
  });
});
