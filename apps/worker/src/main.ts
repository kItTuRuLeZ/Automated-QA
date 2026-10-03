import { ArtifactStore, NetworkPolicy, Store, createLogger, openDatabase, resolveDataPaths } from '@cqa/core';
import { startWorker } from './worker.js';

const log = createLogger('worker');
const paths = resolveDataPaths();
const store = new Store(openDatabase(paths.dbFile));
const artifacts = new ArtifactStore(paths.artifacts, store);

// Production policy: no exemptions. Private, loopback, and reserved destinations are denied.
const worker = startWorker({ store, artifacts, policy: new NetworkPolicy(), tmpRoot: paths.tmp, log });
log.info({ dataDir: paths.root }, 'worker started');

const shutdown = async () => {
  log.info('worker stopping');
  await worker.stop();
  store.db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
