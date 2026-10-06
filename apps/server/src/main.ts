import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactStore, NetworkPolicy, PACKAGE_PORT, parseLocalTargets, SERVER_HOST, SERVER_PORT, Store, WEB_DEV_PORT, createLogger, openDatabase, resolveDataPaths, sweepRetention } from '@cqa/core';
import { buildApp } from './app.js';
import { AuthGate } from './auth.js';
import { resolveLanMode } from './lan.js';
import { createPackageServer } from './package-server.js';

const log = createLogger('server');

// Optional LAN demo mode (docs/LAN_DEMO.md). Decided before anything is opened; an unsafe setting stops the server
// instead of falling back. Only the app's own listener changes: core's SERVER_HOST and the package server stay loopback.
const lan = resolveLanMode(process.env, SERVER_PORT);
if (lan.mode === 'invalid') {
  console.error('LAN demo mode settings are not safe to use, so the app did not start:');
  for (const p of lan.problems) console.error(`  - ${p}`);
  console.error('See docs/LAN_DEMO.md. To run on this computer only, clear CQA_LAN_HOST, CQA_LAN_USER and CQA_LAN_PASSWORD.');
  process.exit(1);
}
const lanConfig = lan.mode === 'lan' ? lan.config : undefined;

const paths = resolveDataPaths();
// Off by default. An administrator can allow exact loopback address:port pairs (for the offline sample pack); see docs/SETUP.md.
const localTargets = parseLocalTargets(process.env.CQA_ALLOW_LOCAL_TARGETS);
for (const r of localTargets.rejected) log.warn({ entry: r.entry }, `CQA_ALLOW_LOCAL_TARGETS entry ignored: ${r.reason}`);
if (localTargets.exemptions.length) log.warn({ allowed: localTargets.exemptions }, 'Scanning of these local addresses is allowed by CQA_ALLOW_LOCAL_TARGETS');
const store = new Store(openDatabase(paths.dbFile));
const artifacts = new ArtifactStore(paths.artifacts, store);

// Optional clean-up of old scans at start-up (CQA_RETENTION_DAYS). Off unless set.
const retentionDays = Number(process.env.CQA_RETENTION_DAYS) > 0 ? Number(process.env.CQA_RETENTION_DAYS) : undefined;
if (retentionDays) {
  const swept = sweepRetention(store, artifacts, { days: retentionDays });
  log.info({ days: retentionDays, deleted: swept.deleted.length, keptLatest: swept.kept.latestForCourse, keptBaseline: swept.kept.holdsBaseline }, 'retention clean-up done');
}
const here = path.dirname(fileURLToPath(import.meta.url));

// Local mode: loopback Host values (and the Vite dev server). LAN mode: exactly the one LAN Host and Origin.
const localHosts = [`${SERVER_HOST}:${SERVER_PORT}`, `localhost:${SERVER_PORT}`, `${SERVER_HOST}:${WEB_DEV_PORT}`, `localhost:${WEB_DEV_PORT}`];
const allowedHosts = lanConfig ? lanConfig.allowedHosts : localHosts;
const allowedOrigins = lanConfig ? lanConfig.allowedOrigins : localHosts.map((h) => `http://${h}`);
const app = buildApp({
  store,
  artifacts,
  policy: new NetworkPolicy({ exemptAddresses: [...localTargets.exemptions, { ip: '127.0.0.1', port: PACKAGE_PORT }] }),
  allowedHosts,
  allowedOrigins,
  webDist: path.resolve(here, '../../web/dist'),
  packages: { dir: paths.packages, port: PACKAGE_PORT },
  capabilities: { localTargets: localTargets.exemptions, retentionDays, lanHost: lanConfig ? `${lanConfig.host}:${lanConfig.port}` : undefined },
  auth: lanConfig ? new AuthGate({ user: lanConfig.user, password: lanConfig.password }) : undefined,
});

// Default: loopback only. LAN demo mode: only the one private address named in CQA_LAN_HOST, with sign-in required.
const appHost = lanConfig?.host ?? SERVER_HOST;
if (lanConfig) log.warn({ url: `http://${lanConfig.host}:${SERVER_PORT}`, user: lanConfig.user }, 'LAN demo mode is ON: sign-in required, plain HTTP, not listening on 127.0.0.1. See docs/LAN_DEMO.md.');
await app.listen({ host: appHost, port: SERVER_PORT });
log.info({ url: `http://${appHost}:${SERVER_PORT}`, dataDir: paths.root }, 'server listening');

// The restricted origin for uploaded packages: a different port from the app, loopback only (in every mode), read-only.
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
