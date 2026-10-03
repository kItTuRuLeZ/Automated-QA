import { ArtifactStore, NetworkPolicy, parseLocalTargets, Store, createLogger, openDatabase, resolveDataPaths } from '@cqa/core';
import { startWorker } from './worker.js';

const log = createLogger('worker');
const paths = resolveDataPaths();
// Off by default. An administrator can allow exact loopback address:port pairs (for the offline sample pack); see docs/SETUP.md.
const localTargets = parseLocalTargets(process.env.CQA_ALLOW_LOCAL_TARGETS);
for (const r of localTargets.rejected) log.warn({ entry: r.entry }, `CQA_ALLOW_LOCAL_TARGETS entry ignored: ${r.reason}`);
if (localTargets.exemptions.length) log.warn({ allowed: localTargets.exemptions }, 'Scanning of these local addresses is allowed by CQA_ALLOW_LOCAL_TARGETS');
const store = new Store(openDatabase(paths.dbFile));
const artifacts = new ArtifactStore(paths.artifacts, store);

// Production policy: no exemptions. Private, loopback, and reserved destinations are denied.
const worker = startWorker({ store, artifacts, policy: new NetworkPolicy({ exemptAddresses: localTargets.exemptions }), tmpRoot: paths.tmp, log });
log.info({ dataDir: paths.root }, 'worker started');

const shutdown = async () => {
  log.info('worker stopping');
  await worker.stop();
  store.db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
