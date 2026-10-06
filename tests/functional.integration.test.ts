import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BehaviorRule, ProjectId, RuleItem, TestExecution } from '@cqa/shared';
import { QaStore, buildScanConfig, newId, nowIso } from '@cqa/core';
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

const ITEMS: RuleItem[] = [{ label: 'Alpha' }, { label: 'Bravo' }, { label: 'Charlie' }, { label: 'Delta' }];

function rule(projectId: string, over: Partial<BehaviorRule> = {}): BehaviorRule {
  const at = nowIso();
  return {
    id: newId<string & { __brand: 'rule' }>(),
    projectId,
    title: 'Next is enabled after all four items',
    unitMatch: '',
    requiredItems: ITEMS,
    optionalItems: [],
    prerequisites: [],
    expectedEvent: 'next_enabled',
    eventTarget: 'Next',
    timingWindowMs: 2000,
    orderPolicy: 'any_order',
    repeatPolicy: 'once',
    resetPolicy: 'fresh_context',
    expectationSource: 'approved_case',
    reviewState: 'reviewed',
    createdAt: at,
    updatedAt: at,
    ...over,
  } as BehaviorRule;
}

/** Runs a functional scan of one fixture, with the given behavior rules, and returns the finished run. */
async function scan(path: string, opts: { rules?: Array<Partial<BehaviorRule>>; explore?: boolean } = {}) {
  const project = h.store.createProject({ name: `Functional ${path}` });
  for (const r of opts.rules ?? []) qa.saveRule(rule(project.id, r));
  const url = `${fx.origin}/${path}/`;
  const config = buildScanConfig({ projectId: project.id as ProjectId, url: new URL(url), explore: opts.explore ?? false, accessibility: false, layout: false, functional: true, qaProfile: 'functional', maxStates: 6, maxDepth: 2 });
  const queued = h.store.createRun(config, url);
  const run = await h.waitForTerminal(queued.id, 230_000);
  await h.worker!.idle(); // the run record is finalized just after the run status turns terminal
  const execs = qa.currentExecutions(run.id);
  const by = (id: string, status?: string) => execs.filter((e) => e.definitionId === id && (!status || e.status === status));
  return { run, execs, by, project };
}
const statuses = (list: TestExecution[]) => list.map((e) => e.status);

describe('behavior rules: the all-click scenario', () => {
  it('a correct four-item rule passes every scenario, with an ordered action trace and the unique-item count', async () => {
    const { run, execs, by } = await scan('logic-allclick-correct', { rules: [{}] });
    expect(['completed', 'partial']).toContain(run.status);
    for (const id of ['LOG-01', 'LOG-02', 'LOG-03', 'LOG-04']) expect(statuses(by(id)), id).toEqual(['passed']);
    const one = by('LOG-01')[0]!;
    expect(one.scope).toBe('functional');
    expect(one.expectedSource).toBe('approved_case');
    const actions = one.trace.filter((t) => t.step === 'action').map((t) => t.detail);
    expect(actions.filter((a) => a.startsWith('Activate "')).map((a) => a.match(/"(.+)"/)![1])).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    expect(one.trace.some((t) => t.step === 'observed' && /not true \(as expected\)/.test(t.detail))).toBe(true); // clean starting state confirmed
    expect(one.trace.some((t) => t.step === 'asserted' && /Event present after the final required item: true/.test(t.detail))).toBe(true);
    // The duplicate-click case clicked one item four times and the event still did not appear.
    const dup = by('LOG-03')[0]!;
    expect(dup.trace.filter((t) => t.step === 'action' && /Activate "Alpha"/.test(t.detail))).toHaveLength(4);
    expect(dup.trace.some((t) => t.step === 'asserted' && /stayed absent through the observation window/.test(t.detail))).toBe(true);
    // Every omission was tried, each from a clean screen.
    expect(by('LOG-02')[0]!.actual).toMatch(/Leave "Alpha" untouched.*Leave "Delta" untouched/);
    expect(execs.filter((e) => e.status === 'failed')).toEqual([]);
    expect(h.store.listFindings(run.id).filter((f) => f.ruleId.startsWith('FUN'))).toEqual([]);
  });

  it('an event that fires after three of four items fails, naming the violating action and count', async () => {
    const { run, by } = await scan('logic-allclick-early', { rules: [{}] });
    const early = by('LOG-01')[0]!;
    expect(early.status).toBe('failed');
    expect(early.reason).toMatch(/fired before the last required item/);
    expect(early.actual).toMatch(/After 3 clicks \(3 unique items: "Alpha", "Bravo", "Charlie"\)/);
    expect(by('LOG-02')[0]!.status).toBe('failed'); // omitting Delta still enables Next
    expect(by('LOG-02')[0]!.actual).toMatch(/After 3 clicks \(3 unique items/);
    const finding = h.store.listFindings(run.id).find((f) => f.ruleId === 'FUN-002')!;
    expect(finding.title).toMatch(/LOG-01 failed/);
    expect(finding.expected).toMatch(/reviewer-approved case/);
    expect(by('LOG-01')[0]!.evidenceIds.length).toBe(1); // a screenshot of the state at the failure
  });

  it('a counter that counts clicks instead of unique items is caught by the duplicate-click case', async () => {
    const { by } = await scan('logic-duplicate-bug', { rules: [{}] });
    expect(by('LOG-03')[0]!.status).toBe('failed');
    expect(by('LOG-03')[0]!.actual).toMatch(/After 4 clicks \(1 unique item: "Alpha"\)/);
    expect(by('LOG-01')[0]!.status).toBe('passed'); // with four different items it still completes
  });

  it('an order-dependent bug fails the order-independence case and passes when the course declares that sequence', async () => {
    const anyOrder = await scan('logic-order-dependent', { rules: [{ orderPolicy: 'any_order' }] });
    expect(anyOrder.by('LOG-01')[0]!.status).toBe('passed');
    expect(anyOrder.by('LOG-04')[0]!.status).toBe('failed');
    expect(anyOrder.by('LOG-04')[0]!.actual).toMatch(/reverse order/);
    const sequence = await scan('logic-order-dependent', { rules: [{ orderPolicy: 'sequence' }] });
    expect(sequence.by('LOG-05')[0]!.status).toBe('passed'); // valid sequence fires; the swapped one does not
    expect(sequence.by('LOG-05')[0]!.actual).toMatch(/wrong order/);
    expect(sequence.by('LOG-04')).toMatchObject([{ status: 'not_applicable', reason: expect.stringMatching(/order-independent/) }]);
  });

  it('an event that never fires fails; a delayed event passes only inside the declared timing window', async () => {
    const never = await scan('logic-never-fires', { rules: [{}] });
    expect(never.by('LOG-01')[0]!.status).toBe('failed');
    expect(never.by('LOG-01')[0]!.actual).toMatch(/did not happen within 2000 ms/);
    const slowOk = await scan('logic-delayed', { rules: [{ timingWindowMs: 3000 }] });
    expect(slowOk.by('LOG-01')[0]!.status).toBe('passed');
    const slowLate = await scan('logic-delayed', { rules: [{ timingWindowMs: 500 }] });
    expect(slowLate.by('LOG-01')[0]!.status).toBe('failed');
  });

  it('an optional item that quietly counts as a requirement is caught', async () => {
    const { by } = await scan('logic-optional-bug', { rules: [{ optionalItems: [{ label: 'Extra reading' }] }] });
    expect(by('LOG-02')[0]!.status).toBe('failed');
    expect(by('LOG-02')[0]!.actual).toMatch(/optional items/);
  });

  it('with no rule configured the expected behavior is unknown: manual review, never a pass', async () => {
    const { by, run } = await scan('logic-allclick-correct');
    for (const id of ['LOG-01', 'LOG-02', 'LOG-03', 'LOG-04', 'LOG-05']) {
      const e = by(id)[0]!;
      expect(e.status, id).toBe('manual_review_required');
      expect(e.reason, id).toMatch(/no behavior rule is configured/);
    }
    expect(qa.getProgress(run.id)!.counters.testsPassed).toBe(by('NAV-01', 'passed').length + by('ERR-01', 'passed').length + by('ERR-02', 'passed').length + qa.currentExecutions(run.id).filter((e) => e.status === 'passed' && !['NAV-01', 'ERR-01', 'ERR-02'].includes(e.definitionId)).length);
  });
});

describe('interaction cases from the test library', () => {
  it('working tabs, accordions, dialogs and Next/Previous pass, with real traces', async () => {
    const { run, by, execs } = await scan('functional-good', { explore: true });
    // Each screen the scan reached gets its own checks: two tabs, three accordion items (two buttons and a details element) and one dialog.
    const allPassed = (id: string, min: number) => {
      expect(by(id).length, id).toBeGreaterThanOrEqual(min);
      expect(new Set(statuses(by(id))), id).toEqual(new Set(['passed']));
    };
    allPassed('TAB-01', 1);
    allPassed('ACC-01', 3);
    allPassed('LAY-01', 1);
    allPassed('LAY-02', 1);
    expect(by('LAY-02')[0]!.actual).toMatch(/focus returned/);
    allPassed('NAV-02', 1);
    // Policy is not knowable, so the accordion-state case records what it saw and asks a person.
    expect(by('ACC-02')[0]!.status).toBe('manual_review_required');
    expect(by('ACC-02')[0]!.actual).toMatch(/Observed (single|multi)-open/);
    expect(by('STAT-01')[0]).toMatchObject({ status: 'not_applicable', reason: expect.stringMatching(/only apply to an uploaded course package/) });
    expect(execs.filter((e) => e.status === 'failed')).toEqual([]);
    const units = qa.listUnits(run.id);
    expect(units.filter((u) => u.kind === 'screen' && u.visitedAt).length).toBeGreaterThanOrEqual(1); // at least the opening screen is recorded as visited by a browser
  });

  it('each defect is reported against the interaction that has it, as a finding that flows into the issue list', async () => {
    const { run, by } = await scan('functional-broken', { explore: true });
    const tabs = by('TAB-01');
    expect(tabs.find((e) => /Detail/.test(e.trace.map((t) => t.detail).join(' ')))!.status).toBe('failed');
    expect(tabs.find((e) => /Detail/.test(e.trace.map((t) => t.detail).join(' ')))!.actual).toMatch(/panel it controls \(#panel-2\) was not visible/);
    const accs = by('ACC-01');
    expect(accs.filter((e) => e.status === 'failed')).toHaveLength(1);
    expect(accs.filter((e) => e.status === 'failed')[0]!.trace.some((t) => /Never opens/.test(t.detail))).toBe(true);
    expect(accs.filter((e) => e.status === 'passed')).toHaveLength(1);
    expect(by('LAY-02')[0]!.status).toBe('failed');
    expect(by('LAY-02')[0]!.reason).toMatch(/focus did not return/);
    expect(by('NAV-02')[0]!.status).toBe('failed');
    const findings = h.store.listFindings(run.id).filter((f) => f.ruleId === 'FUN-001');
    expect(findings.length).toBeGreaterThanOrEqual(4);
    expect(findings.every((f) => /starter baseline; a baseline, not a client requirement/.test(f.expected))).toBe(true);
  });
});

describe('progress, inventory and screen status come from stored records', () => {
  it('stores a stage history, strictly increasing events, counters that equal the rows, and completed-with-gaps for a course whose total is unknown', async () => {
    const { run, execs } = await scan('functional-good', { explore: true });
    const events = qa.listEvents(run.id);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const stages = events.filter((e) => e.type === 'stage_changed').map((e) => e.payload.stage);
    expect(stages).toEqual(expect.arrayContaining(['validating', 'discovering', 'running', 'finalizing']));
    expect(stages.indexOf('validating')).toBeLessThan(stages.indexOf('running'));
    const progress = qa.getProgress(run.id)!;
    expect(progress.stage).toBe('completed_with_gaps'); // a plain URL has no independent list of what the course contains
    expect(progress.lastSeq).toBe(events.length);
    const counts = (s: string) => execs.filter((e) => e.status === s).length;
    expect(progress.counters).toMatchObject({ testsPassed: counts('passed'), testsFailed: counts('failed'), testsManual: counts('manual_review_required'), testsBlocked: counts('blocked'), testsRunning: 0, testsPending: 0 });
    // A second recount changes nothing: no number can grow twice.
    qa.recount(run.id);
    qa.recount(run.id);
    expect(qa.getProgress(run.id)!.counters).toEqual(progress.counters);
    expect(events.at(-1)!.type).toBe('run_finalized');
    expect(events.filter((e) => e.type === 'test_started').length).toBe(events.filter((e) => e.type === 'test_finished').length);
  });
});
