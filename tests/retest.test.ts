import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionId, CheckResultId, CourseState, Finding, FindingId, ProjectId, RuleId, ScanRun, StateId } from '@cqa/shared';
import { applyRetestOutcome, buildRunReport, buildScanConfig, newId, nowIso } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
import { type Harness, createHarness } from './support/harness.js';

const COURSE = 'https://course.example.com/';
const HOST = '127.0.0.1:4317';
let h: Harness;
let projectId: ProjectId;
beforeEach(() => {
  h = createHarness({ resolver: async () => ['93.184.215.14'] });
  projectId = h.store.createProject({ name: 'Retest project', courseUrl: COURSE }).id;
});
afterEach(async () => {
  await h.close();
});

const FP = { gone: 'a1'.repeat(32), still: 'b2'.repeat(32), unreached: 'c3'.repeat(32), notFixed: 'd4'.repeat(32), accepted: 'e5'.repeat(32) };

/** A run with one opening screen and (optionally) a second reached by clicking "Next". */
function run(opts: { retestOf?: string; findings: string[]; passed: string[]; reachSecond?: boolean; status?: 'completed' | 'failed' }): { run: ScanRun } {
  const r = h.store.createRun(buildScanConfig({ projectId, url: new URL(COURSE) }), COURSE, opts.retestOf);
  const mk = (path: ActionId[], title: string): CourseState => ({ id: newId<StateId>(), runId: r.id, url: COURSE as never, title, signature: newId(), openDialogs: [], selectedTabs: [], depth: path.length, pathFromRoot: path, surfaces: [{ kind: 'document' }], viewportName: 'desktop', capturedAt: nowIso() });
  const s1 = mk([], 'one');
  h.store.insertState(s1);
  let s2: CourseState | undefined;
  if (opts.reachSecond !== false) {
    const actionId = newId<ActionId>();
    s2 = mk([actionId], 'two');
    h.store.insertState(s2);
    h.store.insertActions([{ id: actionId, runId: r.id, kind: 'click', fromStateId: s1.id, toStateId: s2.id, targetDescription: 'button "Next"', outcome: 'succeeded', adapter: 'generic' } as never]);
  }
  // FP.unreached lives on the second screen (rule RUN-003); the others on the opening screen (RUN-005).
  for (const fp of opts.findings) {
    const sid = fp === FP.unreached ? (s2 ?? s1).id : s1.id;
    h.store.upsertFinding({
      id: newId<FindingId>(), runId: r.id, ruleId: (fp === FP.unreached ? 'RUN-003' : 'RUN-005') as RuleId, category: 'runtime', type: 'automated_defect', severity: 'high', confidence: 'high', title: `T ${fp.slice(0, 2)}`, fingerprint: fp,
      location: { stateId: sid, url: COURSE as never }, occurrences: [{ location: { stateId: sid }, checkResultIds: [], evidenceIds: [], observed: 'x' }], observed: 'o', expected: 'e', evidenceIds: [], reproductionSteps: [], remediation: 'r', standards: [],
      reviewer: { status: 'open', updatedAt: nowIso() }, createdAt: nowIso(),
    } as Finding);
  }
  for (const entry of opts.passed) {
    const [ruleId, screen] = entry.split('@') as [string, string];
    h.store.insertCheckResult({ id: newId<CheckResultId>(), runId: r.id, ruleId: ruleId as RuleId, stateId: (screen === '2' ? s2!.id : s1.id) as StateId, outcome: 'passed', durationMs: 1, evidenceIds: [], executedAt: nowIso() });
  }
  h.store.finishRun(r.id, { status: opts.status ?? 'completed' });
  return { run: h.store.getRun(r.id)! };
}
const statusOf = (fp: string) => h.store.getWorkflow(projectId, fp)?.status ?? 'open';

describe('finding workflow and retest', () => {
  it('Verified only when claimed fixed, gone, and the rule passed on the equivalent screen; everything else stays distinct', () => {
    const before = run({ findings: [FP.gone, FP.still, FP.unreached, FP.notFixed, FP.accepted], passed: [] });
    for (const fp of [FP.gone, FP.still, FP.unreached]) h.store.setWorkflow(projectId, fp, { status: 'fixed' }, { actor: 't' });
    h.store.setWorkflow(projectId, FP.accepted, { status: 'accepted_risk', reason: 'Known and approved' }, { actor: 't' });

    // Retest: RUN-005 passes on screen one; screen two ("Next") is not reached again; FP.still is found again.
    const after = run({ retestOf: before.run.id, findings: [FP.still], passed: ['RUN-005@1'], reachSecond: false });
    const summary = applyRetestOutcome(h.store, after.run.id);

    expect(statusOf(FP.gone)).toBe('verified');
    expect(statusOf(FP.still)).toBe('open');
    expect(statusOf(FP.unreached)).toBe('not_retested');
    expect(statusOf(FP.notFixed)).toBe('not_reproduced');
    expect(statusOf(FP.accepted)).toBe('accepted_risk');
    expect(summary).toEqual({ verified: 1, notReproduced: 1, notRetested: 1, reopened: 1 });
    expect(h.store.listHistory(projectId, FP.gone).map((x) => x.to)).toEqual(['fixed', 'verified']);
    expect(h.store.listFindings(before.run.id).length).toBe(5);
  });

  it('a retest that did not finish confirms nothing', () => {
    const before = run({ findings: [FP.gone], passed: [] });
    h.store.setWorkflow(projectId, FP.gone, { status: 'fixed' }, { actor: 't' });
    const after = run({ retestOf: before.run.id, findings: [], passed: ['RUN-005@1'], status: 'failed' });
    applyRetestOutcome(h.store, after.run.id);
    expect(statusOf(FP.gone)).toBe('not_retested');
  });

  it('a rule that did not run is not treated as passing', () => {
    const before = run({ findings: [FP.gone], passed: [] });
    h.store.setWorkflow(projectId, FP.gone, { status: 'retest' }, { actor: 't' });
    const after = run({ retestOf: before.run.id, findings: [], passed: [] });
    applyRetestOutcome(h.store, after.run.id);
    expect(statusOf(FP.gone)).toBe('not_retested');
  });

  it('status set by hand shows in the report; accepted risk needs a reason; retest-only states are refused; retest links a new run', async () => {
    const { run: r } = run({ findings: [FP.gone], passed: [] });
    const app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`] });
    try {
      const f = h.store.listFindings(r.id)[0]!;
      const patch = (payload: object) => app.inject({ method: 'PATCH', url: `/api/findings/${f.id}/workflow`, headers: { host: HOST, 'x-qa-request': '1', 'content-type': 'application/json' }, payload });
      expect((await patch({ status: 'accepted_risk' })).statusCode).toBe(400);
      expect((await patch({ status: 'verified' })).statusCode).toBe(400);
      expect((await patch({ status: 'assigned', assignee: 'Priya' })).statusCode).toBe(200);
      expect((await patch({ status: 'false_positive', reason: 'Decorative image' })).statusCode).toBe(200);
      const issue = buildRunReport(h.store, r.id).issues.find((i) => i.findingId === f.id)!;
      expect(issue).toMatchObject({ status: 'false_positive', statusReason: 'Decorative image', assignee: 'Priya' });
      const hist = (await app.inject({ method: 'GET', url: `/api/findings/${f.id}/history`, headers: { host: HOST } })).json() as Array<{ to: string }>;
      expect(hist.map((x) => x.to)).toEqual(['assigned', 'false_positive']);

      const re = await app.inject({ method: 'POST', url: `/api/runs/${r.id}/retest`, headers: { host: HOST, 'x-qa-request': '1', 'content-type': 'application/json' }, payload: {} });
      expect(re.statusCode).toBe(201);
      expect(re.json()).toMatchObject({ retestOfRunId: r.id, status: 'queued' });
      expect((await app.inject({ method: 'POST', url: `/api/runs/${(re.json() as { id: string }).id}/retest`, headers: { host: HOST, 'x-qa-request': '1', 'content-type': 'application/json' }, payload: {} })).statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});
