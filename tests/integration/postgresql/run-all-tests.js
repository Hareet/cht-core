#!/usr/bin/env node
/**
 * Runs all PostgreSQL integration test suites sequentially.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.env.POSTGRES_PASSWORD = process.env.POSTGRES_PASSWORD || 'pgpass';

require('../../aliases');

const Mocha = require('mocha');
const path = require('path');
const fs = require('fs');

const testDir = __dirname;
const mocha = new Mocha({ timeout: 120000 });

// Add all live-*.spec.js and smoke-test.spec.js files
const testFiles = fs.readdirSync(testDir)
  .filter(f => (f.startsWith('live-') || f === 'smoke-test.spec.js') && f.endsWith('.spec.js'))
  .sort();

console.log(`Found ${testFiles.length} test files:`);
testFiles.forEach(f => console.log(`  - ${f}`));
console.log('');

testFiles.forEach(f => mocha.addFile(path.join(testDir, f)));

mocha.run((failures) => {
  process.exitCode = failures ? 1 : 0;
});
