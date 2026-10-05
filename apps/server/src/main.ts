import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactStore, NetworkPolicy, PACKAGE_PORT, parseLocalTargets, SERVER_HOST, SERVER_PORT, Store, WEB_DEV_PORT, createLogger, openDatabase, resolveDataPaths, sweepRetention } from '@cqa/core';
import { buildApp } from './app.js';
import { type LanMode, resolveLanMode } from './lan.js';
import { createPackageServer } from './package-server.js';

const log = createLogger('server');
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

// Optional LAN demo mode (CQA_LAN_HOST + CQA_LAN_PASSWORD), off by default; see docs/LAN_DEMO.md.
// It changes only where the app itself listens. The package server below stays on loopback.
let lan: LanMode | undefined;
try {
  lan = resolveLanMode(process.env, os.networkInterfaces(), SERVER_PORT);
} catch (err) {
  log.error((err as Error).message);
  process.exit(1);
}
const appHost = lan?.host ?? SERVER_HOST;
// LAN mode accepts exactly one Host and Origin: the configured address and port. Loopback mode is unchanged.
const hosts = lan ? [`${lan.host}:${lan.port}`] : [`${SERVER_HOST}:${SERVER_PORT}`, `localhost:${SERVER_PORT}`, `${SERVER_HOST}:${WEB_DEV_PORT}`, `localhost:${WEB_DEV_PORT}`];
const app = buildApp({
  store,
  artifacts,
  policy: new NetworkPolicy({ exemptAddresses: [...localTargets.exemptions, { ip: '127.0.0.1', port: PACKAGE_PORT }] }),
  allowedHosts: hosts,
  allowedOrigins: hosts.map((h) => `http://${h}`),
  webDist: path.resolve(here, '../../web/dist'),
  packages: { dir: paths.packages, port: PACKAGE_PORT },
  capabilities: { localTargets: localTargets.exemptions, retentionDays, lanUrl: lan ? `http://${lan.host}:${lan.port}` : undefined },
  auth: lan ? { password: lan.password } : undefined,
});

// Loopback only by default. In LAN mode, only the one configured LAN address, and every request must be signed in.
await app.listen({ host: appHost, port: SERVER_PORT });
if (lan) log.warn({ url: `http://${lan.host}:${lan.port}`, dataDir: paths.root }, 'LAN demo mode: app listening on the local network, sign-in required (not reachable on 127.0.0.1)');
else log.info({ url: `http://${SERVER_HOST}:${SERVER_PORT}`, dataDir: paths.root }, 'server listening');

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
