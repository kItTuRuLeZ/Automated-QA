import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfo } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../apps/server/src/app.js';
import { resolveLanMode } from '../apps/server/src/lan.js';
import { type Harness, createHarness } from './support/harness.js';

const LAN = '192.168.1.50:4317';
const ORIGIN = `http://${LAN}`;
const PASSWORD = 'correct horse battery';
const json = { host: LAN, origin: ORIGIN, 'content-type': 'application/json', 'x-qa-request': '1' };
const form = { host: LAN, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' };

const nic = (address: string, internal = false): NetworkInterfaceInfo => ({ address, family: 'IPv4', internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24` });
const interfaces = { Ethernet: [nic('192.168.1.50')], Loopback: [nic('127.0.0.1', true)] };

describe('LAN mode settings', () => {
  it('is off unless CQA_LAN_HOST is set', () => {
    expect(resolveLanMode({}, interfaces, 4317)).toBeUndefined();
    expect(resolveLanMode({ CQA_LAN_PASSWORD: PASSWORD }, interfaces, 4317)).toBeUndefined();
  });

  it('accepts a private IPv4 address of this computer with a long enough password', () => {
    expect(resolveLanMode({ CQA_LAN_HOST: '192.168.1.50', CQA_LAN_PASSWORD: PASSWORD }, interfaces, 4317)).toEqual({ host: '192.168.1.50', port: 4317, password: PASSWORD });
  });

  it('refuses wildcard, loopback, public, link-local, unowned addresses and hostnames', () => {
    for (const host of ['0.0.0.0', '127.0.0.1', '8.8.8.8', '169.254.10.10', '192.168.1.99', 'my-pc', '::']) {
      expect(() => resolveLanMode({ CQA_LAN_HOST: host, CQA_LAN_PASSWORD: PASSWORD }, interfaces, 4317)).toThrow();
    }
  });

  it('refuses to start without a password of at least 12 characters', () => {
    expect(() => resolveLanMode({ CQA_LAN_HOST: '192.168.1.50' }, interfaces, 4317)).toThrow(/CQA_LAN_PASSWORD/);
    expect(() => resolveLanMode({ CQA_LAN_HOST: '192.168.1.50', CQA_LAN_PASSWORD: 'short' }, interfaces, 4317)).toThrow(/CQA_LAN_PASSWORD/);
  });
});

describe('LAN mode sign-in', () => {
  let h: Harness;
  let app: FastifyInstance;
  let clock = 1_000_000;

  beforeEach(() => {
    h = createHarness({ resolver: async () => ['93.184.215.14'] });
    app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [LAN], allowedOrigins: [ORIGIN], auth: { password: PASSWORD, sessionTtlMs: 60_000, maxFailures: 3, now: () => clock } });
  });

  afterEach(async () => {
    await app.close();
    await h.close();
  });

  async function signIn(): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/login', headers: form, payload: `password=${encodeURIComponent(PASSWORD)}&next=%2Fprojects` });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/projects');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    return cookie.split(';')[0]!;
  }

  it('blocks APIs, uploads, reports, artifacts and the UI until signed in', async () => {
    for (const url of ['/api/projects', '/api/health', '/api/runs/00000000-0000-4000-8000-000000000000/export.xlsx', '/api/artifacts/00000000-0000-4000-8000-000000000000']) {
      const res = await app.inject({ method: 'GET', url, headers: { host: LAN } });
      expect(res.statusCode, url).toBe(401);
    }
    const create = await app.inject({ method: 'POST', url: '/api/projects', headers: json, payload: { name: 'x' } });
    expect(create.statusCode).toBe(401);
    const upload = await app.inject({ method: 'POST', url: '/api/projects/00000000-0000-4000-8000-000000000000/packages', headers: { ...json, 'content-type': 'application/zip' }, payload: Buffer.from('PK') });
    expect(upload.statusCode).toBe(401);
    expect(h.store.listProjects()).toHaveLength(0);
    const ui = await app.inject({ method: 'GET', url: '/projects/abc', headers: { host: LAN } });
    expect(ui.statusCode).toBe(303);
    expect(ui.headers.location).toBe('/login?next=%2Fprojects%2Fabc');
    const login = await app.inject({ method: 'GET', url: '/login', headers: { host: LAN } });
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain('type="password"');
  });

  it('allows access after signing in, and the existing request checks still apply', async () => {
    const cookie = await signIn();
    const created = await app.inject({ method: 'POST', url: '/api/projects', headers: { ...json, cookie }, payload: { name: 'Course A' } });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { host: LAN, cookie } })).statusCode).toBe(200);
    // Signed in, but still: wrong Host, foreign Origin, missing CSRF header.
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { host: '127.0.0.1:4317', cookie } })).statusCode).toBe(421);
    expect((await app.inject({ method: 'POST', url: '/api/projects', headers: { ...json, cookie, origin: 'http://192.168.1.51:4317' }, payload: { name: 'y' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/projects', headers: { host: LAN, cookie, 'content-type': 'application/json' }, payload: { name: 'y' } })).statusCode).toBe(403);
    expect(h.store.listProjects()).toHaveLength(1);
  });

  it('checks Host and Origin before the sign-in page', async () => {
    expect((await app.inject({ method: 'GET', url: '/login', headers: { host: 'evil.example:4317' } })).statusCode).toBe(421);
    expect((await app.inject({ method: 'POST', url: '/login', headers: { ...form, origin: 'https://evil.example' }, payload: `password=${PASSWORD}` })).statusCode).toBe(403);
  });

  it('rejects wrong passwords, forged cookies, and locks out repeated failures', async () => {
    const forged = await app.inject({ method: 'GET', url: '/api/projects', headers: { host: LAN, cookie: 'cqa_session=forged' } });
    expect(forged.statusCode).toBe(401);
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'POST', url: '/login', headers: form, payload: 'password=wrong' });
      expect(res.statusCode).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    const locked = await app.inject({ method: 'POST', url: '/login', headers: form, payload: `password=${encodeURIComponent(PASSWORD)}` });
    expect(locked.statusCode).toBe(429);
    clock += 16 * 60 * 1000;
    await signIn();
  });

  it('ignores off-site return paths', async () => {
    const res = await app.inject({ method: 'POST', url: '/login', headers: form, payload: `password=${encodeURIComponent(PASSWORD)}&next=%2F%2Fevil.example` });
    expect(res.headers.location).toBe('/');
  });

  it('expires sessions and signs out', async () => {
    const cookie = await signIn();
    clock += 61_000;
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { host: LAN, cookie } })).statusCode).toBe(401);
    const again = await signIn();
    const out = await app.inject({ method: 'POST', url: '/logout', headers: { ...form, cookie: again } });
    expect(out.statusCode).toBe(303);
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { host: LAN, cookie: again } })).statusCode).toBe(401);
  });
});

describe('default loopback mode', () => {
  it('needs no sign-in and has no sign-in page', async () => {
    const h = createHarness({ resolver: async () => ['93.184.215.14'] });
    const app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: ['127.0.0.1:4317'], allowedOrigins: ['http://127.0.0.1:4317'] });
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { host: '127.0.0.1:4317' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/login', headers: { host: '127.0.0.1:4317', 'content-type': 'application/x-www-form-urlencoded' }, payload: 'password=x' })).statusCode).not.toBe(303);
    await app.close();
    await h.close();
  });
});
