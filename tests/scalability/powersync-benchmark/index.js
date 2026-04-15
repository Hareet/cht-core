import { printResults, cleanFile, writeDbInfo } from './utils.js';
import testRoundTrip from './round-trip.js';

(async () => {
  await cleanFile();
  await writeDbInfo();

  await printResults('round_trip', await testRoundTrip());
})();
