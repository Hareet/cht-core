const ps = require('@powersync/web');
const keys = Object.keys(ps);
console.log('All exports matching schema/table/column:');
console.log(keys.filter(k => k.match(/schema|table|column/i)).join('\n'));
console.log('\nAll exports:');
console.log(keys.join(', '));
