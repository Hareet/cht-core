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
    it('should skip initialization when user is online-only', async () => {
      sessionService.isOnlineOnly.returns(true);

      await initializePowerSync(powerSyncService, sessionService);

      expect(powerSyncService.initialize.called).to.be.false;
    });

    it('should skip initialization when no user session exists', async () => {
      sessionService.userCtx.returns(null);

      await initializePowerSync(powerSyncService, sessionService);

      expect(powerSyncService.initialize.called).to.be.false;
    });

    it('should skip initialization when user has no name', async () => {
      sessionService.userCtx.returns({ name: '', roles: ['chw'] });

      await initializePowerSync(powerSyncService, sessionService);

      expect(powerSyncService.initialize.called).to.be.false;
    });

    it('should skip initialization when userCtx returns undefined name', async () => {
      sessionService.userCtx.returns({ roles: ['chw'] });

      await initializePowerSync(powerSyncService, sessionService);

      expect(powerSyncService.initialize.called).to.be.false;
    });

    it('should initialize for offline users with valid session', async () => {
      await initializePowerSync(powerSyncService, sessionService);

      expect(powerSyncService.initialize.calledOnce).to.be.true;
    });
  });

  describe('production mode (default)', () => {
    it('should call initialize without devMode config', async () => {
      await initializePowerSync(powerSyncService, sessionService);

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.devMode).to.be.undefined;
      expect(config.devUser).to.be.undefined;
    });

    it('should pass powerSyncUrl when provided', async () => {
      await initializePowerSync(powerSyncService, sessionService, {
        powerSyncUrl: 'http://powersync:8080',
      });

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.powerSyncUrl).to.equal('http://powersync:8080');
    });

    it('should leave powerSyncUrl undefined when not provided', async () => {
      await initializePowerSync(powerSyncService, sessionService);

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.powerSyncUrl).to.be.undefined;
    });
  });

  describe('dev mode', () => {
    it('should set devMode and devUser in config', async () => {
      await initializePowerSync(powerSyncService, sessionService, { devMode: true });

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.devMode).to.be.true;
      expect(config.devUser).to.be.an('object');
    });

    it('should construct userId from CouchDB user format', async () => {
      sessionService.userCtx.returns({ name: 'mary', roles: ['chw'] });

      await initializePowerSync(powerSyncService, sessionService, { devMode: true });

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.devUser.userId).to.equal('org.couchdb.user:mary');
    });

    it('should pass user roles from session', async () => {
      sessionService.userCtx.returns({ name: 'supervisor', roles: ['chw_supervisor', 'data_entry'] });

      await initializePowerSync(powerSyncService, sessionService, { devMode: true });

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.devUser.roles).to.deep.equal(['chw_supervisor', 'data_entry']);
    });

    it('should default roles to empty array when not in session', async () => {
      sessionService.userCtx.returns({ name: 'norolesuser' });

      await initializePowerSync(powerSyncService, sessionService, { devMode: true });

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.devUser.roles).to.deep.equal([]);
    });

    it('should set default reportDepth of 1', async () => {
      await initializePowerSync(powerSyncService, sessionService, { devMode: true });

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.devUser.reportDepth).to.equal(1);
    });

    it('should pass powerSyncUrl in dev mode', async () => {
      await initializePowerSync(powerSyncService, sessionService, {
        devMode: true,
        powerSyncUrl: 'http://powersync:8080',
      });

      const config = powerSyncService.initialize.firstCall.args[0];
      expect(config.powerSyncUrl).to.equal('http://powersync:8080');
    });
  });

  describe('error handling', () => {
    it('should not throw when initialization fails', async () => {
      powerSyncService.initialize.rejects(new Error('WASM failed to load'));

      // Should not throw — falls back to PouchDB
      await initializePowerSync(powerSyncService, sessionService);
    });

    it('should not throw when initialization rejects with network error', async () => {
      powerSyncService.initialize.rejects(new TypeError('Failed to fetch'));

      await initializePowerSync(powerSyncService, sessionService);
    });
  });
});
