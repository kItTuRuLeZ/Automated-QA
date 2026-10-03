import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckResult, Finding, ScanRun, TraversalAction } from '@cqa/shared';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';
import { type Harness, createHarness } from './support/harness.js';

let fx: FixtureServer;
let h: Harness;

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

async function scan(path: string, opts: Parameters<Harness['queueScan']>[1] = {}) {
  const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/${path}`, opts).id, 120_000);
  return {
    run,
    states: h.store.listStates(run.id),
    actions: h.store.listActions(run.id),
    checks: h.store.listCheckResults(run.id),
    findings: h.store.listFindings(run.id),
  };
}

const actionsFor = (actions: TraversalAction[], name: string) => actions.filter((a) => a.targetDescription.includes(`"${name}"`));
const outcomes = (checks: CheckResult[], ruleId: string) => checks.filter((c) => c.ruleId === ruleId).map((c) => c.outcome);
const ruleFindings = (findings: Finding[], ruleId: string) => findings.filter((f) => f.ruleId === ruleId);

describe('bounded traversal against fixtures', () => {
  it('SPA lessons: follows Next/Back through hash-routed lessons and records each lesson as a state', async () => {
    const { run, states, actions, findings } = await scan('spa-lessons/');
    expect(run.status).toBe('completed');
    const lessonIds = new Set(states.map((s) => s.lessonId).filter(Boolean));
    expect(lessonIds).toEqual(new Set(['2', '3', '1']));
    expect(actionsFor(actions, 'Next').every((a) => a.outcome === 'succeeded')).toBe(true);
    // Disabled controls (Back on lesson 1, Next on lesson 3) are not attempted.
    expect(actions.some((a) => a.outcome === 'failed')).toBe(false);
    expect(findings).toEqual([]);
    expect(run.coverage?.statesReached).toBe(states.length);
  });

  it('tabs: working tabs pass, a tab that does not select fails NAV-001 with a reproducible path', async () => {
    const { actions, findings } = await scan('tabs/');
    expect(actionsFor(actions, 'Details').every((a) => a.outcome === 'succeeded')).toBe(true);
    expect(actionsFor(actions, 'Broken tab').every((a) => a.outcome === 'failed')).toBe(true);
    const [broken] = ruleFindings(findings, 'NAV-001');
    expect(broken?.title).toContain('Broken tab');
    expect(broken?.type).toBe('automated_defect');
    expect(broken?.reproductionSteps.at(-2)).toContain('Select tab "Broken tab"');
    expect(broken?.evidenceIds.length).toBeGreaterThan(0);
    expect(ruleFindings(findings, 'NAV-001')).toHaveLength(1);
  });

  it('accordion: expands working sections and <details>, flags the section that never expands', async () => {
    const { actions, findings } = await scan('accordion/');
    expect(actionsFor(actions, 'Section one')[0]?.outcome).toBe('succeeded');
    expect(actionsFor(actions, 'More information')[0]?.outcome).toBe('succeeded');
    expect(ruleFindings(findings, 'NAV-001').map((f) => f.title)).toEqual([expect.stringContaining('Broken section')]);
    // Already-expanded controls are not reported as unrecognized.
    expect(ruleFindings(findings, 'COV-001')).toEqual([]);
  });

  it('modal: a working dialog opens and closes; a dead opener and a dead close button are flagged', async () => {
    const { actions, findings } = await scan('modal/');
    expect(actionsFor(actions, 'Open glossary')[0]?.outcome).toBe('succeeded');
    expect(actions.some((a) => a.kind === 'close_dialog' && a.outcome === 'succeeded')).toBe(true);
    expect(ruleFindings(findings, 'NAV-001').map((f) => f.title)).toEqual([expect.stringContaining('Open help')]);
    expect(ruleFindings(findings, 'NAV-003')).toHaveLength(1);
  });

  it('navigation loop: a cycling Next button terminates without hitting a budget', async () => {
    const { run, states, actions } = await scan('nav-loop/');
    expect(run.status).toBe('completed');
    expect(states.length).toBeLessThanOrEqual(4);
    expect(run.coverage?.budgetsReached).toEqual([]);
    // The final Next returns to an already-known state instead of creating a new one.
    const last = actions.at(-1)!;
    expect(states.map((s) => s.id)).toContain(last.toStateId);
  });

  it('frames: out-of-scope, blocked, and not-yet-explored frames are disclosed, never counted as passed', async () => {
    const { checks, findings, states } = await scan('iframe/');
    expect(outcomes(checks, 'COV-002')).toEqual(['needs_review']);
    const titles = ruleFindings(findings, 'COV-002').map((f) => f.observed);
    expect(titles.some((t) => t.includes(fx.otherOrigin) && t.includes('out_of_scope'))).toBe(true);
    expect(titles.some((t) => t.includes('169.254.169.254'))).toBe(true);
    expect(titles.some((t) => t.includes('/healthy/') && t.includes('not_implemented'))).toBe(true);
    expect(states[0]?.surfaces.filter((s) => s.kind !== 'document').length).toBe(3);
    // Our own policy blocks are not reported as course console errors.
    expect(ruleFindings(findings, 'RUN-003')).toEqual([]);
  });

  it('canvas: canvas-rendered content is disclosed as unsupported', async () => {
    const { run, findings } = await scan('canvas/');
    expect(ruleFindings(findings, 'COV-003')[0]?.title).toContain('640×360');
    expect(run.coverage?.unsupportedSurfaces).toBe(1);
  });

  it('unsafe actions are skipped with reasons and never clicked', async () => {
    const { actions, findings, states } = await scan('unsafe-actions/');
    const byName = (n: string) => actionsFor(actions, n)[0];
    expect(byName('Send answer')).toMatchObject({ outcome: 'skipped', reason: 'unsafe_action' });
    expect(byName('Delete my progress')).toMatchObject({ outcome: 'skipped', reason: 'unsafe_action' });
    expect(byName('Buy certificate')).toMatchObject({ outcome: 'skipped', reason: 'unsafe_action' });
    expect(byName('Show hint')).toMatchObject({ outcome: 'skipped', reason: 'ambiguous_action' });
    // Clicking Delete/Buy would have changed the title; the only state is the untouched page.
    expect(states.map((s) => s.title)).toEqual(['Unsafe Actions Fixture']);
    expect(ruleFindings(findings, 'COV-001').length).toBe(4);
  });
});

describe('scan budgets', () => {
  const expectBudget = (run: ScanRun, findings: Finding[], reason: string) => {
    expect(run.status).toBe('partial');
    expect(run.coverage?.budgetsReached).toContain(reason);
    expect(ruleFindings(findings, 'COV-004')).toHaveLength(1);
  };

  it('max states stops exploration predictably and marks the run partial', async () => {
    const { run, states, findings } = await scan('spa-lessons/', { maxStates: 2 });
    expect(states).toHaveLength(2);
    expectBudget(run, findings, 'budget_states');
  });

  it('max depth limits how far from the start the scanner goes', async () => {
    const { run, states, findings } = await scan('spa-lessons/', { maxDepth: 1 });
    expect(Math.max(...states.map((s) => s.depth))).toBe(1);
    expectBudget(run, findings, 'budget_depth');
  });

  it('exploration can be turned off: only the initial capture runs and traversal rules are not owned', async () => {
    const { run, states, checks, actions } = await scan('tabs/', { explore: false });
    expect(run.status).toBe('completed');
    expect(states).toHaveLength(1);
    expect(actions).toEqual([]);
    expect(checks.some((c) => c.ruleId.startsWith('NAV-') || c.ruleId.startsWith('COV-'))).toBe(false);
  });
});

describe('defects must reproduce', () => {
  it('a control that is only slow the first time passes on the retry and is not reported', async () => {
    const { actions, findings, checks } = await scan('slow-first-tab/');
    expect(ruleFindings(findings, 'NAV-001')).toEqual([]);
    expect(actionsFor(actions, 'Two')[0]?.outcome).toBe('succeeded');
    expect(checks.find((c) => c.ruleId === 'NAV-001')?.reasonDetail).toContain('second attempt');
  });
});
