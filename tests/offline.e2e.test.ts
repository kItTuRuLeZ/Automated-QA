import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../apps/server/src/app.js';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';
import { type Harness, createHarness } from './support/harness.js';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const HOST = '127.0.0.1:4317';
let fx: FixtureServer;
let h: Harness;
const lookups: string[] = [];

beforeAll(async () => {
  fx = await startFixtureServer();
  h = createHarness({
    // A machine with no internet: any attempt to look up a hostname fails, and is recorded.
    resolver: async (host) => {
      lookups.push(host);
      throw new Error(`getaddrinfo ENOTFOUND ${host}`);
    },
    exemptAddresses: [
      { ip: '127.0.0.1', port: fx.port },
      { ip: '127.0.0.1', port: fx.otherPort },
    ],
  });
  h.startWorker();
});
afterAll(async () => {
  await h?.close();
  await fx?.close();
});

describe('offline scan of the sample course pack', () => {
  it('scans local fixtures end to end and produces every report format without any name lookup', async () => {
    const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/spa-lessons/`, { accessibility: true, layout: true, viewports: ['desktop', 'mobile'], maxStates: 6 }).id, 200_000);
    expect(['completed', 'partial']).toContain(run.status);
    expect(h.store.listStates(run.id).length).toBeGreaterThan(1);
    expect(h.store.listFindings(run.id).length + h.store.listCheckResults(run.id).length).toBeGreaterThan(0);

    const app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`] });
    try {
      for (const [ext, type, magic] of [
        ['json', 'application/json', '{'],
        ['html', 'text/html', '<!doctype html>'],
        ['pdf', 'application/pdf', '%PDF-'],
        ['xlsx', 'spreadsheetml', 'PK'],
      ] as const) {
        const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/export.${ext}`, headers: { host: HOST } });
        expect(res.statusCode, ext).toBe(200);
        expect(String(res.headers['content-type']), ext).toContain(type);
        expect(res.rawPayload.subarray(0, magic.length).toString(), ext).toBe(magic);
      }
    } finally {
      await app.close();
    }
    // Nothing needed the network: no hostname was ever looked up.
    expect(lookups).toEqual([]);
  });

  it('still refuses a local address that is not on the administrator list', async () => {
    const app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`] });
    try {
      const project = h.store.createProject({ name: 'Offline' });
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/scans`,
        headers: { host: HOST, 'x-qa-request': '1', 'content-type': 'application/json' },
        payload: { url: 'http://127.0.0.1:9/' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ ruleId: 'NET-001' });
    } finally {
      await app.close();
    }
  });
});
