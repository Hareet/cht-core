const { execSync } = require('child_process');
const result = execSync('find /tmp/node_modules -name "*worker*" -o -name "*Worker*" | grep -i wasqlite', { encoding: 'utf8' });
console.log(result || 'No matches');

const result2 = execSync('find /tmp/node_modules/@powersync -name "*.worker.*" -o -name "*Worker*"', { encoding: 'utf8' });
console.log('PowerSync workers:', result2 || 'none');
