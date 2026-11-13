import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionId, CheckResultId, CourseState, Finding, FindingId, ProjectId, RuleId, ScanRun, StateId } from '@cqa/shared';
import { buildScanConfig, compareRuns, newId, nowIso } from '@cqa/core';
import { type Harness, createHarness } from './support/harness.js';

const COURSE = 'https://course.example.com/lesson/';
let h: Harness;
let projectId: ProjectId;
beforeEach(() => {
  h = createHarness({ resolver: async () => ['93.184.215.14'] });
  projectId = h.store.createProject({ name: 'Compare', courseUrl: COURSE }).id;
});
afterEach(async () => {
  await h.close();
});

interface Spec { sizes?: Array<{ name: string; width: number; height: number }>; url?: string; findings?: Array<{ fp: string; rule: string; key?: string; family?: string; screen?: 1 | 2 }>; passed?: Array<{ rule: string; key?: string; family?: string; screen?: 1 | 2 }>; second?: 'same' | 'renamed' | 'none'; browser?: string; status?: 'completed' | 'partial' | 'failed' }

/** A run with an opening screen and, optionally, a second one reached by "Next" (or by another route with the same title). */
function run(s: Spec): ScanRun {
  const url = s.url ?? COURSE;
  const config = buildScanConfig({ projectId, url: new URL(url) });
  if (s.sizes) config.viewports = s.sizes.map((v) => ({ ...config.viewports[0]!, ...v }));
  const r = h.store.createRun(config, url);
  const mk = (path: ActionId[], title: string): CourseState => ({ id: newId<StateId>(), runId: r.id, url: url as never, title, signature: newId(), openDialogs: [], selectedTabs: [], depth: path.length, pathFromRoot: path, surfaces: [{ kind: 'document' }], viewportName: 'desktop', capturedAt: nowIso() });
  const one = mk([], 'Welcome');
  h.store.insertState(one);
  let two: CourseState | undefined;
  if ((s.second ?? 'same') !== 'none') {
    const action = newId<ActionId>();
    two = mk([action], 'Policies');
    h.store.insertState(two);
    h.store.insertActions([{ id: action, runId: r.id, kind: 'click', fromStateId: one.id, toStateId: two.id, targetDescription: s.second === 'renamed' ? 'link "Policies"' : 'button "Next"', outcome: 'succeeded', adapter: 'generic' } as never]);
  }
  const screen = (n?: 1 | 2) => (n === 2 ? two! : one).id;
  if (s.browser) h.store.setRunEnvironment(r.id, { engine: 'chromium', version: s.browser, userAgent: 'x', headless: true }, []);
  for (const f of s.findings ?? []) {
    h.store.upsertFinding({ id: newId<FindingId>(), runId: r.id, ruleId: f.rule as RuleId, category: 'runtime', type: 'automated_defect', severity: 'high', confidence: 'high', title: `Finding ${f.fp}`, fingerprint: f.fp, location: { stateId: screen(f.screen), url: url as never }, occurrences: [{ location: { stateId: screen(f.screen) }, checkResultIds: [], evidenceIds: [], observed: 'x' }], observed: 'o', expected: 'e', evidenceIds: [], reproductionSteps: [], remediation: 'r', standards: [], reviewer: { status: 'open', updatedAt: nowIso() }, createdAt: nowIso(), ...(f.key ? { checkKey: f.key } : {}), ...(f.family ? { checkFamily: f.family } : {}) } as Finding);
  }
  for (const p of s.passed ?? []) h.store.insertCheckResult({ id: newId<CheckResultId>(), runId: r.id, ruleId: p.rule as RuleId, stateId: screen(p.screen), outcome: 'passed', durationMs: 1, evidenceIds: [], executedAt: nowIso(), ...(p.key ? { targetKey: p.key } : {}), ...(p.family ? { targetFamily: p.family } : {}) });
  h.store.finishRun(r.id, { status: s.status ?? 'completed' });
  return h.store.getRun(r.id)!;
}
const statusOf = (c: ReturnType<typeof compareRuns>, fp: string) => c!.findings.find((f) => f.fingerprint === fp)!;
const FP = (n: number) => String(n).repeat(64).slice(0, 64);

describe('comparing two scans of a course', () => {
  const before = () => run({ findings: [{ fp: FP(1), rule: 'FUN-001', key: 'tab-a', family: 'tab-a-family' }, { fp: FP(2), rule: 'FUN-001', key: 'tab-b', screen: 2 }, { fp: FP(3), rule: 'RUN-005' }] });

  it('sorts findings into new, still there, resolved and not retested, and says why', () => {
    const b = before();
    const a = run({ second: 'none', findings: [{ fp: FP(3), rule: 'RUN-005' }, { fp: FP(4), rule: 'RUN-002' }], passed: [{ rule: 'FUN-001', key: 'tab-a' }] });
    const c = compareRuns(h.store, b.id, a.id)!;
    expect(statusOf(c, FP(1))).toMatchObject({ status: 'resolved' });
    expect(statusOf(c, FP(2))).toMatchObject({ status: 'not_retested', reason: expect.stringMatching(/same screen was not reached/) });
    expect(statusOf(c, FP(3))).toMatchObject({ status: 'persistent' });
    expect(statusOf(c, FP(4))).toMatchObject({ status: 'new' });
    expect(c.counts).toEqual({ new: 1, persistent: 1, resolved: 1, not_retested: 1, incomparable: 0 });
  });

  it('a check that did not run again cannot resolve its finding, even though the finding is gone', () => {
    const c = compareRuns(h.store, before().id, run({ passed: [] }).id)!;
    expect(statusOf(c, FP(1))).toMatchObject({ status: 'not_retested', reason: expect.stringMatching(/did not run and pass/) });
  });

  it('a pass from a changed check (new case version, rule version or expectation) is not comparable', () => {
    const c = compareRuns(h.store, before().id, run({ passed: [{ rule: 'FUN-001', key: 'tab-a-v2', family: 'tab-a-family' }] }).id)!;
    expect(statusOf(c, FP(1))).toMatchObject({ status: 'incomparable', reason: expect.stringMatching(/check changed/) });
  });

  it('a different check passing under the same rule ID is neither a fix nor a change', () => {
    const c = compareRuns(h.store, before().id, run({ passed: [{ rule: 'FUN-001', key: 'accordion-z', family: 'accordion-family' }] }).id)!;
    expect(statusOf(c, FP(1))).toMatchObject({ status: 'not_retested' });
  });

  it('a different browser version makes exact checks not comparable', () => {
    const b = run({ findings: [{ fp: FP(1), rule: 'FUN-001', key: 'tab-a' }], browser: '156.0.1' });
    const a = run({ passed: [{ rule: 'FUN-001', key: 'tab-a' }], browser: '150.0.1' });
    const c = compareRuns(h.store, b.id, a.id)!;
    expect(c.comparable.differences.join(' ')).toMatch(/browser/);
    expect(statusOf(c, FP(1))).toMatchObject({ status: 'incomparable' });
  });

  it('a screen reached by a different route is not assumed to be the same, even with the same title', () => {
    const c = compareRuns(h.store, before().id, run({ second: 'renamed', passed: [{ rule: 'FUN-001', key: 'tab-b', screen: 2 }] }).id)!;
    expect(statusOf(c, FP(2))).toMatchObject({ status: 'not_retested', reason: expect.stringMatching(/titled "Policies" was reached by a different route/) });
  });

  it('an unfinished later scan confirms nothing, and a different course is not comparable at all', () => {
    expect(statusOf(compareRuns(h.store, before().id, run({ status: 'failed', passed: [{ rule: 'FUN-001', key: 'tab-a' }] }).id), FP(1))).toMatchObject({ status: 'not_retested', reason: expect.stringMatching(/did not finish/) });
    const other = compareRuns(h.store, before().id, run({ url: 'https://other.example.com/course/', passed: [{ rule: 'FUN-001', key: 'tab-a' }] }).id)!;
    expect(other.comparable.sameCourse).toBe(false);
    expect(other.counts.resolved).toBe(0);
    expect(statusOf(other, FP(1)).status).toBe('incomparable');
  });

  it('different screen sizes make even whole-screen findings not comparable', () => {
    const b = run({ findings: [{ fp: FP(5), rule: 'LAY-001' }], sizes: [{ name: 'desktop', width: 1280, height: 800 }] });
    const a = run({ passed: [{ rule: 'LAY-001' }], sizes: [{ name: 'desktop', width: 1920, height: 1080 }] });
    expect(statusOf(compareRuns(h.store, b.id, a.id), FP(5))).toMatchObject({ status: 'incomparable', reason: expect.stringMatching(/screen sizes/) });
  });

  it('a finding is new only where the earlier scan also looked', () => {
    const b = run({ second: 'none' });
    const a = run({ findings: [{ fp: FP(6), rule: 'RUN-002' }, { fp: FP(7), rule: 'RUN-002', screen: 2 }] });
    const c = compareRuns(h.store, b.id, a.id)!;
    expect(statusOf(c, FP(6))).toMatchObject({ status: 'new' });
    expect(statusOf(c, FP(7))).toMatchObject({ status: 'not_retested', reason: expect.stringMatching(/did not reach/) });
    const unfinished = run({ status: 'failed' });
    expect(statusOf(compareRuns(h.store, unfinished.id, run({ findings: [{ fp: FP(8), rule: 'RUN-002' }] }).id), FP(8))).toMatchObject({ status: 'not_retested' });
  });

  it('reads earlier to later whichever order it is asked in', () => {
    const b = before();
    const a = run({ second: 'none', findings: [{ fp: FP(4), rule: 'RUN-002' }], passed: [{ rule: 'FUN-001', key: 'tab-a' }] });
    expect(statusOf(compareRuns(h.store, a.id, b.id), FP(1))).toMatchObject({ status: 'resolved' });
  });

  it('the same address with a different query is the same course', () => {
    const b = run({ url: `${COURSE}?v=1`, findings: [{ fp: FP(1), rule: 'FUN-001', key: 'tab-a' }] });
    const a = run({ url: `${COURSE}?v=2`, passed: [{ rule: 'FUN-001', key: 'tab-a' }] });
    expect(compareRuns(h.store, b.id, a.id)!.comparable.sameCourse).toBe(true);
  });
});
