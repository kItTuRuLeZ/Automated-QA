import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactStore, NetworkPolicy, SERVER_HOST, SERVER_PORT, Store, WEB_DEV_PORT, createLogger, openDatabase, resolveDataPaths } from '@cqa/core';
import { buildApp } from './app.js';

const log = createLogger('server');
const paths = resolveDataPaths();
const store = new Store(openDatabase(paths.dbFile));
const artifacts = new ArtifactStore(paths.artifacts, store);
const here = path.dirname(fileURLToPath(import.meta.url));

const hosts = [`${SERVER_HOST}:${SERVER_PORT}`, `localhost:${SERVER_PORT}`, `${SERVER_HOST}:${WEB_DEV_PORT}`, `localhost:${WEB_DEV_PORT}`];
const app = buildApp({
  store,
  artifacts,
  policy: new NetworkPolicy(),
  allowedHosts: hosts,
  allowedOrigins: hosts.map((h) => `http://${h}`),
  webDist: path.resolve(here, '../../web/dist'),
});

// Bound to loopback only. Network exposure requires authentication first (future work).
await app.listen({ host: SERVER_HOST, port: SERVER_PORT });
log.info({ url: `http://${SERVER_HOST}:${SERVER_PORT}`, dataDir: paths.root }, 'server listening');

const shutdown = async () => {
  await app.close();
  store.db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
