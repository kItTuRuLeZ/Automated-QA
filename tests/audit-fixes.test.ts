import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckResultId, CourseState, Finding, FindingId, ProjectId, RuleId, ScanRun, StateId } from '@cqa/shared';
import { QaStore, applyRetestOutcome, buildScanConfig, newId, nowIso, seedStarterLibrary } from '@cqa/core';
import { type FunctionalInput, resolveSharedControls, runFunctionalTests } from '../apps/worker/src/engines/functional.js';
import { STALE_AFTER_MS, workerLockPath } from '../apps/worker/src/worker-lock.js';
import { type Harness, createHarness } from './support/harness.js';

const COURSE = 'https://course.example.com/';
let h: Harness;
let projectId: ProjectId;
beforeEach(() => {
  h = createHarness({ resolver: async () => ['93.184.215.14'] });
  projectId = h.store.createProject({ name: 'Audit', courseUrl: COURSE }).id;
});
afterEach(async () => {
  await h.close();
});

describe('A1: a retest must re-run the exact check it claims to confirm', () => {
  const FP = 'a1'.repeat(32);
  const KEY_A = 'TAB-01@1|accordion-a|expected-1';
  const KEY_B = 'TAB-01@1|accordion-b|expected-1';

  function run(opts: { retestOf?: string; finding?: Partial<Finding>; passed?: Array<string | undefined>; browser?: string; ruleId?: string; noScreen?: boolean }): ScanRun {
    const r = h.store.createRun(buildScanConfig({ projectId, url: new URL(COURSE) }), COURSE, opts.retestOf);
    const state: CourseState = { id: newId<StateId>(), runId: r.id, url: COURSE as never, title: 'one', signature: newId(), openDialogs: [], selectedTabs: [], depth: 0, pathFromRoot: [], surfaces: [{ kind: 'document' }], viewportName: 'desktop', capturedAt: nowIso() };
    h.store.insertState(state);
    if (opts.browser) h.store.setRunEnvironment(r.id, { engine: 'chromium', version: opts.browser, userAgent: 'x', headless: true }, []);
    if (opts.finding) {
      h.store.upsertFinding({ id: newId<FindingId>(), runId: r.id, ruleId: 'FUN-001' as RuleId, category: 'runtime', type: 'automated_defect', severity: 'high', confidence: 'high', title: 'Accordion A failed', fingerprint: FP, location: { stateId: state.id, url: COURSE as never }, occurrences: [{ location: { stateId: state.id }, checkResultIds: [], evidenceIds: [], observed: 'x' }], observed: 'o', expected: 'e', evidenceIds: [], reproductionSteps: [], remediation: 'r', standards: [], reviewer: { status: 'open', updatedAt: nowIso() }, createdAt: nowIso(), ...opts.finding } as Finding);
    }
    for (const targetKey of opts.passed ?? []) h.store.insertCheckResult({ id: newId<CheckResultId>(), runId: r.id, ruleId: (opts.ruleId ?? 'FUN-001') as RuleId, ...(opts.noScreen ? {} : { stateId: state.id }), outcome: 'passed', durationMs: 1, evidenceIds: [], executedAt: nowIso(), ...(targetKey ? { targetKey } : {}) });
    h.store.finishRun(r.id, { status: 'completed' });
    return h.store.getRun(r.id)!;
  }
  const claimedFixed = (over: Partial<Finding>, browser?: string) => {
    const before = run({ finding: over, browser });
    h.store.setWorkflow(projectId, FP, { status: 'fixed' }, { actor: 't' });
    return before;
  };
  const statusOf = () => h.store.getWorkflow(projectId, FP)?.status;

  it('stays not retested when a different interaction with the same rule passes', () => {
    const before = claimedFixed({ checkKey: KEY_A });
    applyRetestOutcome(h.store, run({ retestOf: before.id, passed: [KEY_B] }).id);
    expect(statusOf()).toBe('not_retested');
  });

  it('is verified when that exact check runs again and passes', () => {
    const before = claimedFixed({ checkKey: KEY_A });
    applyRetestOutcome(h.store, run({ retestOf: before.id, passed: [KEY_B, KEY_A] }).id);
    expect(statusOf()).toBe('verified');
  });

  it('a changed expectation or version is a different check, so it cannot verify the old one', () => {
    const before = claimedFixed({ checkKey: KEY_A });
    applyRetestOutcome(h.store, run({ retestOf: before.id, passed: ['TAB-01@2|accordion-a|expected-2'] }).id);
    expect(statusOf()).toBe('not_retested');
  });

  it('a result from a different browser version is not comparable', () => {
    const before = claimedFixed({ checkKey: KEY_A }, '156.0.1');
    applyRetestOutcome(h.store, run({ retestOf: before.id, passed: [KEY_A], browser: '150.0.1' }).id);
    expect(statusOf()).toBe('not_retested');
    expect(h.store.getWorkflow(projectId, FP)?.reason).toMatch(/browser/i);
  });

  it('an older functional finding with no recorded check identity is never verified by a rule-level pass', () => {
    const before = claimedFixed({});
    applyRetestOutcome(h.store, run({ retestOf: before.id, passed: [undefined, KEY_A] }).id);
    expect(statusOf()).toBe('not_retested');
  });
});

describe('A1: which findings need an exact match', () => {
  const FP = 'b7'.repeat(32);
  function run(opts: { retestOf?: string; ruleId: string; checkKey?: string; withFinding?: boolean; passed?: string; noScreen?: boolean; browser?: string }): ScanRun {
    const r = h.store.createRun(buildScanConfig({ projectId, url: new URL(COURSE) }), COURSE, opts.retestOf);
    const state: CourseState = { id: newId<StateId>(), runId: r.id, url: COURSE as never, title: 'one', signature: newId(), openDialogs: [], selectedTabs: [], depth: 0, pathFromRoot: [], surfaces: [{ kind: 'document' }], viewportName: 'desktop', capturedAt: nowIso() };
    h.store.insertState(state);
    if (opts.browser) h.store.setRunEnvironment(r.id, { engine: 'chromium', version: opts.browser, userAgent: 'x', headless: true }, []);
    if (opts.withFinding) h.store.upsertFinding({ id: newId<FindingId>(), runId: r.id, ruleId: opts.ruleId as RuleId, category: 'runtime', type: 'automated_defect', severity: 'high', confidence: 'high', title: 'T', fingerprint: FP, location: { stateId: state.id, url: COURSE as never }, occurrences: [{ location: { stateId: state.id }, checkResultIds: [], evidenceIds: [], observed: 'x' }], observed: 'o', expected: 'e', evidenceIds: [], reproductionSteps: [], remediation: 'r', standards: [], reviewer: { status: 'open', updatedAt: nowIso() }, createdAt: nowIso(), ...(opts.checkKey ? { checkKey: opts.checkKey } : {}) } as Finding);
    if (opts.passed !== undefined) h.store.insertCheckResult({ id: newId<CheckResultId>(), runId: r.id, ruleId: opts.ruleId as RuleId, ...(opts.noScreen ? {} : { stateId: state.id }), outcome: 'passed', durationMs: 1, evidenceIds: [], executedAt: nowIso(), ...(opts.passed ? { targetKey: opts.passed } : {}) });
    h.store.finishRun(r.id, { status: 'completed' });
    return h.store.getRun(r.id)!;
  }
  const fixedThenRetest = (before: Parameters<typeof run>[0], after: Omit<Parameters<typeof run>[0], 'retestOf'>) => {
    const first = run({ ...before, withFinding: true });
    h.store.setWorkflow(projectId, FP, { status: 'fixed' }, { actor: 't' });
    applyRetestOutcome(h.store, run({ ...after, retestOf: first.id }).id);
    return h.store.getWorkflow(projectId, FP)?.status;
  };

  it('an older control finding with no identity is not verified by another control passing', () => {
    expect(fixedThenRetest({ ruleId: 'NAV-001' }, { ruleId: 'NAV-001', passed: 'some-other-control' })).toBe('not_retested');
  });

  it('a broken link can be verified even though link checks have no screen of their own', () => {
    expect(fixedThenRetest({ ruleId: 'LNK-001', checkKey: 'link-a' }, { ruleId: 'LNK-001', passed: 'link-a', noScreen: true })).toBe('verified');
  });

  it('and another link passing does not verify it', () => {
    expect(fixedThenRetest({ ruleId: 'LNK-001', checkKey: 'link-a' }, { ruleId: 'LNK-001', passed: 'link-b', noScreen: true })).toBe('not_retested');
  });

  it('a whole-screen rule is not held back by a browser update', () => {
    expect(fixedThenRetest({ ruleId: 'RUN-005', browser: '156.0.1' }, { ruleId: 'RUN-005', passed: '', browser: '150.0.1' })).toBe('verified');
  });
});

describe('A2: a second worker must not disturb a running scan', () => {
  function activeJob(workerId: string) {
    const run = h.queueScan(COURSE);
    expect(h.store.claimNextJob(workerId, 120_000)?.id).toBe(run.id);
    const dir = path.join(h.tmpRoot, `scan-${run.id}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'working-file'), 'x');
    return { run, dir };
  }

  it('refuses to start, leaving the active job and its files untouched', () => {
    h.startWorker();
    const { run, dir } = activeJob('worker-a');
    expect(() => h.startWorker()).toThrow(/already running/i);
    expect(h.store.getRun(run.id)?.status).toBe('running');
    expect(existsSync(path.join(dir, 'working-file'))).toBe(true);
  });

  it('a lock left by a dead process does not block recovery of its abandoned job', async () => {
    const { run, dir } = activeJob('dead-worker');
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
    writeFileSync(workerLockPath(h.tmpRoot), JSON.stringify({ pid: deadPid, startedAt: nowIso() }));
    h.startWorker();
    expect(h.store.getRun(run.id)).toMatchObject({ status: 'failed', statusReason: 'worker_lost' });
    expect(existsSync(dir)).toBe(false);
  });

  it('a process number reused by something else does not block the tool forever', () => {
    const { run } = activeJob('dead-worker');
    const file = workerLockPath(h.tmpRoot);
    writeFileSync(file, JSON.stringify({ pid: process.ppid, startedAt: nowIso() }));
    const old = new Date(Date.now() - STALE_AFTER_MS - 1_000);
    utimesSync(file, old, old);
    h.startWorker();
    expect(h.store.getRun(run.id)).toMatchObject({ statusReason: 'worker_lost' });
  });

  it('a recently refreshed lock from a live process is respected', () => {
    const { run } = activeJob('worker-a');
    writeFileSync(workerLockPath(h.tmpRoot), JSON.stringify({ pid: process.ppid, startedAt: nowIso() }));
    expect(() => h.startWorker()).toThrow(/already running/i);
    expect(h.store.getRun(run.id)?.status).toBe('running');
    rmSync(workerLockPath(h.tmpRoot));
  });

  it('a lock taken over by another copy is left alone when the old worker stops', async () => {
    const worker = h.startWorker();
    const file = workerLockPath(h.tmpRoot);
    writeFileSync(file, JSON.stringify({ pid: process.ppid, startedAt: nowIso() }));
    await worker.stop();
    expect(existsSync(file)).toBe(true);
    rmSync(file);
  });

  it('a stopped worker releases the lock so the tool can restart', async () => {
    await h.startWorker().stop();
    expect(existsSync(workerLockPath(h.tmpRoot))).toBe(false);
    expect(() => h.startWorker()).not.toThrow();
  });
});

describe('A4: only real player controls are shared between lessons', () => {
  let qa: QaStore;
  let run: ScanRun;

  /** Two visited lessons showing the given control. An expired deadline stops before any browser work, so this isolates planning. */
  async function plan(label: string, locator: string, signal = new AbortController().signal, deadline = 0) {
    qa = new QaStore(h.store.db);
    seedStarterLibrary(qa);
    run = h.queueScan(COURSE);
    const stateIds = ['s1', 's2'];
    qa.addUnits(run.id, ['l1', 'l2'].map((id, order) => ({ id, kind: 'lesson' as const, title: `Lesson ${order + 1}`, titleIsFallback: false, source: 'runtime' as const, confidence: 'high' as const, order })));
    ['l1', 'l2'].forEach((id, k) => qa.markVisited(run.id, id, stateIds[k]!));
    qa.addInteractions(run.id, ['l1', 'l2'].map((unitId) => ({ id: `i-${unitId}`, unitId, type: 'tab' as const, label, locator, confidence: 'high' as const, capabilities: ['activate'], detectedBy: 't', stateId: stateIds[['l1', 'l2'].indexOf(unitId)]! })));
    await runFunctionalTests({ browser: {} as never, run, targetUrl: COURSE, replay: stateIds.map((stateId) => ({ stateId, steps: [] })) as never, states: stateIds.map((id, depth) => ({ id, depth })) as never, qa, rec: {} as never, definitions: new Map(qa.listDefinitions().map((d) => [d.id, d])), rules: [], deadline, signal, evidence: {} as never, newContext: () => Promise.reject(new Error('no browser')) } as FunctionalInput);
    return qa.currentExecutions(run.id).filter((e) => e.definitionId === 'TAB-01');
  }

  it('two same-named lesson tabs at the same selector are each planned', async () => {
    const execs = await plan('tab "Overview"', '[role="tablist"] > :nth-child(1)');
    expect(execs).toHaveLength(2);
    expect(execs.map((e) => e.status)).toEqual(['skipped', 'skipped']);
    expect(execs.every((e) => /ran out of time/.test(e.reason ?? ''))).toBe(true);
  });

  it('a player control whose first test never ran does not claim it was tested elsewhere', async () => {
    const execs = await plan('tab "Resources"', '#link-resources');
    expect(execs).toHaveLength(2);
    expect(execs.map((e) => e.status)).toEqual(['skipped', 'skipped']);
    expect(execs.some((e) => /applies wherever|already tested/.test(e.reason ?? ''))).toBe(false);
  });

  it('a lesson tab named like a player control, found by position, is still tested on each lesson', async () => {
    const execs = await plan('tab "Notes"', '[role="tablist"] > :nth-child(1)');
    expect(execs.map((e) => e.reason)).toEqual(['The scan ran out of time before this check could run.', 'The scan ran out of time before this check could run.']);
  });

  it('a lesson tab whose name only starts like a player control is still tested on each lesson', async () => {
    const execs = await plan('tab "Notes on safety"', '#notes-safety');
    expect(execs.map((e) => e.reason)).toEqual(['The scan ran out of time before this check could run.', 'The scan ran out of time before this check could run.']);
  });

  it('cancelling a scan leaves no shared control waiting forever', async () => {
    const stop = new AbortController();
    stop.abort();
    await expect(plan('tab "Resources"', '#link-resources', stop.signal, Date.now() + 60_000)).rejects.toThrow('aborted');
    const copy = qa.currentExecutions(run.id).filter((e) => e.definitionId === 'TAB-01')[1]!;
    expect(copy.status).toBe('skipped');
    expect(copy.reason).toMatch(/could not be confirmed/);
  });

  describe('a shared result carries the first screen\'s real outcome', () => {
    const insert = (status: 'pending' | 'passed' | 'failed' | 'blocked') => qa.insertExecution({ runId: run.id, definitionId: 'TAB-01', definitionVersion: 1, status, trace: [], evidenceIds: [], scope: 'functional', ...(status === 'blocked' ? { reason: 'x' } : {}) });
    const settle = (status: 'passed' | 'failed' | 'blocked') => {
      qa = new QaStore(h.store.db);
      seedStarterLibrary(qa);
      run = h.queueScan(COURSE);
      const source = insert(status);
      const copy = insert('pending');
      resolveSharedControls(qa, [{ executionId: copy.id, sourceExecutionId: source.id, label: 'tab "Resources"', sourceTitle: 'Lesson 1' }]);
      return { source, copy: qa.currentExecutions(run.id).find((e) => e.id === copy.id)! };
    };

    it('passed: not repeated, linked to the source', () => {
      const { source, copy } = settle('passed');
      expect(copy.status).toBe('not_applicable');
      expect(copy.reason).toMatch(/passed on "Lesson 1"/);
      expect(copy.trace.some((t) => t.data?.sourceExecutionId === source.id)).toBe(true);
    });

    it('failed: says so, and never reads as a pass', () => {
      const { copy } = settle('failed');
      expect(copy.status).toBe('not_applicable');
      expect(copy.reason).toMatch(/failed on "Lesson 1"/);
    });

    it('blocked: stays a gap', () => {
      const { copy } = settle('blocked');
      expect(copy.status).toBe('skipped');
      expect(copy.reason).toMatch(/could not be confirmed/);
    });
  });
});
