const fs = require('fs');
// Find the WASQLiteOpenFactory source
const factoryPath = '/tmp/node_modules/@powersync/web/lib/src/db/adapters/wa-sqlite/WASQLiteOpenFactory.js';
if (fs.existsSync(factoryPath)) {
  const src = fs.readFileSync(factoryPath, 'utf8');
  // Print lines with option/config/wasm references
  src.split('\n').forEach((line, i) => {
    if (line.match(/wasm|worker|Worker|dbFilename|vfs|options|config|constructor|flags/i)) {
      console.log(`${i + 1}: ${line.trim()}`);
    }
  });
} else {
  console.log('File not found, searching...');
  const { execSync } = require('child_process');
  console.log(execSync('find /tmp/node_modules/@powersync/web -name "WASQLiteOpenFactory*" -type f').toString());
}
