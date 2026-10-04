import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScanRun } from '@cqa/shared';
import { buildRunReport } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
import { buildHtmlReport } from '../apps/server/src/export/html.js';
import { createPackageServer } from '../apps/server/src/package-server.js';
import { type Harness, createHarness } from './support/harness.js';
import { makeZip, manifest12, page } from './support/packages.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const HOST = '127.0.0.1:4317';
const hdr = { host: HOST, 'x-qa-request': '1' };
const json = { ...hdr, 'content-type': 'application/json' };

let h: Harness;
let app: ReturnType<typeof buildApp>;
let pkgServer: http.Server;
let pkgPort = 0;
let packagesDir = '';
let fakeApp: http.Server;
let fakeAppPort = 0;
let fakeAppHits: string[] = [];
let projectId = '';

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

beforeAll(async () => {
  pkgPort = await freePort();
  // Stands in for the application on its own port: package code must never be able to reach it.
  fakeApp = http.createServer((req, res) => {
    fakeAppHits.push(req.url ?? '');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }).end('[{"secret":"projects"}]');
  });
  await new Promise<void>((r) => fakeApp.listen(0, '127.0.0.1', r));
  fakeAppPort = (fakeApp.address() as AddressInfo).port;

  // The only exemption is the package server's own port; the fake app port is not exempt.
  h = createHarness({ resolver: async () => ['93.184.215.14'], exemptAddresses: [{ ip: '127.0.0.1', port: pkgPort }] });
  packagesDir = mkdtempSync(path.join(tmpdir(), 'cqa-pkgs-'));
  pkgServer = createPackageServer({ root: packagesDir, port: pkgPort });
  await new Promise<void>((r) => pkgServer.listen(pkgPort, '127.0.0.1', r));
  app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`], packages: { dir: packagesDir, port: pkgPort } });
  projectId = h.store.createProject({ name: 'Packages' }).id;
  h.startWorker();
});
afterAll(async () => {
  await app?.close();
  await new Promise((r) => pkgServer?.close(r));
  await new Promise((r) => fakeApp?.close(r));
  await h?.close();
});

const upload = (zip: Buffer, query = 'filename=course.zip') => app.inject({ method: 'POST', url: `/api/projects/${projectId}/packages?${query}`, headers: { ...hdr, 'content-type': 'application/zip' }, payload: zip });
const scan = (id: string, body: object) => app.inject({ method: 'POST', url: `/api/packages/${id}/scans`, headers: json, payload: body });
const QUICK = { explore: false, accessibility: false, layout: false, acknowledgeLocalExecution: true };
const get = (urlPath: string, opts: http.RequestOptions = {}) =>
  new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: pkgPort, path: urlPath, headers: { host: `127.0.0.1:${pkgPort}` }, ...opts }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });

describe('uploading packages', () => {
  it('rejects hostile archives with a PKG-001 reason and leaves no files behind', async () => {
    const before = readdirSync(packagesDir);
    for (const [zip, code] of [
      [makeZip({ '../evil.txt': 'x', 'index.html': 'x' }), 'unsafe_path'],
      [makeZip({ 'index.html': 'x', l: '/etc/passwd' }, { symlinks: ['l'] }), 'symlink'],
      [makeZip({ 'z.bin': new Uint8Array(8 * 1024 * 1024) }), 'ratio'],
      [Buffer.from('not a zip at all'), 'corrupt'],
    ] as const) {
      const res = await upload(zip);
      expect(res.statusCode, code).toBe(422);
      expect(res.json()).toMatchObject({ code, ruleId: 'PKG-001' });
    }
    expect(readdirSync(packagesDir)).toEqual(before);
    expect(existsSync(path.join(packagesDir, '..', 'evil.txt'))).toBe(false);
  });

  it('stores a valid package with its inspection, lists it, and deletes it with its files', async () => {
    const res = await upload(makeZip({ 'imsmanifest.xml': manifest12(), 'index.html': page('Lesson 1') }), 'filename=safety.zip');
    expect(res.statusCode).toBe(201);
    const pkg = res.json() as { id: string; name: string; sha256: string; inspection: { kind: string; launchChoices: unknown[] } };
    expect(pkg).toMatchObject({ name: 'Safety Basics', inspection: { kind: 'scorm12' } });
    expect(pkg.inspection.launchChoices).toHaveLength(1);
    expect(existsSync(path.join(packagesDir, pkg.id, 'content', 'index.html'))).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${projectId}/packages`, headers: { host: HOST } })).json()).toHaveLength(h.store.listPackages(projectId).length);
    expect((await app.inject({ method: 'DELETE', url: `/api/packages/${pkg.id}`, headers: hdr })).statusCode).toBe(204);
    expect(existsSync(path.join(packagesDir, pkg.id))).toBe(false);
  });

  it('keeps the package id when a fixed version is uploaded as a replacement', async () => {
    const first = (await upload(makeZip({ 'index.html': page('v1') }), 'filename=a.zip')).json() as { id: string };
    const second = await upload(makeZip({ 'index.html': page('v2') }), `filename=a.zip&replace=${first.id}`);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { id: string }).id).toBe(first.id);
    expect((await get(`/p/${first.id}/index.html`)).body).toContain('v2');
  });
});

describe('choosing what to scan', () => {
  const multi = makeZip({
    'imsmanifest.xml': manifest12({
      items: [{ id: 'i1', title: 'Intro', ref: 'r1' }, { id: 'i2', title: 'Module 2', ref: 'r2' }],
      resources: '<resource identifier="r1" type="webcontent" adlcp:scormtype="sco" href="a.html"/><resource identifier="r2" type="webcontent" adlcp:scormtype="sco" href="b.html"/>',
    }),
    'a.html': page('A'),
    'b.html': page('B'),
  });

  it('will not silently pick one lesson, and needs the local-execution acknowledgement', async () => {
    const pkg = (await upload(multi)).json() as { id: string };
    const noChoice = await scan(pkg.id, QUICK);
    expect(noChoice.statusCode).toBe(422);
    expect(noChoice.json()).toMatchObject({ ruleId: 'PKG-007' });
    expect((noChoice.json() as { choices: unknown[] }).choices).toHaveLength(2);
    const noAck = await scan(pkg.id, { ...QUICK, acknowledgeLocalExecution: false, launch: 'all' });
    expect(noAck.statusCode).toBe(422);
    expect(noAck.json()).toMatchObject({ needsAcknowledgement: true });
    expect(h.store.listRuns(projectId)).toEqual([]);
  });

  it('records which lessons were and were not scanned, in the results of each scan', async () => {
    const pkg = (await upload(multi)).json() as { id: string };
    const some = await scan(pkg.id, { ...QUICK, launch: ['r2'] });
    expect(some.statusCode).toBe(201);
    const body = some.json() as { runs: ScanRun[]; scanned: string[]; notScanned: string[] };
    expect(body.scanned).toEqual(['Module 2']);
    expect(body.notScanned).toEqual(['Intro']);
    expect(body.runs[0]!.config.target).toMatchObject({ kind: 'package', launchEntry: 'r2', packageId: pkg.id });
    const f = h.store.listFindings(body.runs[0]!.id).find((x) => x.ruleId === 'PKG-007')!;
    expect(f.title).toBe('Scanned 1 of 2 lessons; 1 were not scanned');
    expect(f.observed).toMatch(/Not scanned: Intro/);
    expect(h.store.listCheckResults(body.runs[0]!.id).find((c) => c.ruleId === 'PKG-007')!.outcome).toBe('needs_review');

    const all = await scan(pkg.id, { ...QUICK, launch: 'all' });
    const runs = (all.json() as { runs: ScanRun[] }).runs;
    expect(runs).toHaveLength(2);
    for (const r of runs) expect(h.store.listCheckResults(r.id).find((c) => c.ruleId === 'PKG-007')!.outcome).toBe('passed');
    for (const r of [...body.runs, ...runs]) await h.waitForTerminal(r.id, 120_000);
  });
});

describe('scanning an uploaded package', () => {
  it('opens a valid package, reports what the files and the browser each showed, and keeps the app out of reach', async () => {
    const indexHtml = page(
      'Hostile lesson',
      `<button id="go">Go</button>
       <script src="js/App.js"></script>
       <script src="https://cdn.example.net/x.js"></script>
       <script>fetch('http://127.0.0.1:${fakeAppPort}/api/projects').then(r => r.text()).then(t => document.title = 'LEAKED ' + t).catch(() => {});</script>`,
    );
    const zip = makeZip({ 'imsmanifest.xml': manifest12(), 'index.html': indexHtml, 'js/app.js': 'window.loaded = true;' });
    const pkg = (await upload(zip, 'filename=hostile.zip')).json() as { id: string };
    const res = await scan(pkg.id, { acknowledgeLocalExecution: true, explore: false, accessibility: false, layout: false });
    expect(res.statusCode).toBe(201);
    const run = await h.waitForTerminal((res.json() as { runs: ScanRun[] }).runs[0]!.id, 120_000);
    expect(['completed', 'partial']).toContain(run.status);
    expect(h.store.listStates(run.id).length).toBe(1);

    // The application on another port was never reached, and nothing leaked into the page.
    expect(fakeAppHits).toEqual([]);
    expect(h.store.listStates(run.id)[0]!.title).not.toMatch(/LEAKED/);

    const findings = h.store.listFindings(run.id);
    const blocked = findings.filter((f) => f.ruleId === 'NET-002').map((f) => `${f.title} ${f.observed}`).join('\n');
    expect(blocked).toMatch(/cdn\.example\.net/);
    expect(blocked).toMatch(new RegExp(`127\\.0\\.0\\.1:${fakeAppPort}`));
    // Case mismatch: the file is js/app.js but the page asks for js/App.js. A case-sensitive server 404s; so does this one.
    expect(findings.some((f) => f.ruleId === 'RUN-004' && /App\.js/.test(f.title + f.observed))).toBe(true);
    // The same mistake is also found statically, from the files alone.
    const staticCase = findings.find((f) => f.ruleId === 'PKG-005');
    expect(staticCase).toMatchObject({ category: 'package' });
    expect(findings.find((f) => f.ruleId === 'PKG-006')).toBeDefined();

    // Reports keep static and runtime results apart and describe the package.
    const report = buildRunReport(h.store, run.id);
    expect(report.package).toMatchObject({ name: 'Safety Basics', launchTitle: 'Lesson 1', available: true });
    expect(report.package!.externalDependencies.map((d) => d.host)).toContain('cdn.example.net');
    expect(report.issues.filter((i) => i.source === 'static').every((i) => i.category === 'package')).toBe(true);
    expect(report.issues.some((i) => i.source === 'runtime')).toBe(true);
    const html = buildHtmlReport(report, {});
    expect(html).toContain('id="package"');
    expect(html).toContain('Static package check');
    // External links inside packages are never requested.
    expect(h.store.listCheckResults(run.id).every((c) => c.ruleId !== 'LNK-002' || c.outcome !== 'failed')).toBe(true);
  });

  it('serves only that package, read-only, from its own origin, with exact letter case', async () => {
    const a = (await upload(makeZip({ 'index.html': page('A'), 'Data/File.json': '{"a":1}' }), 'filename=a.zip')).json() as { id: string };
    const b = (await upload(makeZip({ 'index.html': page('B'), 'secret.txt': 'b-secret' }), 'filename=b.zip')).json() as { id: string };
    expect((await get(`/p/${a.id}/index.html`)).status).toBe(200);
    expect((await get(`/p/${a.id}/Data/File.json`)).headers['content-type']).toBe('application/json');
    expect((await get(`/p/${a.id}/data/file.json`)).status).toBe(404); // wrong letter case is a miss, as on a Linux server
    expect((await get(`/p/${a.id}/../${b.id}/content/secret.txt`)).status).toBeGreaterThanOrEqual(400);
    expect((await get(`/p/${a.id}/%2e%2e/${b.id}/content/secret.txt`)).status).toBeGreaterThanOrEqual(400);
    expect((await get(`/p/${a.id}/secret.txt`)).status).toBe(404);
    expect((await get(`/p/${a.id}/..%5C..%5Cqa.sqlite`)).status).toBe(400);
    expect((await get('/api/projects')).status).toBe(404);
    expect((await get(`/p/${a.id}/index.html`, { method: 'POST' })).status).toBe(405);
    expect((await get(`/p/${a.id}/index.html`, { headers: { host: 'evil.example:80' } })).status).toBe(421);
    const ok = await get(`/p/${a.id}/index.html`);
    expect(ok.headers['set-cookie']).toBeUndefined();
    expect(ok.headers['x-content-type-options']).toBe('nosniff');
    expect(ok.headers['cross-origin-resource-policy']).toBe('same-origin');
  });
});
