import sinon from 'sinon';
import { expect } from 'chai';

import { initializePowerSync } from '@mm-services/powersync/powersync-init';

describe('PowerSync Init', () => {
  let powerSyncService: any;
  let sessionService: any;

  beforeEach(() => {
    powerSyncService = {
      initialize: sinon.stub().resolves(),
    };
    sessionService = {
      userCtx: sinon.stub().returns({ name: 'chw_user', roles: ['chw'] }),
      isOnlineOnly: sinon.stub().returns(false),
    };
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('session checks', () => {
    it('should skip initialization when user is online-only', () => {
      sessionService.isOnlineOnly.returns(true);

      const result = initializePowerSync(powerSyncService, sessionService);

      expect(result.attempted).to.be.false;
      expect(powerSyncService.initialize.called).to.be.false;
    });

    it('should skip initialization when no user session exists', () => {
      sessionService.userCtx.returns(null);

      const result = initializePowerSync(powerSyncService, sessionService);

      expect(result.attempted).to.be.false;
      expect(powerSyncService.initialize.called).to.be.false;
    });

    it('should skip initialization when user has no name', () => {
      sessionService.userCtx.returns({ name: '', roles: ['chw'] });

      const result = initializePowerSync(powerSyncService, sessionService);

      expect(result.attempted).to.be.false;
      expect(powerSyncService.initialize.called).to.be.false;
    });

    it('should skip initialization when userCtx returns undefined name', () => {
      sessionService.userCtx.returns({ roles: ['chw'] });

      const result = initializePowerSync(powerSyncService, sessionService);

      expect(result.attempted).to.be.false;
    });

    it('should return ready promise that resolves for skipped init', async () => {
      sessionService.isOnlineOnly.returns(true);

      const result = initializePowerSync(powerSyncService, sessionService);

      // ready should resolve immediately, not reject
      await result.ready;
    });

    it('should initialize for offline users with valid session', async () => {
      const result = initializePowerSync(powerSyncService, sessionService);

      expect(result.attempted).to.be.true;
      await result.ready;
      expect(powerSyncService.initialize.calledOnce).to.be.true;
    });
  });

  describe('non-blocking behavior', () => {
    it('should return synchronously before initialization completes', () => {
      let initResolved = false;
      powerSyncService.initialize = sinon.stub().callsFake(() => {
        return new Promise(resolve => {
          setTimeout(() => { initResolved = true; resolve(undefined); }, 100);
        });
      });

      const result = initializePowerSync(powerSyncService, sessionService);

      // Function returns immediately — init hasn't resolved yet
      expect(result.attempted).to.be.true;
      expect(initResolved).to.be.false;
    });

    it('should resolve ready promise when initialization completes', async () => {
      const result = initializePowerSync(powerSyncService, sessionService);

      await result.ready;

      expect(powerSyncService.initialize.calledOnce).to.be.true;
    });
  });

  describe('production mode (default)', () => {
    it('should call initialize without devMode config', async () => {
      const result = initializePowerSync(powerSyncService, sessionService);
      await result.ready;

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.devMode).to.be.undefined;
      expect(config.devUser).to.be.undefined;
    });

    it('should pass powerSyncUrl when provided', async () => {
      const result = initializePowerSync(powerSyncService, sessionService, {
        powerSyncUrl: 'http://powersync:8080',
      });
      await result.ready;

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.powerSyncUrl).to.equal('http://powersync:8080');
    });

    it('should leave powerSyncUrl undefined when not provided', async () => {
      const result = initializePowerSync(powerSyncService, sessionService);
      await result.ready;

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.powerSyncUrl).to.be.undefined;
    });
  });

  describe('dev mode', () => {
    it('should set devMode and devUser in config', async () => {
      const result = initializePowerSync(powerSyncService, sessionService, { devMode: true });
      await result.ready;

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.devMode).to.be.true;
      expect(config.devUser).to.be.an('object');
    });

    it('should construct userId from CouchDB user format', async () => {
      sessionService.userCtx.returns({ name: 'mary', roles: ['chw'] });

      const result = initializePowerSync(powerSyncService, sessionService, { devMode: true });
      await result.ready;

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.devUser.userId).to.equal('org.couchdb.user:mary');
    });

    it('should pass user roles from session', async () => {
      sessionService.userCtx.returns({ name: 'supervisor', roles: ['chw_supervisor', 'data_entry'] });

      const result = initializePowerSync(powerSyncService, sessionService, { devMode: true });
      await result.ready;

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.devUser.roles).to.deep.equal(['chw_supervisor', 'data_entry']);
    });

    it('should default roles to empty array when not in session', async () => {
      sessionService.userCtx.returns({ name: 'norolesuser' });

      const result = initializePowerSync(powerSyncService, sessionService, { devMode: true });
      await result.ready;

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.devUser.roles).to.deep.equal([]);
    });

    it('should set default reportDepth of 1', async () => {
      const result = initializePowerSync(powerSyncService, sessionService, { devMode: true });
      await result.ready;

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.devUser.reportDepth).to.equal(1);
    });

    it('should pass powerSyncUrl in dev mode', async () => {
      const result = initializePowerSync(powerSyncService, sessionService, {
        devMode: true,
        powerSyncUrl: 'http://powersync:8080',
      });
      await result.ready;

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.powerSyncUrl).to.equal('http://powersync:8080');
    });
  });

  describe('error handling', () => {
    it('should not throw when initialization fails', async () => {
      powerSyncService.initialize.rejects(new Error('WASM failed to load'));

      const result = initializePowerSync(powerSyncService, sessionService);

      // ready promise should resolve (not reject) even on init failure
      await result.ready;
    });

    it('should not throw when initialization rejects with network error', async () => {
      powerSyncService.initialize.rejects(new TypeError('Failed to fetch'));

      const result = initializePowerSync(powerSyncService, sessionService);

      await result.ready;
    });

    it('should still set attempted to true when init fails', async () => {
      powerSyncService.initialize.rejects(new Error('WASM failed'));

      const result = initializePowerSync(powerSyncService, sessionService);

      expect(result.attempted).to.be.true;
      await result.ready;
    });
  });

  describe('feature flag', () => {
    it('should not initialize when powersync.enabled is false in settings', async () => {
      const getSettings = sinon.stub().resolves({ powersync: { enabled: false } });

      const result = initializePowerSync(powerSyncService, sessionService, { getSettings });
      await result.ready;

      expect(result.attempted).to.be.true;
      expect(powerSyncService.initialize.called).to.be.false;
    });

    it('should not initialize when powersync key is missing from settings', async () => {
      const getSettings = sinon.stub().resolves({});

      const result = initializePowerSync(powerSyncService, sessionService, { getSettings });
      await result.ready;

      expect(powerSyncService.initialize.called).to.be.false;
    });

    it('should initialize when powersync.enabled is true', async () => {
      const getSettings = sinon.stub().resolves({ powersync: { enabled: true } });

      const result = initializePowerSync(powerSyncService, sessionService, { getSettings });
      await result.ready;

      expect(powerSyncService.initialize.calledOnce).to.be.true;
    });

    it('should initialize when no getSettings callback is provided (default enabled)', async () => {
      const result = initializePowerSync(powerSyncService, sessionService);
      await result.ready;

      expect(powerSyncService.initialize.calledOnce).to.be.true;
    });

    it('should not initialize when getSettings throws (fail-safe to disabled)', async () => {
      const getSettings = sinon.stub().rejects(new Error('DB error'));

      const result = initializePowerSync(powerSyncService, sessionService, { getSettings });
      await result.ready;

      expect(powerSyncService.initialize.called).to.be.false;
    });

    it('should pass devMode config when feature flag is enabled', async () => {
      const getSettings = sinon.stub().resolves({ powersync: { enabled: true } });

      const result = initializePowerSync(powerSyncService, sessionService, {
        getSettings,
        devMode: true,
      });
      await result.ready;

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.devMode).to.be.true;
      expect(config.devUser).to.be.an('object');
    });
  });
});
