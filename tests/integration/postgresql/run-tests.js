#!/usr/bin/env node
/**
 * Test runner for PostgreSQL integration tests.
 * Runs mocha programmatically to avoid CLI permission issues.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || 'pgpass';

// Load module aliases (@utils, @constants, etc.) before any test requires
require('../../aliases');

const Mocha = require('mocha');
const path = require('path');

const testFile = process.argv[2] || 'smoke-test.spec.js';
const mocha = new Mocha({ timeout: 120000 });

const testPath = path.resolve(__dirname, testFile);
mocha.addFile(testPath);

mocha.run((failures) => {
  process.exitCode = failures ? 1 : 0;
});
