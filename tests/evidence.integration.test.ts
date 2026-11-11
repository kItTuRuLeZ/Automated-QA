import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BehaviorRule, ProjectId } from '@cqa/shared';
import { QaStore, buildScanConfig, newId, nowIso } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
import { type Harness, createHarness } from './support/harness.js';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

let fx: FixtureServer;
let h: Harness;
let qa: QaStore;

beforeAll(async () => {
  fx = await startFixtureServer();
  h = createHarness({ exemptAddresses: [{ ip: '127.0.0.1', port: fx.port }] });
  qa = new QaStore(h.store.db);
  h.startWorker();
});
afterAll(async () => {
  await h?.close();
  await fx?.close();
});

const ITEMS = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((label) => ({ label }));

async function scan(path: string, opts: { traces?: 'off' | 'first_failure' } = {}) {
  const project = h.store.createProject({ name: `Evidence ${path}` });
  const at = nowIso();
  qa.saveRule({ id: newId<string & { __brand: 'rule' }>(), projectId: project.id, title: 'Next after every item', unitMatch: '', requiredItems: ITEMS, optionalItems: [], prerequisites: [], expectedEvent: 'next_enabled', eventTarget: 'Next', timingWindowMs: 1000, orderPolicy: 'sequence', repeatPolicy: 'once', resetPolicy: 'fresh_context', expectationSource: 'approved_case', reviewState: 'reviewed', createdAt: at, updatedAt: at } as BehaviorRule);
  const url = `${fx.origin}/${path}/`;
  const config = buildScanConfig({ projectId: project.id as ProjectId, url: new URL(url), explore: false, accessibility: false, layout: false, functional: true, qaProfile: 'functional', maxStates: 6, maxDepth: 2, traces: opts.traces });
  const run = await h.waitForTerminal(h.store.createRun(config, url).id, 230_000);
  await h.worker!.idle();
  const execs = qa.currentExecutions(run.id);
  const one = (id: string) => execs.find((e) => e.definitionId === id)!;
  const evidenceOf = (id: string) => h.store.getEvidence(one(id).evidenceIds);
  return { run, one, evidenceOf };
}

describe('a browser trace is kept for a failed check', () => {
  it('the first failure has a trace file a reviewer can open, beside its screenshot', async () => {
    const { one, evidenceOf } = await scan('logic-allclick-early');
    expect(one('LOG-01').status).toBe('failed');
    const trace = evidenceOf('LOG-01').find((e) => e.kind === 'trace')!;
    expect(trace, 'a trace is attached').toBeTruthy();
    expect(trace.caption).toMatch(/Playwright Trace Viewer/);
    const art = h.store.getArtifact(trace.artifactId!)!;
    expect(art.mime).toBe('application/zip');
    const bytes = readFileSync(h.artifacts.absolutePath(art));
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(bytes.includes(Buffer.from('trace.trace'))).toBe(true);
    expect(evidenceOf('LOG-01').some((e) => e.kind === 'screenshot')).toBe(true);
  });

  it('a check that passes keeps no trace', async () => {
    const { one, evidenceOf } = await scan('logic-allclick-correct');
    expect(one('LOG-01').status).toBe('passed');
    expect(evidenceOf('LOG-01').some((e) => e.kind === 'trace')).toBe(false);
  });

  it('traces can be turned off, for pages with sensitive content', async () => {
    const { one, evidenceOf } = await scan('logic-allclick-early', { traces: 'off' });
    expect(one('LOG-01').status).toBe('failed');
    expect(evidenceOf('LOG-01').some((e) => e.kind === 'trace')).toBe(false);
  });

  it('the evidence archive includes the trace, listed in its manifest with a relative path', async () => {
    const { run } = await scan('logic-allclick-early');
    const HOST = '127.0.0.1:4317';
    const app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`], webDist: undefined });
    try {
      const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/evidence-archive.zip`, headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      const zipped = unzipSync(new Uint8Array(res.rawPayload));
      const manifest = JSON.parse(strFromU8(zipped['manifest.json']!)) as { files: Array<{ kind: string; file?: string; status: string }> };
      const entry = manifest.files.find((e) => e.kind === 'trace')!;
      expect(entry).toMatchObject({ status: 'included' });
      expect(entry.file).toMatch(/^evidence\/[0-9a-f-]+\.zip$/);
    } finally {
      await app.close();
    }
  });
});

describe('evidence that could not be saved is reported, never linked', () => {
  it('a failed save leaves a note on the result and no evidence link', async () => {
    const write = h.artifacts.write.bind(h.artifacts);
    h.artifacts.write = () => {
      throw new Error('disk full (simulated)');
    };
    try {
      const { one } = await scan('logic-allclick-early');
      const e = one('LOG-01');
      expect(e.status).toBe('failed');
      expect(e.evidenceIds).toEqual([]);
      expect(e.trace.some((t) => /The screenshot could not be saved: disk full \(simulated\)/.test(t.detail))).toBe(true);
      expect(e.trace.some((t) => /The browser trace could not be saved: disk full \(simulated\)/.test(t.detail))).toBe(true);
    } finally {
      h.artifacts.write = write;
    }
  });
});
