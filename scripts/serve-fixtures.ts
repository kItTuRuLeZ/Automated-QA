import { startFixtureServer } from '../tests/support/fixture-server.js';

// Serves the sample course pack on loopback so scans work with no internet connection.
// To scan it, start the app with CQA_ALLOW_LOCAL_TARGETS=127.0.0.1:4400,127.0.0.1:4401 (see docs/SETUP.md).
const fx = await startFixtureServer({ port: 4400, otherPort: 4401 });
console.log(`Sample course pack: ${fx.origin}/healthy/  (index of pages: see fixtures/README.md)`);
console.log('Press Ctrl+C to stop.');
process.on('SIGINT', () => void fx.close().then(() => process.exit(0)));
