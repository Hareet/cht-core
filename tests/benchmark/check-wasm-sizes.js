const fs = require('fs');
const path = require('path');

function findWasm(dir) {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.includes('.cache')) {
        results.push(...findWasm(full));
      } else if (entry.name.endsWith('.wasm')) {
        const stat = fs.statSync(full);
        results.push({ path: full.replace('/tmp/node_modules/', ''), size: stat.size, sizeKB: Math.round(stat.size / 1024) });
      }
    }
  } catch {}
  return results;
}

// Check webapp node_modules
const webappPath = '/workspace/cht-core/webapp/node_modules';
const tmpPath = '/tmp/node_modules';

for (const base of [webappPath, tmpPath]) {
  if (!fs.existsSync(base)) continue;
  console.log(`\n=== ${base} ===`);
  const files = findWasm(base);
  files.sort((a, b) => b.size - a.size);
  let total = 0;
  for (const f of files) {
    console.log(`  ${f.sizeKB}KB  ${f.path}`);
    total += f.size;
  }
  console.log(`  TOTAL: ${Math.round(total / 1024)}KB (${(total / 1e6).toFixed(1)}MB)`);
}
