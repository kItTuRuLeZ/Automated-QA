import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../apps/server/src/app.js';
import { type Harness, createHarness } from './support/harness.js';

const HOST = '127.0.0.1:4317';
const ORIGIN = `http://${HOST}`;
const json = { host: HOST, origin: ORIGIN, 'content-type': 'application/json', 'x-qa-request': '1' };

let h: Harness;
let app: FastifyInstance;

beforeEach(() => {
  // Resolver returns a public address so validation does not depend on real DNS.
  h = createHarness({ resolver: async () => ['93.184.215.14'] });
  app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [ORIGIN] });
});

afterEach(async () => {
  await app.close();
  await h.close();
});

async function createProject(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/projects', headers: json, payload: { name: 'Course A', courseUrl: 'https://course.example.com/' } });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe('request guard', () => {
  it('rejects unexpected Host headers (DNS rebinding against the API)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects', headers: { host: 'evil.example:4317' } });
    expect(res.statusCode).toBe(421);
  });

  it('rejects cross-origin requests', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', headers: { ...json, origin: 'https://evil.example' }, payload: { name: 'x' } });
    expect(res.statusCode).toBe(403);
  });

  it('requires the CSRF header and JSON content type on state-changing requests', async () => {
    const noHeader = await app.inject({ method: 'POST', url: '/api/projects', headers: { host: HOST, 'content-type': 'application/json' }, payload: { name: 'x' } });
    expect(noHeader.statusCode).toBe(403);
    const form = await app.inject({ method: 'POST', url: '/api/projects', headers: { host: HOST, 'x-qa-request': '1', 'content-type': 'application/x-www-form-urlencoded' }, payload: 'name=x' });
    expect(form.statusCode).toBe(415);
    expect(h.store.listProjects()).toHaveLength(0);
  });
});

describe('scan submission', () => {
  it('queues a valid scan with the configured scope, timeout, and viewport', async () => {
    const id = await createProject();
    const res = await app.inject({
      method: 'POST',
      url: `/api/projects/${id}/scans`,
      headers: json,
      payload: { url: 'https://course.example.com/lesson/1', allowedPathPrefixes: ['/lesson/'], navigationTimeoutMs: 15_000, viewport: { name: 'laptop', width: 1366, height: 768 } },
    });
    expect(res.statusCode).toBe(201);
    const run = res.json();
    expect(run.status).toBe('queued');
    expect(run.config.scope.allowedPathPrefixes).toEqual(['/lesson/']);
    expect(run.config.budgets.navigationTimeoutMs).toBe(15_000);
    expect(run.config.viewports[0]).toMatchObject({ name: 'laptop', width: 1366, height: 768 });
    expect(run.config.engines.advisory).toBe(false);
  });

  it.each(['http://127.0.0.1:8080/', 'http://169.254.169.254/', 'http://user:pw@course.example.com/', 'file:///C:/Windows/win.ini', 'http://[::1]/'])(
    'refuses denied target %s and never queues it',
    async (url) => {
      const id = await createProject();
      const res = await app.inject({ method: 'POST', url: `/api/projects/${id}/scans`, headers: json, payload: { url } });
      expect(res.statusCode).toBe(422);
      expect(res.json().ruleId).toBe('NET-001');
      expect(h.store.listRuns(id)).toHaveLength(0);
    },
  );

  it('refuses targets whose hostname resolves to a private address', async () => {
    const privateHarness = createHarness({ resolver: async () => ['10.0.0.8'] });
    const app2 = buildApp({ store: privateHarness.store, artifacts: privateHarness.artifacts, policy: privateHarness.policy, allowedHosts: [HOST], allowedOrigins: [ORIGIN] });
    try {
      const p = privateHarness.store.createProject({ name: 'p' });
      const res = await app2.inject({ method: 'POST', url: `/api/projects/${p.id}/scans`, headers: json, payload: { url: 'https://intranet.example.com/' } });
      expect(res.statusCode).toBe(422);
      expect(privateHarness.store.listRuns(p.id)).toHaveLength(0);
    } finally {
      await app2.close();
      await privateHarness.close();
    }
  });

  it('cancels a queued scan immediately', async () => {
    const id = await createProject();
    const run = (await app.inject({ method: 'POST', url: `/api/projects/${id}/scans`, headers: json, payload: { url: 'https://course.example.com/' } })).json();
    const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel`, headers: json, payload: {} });
    expect(res.json().status).toBe('cancelled');
    expect(h.store.getRun(run.id)?.status).toBe('cancelled');
  });
});

describe('artifact access', () => {
  it('serves artifacts by opaque ID only and rejects traversal or unknown IDs', async () => {
    const id = await createProject();
    const run = (await app.inject({ method: 'POST', url: `/api/projects/${id}/scans`, headers: json, payload: { url: 'https://course.example.com/' } })).json();
    const rec = h.artifacts.write(run.id, { kind: 'screenshot', mime: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) });

    const ok = await app.inject({ method: 'GET', url: `/api/artifacts/${rec.id}`, headers: { host: HOST } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');

    for (const bad of ['..%2F..%2Fqa.sqlite', '..%5C..%5Cqa.sqlite', 'qa.sqlite', '00000000-0000-0000-0000-000000000000']) {
      const res = await app.inject({ method: 'GET', url: `/api/artifacts/${bad}`, headers: { host: HOST } });
      expect(res.statusCode, bad).toBe(404);
    }
  });

  it('removes artifacts when a finished run is deleted', async () => {
    const id = await createProject();
    const run = (await app.inject({ method: 'POST', url: `/api/projects/${id}/scans`, headers: json, payload: { url: 'https://course.example.com/' } })).json();
    const rec = h.artifacts.write(run.id, { kind: 'screenshot', mime: 'image/png', bytes: new Uint8Array([1]) });
    await app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel`, headers: json, payload: {} });
    const del = await app.inject({ method: 'DELETE', url: `/api/runs/${run.id}`, headers: { host: HOST, 'x-qa-request': '1' } });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/artifacts/${rec.id}`, headers: { host: HOST } })).statusCode).toBe(404);
  });
});

describe('result integrity', () => {
  it('the database refuses not_tested or error results without a reason', () => {
    const p = h.store.createProject({ name: 'p' });
    const run = h.store.createRun({ projectId: p.id } as never, 'https://course.example.com/');
    expect(() =>
      h.store.db
        .prepare("INSERT INTO check_results (id, run_id, rule_id, outcome, duration_ms, data_json, executed_at) VALUES ('x', ?, 'RUN-001', 'not_tested', 0, '{}', 'now')")
        .run(run.id),
    ).toThrow(/CHECK constraint/);
  });

  it('summaries keep unique rules and executions separate and never fold not_tested into passes', () => {
    const p = h.store.createProject({ name: 'p' });
    const run = h.store.createRun({ projectId: p.id } as never, 'https://course.example.com/');
    const base = { runId: run.id, durationMs: 0, evidenceIds: [], executedAt: new Date().toISOString() };
    h.store.insertCheckResult({ ...base, id: 'a' as never, ruleId: 'RUN-001', outcome: 'passed' });
    h.store.insertCheckResult({ ...base, id: 'b' as never, ruleId: 'RUN-001', outcome: 'passed', viewportName: 'mobile' });
    h.store.insertCheckResult({ ...base, id: 'c' as never, ruleId: 'RUN-005', outcome: 'not_tested', reason: 'cancelled' });
    const s = h.store.summarizeRun(run.id);
    expect(s).toMatchObject({ uniqueRules: 2, executions: 3 });
    expect(s.byOutcome).toMatchObject({ passed: 2, not_tested: 1 });
  });
});
