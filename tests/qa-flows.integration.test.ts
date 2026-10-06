import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProjectId, ScanRun } from '@cqa/shared';
import { QaStore, buildScanConfig, screenStatus } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
import { createPackageServer } from '../apps/server/src/package-server.js';
import { RunRecorder } from '../apps/worker/src/recorder.js';
import { type Harness, createHarness } from './support/harness.js';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';
import { makeZip, manifest12, page } from './support/packages.js';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

const HOST = '127.0.0.1:4317';
const hdr = { host: HOST, 'x-qa-request': '1' };
const json = { ...hdr, 'content-type': 'application/json' };

let h: Harness;
let fx: FixtureServer;
let app: ReturnType<typeof buildApp>;
let pkgServer: http.Server;
let qa: QaStore;
let projectId = '';

beforeAll(async () => {
  fx = await startFixtureServer();
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const pkgPort = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  h = createHarness({ exemptAddresses: [{ ip: '127.0.0.1', port: pkgPort }, { ip: '127.0.0.1', port: fx.port }] });
  const dir = mkdtempSync(path.join(tmpdir(), 'cqa-qaflows-'));
  pkgServer = createPackageServer({ root: dir, port: pkgPort });
  await new Promise<void>((r) => pkgServer.listen(pkgPort, '127.0.0.1', r));
  app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`], packages: { dir, port: pkgPort } });
  qa = new QaStore(h.store.db);
  projectId = h.store.createProject({ name: 'QA flows' }).id;
  h.startWorker();
});
afterAll(async () => {
  await app?.close();
  await new Promise((r) => pkgServer?.close(r));
  await h?.close();
  await fx?.close();
});

async function scanPackage(files: Record<string, string>, body: Record<string, unknown>): Promise<ScanRun> {
  const up = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/packages?filename=c.zip`, headers: { ...hdr, 'content-type': 'application/zip' }, payload: makeZip(files) });
  expect(up.statusCode, up.body).toBe(201);
  const pkg = up.json() as { id: string };
  const res = await app.inject({ method: 'POST', url: `/api/packages/${pkg.id}/scans`, headers: json, payload: { acknowledgeLocalExecution: true, ...body } });
  expect(res.statusCode, res.body).toBe(201);
  const run = await h.waitForTerminal((res.json() as { runs: ScanRun[] }).runs[0]!.id, 200_000);
  await h.worker!.idle();
  return run;
}

describe('a package whose own list names a lesson that was never opened', () => {
  it('lists it, says it was not reached, gives visit coverage with its denominator, and finishes completed with gaps', async () => {
    const files = {
      'imsmanifest.xml': manifest12({
        items: [
          { id: 'i1', title: 'Lesson 1: Opened', ref: 'r1' },
          { id: 'i2', title: 'Lesson 2: Listed but never opened', ref: 'r2' },
        ],
        resources: `<resource identifier="r1" type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource>
    <resource identifier="r2" type="webcontent" adlcp:scormtype="sco" href="lesson2.html"><file href="lesson2.html"/></resource>`,
      }),
      'index.html': page('Lesson 1', '<p>Hello</p>'),
      'lesson2.html': page('Lesson 2', '<p>Second</p>'),
    };
    const run = await scanPackage(files, { launch: ['r1'], explore: false, accessibility: false, layout: false, scorm: { enabled: false } });
    const units = qa.listUnits(run.id);
    const two = units.find((u) => u.title.startsWith('Lesson 2'))!;
    expect(two).toMatchObject({ source: 'manifest', confidence: 'high', kind: 'sco' });
    expect(two.visitedAt).toBeUndefined();
    expect(two.notReachedReason).toMatch(/No control the scanner could operate led here|stopped/);
    const cov = (await app.inject({ method: 'GET', url: `/api/runs/${run.id}/coverage`, headers: { host: HOST } })).json().coverage;
    expect(cov.discovery.completeness).toBe('partial'); // the opened page is a run-time screen the manifest does not list on its own
    expect(cov.visit).toMatchObject({ available: true, numerator: 1, denominator: 2 });
    expect(cov.gaps.unitsNotReached.map((u: { title: string }) => u.title)).toEqual(['Lesson 2: Listed but never opened']);
    expect(cov.statement).toMatch(/1 of 2 discovered screens visited/);
    const progress = qa.getProgress(run.id)!;
    expect(progress.stage).toBe('completed_with_gaps');
    expect(progress.counters.unitsDiscovered).toBe(2);
    expect(progress.counters.unitsVisited).toBe(1);
  });
});

describe('Quick check on a package', () => {
  it('records only static results, labels them static, and never calls the screen functionally tested', async () => {
    const files = { 'imsmanifest.xml': manifest12(), 'index.html': page('Quick', '<p>Static</p>') };
    const run = await scanPackage(files, { explore: false, accessibility: false, layout: false, functional: false, qaProfile: 'quick', scorm: { enabled: false } });
    const execs = qa.currentExecutions(run.id);
    expect(execs.length).toBeGreaterThan(0);
    expect(execs.every((e) => e.scope === 'static' && e.definitionId.startsWith('STAT-'))).toBe(true);
    expect(execs.map((e) => e.definitionId).sort()).toEqual(['STAT-01', 'STAT-02', 'STAT-03']);
    expect(execs.find((e) => e.definitionId === 'STAT-01')!.status).toBe('passed');
    // No interaction case and no manual-review queue appear: this profile does not claim to have looked at behavior.
    expect(execs.some((e) => e.status === 'manual_review_required' && !e.definitionId.startsWith('STAT-'))).toBe(false);
    const units = qa.listUnits(run.id);
    const withStatic = units.find((u) => execs.some((e) => e.unitId === u.id))!;
    const result = screenStatus(withStatic, execs, []);
    expect(result.scope).toBe('static');
    expect(result.badges).toContain('static_only');
    expect(result.reasons.join(' ')).toMatch(/Functional behavior was not tested/);
    expect(run.config.engines.functional).toBeFalsy();
  });
});

describe('cancellation and interruption', () => {
  it('a cancelled scan keeps its partial results and leaves unexecuted checks as skipped, never as passed', async () => {
    const project = h.store.createProject({ name: 'Cancel me' });
    const url = `${fx.origin}/functional-good/`;
    const queued = h.store.createRun(buildScanConfig({ projectId: project.id as ProjectId, url: new URL(url), explore: true, accessibility: false, layout: false, functional: true, maxStates: 6, maxDepth: 2 }), url);
    // Cancel as soon as the functional tests are planned.
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && !qa.currentExecutions(queued.id).some((e) => e.status === 'pending' || e.status === 'running')) await new Promise((r) => setTimeout(r, 100));
    h.store.requestCancel(queued.id);
    const run = await h.waitForTerminal(queued.id, 120_000);
    await h.worker!.idle();
    expect(run.status).toBe('cancelled');
    const progress = qa.getProgress(queued.id)!;
    expect(progress.stage).toBe('cancelled');
    const execs = qa.currentExecutions(queued.id);
    expect(execs.some((e) => e.status === 'pending' || e.status === 'running')).toBe(false); // nothing left half-done
    const stopped = execs.filter((e) => e.status === 'skipped' || e.status === 'error');
    expect(stopped.length).toBeGreaterThan(0);
    expect(stopped.every((e) => /cancelled|stopped|ran out of time/i.test(e.reason ?? ''))).toBe(true);
    expect(progress.counters.testsPending + progress.counters.testsRunning).toBe(0);
    expect(qa.listEvents(queued.id).at(-1)!.type).toBe('run_finalized');
  });

  it('marks a check that was running when the worker died as an error and the rest as skipped, and finalizing twice changes nothing', () => {
    const project = h.store.createProject({ name: 'Crash' });
    const run = h.store.createRun(buildScanConfig({ projectId: project.id as ProjectId, url: new URL('https://course.example.com/') }), 'https://course.example.com/');
    const rec = new RunRecorder(qa, run.id);
    qa.ensureProgress(run.id, 'running');
    const base = { runId: run.id, definitionVersion: 1, trace: [], evidenceIds: [], scope: 'functional' as const };
    qa.insertExecution({ ...base, definitionId: 'TAB-01', status: 'passed' });
    qa.insertExecution({ ...base, definitionId: 'ACC-01', status: 'running' });
    qa.insertExecution({ ...base, definitionId: 'LAY-01', status: 'pending' });
    const first = rec.finalize('failed', 'worker stopped');
    const countersAfterFirst = qa.getProgress(run.id)!.counters;
    const eventsAfterFirst = qa.listEvents(run.id).length;
    const second = rec.finalize('failed', 'worker stopped');
    expect(first).toBe('failed');
    expect(second).toBe('failed');
    expect(qa.getProgress(run.id)!.counters).toEqual(countersAfterFirst);
    expect(qa.listEvents(run.id)).toHaveLength(eventsAfterFirst); // the retry added no event
    const by = Object.fromEntries(qa.currentExecutions(run.id).map((e) => [e.definitionId, e]));
    expect(by['TAB-01']!.status).toBe('passed');
    expect(by['ACC-01']).toMatchObject({ status: 'error' });
    expect(by['ACC-01']!.reason).toMatch(/stopped before this check finished/);
    expect(by['LAY-01']).toMatchObject({ status: 'skipped' });
    expect(countersAfterFirst).toMatchObject({ testsPassed: 1, testsErrored: 1, testsSkipped: 1, testsRunning: 0, testsPending: 0 });
    rec.stop();
  });
});

describe('the progress API after a refresh', () => {
  it('rebuilds the same run view from stored records, with no duplicate events', async () => {
    const project = h.store.createProject({ name: 'Refresh' });
    const url = `${fx.origin}/logic-allclick-correct/`;
    const queued = h.store.createRun(buildScanConfig({ projectId: project.id as ProjectId, url: new URL(url), explore: false, accessibility: false, layout: false, functional: true }), url);
    await h.waitForTerminal(queued.id, 200_000);
    await h.worker!.idle();
    const get = async (p: string) => (await app.inject({ method: 'GET', url: p, headers: { host: HOST } })).json();
    const a = await get(`/api/runs/${queued.id}/progress`);
    const b = await get(`/api/runs/${queued.id}/progress`); // a second tab, or the same one after a refresh
    expect(b.progress).toEqual(a.progress);
    const all = (await get(`/api/runs/${queued.id}/events?after=0`)).events as Array<{ seq: number }>;
    const twice = [...all, ...(((await get(`/api/runs/${queued.id}/events?after=0`)).events as Array<{ seq: number }>))];
    // A client that applies only events above the last sequence it has seen ends with each event exactly once.
    let last = 0;
    const applied: number[] = [];
    for (const e of twice) if (e.seq > last) (applied.push(e.seq), (last = e.seq));
    expect(applied).toEqual(all.map((e) => e.seq));
    expect(a.progress.stage).toMatch(/completed/);
    expect(a.stalled).toBe(false);
  });
});
