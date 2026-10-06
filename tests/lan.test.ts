import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScanConfig } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
import { AuthGate, SESSION_COOKIE, readCookie } from '../apps/server/src/auth.js';
import { type Interfaces, isPrivateIPv4, resolveLanMode } from '../apps/server/src/lan.js';
import { type Harness, createHarness } from './support/harness.js';
import { makeZip, manifest12, page } from './support/packages.js';

const NICS = { Ethernet: [{ address: '192.168.1.50', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: '192.168.1.50/24' }], Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '255.0.0.0', mac: '00:00:00:00:00:00', cidr: '127.0.0.1/8' }] } as unknown as Interfaces;
const GOOD = { CQA_LAN_HOST: '192.168.1.50', CQA_LAN_PASSWORD: 'correct horse battery' };

describe('LAN mode settings', () => {
  it('stays this-computer-only when nothing is set', () => {
    expect(resolveLanMode({}, 4317, NICS)).toEqual({ mode: 'local' });
  });

  it('accepts one private address of this computer and allows exactly that Host and Origin', () => {
    const r = resolveLanMode(GOOD, 4317, NICS);
    expect(r).toMatchObject({ mode: 'lan', config: { host: '192.168.1.50', port: 4317, user: 'demo', allowedHosts: ['192.168.1.50:4317'], allowedOrigins: ['http://192.168.1.50:4317'] } });
  });

  it.each([
    ['0.0.0.0', /must not be 0\.0\.0\.0/],
    ['127.0.0.1', /must not be a loopback/],
    ['8.8.8.8', /must be a private network address/],
    ['192.168.1.51', /is not an address of this computer\. Private addresses found here: 192\.168\.1\.50/],
    ['my-laptop.local', /must be one IPv4 address/],
    ['192.168.1.0/24', /must be one IPv4 address/],
    ['::', /must be one IPv4 address/],
  ])('refuses CQA_LAN_HOST=%s', (host, msg) => {
    const r = resolveLanMode({ ...GOOD, CQA_LAN_HOST: host }, 4317, NICS);
    expect(r.mode).toBe('invalid');
    expect((r as { problems: string[] }).problems.join(' ')).toMatch(msg);
  });

  it('refuses a missing, short or user-name password, a bad user name, and credentials without a host, instead of falling back', () => {
    const problems = (env: NodeJS.ProcessEnv) => {
      const r = resolveLanMode(env, 4317, NICS);
      return r.mode === 'invalid' ? r.problems.join(' ') : `mode ${r.mode}`;
    };
    expect(problems({ CQA_LAN_HOST: '192.168.1.50' })).toMatch(/CQA_LAN_PASSWORD is required/);
    expect(problems({ ...GOOD, CQA_LAN_PASSWORD: 'short' })).toMatch(/at least 12 characters/);
    expect(problems({ ...GOOD, CQA_LAN_USER: 'demodemodemo', CQA_LAN_PASSWORD: 'DemoDemoDemo' })).toMatch(/must not be the same as the user name/);
    expect(problems({ ...GOOD, CQA_LAN_USER: 'a b' })).toMatch(/CQA_LAN_USER may use/);
    expect(problems({ CQA_LAN_PASSWORD: 'correct horse battery' })).toMatch(/CQA_LAN_PASSWORD is set but CQA_LAN_HOST is not/);
  });

  it('only treats RFC 1918 ranges as private', () => {
    expect(['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1'].every(isPrivateIPv4)).toBe(true);
    expect(['172.15.0.1', '172.32.0.1', '169.254.1.1', '100.64.0.1', '11.0.0.1', '192.169.0.1', '010.0.0.1'].some(isPrivateIPv4)).toBe(false);
  });

  it('the server refuses to start with an unsafe LAN setting and opens nothing', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'cqa-lan-start-'));
    let out = '';
    let code = 0;
    try {
      execFileSync(process.execPath, ['--import', 'tsx', path.resolve(import.meta.dirname, '../apps/server/src/main.ts')], {
        env: { ...process.env, CQA_DATA_DIR: dataDir, CQA_PORT: '4399', CQA_PACKAGE_PORT: '4398', CQA_LAN_HOST: '0.0.0.0', CQA_LAN_PASSWORD: 'correct horse battery' },
        stdio: 'pipe',
        timeout: 60_000,
      });
    } catch (e) {
      const err = e as { status: number; stdout: Buffer; stderr: Buffer };
      code = err.status;
      out = `${err.stdout}${err.stderr}`;
    }
    expect(code).toBe(1);
    expect(out).toMatch(/LAN demo mode settings are not safe to use/);
    expect(out).toMatch(/must not be 0\.0\.0\.0/);
    expect(out).not.toMatch(/correct horse battery/); // the password is never printed
    expect(out).not.toMatch(/server listening/);
  }, 90_000);
});

describe('sign-in gate', () => {
  it('locks an address out after five wrong tries, keeps other addresses working, and compares both fields', () => {
    let t = 1_000_000;
    const gate = new AuthGate({ user: 'demo', password: 'correct horse battery', now: () => t });
    for (let i = 0; i < 4; i++) expect(gate.login('demo', 'wrong', '10.0.0.9')).toEqual({ ok: false, status: 401 });
    expect(gate.login('demo', 'wrong', '10.0.0.9')).toMatchObject({ ok: false, status: 429 });
    expect(gate.login('demo', 'correct horse battery', '10.0.0.9')).toMatchObject({ ok: false, status: 429 }); // locked even with the right password
    expect(gate.login('other', 'correct horse battery', '10.0.0.8')).toEqual({ ok: false, status: 401 });
    expect(gate.login('demo', 'correct horse battery', '10.0.0.8').ok).toBe(true);
    t += 5 * 60 * 1000 + 1;
    expect(gate.login('demo', 'correct horse battery', '10.0.0.9').ok).toBe(true);
  });

  it('ends sessions after idle time, after the maximum time, and on sign-out', () => {
    let t = 0;
    const gate = new AuthGate({ user: 'demo', password: 'correct horse battery', now: () => t, idleMs: 1000, maxMs: 5000 });
    const a = gate.login('demo', 'correct horse battery', 'x');
    if (!a.ok) throw new Error('login failed');
    t = 900;
    expect(gate.validate(a.token)).toBe(true);
    t = 2000;
    expect(gate.validate(a.token)).toBe(false); // idle too long
    const b = gate.login('demo', 'correct horse battery', 'x');
    if (!b.ok) throw new Error('login failed');
    for (t = 2500; t <= 7000; t += 800) gate.validate(b.token);
    expect(gate.validate(b.token)).toBe(false); // past the maximum even while active
    const c = gate.login('demo', 'correct horse battery', 'x');
    if (!c.ok) throw new Error('login failed');
    gate.logout(c.token);
    expect(gate.validate(c.token)).toBe(false);
    expect(gate.validate(undefined)).toBe(false);
    expect(gate.validate('made-up')).toBe(false);
  });
});

describe('the app in LAN mode', () => {
  const HOST = '192.168.1.50:4317';
  const ORIGIN = `http://${HOST}`;
  let h: Harness;
  let app: ReturnType<typeof buildApp>;
  let runId = '';
  let projectId = '';
  let artifactId = '';

  beforeAll(async () => {
    h = createHarness();
    const web = mkdtempSync(path.join(tmpdir(), 'cqa-lan-web-'));
    writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>Course QA UI</title>');
    const pkgs = mkdtempSync(path.join(tmpdir(), 'cqa-lan-pkgs-'));
    mkdirSync(pkgs, { recursive: true });
    app = buildApp({
      store: h.store,
      artifacts: h.artifacts,
      policy: h.policy,
      allowedHosts: [HOST],
      allowedOrigins: [ORIGIN],
      webDist: web,
      packages: { dir: pkgs, port: 4318 },
      auth: new AuthGate({ user: 'demo', password: 'correct horse battery' }),
    });
    const p = h.store.createProject({ name: 'LAN project' });
    projectId = p.id;
    const run = h.store.createRun(buildScanConfig({ projectId: p.id, url: new URL('https://course.example.com/') }), 'https://course.example.com/');
    runId = run.id;
    artifactId = h.artifacts.write(run.id, { kind: 'screenshot', mime: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) }).id;
    h.store.finishRun(run.id, { status: 'completed' });
  });
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  const get = (url: string, cookie?: string, extra: Record<string, string> = {}) => app.inject({ method: 'GET', url, headers: { host: HOST, ...(cookie ? { cookie } : {}), ...extra } });
  const signIn = async (password = 'correct horse battery', remoteAddress = '192.168.1.20') => {
    const res = await app.inject({ method: 'POST', url: '/login', remoteAddress, headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ user: 'demo', password }).toString() });
    const set = String(res.headers['set-cookie'] ?? '');
    return { res, set, cookie: set ? `${SESSION_COOKIE}=${readCookie(set.split(';')[0], SESSION_COOKIE)}` : '' };
  };

  it('requires sign-in for the UI, every API, uploads, screenshots and reports', async () => {
    const ui = await get('/');
    expect(ui.statusCode).toBe(302);
    expect(ui.headers.location).toBe('/login');
    expect((await get('/assets/app.js')).statusCode).toBe(302);
    for (const url of ['/api/projects', `/api/runs/${runId}`, `/api/runs/${runId}/report`, `/api/runs/${runId}/export.html`, `/api/runs/${runId}/export.xlsx`, `/api/runs/${runId}/export.json`, `/api/artifacts/${artifactId}`, '/api/capabilities', '/api/health']) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(401);
      expect(r.body, url).not.toMatch(/LAN project|course\.example\.com/);
    }
    const upload = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/packages?filename=c.zip`, headers: { host: HOST, origin: ORIGIN, 'x-qa-request': '1', 'content-type': 'application/zip' }, payload: makeZip({ 'imsmanifest.xml': manifest12(), 'index.html': page('x') }) });
    expect(upload.statusCode).toBe(401);
    expect(h.store.listPackages(projectId)).toHaveLength(0);
    const scan = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/scans`, headers: { host: HOST, origin: ORIGIN, 'x-qa-request': '1', 'content-type': 'application/json' }, payload: { url: 'https://course.example.com/' } });
    expect(scan.statusCode).toBe(401);
    const login = await get('/login');
    expect(login.statusCode).toBe(200);
    expect(login.body).toMatch(/<form method="post" action="\/login">/);
    expect(login.body).not.toMatch(/<script/);
  });

  it('signs in with a strict, HttpOnly session cookie, then serves everything, marked not to be cached', async () => {
    const { res, set, cookie } = await signIn();
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/');
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).toMatch(/Path=\//);
    const ui = await get('/', cookie);
    expect(ui.statusCode).toBe(200);
    expect(ui.body).toMatch(/Course QA UI/);
    const projects = await get('/api/projects', cookie);
    expect(projects.statusCode).toBe(200);
    expect(projects.headers['cache-control']).toMatch(/no-store/);
    expect((await get(`/api/runs/${runId}/export.html`, cookie)).statusCode).toBe(200);
    expect((await get(`/api/artifacts/${artifactId}`, cookie)).statusCode).toBe(200);
    expect((await get('/api/session', cookie)).json()).toEqual({ lan: true, user: 'demo' });
  });

  it('a wrong password gets one generic message and no cookie', async () => {
    const { res, set } = await signIn('wrong password here', '192.168.1.30');
    expect(res.statusCode).toBe(401);
    expect(set).toBe('');
    expect(res.body).toMatch(/Sign-in failed\. Check the user name and password\./);
    expect(res.body).not.toMatch(/wrong password here/);
  });

  it('keeps the Host, Origin, cross-site and X-QA-Request checks for signed-in requests', async () => {
    const { cookie } = await signIn();
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { host: '127.0.0.1:4317', cookie } })).statusCode).toBe(421);
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { host: 'evil.example:4317', cookie } })).statusCode).toBe(421);
    expect((await get('/api/projects', cookie, { origin: 'http://192.168.1.99:4317' })).statusCode).toBe(403);
    expect((await get('/api/projects', cookie, { 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    const noHeader = await app.inject({ method: 'POST', url: '/api/projects', headers: { host: HOST, origin: ORIGIN, cookie, 'content-type': 'application/json' }, payload: { name: 'x' } });
    expect(noHeader.statusCode).toBe(403);
    // Sign-in itself is refused from another origin.
    const foreign = await app.inject({ method: 'POST', url: '/login', headers: { host: HOST, origin: 'http://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, payload: 'user=demo&password=correct+horse+battery' });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.headers['set-cookie']).toBeUndefined();
  });

  it('signing out ends the session', async () => {
    const { cookie } = await signIn();
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { host: HOST, origin: ORIGIN, cookie, 'x-qa-request': '1', 'content-type': 'application/json' }, payload: {} });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0/);
    expect((await get('/api/projects', cookie)).statusCode).toBe(401);
  });

  it('locks out an address after repeated wrong passwords', async () => {
    for (let i = 0; i < 5; i++) await signIn('nope nope nope', '192.168.1.40');
    const { res } = await signIn('correct horse battery', '192.168.1.40');
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });
});

describe('the app in default (this computer only) mode', () => {
  it('needs no sign-in and reports that LAN mode is off', async () => {
    const h = createHarness();
    const app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: ['127.0.0.1:4317'], allowedOrigins: ['http://127.0.0.1:4317'] });
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { host: '127.0.0.1:4317' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/session', headers: { host: '127.0.0.1:4317' } })).json()).toEqual({ lan: false });
    expect((await app.inject({ method: 'GET', url: '/login', headers: { host: '127.0.0.1:4317' } })).statusCode).toBe(404);
    await app.close();
    await h.close();
  });
});
