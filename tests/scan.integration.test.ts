import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckResult } from '@cqa/shared';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';
import { type Harness, createHarness } from './support/harness.js';

let fx: FixtureServer;
let h: Harness;

const byRule = (checks: CheckResult[], ruleId: string) => checks.filter((c) => c.ruleId === ruleId);

beforeAll(async () => {
  fx = await startFixtureServer();
  h = createHarness({
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

describe('URL scan pipeline against local fixtures', () => {
  it('healthy page: queued → completed with real screenshot evidence and no findings', async () => {
    const queued = h.queueScan(`${fx.origin}/healthy/`);
    expect(queued.status).toBe('queued');
    const run = await h.waitForTerminal(queued.id);

    expect(run.status).toBe('completed');
    expect(run.browser?.engine).toBe('chromium');
    expect(run.toolVersions.map((t) => t.name)).toContain('playwright');
    expect(h.store.listFindings(run.id)).toEqual([]);

    const checks = h.store.listCheckResults(run.id);
    for (const rule of ['RUN-001', 'RUN-002', 'RUN-003', 'RUN-004', 'RUN-005', 'RUN-006', 'NET-002']) {
      expect(byRule(checks, rule)[0]?.outcome, rule).toBe('passed');
    }
    expect(byRule(checks, 'NET-003')[0]?.outcome).toBe('not_applicable');

    const states = h.store.listStates(run.id);
    expect(states).toHaveLength(1);
    expect(states[0]?.title).toBe('Healthy Fixture Course');

    const [shot] = h.store.listArtifacts(run.id);
    expect(shot?.mime).toBe('image/png');
    const bytes = readFileSync(h.artifacts.absolutePath(shot!));
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(shot?.sha256);
  });

  it('missing assets are reported as failed requests with the right resource types', async () => {
    const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/missing-asset/`).id);
    expect(run.status).toBe('completed');
    const failed = h.store.listFindings(run.id).filter((f) => f.ruleId === 'RUN-004');
    const urls = failed.map((f) => f.observed);
    expect(urls.some((u) => u.includes('/missing-asset/missing.js') && u.includes('HTTP 404'))).toBe(true);
    expect(urls.some((u) => u.includes('/missing-asset/missing.png') && u.includes('HTTP 404'))).toBe(true);
    expect(failed.find((f) => f.observed.includes('missing.js'))?.severity).toBe('high');
    expect(failed.find((f) => f.observed.includes('missing.png'))?.severity).toBe('medium');
    for (const f of failed) expect(f.reproductionSteps.length).toBeGreaterThan(1);
  });

  it('captures uncaught exceptions and console errors accurately', async () => {
    const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/js-exception/`).id);
    const findings = h.store.listFindings(run.id);
    const ex = findings.filter((f) => f.ruleId === 'RUN-002');
    const ce = findings.filter((f) => f.ruleId === 'RUN-003');
    expect(ex).toHaveLength(1);
    expect(ex[0]?.observed).toContain('Fixture exception on load');
    expect(ex[0]?.type).toBe('automated_defect');
    expect(ce.map((f) => f.observed)).toContain('Fixture console error');
    expect(ce[0]?.type).toBe('heuristic_warning');
    expect(findings.some((f) => f.ruleId === 'RUN-004')).toBe(false);
  });

  it('missing title is a standards warning', async () => {
    const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/no-title/`).id);
    const f = h.store.listFindings(run.id).find((x) => x.ruleId === 'RUN-005');
    expect(f?.type).toBe('standards_warning');
  });

  it('HTTP 404 document completes the scan with a critical RUN-001 finding', async () => {
    const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/http-404`).id);
    expect(run.status).toBe('completed');
    const f = h.store.listFindings(run.id).find((x) => x.ruleId === 'RUN-001');
    expect(f?.severity).toBe('critical');
    expect(f?.title).toContain('404');
  });

  it('in-scope redirect passes and records the final URL', async () => {
    const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/redirect/in`).id);
    expect(run.status).toBe('completed');
    expect(byRule(h.store.listCheckResults(run.id), 'NET-003')[0]?.outcome).toBe('passed');
    expect(h.store.listStates(run.id)[0]?.url).toBe(`${fx.origin}/healthy/`);
  });

  it('out-of-scope redirect is flagged and page checks are not counted as passed', async () => {
    const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/redirect/out`).id);
    expect(run.status).toBe('partial');
    expect(run.statusReason).toBe('out_of_scope');
    const checks = h.store.listCheckResults(run.id);
    expect(byRule(checks, 'NET-003')[0]?.outcome).toBe('needs_review');
    for (const rule of ['RUN-002', 'RUN-003', 'RUN-004', 'RUN-005']) {
      expect(byRule(checks, rule)[0]).toMatchObject({ outcome: 'not_tested', reason: 'out_of_scope' });
    }
  });

  it('subrequests to reserved addresses are blocked by the proxy and reported as NET-002, not course defects', async () => {
    const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/blocked-subrequest/`).id);
    const findings = h.store.listFindings(run.id);
    expect(findings.find((f) => f.ruleId === 'NET-002')?.observed).toContain('169.254.169.254');
    expect(findings.some((f) => f.ruleId === 'RUN-004')).toBe(false);
    expect(run.coverage?.blockedRequests).toBe(1);
  });

  it('navigation timeout fails the run with reason timeout and keeps evidence', async () => {
    const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/slow`, { navigationTimeoutMs: 2_000 }).id);
    expect(run.status).toBe('failed');
    expect(run.statusReason).toBe('timeout');
    const checks = h.store.listCheckResults(run.id);
    expect(byRule(checks, 'RUN-001')[0]).toMatchObject({ outcome: 'failed', reason: 'timeout' });
    expect(byRule(checks, 'RUN-005')[0]).toMatchObject({ outcome: 'not_tested' });
    expect(checks.some((c) => c.outcome === 'passed' && c.ruleId.startsWith('RUN-00') && c.ruleId !== 'RUN-001')).toBe(false);
  });

  it('cancellation stops a running scan, marks unexecuted checks not tested, and removes temp files', async () => {
    const queued = h.queueScan(`${fx.origin}/slow`, { navigationTimeoutMs: 30_000 });
    const deadline = Date.now() + 20_000;
    while (h.store.getRun(queued.id)?.status !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 1_500)); // let the browser start navigating
    expect(h.store.requestCancel(queued.id)).toBe('running');
    const started = Date.now();
    const run = await h.waitForTerminal(queued.id);
    expect(run.status).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(10_000);
    const checks = h.store.listCheckResults(run.id);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.outcome === 'not_tested' && c.reason === 'cancelled')).toBe(true);
    expect(existsSync(`${h.tmpRoot}/${run.id}`)).toBe(false);
  });

  it('cancelling a queued scan never launches it', async () => {
    await h.worker!.stop();
    const queued = h.queueScan(`${fx.origin}/healthy/`);
    expect(h.store.requestCancel(queued.id)).toBe('cancelled');
    h.startWorker();
    await new Promise((r) => setTimeout(r, 500));
    expect(h.store.getRun(queued.id)?.status).toBe('cancelled');
    expect(h.store.listArtifacts(queued.id)).toEqual([]);
  });
});

describe('restart recovery and run-time policy', () => {
  it('a run left running by a dead worker is marked failed (worker_lost) on restart, not re-run', async () => {
    const r = createHarness();
    try {
      const queued = r.queueScan('https://course.example.com/');
      expect(r.store.claimNextJob('dead-worker', 60_000)?.status).toBe('running');
      r.startWorker();
      await new Promise((res) => setTimeout(res, 300));
      const run = r.store.getRun(queued.id)!;
      expect(run).toMatchObject({ status: 'failed', statusReason: 'worker_lost' });
    } finally {
      await r.close();
    }
  });

  it('a target that resolves to a private address at run time is rejected before any browser launches', async () => {
    // Submission-time DNS said public; run-time DNS says loopback (rebinding).
    const r = createHarness({ resolver: async () => ['127.0.0.1'] });
    try {
      const queued = r.queueScan('https://rebind.example.com/');
      r.startWorker();
      const run = await r.waitForTerminal(queued.id);
      expect(run).toMatchObject({ status: 'failed', statusReason: 'blocked_by_policy' });
      expect(run.browser).toBeUndefined();
      expect(r.store.listArtifacts(run.id)).toEqual([]);
      expect(r.store.listCheckResults(run.id).every((c) => c.outcome === 'not_tested')).toBe(true);
      expect(readdirSync(r.tmpRoot)).toEqual([]);
    } finally {
      await r.close();
    }
  });
});

describe('false-positive regressions found on real courses', () => {
  it('a title set by script shortly after load is not reported as missing', async () => {
    const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/late-title/`, { explore: false }).id);
    expect(h.store.listFindings(run.id).some((f) => f.ruleId === 'RUN-005')).toBe(false);
    expect(h.store.listStates(run.id)[0]?.title).toBe('Late Title Fixture');
  });

  it('a request the page cancels itself (net::ERR_ABORTED) is not a failed request', async () => {
    const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/aborted-fetch/`, { explore: false }).id);
    expect(h.store.listFindings(run.id).some((f) => f.ruleId === 'RUN-004')).toBe(false);
  });
});
