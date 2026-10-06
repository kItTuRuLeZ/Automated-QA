import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactStore, NetworkPolicy, PACKAGE_PORT, parseLocalTargets, SERVER_HOST, SERVER_PORT, Store, WEB_DEV_PORT, createLogger, openDatabase, resolveDataPaths, sweepRetention } from '@cqa/core';
import { buildApp } from './app.js';
import { createPackageServer } from './package-server.js';

const log = createLogger('server');
const paths = resolveDataPaths();
// Off by default. An administrator can allow exact loopback address:port pairs (for the offline sample pack); see docs/SETUP.md.
const localTargets = parseLocalTargets(process.env.CQA_ALLOW_LOCAL_TARGETS);
for (const r of localTargets.rejected) log.warn({ entry: r.entry }, `CQA_ALLOW_LOCAL_TARGETS entry ignored: ${r.reason}`);
if (localTargets.exemptions.length) log.warn({ allowed: localTargets.exemptions }, 'Scanning of these local addresses is allowed by CQA_ALLOW_LOCAL_TARGETS');
const allowPrivateAddresses = Boolean(process.env.CQA_ALLOW_INTRANET && process.env.CQA_ALLOW_INTRANET !== '0' && process.env.CQA_ALLOW_INTRANET !== 'false');
if (allowPrivateAddresses) {
  log.warn('CQA_ALLOW_INTRANET is enabled: Scanning of private intranet addresses (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) is allowed.');
}
const store = new Store(openDatabase(paths.dbFile));
const artifacts = new ArtifactStore(paths.artifacts, store);

// Optional clean-up of old scans at start-up (CQA_RETENTION_DAYS). Off unless set.
const retentionDays = Number(process.env.CQA_RETENTION_DAYS) > 0 ? Number(process.env.CQA_RETENTION_DAYS) : undefined;
if (retentionDays) {
  const swept = sweepRetention(store, artifacts, { days: retentionDays });
  log.info({ days: retentionDays, deleted: swept.deleted.length, keptLatest: swept.kept.latestForCourse, keptBaseline: swept.kept.holdsBaseline }, 'retention clean-up done');
}
const here = path.dirname(fileURLToPath(import.meta.url));

const hosts = [`${SERVER_HOST}:${SERVER_PORT}`, `localhost:${SERVER_PORT}`, `${SERVER_HOST}:${WEB_DEV_PORT}`, `localhost:${WEB_DEV_PORT}`];
const app = buildApp({
  store,
  artifacts,
  policy: new NetworkPolicy({ exemptAddresses: [...localTargets.exemptions, { ip: '127.0.0.1', port: PACKAGE_PORT }], allowPrivateAddresses }),
  allowedHosts: hosts,
  allowedOrigins: hosts.map((h) => `http://${h}`),
  webDist: path.resolve(here, '../../web/dist'),
  packages: { dir: paths.packages, port: PACKAGE_PORT },
  capabilities: { localTargets: localTargets.exemptions, retentionDays },
});

// Bound to loopback only. Network exposure requires authentication first (future work).
await app.listen({ host: SERVER_HOST, port: SERVER_PORT });
log.info({ url: `http://${SERVER_HOST}:${SERVER_PORT}`, dataDir: paths.root }, 'server listening');

// The restricted origin for uploaded packages: a different port from the app, loopback only, read-only.
const packageServer = createPackageServer({ root: paths.packages, port: PACKAGE_PORT });
await new Promise<void>((resolve, reject) => packageServer.once('error', reject).listen(PACKAGE_PORT, SERVER_HOST, resolve));
log.info({ url: `http://${SERVER_HOST}:${PACKAGE_PORT}` }, 'package server listening (separate origin)');

const shutdown = async () => {
  packageServer.close();
  await app.close();
  store.db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
