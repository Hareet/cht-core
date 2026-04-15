/**
 * Mocha root hooks for PostgreSQL integration tests.
 *
 * Uses agent-harness instead of Docker-based service management.
 * Services (CouchDB, API, PostgreSQL, optionally PowerSync) must be pre-running.
 */
require('../../aliases');
const utils = require('../../utils/agent-harness');

exports.mochaHooks = {
  beforeAll: async () => {
    console.log('PostgreSQL integration tests: starting...');
    await utils.waitForAllServices({ requirePowersync: false });
    await utils.prepServices(true);
    console.log('PostgreSQL integration tests: services ready');
  },

  afterAll: async () => {
    await utils.tearDownServices();
    console.log('PostgreSQL integration tests: done');
  },

  beforeEach: function () {
    return utils.apiLogTestStart(this.currentTest.title);
  },

  afterEach: function () {
    return utils.apiLogTestEnd(this.currentTest.title);
  },
};
