require('../../aliases');
const chaiExclude = require('chai-exclude');
const chaiAsPromised = require('chai-as-promised');
const chai = require('chai');
const deepEqualInAnyOrder = require('deep-equal-in-any-order');

chai.use(chaiExclude);
chai.use(chaiAsPromised);
chai.use(deepEqualInAnyOrder);
chai.use(require('chai-shallow-deep-equal'));
global.expect = chai.expect;
global.chai = chai;

module.exports = {
  allowUncaught: false,
  color: true,
  checkLeaks: true,
  fullTrace: true,
  asyncOnly: false,
  spec: [
    'tests/integration/postgresql/**/*.spec.js',
  ],
  timeout: 120 * 1000,
  reporter: 'spec',
  require: ['tests/integration/postgresql/hooks.js'],
  captureFile: 'tests/results/pg-results.txt',
  exit: true,
};
