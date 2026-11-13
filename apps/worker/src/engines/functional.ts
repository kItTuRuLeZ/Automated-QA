import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentRoot, waitForContentRoot } from '../adapters/content-root.js';
import { parseDragItem, parseMediaItem, performDrag } from '../adapters/drag.js';
import type { Browser, BrowserContext, ElementHandle, Locator, Page } from 'playwright';
import { isRuleConfirmed } from '@cqa/shared';
import type { AssessmentSpec, BehaviorRule, ContentUnit, CourseState, EvidenceId, EvidenceSink, ExecutionTraceStep, InteractionInstance, RuleEvent, RuleItem, ScanRun, TestDefinition, TestExecution, TestStatus } from '@cqa/shared';
import { type QaStore, effectiveAutomation, isPrimaryUnit, nowIso } from '@cqa/core';
import { testAssessment } from './assessment.js';
import { type NewCheck, type NewFinding, assertionKey, wholePhrase } from './helpers.js';
import { check, finding, truncate } from './helpers.js';
import type { ReplayPath } from './traversal.js';
import type { RunRecorder } from '../recorder.js';

/**
 * Runs the reusable test cases that the generic HTML adapter can really perform, and the behavior rules a reviewer
 * configured. Each test is planned first (a pending execution is stored), then run in a fresh browser context at the
 * screen it belongs to, and ends in a status with the evidence for it: an ordered trace of what was done and observed.
 *
 * Rules of the road:
 *  - A click is never proof. Presence of an effect is asserted from observable state; absence over a window.
 *  - A test that cannot be carried out is blocked or an error, never a pass and never a confirmed defect.
 *  - An unknown expectation is manual review, not a pass.
 */

export const ENGINE_VERSION = 'functional-1.0';
const STEP_TIMEOUT_MS = 4_000;
const MAX_TESTS_PER_UNIT = 24;
const MAX_OMISSIONS = 12;

export interface FunctionalInput {
  browser: Browser;
  run: ScanRun;
  targetUrl: string;
  replay: ReplayPath[];
  states: CourseState[];
  qa: QaStore;
  rec: RunRecorder;
  definitions: ReadonlyMap<string, TestDefinition>;
  rules: BehaviorRule[];
  deadline: number;
  signal: AbortSignal;
  evidence: EvidenceSink;
  /** Fresh, hardened context with the same settings as the main one. */
  newContext: () => Promise<BrowserContext>;
  contentHash?: string;
  configHash?: string;
  /** How many traces this run has kept so far. */
  traceBudget?: { kept: number };
}

interface Planned {
  executionId: string;
  def: TestDefinition;
  unit: ContentUnit;
  stateId: string;
  instance?: InteractionInstance;
  rule?: BehaviorRule;
}

type Outcome = { status: TestStatus; reason?: string; actual?: string; evidenceId?: EvidenceId; extraEvidence?: EvidenceId[]; reproSteps?: string[] };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** A short wait for an in-page action to take effect. Full load waiting is only done after navigating. */
const quick = () => sleep(250);

async function settle(page: Page, navTimeout: number): Promise<void> {
  await page.waitForLoadState('load', { timeout: navTimeout }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 1_200 }).catch(() => undefined);
  await sleep(250);
}

/** How a reviewer names something: a visible label, or a CSS selector they or the picker supplied. */
const looksLikeSelector = (s: string) => /^[#.[]|>>|^css=|^xpath=|^\/\/|^[a-z][a-z0-9-]*[[.#]/i.test(s.trim());

async function locate(page: Page, spec: string): Promise<{ ok: true; loc: Locator } | { ok: false; why: string }> {
  const s = spec.trim();
  if (!s) return { ok: false, why: 'No item was named.' };
  if (parseDragItem(s)) return { ok: false, why: 'This rule item is a drag. Drags are used to get past a screen during the scan; the click-order tests cannot repeat them, so this rule is not tested here.' };
  if (looksLikeSelector(s)) {
    const loc = page.locator(s);
    const n = await loc.count().catch(() => 0);
    if (n === 0) return { ok: false, why: `Nothing on the screen matches "${truncate(s, 60)}".` };
    if (n > 1) return { ok: false, why: `${n} controls match "${truncate(s, 60)}". The rule needs a more specific item.` };
    return { ok: true, loc: loc.first() };
  }
  const tries: Array<[string, Locator]> = [
    ['button', page.getByRole('button', { name: s, exact: true })],
    ['link', page.getByRole('link', { name: s, exact: true })],
    ['tab', page.getByRole('tab', { name: s, exact: true })],
    ['button (partial name)', page.getByRole('button', { name: s })],
    ['link (partial name)', page.getByRole('link', { name: s })],
    ['tab (partial name)', page.getByRole('tab', { name: s })],
    ['text', page.getByText(s, { exact: true })],
    ['text (partial)', page.getByText(s)],
  ];
  for (const [, loc] of tries) {
    const visible = loc.filter({ visible: true });
    const n = await visible.count().catch(() => 0);
    if (n === 1) return { ok: true, loc: visible.first() };
    if (n > 1) return { ok: false, why: `${n} visible controls are named "${truncate(s, 60)}". The rule needs a more specific item.` };
  }
  return { ok: false, why: `No visible control named "${truncate(s, 60)}" was found.` };
}

async function isDisabled(loc: Locator): Promise<boolean> {
  return loc.evaluate((el) => (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true').catch(() => true);
}

const dialogCount = (page: Page) =>
  page.evaluate(() => {
    const visible = (el: Element) => (el as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? (el as HTMLElement).offsetParent !== null;
    return [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]')].filter(visible).length;
  });

const urlKey = (page: Page) => page.evaluate(() => `${location.pathname}${location.hash}`);

class Tracer {
  readonly steps: ExecutionTraceStep[] = [];
  add(step: ExecutionTraceStep['step'], detail: string, data?: Record<string, unknown>): void {
    this.steps.push({ at: nowIso(), step, detail, ...(data ? { data } : {}) });
  }
}

export async function runFunctionalTests(input: FunctionalInput): Promise<{ checks: NewCheck[]; findings: NewFinding[] }> {
  const { qa, run } = input;
  const checks: NewCheck[] = [];
  const findings: NewFinding[] = [];
  const navTimeout = run.config.budgets.navigationTimeoutMs;

  const allUnits = qa.listUnits(run.id);
  const units = allUnits.filter((u) => u.visitedAt && isPrimaryUnit(u, allUnits));
  const replayByState = new Map(input.replay.map((r) => [r.stateId as string, r]));
  const stateById = new Map(input.states.map((s) => [s.id as string, s]));
  const baseStateOf = (u: ContentUnit): string | undefined => [...u.visitedStateIds].sort((a, b) => (stateById.get(a)?.depth ?? 99) - (stateById.get(b)?.depth ?? 99))[0];

  // ---- plan: store a pending execution for everything that is going to run ----
  const planned: Planned[] = [];
  const usable = (id: string): TestDefinition | undefined => {
    const d = input.definitions.get(id);
    return d && d.reviewState !== 'retired' && effectiveAutomation(d) !== 'manual' ? d : undefined;
  };
  const addPlan = (def: TestDefinition, unit: ContentUnit, stateId: string, extra: { instance?: InteractionInstance; rule?: BehaviorRule }) => {
    const e = qa.insertExecution({
      runId: run.id,
      definitionId: def.id,
      definitionVersion: def.version,
      externalId: def.externalId,
      unitId: unit.id,
      instanceId: extra.instance?.id ?? (extra.rule ? `rule:${extra.rule.id}` : undefined),
      statePath: stateId,
      status: 'pending',
      expected: def.body.expectedResult,
      expectedSource: extra.rule ? extra.rule.expectationSource : def.body.expectationSource,
      trace: [],
      evidenceIds: [],
      scope: 'functional',
      engineVersion: ENGINE_VERSION,
      contentHash: input.contentHash,
      configHash: input.configHash,
    });
    planned.push({ executionId: e.id, def, unit, stateId, ...extra });
    return e.id;
  };

  // A control the player draws on every screen (a Resources tab, a menu) is the same control each time. It is tested once, on the
  // first screen that shows it, and the other screens carry that test's real outcome once it has run. Lesson content is never shared.
  const sharedControls = new Map<string, { title: string; executionId: string }>();
  const sharedUses: SharedControlUse[] = [];
  for (const unit of units) {
    const stateId = baseStateOf(unit);
    if (!stateId || !replayByState.has(stateId)) continue;
    const inter = qa.listInteractions(run.id, unit.id).filter((i) => i.capabilities.includes('activate'));
    let count = 0;
    const room = () => count < MAX_TESTS_PER_UNIT;
    const plan = (id: string, i?: InteractionInstance) => {
      const def = usable(id);
      if (!def) return;
      if (!room()) {
        qa.insertExecution({
          runId: run.id,
          definitionId: def.id,
          definitionVersion: def.version,
          externalId: def.externalId,
          unitId: unit.id,
          instanceId: i?.id,
          statePath: stateId,
          status: 'skipped',
          reason: `Skipped: reached the per-unit limit of ${MAX_TESTS_PER_UNIT} functional tests on this screen. Additional detected interaction "${i?.label ?? id}" was not executed.`,
          expected: def.body.expectedResult,
          expectedSource: def.body.expectationSource,
          trace: [],
          evidenceIds: [],
          scope: 'functional',
          engineVersion: ENGINE_VERSION,
          contentHash: input.contentHash,
          configHash: input.configHash,
          startedAt: nowIso(),
          finishedAt: nowIso(),
        });
        return;
      }
      const sharedKey = i && isPlayerControl(i) ? `${id}|${i.type}|${i.label}|${i.locator}` : undefined;
      const first = sharedKey ? sharedControls.get(sharedKey) : undefined;
      if (first && first.title !== unit.title) {
        const copy = qa.insertExecution({
          runId: run.id,
          definitionId: def.id,
          definitionVersion: def.version,
          externalId: def.externalId,
          unitId: unit.id,
          instanceId: i!.id,
          statePath: stateId,
          status: 'pending',
          expected: def.body.expectedResult,
          expectedSource: def.body.expectationSource,
          trace: [],
          evidenceIds: [],
          scope: 'functional',
          engineVersion: ENGINE_VERSION,
          contentHash: input.contentHash,
          configHash: input.configHash,
        });
        sharedUses.push({ executionId: copy.id, sourceExecutionId: first.executionId, label: i!.label, sourceTitle: first.title });
        return;
      }
      // Test it where it was found: on a scrolling lesson that can be after a Continue button.
      const executionId = addPlan(def, unit, i?.stateId && replayByState.has(i.stateId) ? i.stateId : stateId, { instance: i });
      if (sharedKey) sharedControls.set(sharedKey, { title: unit.title, executionId });
      count++;
    };
    for (const i of inter) {
      if (i.type === 'tab') plan('TAB-01', i);
      if (i.type === 'flip_card') plan('FLP-01', i);
      if (i.type === 'carousel') plan('TIM-01', i);
      if (i.type === 'audio') plan('AUD-01', i);
      if (i.type === 'video') plan('VID-01', i);
      if (i.type === 'accordion' || i.type === 'details') plan('ACC-01', i);
      if (i.type === 'dialog') {
        plan('LAY-01', i);
        plan('LAY-02', i);
      }
    }
    const accordions = inter.filter((i) => i.type === 'accordion' || i.type === 'details');
    if (accordions.length >= 2) plan('ACC-02', accordions[0]);
    const next = inter.find((i) => i.type === 'next');
    if (next) plan('NAV-02', next);
  }

  for (const rule of input.rules.filter((r) => r.reviewState !== 'retired')) {
    const unit = pickUnit(units, rule, baseStateOf);
    const quizIds = rule.assessment ? assessmentCases(rule.assessment) : undefined;
    if (!unit) {
      for (const id of quizIds ?? ['LOG-01', 'LOG-02', 'LOG-03']) {
        const def = input.definitions.get(id);
        if (def) qa.insertExecution({ runId: run.id, definitionId: id, definitionVersion: def.version, instanceId: `rule:${rule.id}`, status: 'blocked', reason: `The rule "${rule.title}" names a screen ("${rule.unitMatch || 'the launch page'}") that no browser visit reached, so it could not be tested.`, expected: def.body.expectedResult, expectedSource: rule.expectationSource, trace: [], evidenceIds: [], scope: 'functional', engineVersion: ENGINE_VERSION, startedAt: nowIso(), finishedAt: nowIso() });
      }
      continue;
    }
    const stateId = baseStateOf(unit)!;
    const ids = quizIds ?? ['LOG-01', 'LOG-02', 'LOG-03', rule.orderPolicy === 'any_order' ? 'LOG-04' : 'LOG-05'];
    for (const id of ids) {
      const def = usable(id);
      if (def) addPlan(def, unit, stateId, { rule });
    }
  }
  qa.recount(run.id);

  // ---- run, one unit at a time, each test at a clean copy of its screen ----
  const byUnit = new Map<string, Planned[]>();
  for (const p of planned) byUnit.set(p.unit.id, [...(byUnit.get(p.unit.id) ?? []), p]);

  try {
    for (const [, list] of byUnit) {
      for (const p of list) {
        if (input.signal.aborted) throw new Error('aborted');
        if (Date.now() > input.deadline) {
          qa.updateExecution(p.executionId, { status: 'skipped', reason: 'The scan ran out of time before this check could run.', finishedAt: nowIso() });
          continue;
        }
        await runOne(input, p, navTimeout, replayByState.get(p.stateId)!, stateById.get(p.stateId), checks, findings);
      }
    }
  } finally {
    // Also on cancel: a copy must never be left waiting for a test that will not run.
    resolveSharedControls(qa, sharedUses);
  }
  qa.recount(run.id);
  return { checks, findings };
}

const findState = (input: FunctionalInput, id: string) => input.states.find((s) => (s.id as string) === id);

/** Which library cases an answer key can test. */
function assessmentCases(spec: AssessmentSpec): string[] {
  return [
    spec.selection === 'single' ? 'MCQ-01' : 'MSQ-01',
    ...(spec.unanswered ? ['MCQ-02'] : []),
    ...(spec.cases.some((c) => c.correct) ? ['MCQ-03'] : []),
    ...(spec.cases.some((c) => !c.correct) ? ['MCQ-04'] : []),
    ...(spec.retry ? ['QUIZ-01'] : []),
  ];
}

/** Names players draw on every screen. A matching name alone is not enough: see isPlayerControl. */
const PLAYER_CONTROL_NAME = /^(resources?|resorces|menu|contents|outline|glossary|transcript|notes|search|help|sidebar|settings|exit|volume|captions)$/i;

/**
 * Only a control named like part of the player, at a fixed address outside the lesson's own blocks, is treated as one shared control.
 * A position such as "first tab in the tab list" is not a fixed address: every lesson's tabs can match it.
 */
function isPlayerControl(i: InteractionInstance): boolean {
  if (i.type === 'next' || !i.locator || /data-block-id|data-testid|:nth-/.test(i.locator)) return false;
  return PLAYER_CONTROL_NAME.test((/"([^"]+)"/.exec(i.label)?.[1] ?? i.label).trim().replace(/[.:!?]+$/, ''));
}

export interface SharedControlUse {
  executionId: string;
  sourceExecutionId: string;
  label: string;
  sourceTitle: string;
}

/** Gives each screen that shares a player control the real outcome of the one test, now that it has run. Anything short of a result stays a gap. */
export function resolveSharedControls(qa: QaStore, uses: readonly SharedControlUse[]): void {
  for (const use of uses) {
    const status = qa.getExecution(use.sourceExecutionId)?.status;
    const settled = status === 'passed' || status === 'failed';
    const reason = settled
      ? `Not repeated: "${use.label}" is a player control shared by every screen. Its check ${status} on "${use.sourceTitle}"${status === 'failed' ? ', and the issue is recorded there' : ''}.`
      : `Not tested here: "${use.label}" is a player control shared by every screen, and its check on "${use.sourceTitle}" could not be confirmed (${status ?? 'no result'}).`;
    qa.updateExecution(use.executionId, { status: settled ? 'not_applicable' : 'skipped', reason, trace: [{ at: nowIso(), step: 'note', detail: `Result taken from the check on "${use.sourceTitle}".`, data: { sourceExecutionId: use.sourceExecutionId, sourceStatus: status ?? null } }], startedAt: nowIso(), finishedAt: nowIso() });
  }
}

function pickUnit(units: ContentUnit[], rule: BehaviorRule, baseStateOf: (u: ContentUnit) => string | undefined): ContentUnit | undefined {
  const withState = units.filter((u) => baseStateOf(u));
  if (!rule.unitMatch.trim()) return [...withState].sort((a, b) => a.order - b.order)[0];
  const needle = rule.unitMatch.trim().toLowerCase();
  return withState.find((u) => u.sourceId?.toLowerCase() === needle) ?? withState.find((u) => u.title.toLowerCase().includes(needle) || u.sourceId?.toLowerCase().includes(needle));
}

async function runOne(input: FunctionalInput, p: Planned, navTimeout: number, path: ReplayPath, state: CourseState | undefined, checks: NewCheck[], findings: NewFinding[]): Promise<void> {
  const { qa, run } = input;
  const tracer = new Tracer();
  const started = nowIso();
  qa.updateExecution(p.executionId, { status: 'running', startedAt: started });
  qa.appendEvent(run.id, 'test_started', { executionId: p.executionId, caseId: p.def.id, unitId: p.unit.id, title: p.def.title });
  qa.setActivity(run.id, `${p.def.id}: ${p.def.title} on ${p.unit.title}`, { unitId: p.unit.id, testId: p.def.id });

  let outcome: Outcome;
  let shot: EvidenceId | undefined;
  let traceId: EvidenceId | undefined;
  let keepTrace = false;
  let tracing = false;
  let context: BrowserContext | undefined;
  // Quiz checks open their own fresh screens, so this page would only show an untouched screen: it is not opened at all.
  const ownScreens = Boolean(p.def.body.requiredCapability?.startsWith('assess_'));
  try {
    if (ownScreens) {
      outcome = await dispatch(undefined as unknown as Page, p, input, navTimeout, tracer);
      shot = outcome.evidenceId;
    } else {
      context = await input.newContext();
      tracing = await startTrace(context, input);
      const page = await context.newPage();
      const reached = await replay(page, input.targetUrl, path, navTimeout, tracer);
      if (!reached.ok) {
        outcome = { status: 'blocked', reason: `The screen could not be reached again to run this check: ${reached.why}`, actual: 'No result.' };
      } else {
        // Courses that show the lesson in a frame (Rise) are tested in that frame. Behavior rules keep the page: the SCORM test harness lives there.
        const root = (await contentRoot(page)) as unknown as Page;
        outcome = await dispatch(p.def.body.requiredCapability?.startsWith('rule_') ? page : root, p, input, navTimeout, tracer);
      }
      if (outcome.status === 'failed' || outcome.status === 'manual_review_required' || outcome.status === 'passed') {
        shot = await screenshot(page, input, state, `${p.def.id}: ${p.def.title}`, tracer);
      }
      keepTrace = outcome.status === 'failed';
    }
  } catch (err) {
    if (input.signal.aborted) throw err;
    keepTrace = true;
    outcome = { status: 'error', reason: `The test runner failed: ${truncate((err as Error).message, 200)}. This is not a confirmed defect in the course.`, actual: 'No result.' };
  } finally {
    if (context && tracing) traceId = await stopTrace(context, input, state, keepTrace, `${p.def.id}: ${p.def.title}`, tracer);
    await context?.close().catch(() => undefined);
  }
  const evidenceIds = [shot, ...(outcome.extraEvidence ?? []), traceId].filter((x): x is EvidenceId => Boolean(x));

  // A rule nobody has approved, or one only inferred from what the course did, cannot prove or disprove anything yet.
  const unconfirmed = !p.rule || isRuleConfirmed(p.rule) ? undefined : p.rule.expectationSource === 'observed_hypothesis' ? 'was only inferred from what the course did' : `is still a ${p.rule.reviewState} and has not been approved`;
  if (unconfirmed && (outcome.status === 'passed' || outcome.status === 'failed')) {
    outcome = { ...outcome, status: 'inconclusive', reason: `Provisional: this rule ${unconfirmed}, so a reviewer must confirm it before this counts as a result. Against the rule as written the test ${outcome.status}${outcome.reason ? `: ${outcome.reason}` : '.'}` };
  }

  const done = qa.updateExecution(p.executionId, {
    status: outcome.status,
    reason: outcome.status === 'passed' ? undefined : (outcome.reason ?? 'No reason was recorded.'),
    actual: outcome.actual,
    trace: tracer.steps,
    evidenceIds,
    finishedAt: nowIso(),
  })!;
  qa.appendEvent(run.id, 'test_finished', { executionId: p.executionId, caseId: p.def.id, unitId: p.unit.id, status: done.status });
  qa.recount(run.id);

  // Failures become findings so they flow into the issue list, statuses and reports. Errors and blocks do not.
  const ruleId = p.rule ? 'FUN-002' : 'FUN-001';
  // A changed case, rule version or expectation makes a different key, so an old finding cannot be confirmed by a new meaning.
  const checkKey = assertionKey(p.def.id, p.def.version, p.instance?.id ?? null, p.rule?.id ?? null, p.rule?.version ?? null, p.rule?.expectationSource ?? p.def.body.expectationSource, p.def.body.expectedResult);
  const checkFamily = assertionKey(p.def.id, p.instance?.id ?? null, p.rule?.id ?? null);
  if (done.status === 'passed' || done.status === 'failed') {
    checks.push(check(ruleId, done.status === 'passed' ? 'passed' : 'failed', 0, evidenceIds, { stateId: state?.id, viewportName: run.config.viewports[0]?.name, targetKey: checkKey, targetFamily: checkFamily }));
  }
  if (done.status === 'failed' && state) {
    const subject = p.rule ? `Rule "${p.rule.title}"` : p.instance?.label ?? p.unit.title;
    findings.push(
      finding(
        ruleId,
        { stateId: state.id, url: state.url, lessonId: state.lessonId, lessonTitle: state.lessonTitle ?? p.unit.title, viewportName: run.config.viewports[0]?.name, browser: 'chromium', elementDescription: p.instance?.label, selector: p.instance?.locator },
        {
          title: `${p.def.id} failed: ${truncate(p.def.title, 80)}${p.instance ? ` (${truncate(p.instance.label, 60)})` : ''}`,
          observed: `${done.actual ?? done.reason ?? 'The expected behavior was not observed.'}`,
          expected: `${p.def.body.expectedResult} (source: ${sourceLabel(p.rule ? p.rule.expectationSource : p.def.body.expectationSource)}${p.def.body.expectationSource === 'starter_baseline' && !p.rule ? '; a baseline, not a client requirement' : ''}).`,
          evidenceIds,
          reproductionSteps: [`Open ${input.targetUrl}.`, ...path.steps.map((s) => `Activate ${s.description}.`), ...(outcome.reproSteps ?? tracer.steps.filter((t) => t.step === 'action').map((t) => t.detail))],
          remediation: p.rule ? `Check the trigger logic for "${subject}". The ordered action trace shows the click sequence and when the event appeared.` : `Check how "${subject}" is built or authored. The trace in the test result shows what was done and what was observed.`,
          targetKey: `${p.def.id}|${p.instance?.id ?? p.rule?.id ?? ''}`,
          checkKey,
          checkFamily,
          stateKey: '',
          type: p.def.body.expectationSource === 'starter_baseline' && !p.rule ? 'heuristic_warning' : 'automated_defect',
        },
      ),
    );
  }
}

const sourceLabel = (s: string) => ({ approved_case: 'reviewer-approved case', specification: 'specification', extracted_metadata: 'extracted metadata', starter_baseline: 'starter baseline', observed_hypothesis: 'observed behavior, unconfirmed' })[s] ?? s;

async function replay(page: Page, targetUrl: string, path: ReplayPath, navTimeout: number, tracer: Tracer): Promise<{ ok: true } | { ok: false; why: string }> {
  try {
    await page.goto(targetUrl, { waitUntil: 'load', timeout: navTimeout });
    await settle(page, navTimeout);
    await waitForContentRoot(page);
    tracer.add('entered_unit', `Opened ${targetUrl}`);
    for (const step of path.steps) {
      if (step.kind === 'navigate' && step.rawHref) {
        const root = await contentRoot(page);
        if (root !== page && typeof (root as any).goto === 'function') {
          try {
            await (root as any).goto(step.rawHref, { waitUntil: 'load', timeout: navTimeout });
          } catch {
            await page.goto(step.rawHref, { waitUntil: 'load', timeout: navTimeout });
          }
        } else {
          await page.goto(step.rawHref, { waitUntil: 'load', timeout: navTimeout });
        }
      }
      else if (step.locator && step.dragTo) await performDrag(page, (await contentRoot(page)) as unknown as Page, step.locator, step.dragTo);
      else if (step.locator) await ((await contentRoot(page)) as unknown as Page).locator(step.locator).first().click({ timeout: STEP_TIMEOUT_MS, force: step.force });
      else return { ok: false, why: `No way to repeat "${step.description}".` };
      // Repeating an in-page click (a Next button) needs a short pause, not a full page-load wait: this is what keeps deep slides affordable.
      if (step.kind === 'navigate') await settle(page, navTimeout);
      else await sleep(400);
      tracer.add('action', `Activate ${step.description}.`, { replay: true });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, why: truncate((err as Error).message, 160) };
  }
}

/** At most this many traces per scan: each can be several megabytes. */
const MAX_TRACES_PER_RUN = 25;

async function startTrace(context: BrowserContext, input: FunctionalInput): Promise<boolean> {
  if (input.run.config.traces === 'off') return false;
  try {
    await context.tracing.start({ screenshots: true, snapshots: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Keeps the trace of a failed check as evidence, or discards it. Captured from the first attempt on purpose: a retry is not
 * needed to have one. A trace that cannot be saved is said so in the result, and nothing is linked.
 */
async function stopTrace(context: BrowserContext, input: FunctionalInput, state: CourseState | undefined, keep: boolean, caption: string, t: Tracer): Promise<EvidenceId | undefined> {
  if (!keep) {
    await context.tracing.stop().catch(() => undefined);
    return undefined;
  }
  const budget = (input.traceBudget ??= { kept: 0 });
  if (budget.kept >= MAX_TRACES_PER_RUN) {
    await context.tracing.stop().catch(() => undefined);
    t.add('note', `No browser trace was kept: this scan already holds the limit of ${MAX_TRACES_PER_RUN}.`);
    return undefined;
  }
  const dir = mkdtempSync(join(tmpdir(), 'cqa-trace-'));
  try {
    const file = join(dir, 'trace.zip');
    await context.tracing.stop({ path: file });
    const artifactId = await input.evidence.writeArtifact({ kind: 'trace', mime: 'application/zip', bytes: readFileSync(file) });
    const ev = await input.evidence.addEvidence({ kind: 'trace', artifactId, caption: `Browser trace for ${caption}. Open it with the Playwright Trace Viewer (npx playwright show-trace <file>). It can contain page content and network data.`, stateId: state?.id, viewportName: input.run.config.viewports[0]?.name, capturedAt: nowIso(), redacted: false });
    budget.kept++;
    return ev.id;
  } catch (err) {
    t.add('note', `The browser trace could not be saved: ${truncate((err as Error).message, 160)}. No trace is linked.`);
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function screenshot(page: Page, input: FunctionalInput, state: CourseState | undefined, caption: string, t?: Tracer): Promise<EvidenceId | undefined> {
  try {
    const bytes = await page.screenshot({ type: 'png', timeout: 8_000 });
    const artifactId = await input.evidence.writeArtifact({ kind: 'screenshot', mime: 'image/png', bytes });
    return (await input.evidence.addEvidence({ kind: 'screenshot', artifactId, caption, stateId: state?.id, viewportName: input.run.config.viewports[0]?.name, capturedAt: nowIso(), redacted: false })).id;
  } catch (err) {
    t?.add('note', `The screenshot could not be saved: ${truncate((err as Error).message, 160)}. No screenshot is linked.`);
    return undefined;
  }
}

async function dispatch(page: Page, p: Planned, input: FunctionalInput, navTimeout: number, t: Tracer): Promise<Outcome> {
  const cap = p.def.body.requiredCapability;
  // A lesson may still be building when the route to it has been replayed. Only a control still missing after this wait counts as gone.
  if (p.instance?.locator) await page.locator(p.instance.locator).first().waitFor({ state: 'attached', timeout: 5_000 }).catch(() => undefined);
  switch (cap) {
    case 'tabs':
      return testTab(page, p.instance!, t, navTimeout);
    case 'accordion_open':
      return testAccordion(page, p.instance!, t, navTimeout);
    case 'accordion_policy':
      return testAccordionPolicy(page, input.qa.listInteractions(input.run.id, p.unit.id).filter((i) => i.type === 'accordion' || i.type === 'details'), t, navTimeout);
    case 'dialog_open':
      return testDialog(page, p.instance!, t, navTimeout, false);
    case 'dialog_dismiss':
      return testDialog(page, p.instance!, t, navTimeout, true);
    case 'next_previous':
      return testNextPrevious(page, p.instance!, t, navTimeout);
    case 'flip_card':
      return testFlipCard(page, p.instance!, t);
    case 'carousel':
      return testCarousel(page, p.instance!, t);
    case 'media_playback':
      return testMediaPlayback(page, p.instance!, t);
    case 'rule_all_click':
    case 'rule_premature':
    case 'rule_duplicate':
    case 'rule_order':
    case 'rule_sequence':
      return testRule(page, p, cap, input, navTimeout, t);
    case 'assess_selection':
    case 'assess_unanswered':
    case 'assess_answer_key':
    case 'assess_retry':
      return testAssessment(cap, {
        rule: p.rule!,
        caseId: p.def.id,
        locate,
        add: (step, detail, data) => t.add(step, detail, data),
        capture: (screen, caption) => screenshot(screen, input, findState(input, p.stateId), caption),
        fresh: async () => {
          const context = await input.newContext();
          const tracing = await startTrace(context, input);
          const fresh = await context.newPage();
          const reached = await replay(fresh, input.targetUrl, input.replay.find((r) => r.stateId === p.stateId)!, navTimeout, t);
          if (!reached.ok) {
            await context.close().catch(() => undefined);
            return { ok: false, why: reached.why };
          }
          const close = async (keep: boolean) => {
            const id = tracing ? await stopTrace(context, input, findState(input, p.stateId), keep, `${p.def.id}: ${p.def.title}`, t) : undefined;
            await context.close().catch(() => undefined);
            return id;
          };
          return { ok: true, page: (await contentRoot(fresh)) as unknown as Page, close };
        },
      });
    default:
      return { status: 'manual_review_required', reason: `This case names the capability "${cap ?? 'none'}", which the scanner does not implement.` };
  }
}

// ---- interaction tests ----

/** Polls until the condition holds or the time is up. Animated players need a moment; this is a bounded wait for a stated condition. */
async function waitUntil(check: () => Promise<boolean>, ms = 2_000): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= end) return false;
    await sleep(150);
  }
}

/** Rise flashcards: the card gets `flashcard--flipped`, and the back side stops being inert. */
async function testFlipCard(page: Page, i: InteractionInstance, t: Tracer): Promise<Outcome> {
  const loc = page.locator(i.locator ?? '').first();
  if (!i.locator || (await loc.count()) === 0) return { status: 'blocked', reason: `The card "${i.label}" could not be found again on the screen.` };
  const read = () =>
    loc.evaluate((el) => {
      const card = el.closest('.flashcard');
      const back = card?.querySelector('.flashcard-side--back') as HTMLElement | null | undefined;
      const text = (back?.textContent ?? '').replace(/\s+/g, ' ').replace(/Click to flip/gi, '').trim();
      return {
        hasBack: Boolean(back),
        flipped: Boolean(card?.classList.contains('flashcard--flipped')),
        backReachable: Boolean(back && !back.inert && !back.hidden),
        text,
        hasMedia: Boolean(back?.querySelector('img,svg:not(button svg),video,audio')),
        hasBackButton: Boolean(back?.querySelector('.flashcard-side-flip__btn')),
      };
    });
  const before = await read();
  t.add('observed', 'State before', before);
  if (!before.hasBack) return { status: 'unsupported', reason: 'No back side was found in the page for this card, so the scanner cannot tell what flipping should show. Check it by hand.', actual: 'Not checked.' };
  try {
    await loc.click({ timeout: STEP_TIMEOUT_MS });
  } catch {
    return { status: 'blocked', reason: `The card "${i.label}" could not be clicked: it stayed covered or not ready for about 4 seconds.`, actual: 'No result.' };
  }
  t.add('action', `Flip ${i.label}.`);
  const flipped = await waitUntil(async () => (await read()).flipped);
  const after = await read();
  t.add('observed', 'State after flipping', after);
  if (!flipped) return { status: 'failed', reason: 'The card did not flip.', actual: `After activating "${i.label}", the card still showed its front.` };
  if (!after.text && !after.hasMedia) return { status: 'failed', reason: 'The card flipped but its back is empty.', actual: `The back of "${i.label}" has no text or media.` };
  const backButton = page.locator(i.locator.replace('-front-flip-btn', '-back-flip-btn')).first();
  const canTurn = after.hasBackButton && i.locator.includes('-front-flip-btn') && (await backButton.count()) > 0;
  if (!canTurn) return { status: 'failed', reason: 'The card flipped, but there is no control to turn it back to the front.', actual: `The back of "${i.label}" shows "${truncate(after.text, 120)}" and has no flip control.` };
  try {
    await backButton.click({ timeout: STEP_TIMEOUT_MS });
  } catch {
    return { status: 'blocked', reason: `The flip control on the back of "${i.label}" could not be clicked.`, actual: `The back shows "${truncate(after.text, 120)}".` };
  }
  t.add('action', `Flip back ${i.label}.`);
  const returned = await waitUntil(async () => !(await read()).flipped);
  t.add('asserted', `Flipped: true. Back has content: true. Returned to the front: ${returned}.`);
  if (!returned) return { status: 'failed', reason: 'The card could not be turned back to the front.', actual: `After activating the flip control on the back of "${i.label}", the card still showed its back.` };
  return { status: 'passed', actual: `The card flipped to "${truncate(after.text, 120)}" and turned back to the front.` };
}

/** ARIA carousels: Next moves through the slides, Previous comes back. The last slide is reached when Next stops changing anything. */
async function testCarousel(page: Page, i: InteractionInstance, t: Tracer): Promise<Outcome> {
  const next = page.locator(i.locator ?? '').first();
  if (!i.locator || (await next.count()) === 0) return { status: 'blocked', reason: `The carousel "${i.label}" could not be found again on the screen.` };
  const shown = () =>
    next.evaluate((el) => {
      const c = el.closest('[aria-roledescription="carousel"]');
      const slides = [...(c?.querySelectorAll('[aria-roledescription="slide"]') ?? [])] as HTMLElement[];
      const on = slides.filter((s) => s.checkVisibility?.({ checkVisibilityCSS: true }) ?? !s.hidden);
      return (on.length ? on : c ? [c as HTMLElement] : []).map((s) => s.innerText).join(' ').replace(/\s+/g, ' ').trim();
    });
  const first = await shown();
  t.add('observed', 'First slide', { text: truncate(first, 120) });
  if (await isDisabled(next)) return { status: 'inconclusive', reason: 'Next is disabled on the first slide, so the carousel could not be moved.', actual: 'Not moved.' };
  const seen = [first];
  for (let n = 0; n < 20; n++) {
    if (await isDisabled(next)) break;
    const was = await shown();
    try {
      await next.click({ timeout: STEP_TIMEOUT_MS });
    } catch {
      return { status: 'blocked', reason: 'Next could not be clicked: it stayed covered or not ready for about 4 seconds.', actual: `Reached ${seen.length} slide(s).` };
    }
    t.add('action', `Next slide in ${i.label}.`);
    const moved = await waitUntil(async () => (await shown()) !== was, 1_500);
    if (!moved) break;
    seen.push(await shown());
  }
  t.add('observed', 'Slides reached', { count: seen.length });
  if (seen.length < 2) return { status: 'failed', reason: 'Next did not change the slide.', actual: `After activating Next in "${i.label}", the slide was unchanged.` };
  const prev = next.locator('xpath=ancestor::*[@aria-roledescription="carousel"][1]').getByRole('button', { name: /\b(previous|prev|back)\b/i }).first();
  if ((await prev.count()) === 0) return { status: 'manual_review_required', reason: 'Next worked, but no Previous control was found in the carousel, so the way back could not be tested.', actual: `Reached ${seen.length} slides.` };
  const last = await shown();
  await prev.click({ timeout: STEP_TIMEOUT_MS });
  t.add('action', `Previous slide in ${i.label}.`);
  const back = await waitUntil(async () => (await shown()) !== last, 1_500);
  t.add('asserted', `Slides reached: ${seen.length}. Previous changed the slide: ${back}.`);
  if (!back) return { status: 'failed', reason: 'Previous did not change the slide.', actual: `Reached ${seen.length} slides, then Previous left the last slide showing.` };
  return { status: 'passed', actual: `Moved through ${seen.length} slides (second: "${truncate(seen[1]!, 80)}") and Previous came back.` };
}

/**
 * Audio and video. Plays through a control a learner would use, and passes only when the media time is seen moving and
 * then stops on pause: loaded metadata alone is not playback. Playwright's Chromium does not decode every format, so a
 * format it cannot decode is a limit of the scanner, not a course defect.
 */
async function testMediaPlayback(page: Page, i: InteractionInstance, t: Tracer): Promise<Outcome> {
  const media = page.locator(i.locator ?? '').first();
  if (!i.locator || (await media.count()) === 0) return { status: 'blocked', reason: `The media "${i.label}" could not be found again on the screen.` };
  const read = () =>
    media.evaluate((el) => {
      const m = el as HTMLMediaElement;
      const types = [m.getAttribute('type'), ...[...m.querySelectorAll('source')].map((s) => s.getAttribute('type'))].filter(Boolean) as string[];
      return { paused: m.paused, time: m.currentTime, error: m.error?.code ?? 0, ready: m.readyState, src: m.currentSrc || m.querySelector('source')?.src || m.src || '', types, playable: types.length === 0 || types.some((x) => m.canPlayType(x) !== ''), controls: m.controls };
    });
  const before = await read();
  t.add('observed', 'Media before playing', { time: before.time, paused: before.paused, ready: before.ready, error: before.error, types: before.types });
  if (!before.playable) return { status: 'unsupported', reason: `This scan browser cannot decode ${before.types.join(', ')}, so playback could not be tested. Check it by hand in a normal browser.`, actual: 'Not played.' };
  const crossOrigin = await media.evaluate((el) => {
    const src = (el as HTMLMediaElement).currentSrc || (el as HTMLMediaElement).src;
    try {
      return Boolean(src) && !src.startsWith('blob:') && !src.startsWith('data:') && new URL(src, location.href).origin !== location.origin;
    } catch {
      return false;
    }
  });
  const loadFailed = (error: number): Outcome =>
    crossOrigin
      ? { status: 'blocked', reason: 'The media is on an outside website, which this scan does not load unless it is allowed.', actual: `Media error code ${error}.` }
      : { status: 'failed', reason: 'The media file could not load.', actual: `The browser reported media error code ${error} for "${truncate(before.src, 120)}".` };
  if (before.error) return loadFailed(before.error);

  // The control a learner would use: a labelled button near the media, or the media's own controls.
  const control = (name: RegExp) => media.locator('xpath=ancestor::*[.//button][1]').getByRole('button', { name }).first();
  const useControl = async (name: RegExp): Promise<string | undefined> => {
    const b = control(name);
    if ((await b.count()) > 0) {
      // Read the name first: a play button usually renames itself to Pause once clicked, and this locator would stop matching.
      const label = (await b.getAttribute('aria-label', { timeout: 1_000 }).catch(() => null)) ?? 'media';
      await b.click({ timeout: STEP_TIMEOUT_MS });
      return `the "${label}" control`;
    }
    if (before.controls && (await media.isVisible())) {
      await media.click({ timeout: STEP_TIMEOUT_MS });
      return 'the player itself';
    }
    return undefined;
  };
  let used: string | undefined;
  try {
    used = await useControl(/^play\b/i);
  } catch {
    return { status: 'blocked', reason: 'The play control could not be clicked: it stayed covered or not ready for about 4 seconds.', actual: 'Not played.' };
  }
  if (!used) return { status: 'unsupported', reason: 'No play control a learner could use was found next to this media, so playback could not be tested. Check it by hand.', actual: 'Not played.' };
  t.add('action', `Play ${i.label} with ${used}.`);

  const start = before.time;
  const moving = await waitUntil(async () => {
    const m = await read();
    return m.error !== 0 || (!m.paused && m.time > start + 0.2);
  }, 6_000);
  const during = await read();
  t.add('observed', 'Media after pressing play', { time: during.time, paused: during.paused, error: during.error });
  if (during.error) return loadFailed(during.error);
  if (during.paused) return { status: 'failed', reason: 'Pressing play did not start the media.', actual: `After ${used}, the media stayed paused at ${during.time.toFixed(1)} s.` };
  if (!moving) return { status: 'inconclusive', reason: 'The media reports it is playing, but its time did not move within 6 seconds. It may be buffering.', actual: `Time stayed at ${during.time.toFixed(1)} s.` };

  try {
    const label = (await useControlLabel(control(/^pause\b/i))) ?? (before.controls ? 'media' : undefined);
    if (!label) return { status: 'manual_review_required', reason: 'The media plays, but no pause control was found, so pausing could not be tested.', actual: `Time moved to ${during.time.toFixed(1)} s.` };
    if (label === 'media') await media.click({ timeout: STEP_TIMEOUT_MS });
    t.add('action', `Pause ${i.label}.`);
  } catch {
    return { status: 'blocked', reason: 'The pause control could not be clicked.', actual: `Time moved to ${during.time.toFixed(1)} s.` };
  }
  const paused = await waitUntil(async () => (await read()).paused, 1_500);
  const stopped = await read();
  await sleep(400);
  const later = await read();
  t.add('observed', 'Media time after pausing', { paused: later.paused, time: later.time, timeBefore: stopped.time });
  t.add('asserted', `Time moved while playing: true. Paused: ${paused}. Time stopped: ${later.time === stopped.time}.`);
  if (!paused || later.time !== stopped.time) return { status: 'failed', reason: 'Pressing pause did not stop the media.', actual: `Time went from ${stopped.time.toFixed(1)} s to ${later.time.toFixed(1)} s after pausing.` };
  return { status: 'passed', actual: `The media played (time moved to ${during.time.toFixed(1)} s) and stopped when paused.` };
}

/** Clicks the control if it exists and returns its name; undefined when there is none. */
async function useControlLabel(b: Locator): Promise<string | undefined> {
  if ((await b.count()) === 0) return undefined;
  const label = (await b.getAttribute('aria-label').catch(() => null)) ?? 'pause';
  await b.click({ timeout: STEP_TIMEOUT_MS });
  return label;
}


async function testTab(page: Page, i: InteractionInstance, t: Tracer, navTimeout: number): Promise<Outcome> {
  const loc = page.locator(i.locator ?? '').first();
  if (!i.locator || (await loc.count()) === 0) return { status: 'blocked', reason: `The tab "${i.label}" could not be found again on the screen.` };
  const prior = await loc.evaluate((el) => {
    const list = el.closest('[role="tablist"]');
    const sel = list?.querySelector('[role="tab"][aria-selected="true"]');
    return sel && sel !== el ? { id: sel.getAttribute('aria-controls') } : null;
  });
  t.add('observed', 'State before: tab not yet activated', { priorSelectedPanel: prior?.id ?? null });
  await loc.click({ timeout: STEP_TIMEOUT_MS });
  t.add('action', `Activate ${i.label}.`);
  await quick();
  const selected = (await loc.getAttribute('aria-selected')) === 'true';
  const controls = await loc.getAttribute('aria-controls');
  const panel = controls ? page.locator(`[id="${controls}"]`) : undefined;
  const panelVisible = panel ? await panel.first().isVisible().catch(() => false) : undefined;
  const priorStillVisible = prior?.id ? await page.locator(`[id="${prior.id}"]`).first().isVisible().catch(() => false) : false;
  t.add('observed', 'State after', { selected, controls, panelVisible, priorPanelStillVisible: priorStillVisible });
  t.add('asserted', `Tab selected: ${selected}. Panel visible: ${panelVisible ?? 'unknown (no aria-controls)'}.`);
  if (!selected) return { status: 'failed', reason: 'The tab did not become selected.', actual: `After activating "${i.label}", aria-selected was not "true".` };
  if (controls && !panelVisible) return { status: 'failed', reason: 'The tab\'s panel did not appear.', actual: `After activating "${i.label}", the panel it controls (#${controls}) was not visible.` };
  if (!controls) return { status: 'manual_review_required', reason: 'The tab has no aria-controls, so which panel it should show cannot be confirmed automatically.', actual: 'The tab became selected.' };
  if (priorStillVisible) return { status: 'manual_review_required', reason: 'The previously selected tab\'s panel is still visible. That may be intended.', actual: 'The new panel appeared and the old panel stayed visible.' };
  return { status: 'passed', actual: `"${i.label}" became selected and its panel is visible.` };
}

async function testAccordion(page: Page, i: InteractionInstance, t: Tracer, navTimeout: number): Promise<Outcome> {
  const loc = page.locator(i.locator ?? '').first();
  if (!i.locator || (await loc.count()) === 0) return { status: 'blocked', reason: `The item "${i.label}" could not be found again on the screen.` };
  const read = () =>
    loc.evaluate((el) => {
      const details = el.tagName === 'SUMMARY' ? (el.parentElement as HTMLDetailsElement | null) : el.tagName === 'DETAILS' ? (el as HTMLDetailsElement) : null;
      const controlsId = el.getAttribute('aria-controls');
      const region = controlsId ? document.getElementById(controlsId) : details;
      const text = (region as HTMLElement | null)?.innerText?.replace((details?.querySelector('summary') as HTMLElement | null)?.innerText ?? '\u0000', '').trim() ?? '';
      const visible = region ? ((region as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? (region as HTMLElement).offsetParent !== null) : false;
      const expanded = details ? details.open : el.getAttribute('aria-expanded') === 'true';
      // A panel made of pictures, icons or controls (a resources menu, an image gallery) has content without text.
      const hasParts = Boolean(region?.querySelector('img,svg,video,audio,canvas,a[href],button,input,select,textarea,[aria-label]'));
      return { expanded, visible, readable: text.length > 0 || hasParts, hasRegion: Boolean(region) };
    });
  const before = await read();
  t.add('observed', 'State before', before);
  if (!before.expanded) {
    await loc.click({ timeout: STEP_TIMEOUT_MS });
    t.add('action', `Open ${i.label}.`);
    // Some players take a moment to open (the Rise navigation menu does).
    await waitUntil(async () => (await read()).expanded);
  } else t.add('note', 'The item was already open, so it was not clicked.');
  // Panels often animate open; give a slow one up to 2 seconds to show before judging it.
  let after = await read();
  for (let n = 0; n < 8 && after.expanded && after.hasRegion && !(after.visible && after.readable); n++) {
    await sleep(250);
    after = await read();
  }
  t.add('observed', 'State after', after);
  t.add('asserted', `Expanded: ${after.expanded}. Content visible: ${after.visible}. Content has text: ${after.readable}.`);
  if (!after.expanded) return { status: 'failed', reason: 'The item did not open.', actual: `After activating "${i.label}", it was not expanded.` };
  if (!after.hasRegion) return { status: 'manual_review_required', reason: 'The item opened but no content region is linked to it, so the content cannot be checked automatically.', actual: 'The item reports itself as expanded.' };
  if (!after.visible || !after.readable) return { status: 'failed', reason: 'The item opened but its content is not visible or is empty.', actual: `Expanded: yes. Content visible: ${after.visible}. Content has text: ${after.readable}.` };
  return { status: 'passed', actual: `"${i.label}" opened and shows readable content.` };
}

async function testAccordionPolicy(page: Page, items: InteractionInstance[], t: Tracer, navTimeout: number): Promise<Outcome> {
  const [a, b] = items;
  if (!a?.locator || !b?.locator) return { status: 'blocked', reason: 'Fewer than two accordion items could be found.' };
  const open = (i: InteractionInstance) =>
    page.locator(i.locator!).first().evaluate((el) => {
      const d = el.tagName === 'SUMMARY' ? (el.parentElement as HTMLDetailsElement) : el.tagName === 'DETAILS' ? (el as HTMLDetailsElement) : null;
      return d ? d.open : el.getAttribute('aria-expanded') === 'true';
    });
  for (const i of [a, b]) {
    if (!(await open(i))) {
      await page.locator(i.locator!).first().click({ timeout: STEP_TIMEOUT_MS });
      t.add('action', `Open ${i.label}.`);
      await quick();
    }
  }
  const aOpen = await open(a);
  const bOpen = await open(b);
  t.add('observed', 'Both items opened in turn', { firstStillOpen: aOpen, secondOpen: bOpen });
  const behavior = aOpen && bOpen ? 'multi-open (several items can be open at once)' : 'single-open (opening one closed the other)';
  return { status: 'manual_review_required', reason: `Observed ${behavior}. Whether that is intended depends on a declared policy for this course, which has not been given.`, actual: `Observed ${behavior}.` };
}

async function testDialog(page: Page, i: InteractionInstance, t: Tracer, navTimeout: number, dismiss: boolean): Promise<Outcome> {
  const opener = page.locator(i.locator ?? '').first();
  if (!i.locator || (await opener.count()) === 0) return { status: 'blocked', reason: `The opener "${i.label}" could not be found again on the screen.` };
  const before = await dialogCount(page);
  t.add('observed', 'Dialogs visible before', { count: before });
  await opener.click({ timeout: STEP_TIMEOUT_MS });
  t.add('action', `Activate ${i.label}.`);
  await quick();
  const after = await dialogCount(page);
  const content = await page.evaluate(() => {
    const visible = (el: Element) => (el as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? (el as HTMLElement).offsetParent !== null;
    const d = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]')].filter(visible).pop() as HTMLElement | undefined;
    return d ? d.innerText.trim().length : -1;
  });
  t.add('observed', 'Dialogs visible after opening', { count: after, textLength: content });
  if (after <= before) return { status: 'failed', reason: 'No dialog appeared.', actual: `Dialogs visible: ${before} before, ${after} after activating "${i.label}".` };
  if (!dismiss) {
    t.add('asserted', `A dialog is visible and has ${content} characters of text.`);
    return content > 0 ? { status: 'passed', actual: `A dialog opened with content (${content} characters).` } : { status: 'failed', reason: 'The dialog opened but is empty.', actual: 'The dialog contains no text.' };
  }
  // Dismiss through a close control inside the dialog; fall back to Escape and say which was used.
  const closed = await page.evaluate(() => {
    const visible = (el: Element) => (el as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? (el as HTMLElement).offsetParent !== null;
    const d = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]')].filter(visible).pop() as HTMLElement | undefined;
    if (!d) return null;
    const btn = [...d.querySelectorAll('button,[role="button"],a')].find((b) => visible(b) && /close|dismiss|cancel|got it|done|ok|continue|×|✕|✖/i.test((b.getAttribute('aria-label') ?? '') + ' ' + ((b as HTMLElement).innerText ?? '')));
    if (!btn) return null;
    (btn as HTMLElement).click();
    return ((btn.getAttribute('aria-label') ?? (btn as HTMLElement).innerText ?? 'close').trim() || 'close').slice(0, 40);
  });
  let method = closed ? `the "${closed}" control` : 'the Escape key';
  if (!closed) await page.keyboard.press('Escape');
  t.add('action', `Dismiss the dialog with ${method}.`);
  await quick();
  let still = await dialogCount(page);
  if (still > before && closed) {
    await page.keyboard.press('Escape');
    method += ' and then the Escape key';
    t.add('action', 'Press Escape.');
    await quick();
    still = await dialogCount(page);
  }
  const focusBack = await opener.evaluate((el) => el === document.activeElement || el.contains(document.activeElement)).catch(() => false);
  t.add('observed', 'After dismissing', { dialogsVisible: still, focusReturnedToOpener: focusBack });
  t.add('asserted', `Dialog closed: ${still <= before}. Focus returned to the opener: ${focusBack}.`);
  if (still > before) return { status: 'failed', reason: 'The dialog could not be dismissed.', actual: `After ${method}, ${still} dialog(s) were still visible.` };
  if (!focusBack) return { status: 'failed', reason: 'The dialog closed but keyboard focus did not return to the control that opened it.', actual: `Dismissed with ${method}. Focus was not on "${i.label}" afterwards.` };
  return { status: 'passed', actual: `The dialog closed with ${method} and focus returned to "${i.label}".` };
}

async function testNextPrevious(page: Page, next: InteractionInstance, t: Tracer, navTimeout: number): Promise<Outcome> {
  const loc = page.locator(next.locator ?? '').first();
  if (!next.locator || (await loc.count()) === 0) return { status: 'blocked', reason: 'The Next control could not be found again on the screen.' };
  const snap = () => page.evaluate(() => ({ key: `${location.pathname}${location.hash}`, text: (document.body.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000), title: document.title }));
  if (await isDisabled(loc)) return { status: 'manual_review_required', reason: 'Next is disabled on this screen, so it could not be tested. Courses often unlock Next after the learner finishes something; add a behavior rule for this screen to test that.', actual: 'Next was present but disabled.' };
  const before = await snap();
  try {
    await loc.click({ timeout: STEP_TIMEOUT_MS });
  } catch {
    return { status: 'blocked', reason: 'Next could not be clicked: it stayed covered or not ready for about 4 seconds (for example while the slide was still animating).', actual: 'No click happened.' };
  }
  t.add('action', `Activate ${next.label}.`);
  await quick();
  const forward = await snap();
  const changed = forward.key !== before.key || forward.text !== before.text;
  t.add('observed', 'After Next', { addressChanged: forward.key !== before.key, textChanged: forward.text !== before.text });
  if (!changed) return { status: 'failed', reason: 'Next did not change the content.', actual: 'After Next the address and the visible text were unchanged.' };
  const prev = page.getByRole('button', { name: /^(previous|back)\b/i }).or(page.getByRole('link', { name: /^(previous|back)\b/i }));
  if ((await prev.count()) === 0) return { status: 'manual_review_required', reason: 'Next worked, but no Previous or Back control was found on the next screen, so the way back could not be tested.', actual: 'Next changed the content.' };
  try {
    await prev.first().click({ timeout: STEP_TIMEOUT_MS });
  } catch {
    return { status: 'blocked', reason: 'Next worked, but Previous could not be clicked: it stayed covered or not ready for about 4 seconds, so the way back could not be tested.', actual: 'Next changed the content.' };
  }
  t.add('action', 'Activate Previous.');
  await quick();
  const back = await snap();
  t.add('observed', 'After Previous', { returnedToSameAddress: back.key === before.key, sameText: back.text === before.text });
  // The same screen may be reachable as two addresses (with and without a hash route), so identical content also counts as back where we started.
  if (back.key !== before.key && back.text !== before.text) return { status: 'failed', reason: 'Previous did not return to the screen Next came from.', actual: `Started at ${before.key}; Next went to ${forward.key}; Previous went to ${back.key}, which shows different content.` };
  if (back.key === before.key && back.text !== before.text) return { status: 'manual_review_required', reason: 'Previous returned to the same address but the visible text differs from before. State may not have been kept.', actual: 'Returned to the same address with different text.' };
  return { status: 'passed', actual: 'Next changed the content and Previous returned to the same screen. Whether Next led to the intended screen needs the course map.' };
}

// ---- behavior rules ----

interface Scenario {
  name: string;
  /** Items to activate, in order. */
  clicks: RuleItem[];
  /** Whether the event must appear after the last click, or stay absent through the observation window. */
  expect: 'fires' | 'absent';
  /** For "fires" scenarios, the event must not appear before the last click. */
  noEarlyFire: boolean;
  /** A media item that is started but not left to finish, to show that starting it is not enough. */
  startOnly?: RuleItem;
}

const itemName = (item: RuleItem) => parseMediaItem(item.label)?.control ?? item.label;

/** The longest a single media requirement is left to play. A longer one leaves the test blocked, never passed. */
const MEDIA_WAIT_MS = 120_000;

async function nearestMedia(control: Locator): Promise<ElementHandle<HTMLMediaElement> | null> {
  const handle = await control.evaluateHandle((el) => {
    if (el instanceof HTMLMediaElement) return el;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const m = p.querySelector('audio, video');
      if (m) return m;
    }
    return null;
  });
  return handle.asElement() as ElementHandle<HTMLMediaElement> | null;
}

async function testRule(page: Page, p: Planned, cap: string, input: FunctionalInput, navTimeout: number, t: Tracer): Promise<Outcome> {
  const rule = p.rule!;
  const required = rule.requiredItems;
  if (required.length === 0) return { status: 'blocked', reason: `The rule "${rule.title}" lists no required items.` };
  t.add('note', `Testing rule "${rule.title}", version ${rule.version ?? 1}. Expectation source: ${sourceLabel(rule.expectationSource)}.`);
  const observer = await makeObserver(page, rule, t);
  if (!observer.ok) return { status: 'blocked', reason: observer.why };

  let scenarios: Scenario[];
  switch (cap) {
    case 'rule_all_click':
      scenarios = [{ name: 'Activate every required item in the listed order', clicks: required, expect: 'fires', noEarlyFire: true }];
      break;
    case 'rule_premature':
      scenarios = [
        ...required.slice(0, MAX_OMISSIONS).map((omit) => ({ name: `Leave "${itemName(omit)}" untouched`, clicks: required.filter((_, j) => j !== required.indexOf(omit)), expect: 'absent' as const, noEarlyFire: false })),
        ...required.filter((x) => parseMediaItem(x.label)).map((m) => ({ name: `"${itemName(m)}" started but not finished, every other item activated`, clicks: [...required.filter((x) => x !== m), m], startOnly: m, expect: 'absent' as const, noEarlyFire: false })),
        ...(rule.optionalItems.length
          ? [
              { name: 'Activate only the optional items', clicks: rule.optionalItems, expect: 'absent' as const, noEarlyFire: false },
              { name: `Leave "${required[required.length - 1]!.label}" untouched but activate the optional items`, clicks: [...required.slice(0, -1), ...rule.optionalItems], expect: 'absent' as const, noEarlyFire: false },
            ]
          : []),
      ];
      break;
    case 'rule_duplicate': {
      if (required.length === 1) return { status: 'not_applicable', reason: 'The rule has a single required item, so repeated clicks on it are the requirement.' };
      // Repeating media would only pause it, so only ordinary items are repeated.
      const repeatable = required.filter((x) => !parseMediaItem(x.label));
      const missing = required[required.length - 1]!;
      const again = repeatable[0];
      scenarios = [
        ...[required[0]!, missing].filter((x, k, a) => a.indexOf(x) === k && repeatable.includes(x)).map((item) => ({ name: `Activate "${item.label}" four times, leaving the other items untouched`, clicks: [item, item, item, item], expect: 'absent' as const, noEarlyFire: false })),
        // One walk through the rule: locked after N-1 distinct items, still locked after a repeat, unlocked by the real last item.
        ...(again && again !== missing ? [{ name: `Activate all but "${itemName(missing)}", repeat "${again.label}", then activate "${itemName(missing)}"`, clicks: [...required.slice(0, -1), again, missing], expect: 'fires' as const, noEarlyFire: true }] : []),
      ];
      if (scenarios.length === 0) return { status: 'not_applicable', reason: 'Every required item is media, and repeating media would only pause it.' };
      break;
    }
    case 'rule_order': {
      const reversed = [...required].reverse();
      const shuffled = seededShuffle(required, rule.id);
      scenarios = [
        { name: 'Activate every required item in reverse order', clicks: reversed, expect: 'fires', noEarlyFire: true },
        ...(sameOrder(shuffled, required) || sameOrder(shuffled, reversed) ? [] : [{ name: 'Activate every required item in a shuffled order', clicks: shuffled, expect: 'fires' as const, noEarlyFire: true }]),
      ];
      break;
    }
    case 'rule_sequence': {
      const swapped = required.length >= 2 ? [required[1]!, required[0]!, ...required.slice(2)] : undefined;
      scenarios = [{ name: 'Activate every required item in the declared sequence', clicks: required, expect: 'fires', noEarlyFire: true }, ...(swapped ? [{ name: 'Activate the first two items in the wrong order', clicks: swapped, expect: 'absent' as const, noEarlyFire: false }] : [])];
      break;
    }
    default:
      return { status: 'manual_review_required', reason: `Unsupported rule test "${cap}".` };
  }

  const done: string[] = [];
  for (const [idx, sc] of scenarios.entries()) {
    // Each scenario starts from a clean copy of the screen. The first one reuses the page that was already reset.
    let useCtx: BrowserContext | undefined;
    let usePage = page;
    if (idx > 0) {
      useCtx = await input.newContext();
      usePage = await useCtx.newPage();
      const path = input.replay.find((r) => r.stateId === p.stateId)!;
      const re = await replay(usePage, input.targetUrl, path, navTimeout, t);
      if (!re.ok) {
        await useCtx.close().catch(() => undefined);
        return { status: 'blocked', reason: `A clean copy of the screen could not be opened for "${sc.name}": ${re.why}`, actual: `Completed ${done.length} of ${scenarios.length} scenarios.` };
      }
    }
    try {
      const obs = idx === 0 ? observer : await makeObserver(usePage, rule, t);
      if (!obs.ok) return { status: 'blocked', reason: obs.why };
      const r = await runScenario(usePage, rule, sc, obs, t, navTimeout);
      done.push(sc.name);
      if (r.status !== 'passed') return { ...r, actual: `${r.actual ?? ''} (scenario: ${sc.name}; ${done.length} of ${scenarios.length} run${required.length > MAX_OMISSIONS && cap === 'rule_premature' ? `; sampled: only the first ${MAX_OMISSIONS} of ${required.length} omissions were tried` : ''})`.trim() };
    } finally {
      await useCtx?.close().catch(() => undefined);
    }
  }
  const limited = cap === 'rule_premature' && required.length > MAX_OMISSIONS ? ` (Sampled omission coverage: the first ${MAX_OMISSIONS} of ${required.length} omissions were tested).` : '';
  return { status: 'passed', actual: `${done.length} scenario${done.length === 1 ? '' : 's'} behaved as the rule says: ${done.join('; ')}.${limited}` };
}

const sameOrder = (a: RuleItem[], b: RuleItem[]) => a.every((x, i) => x === b[i]);

/** A fixed shuffle (seeded by the rule ID) so the same rule is always tried in the same representative order. */
function seededShuffle<T>(list: readonly T[], seed: string): T[] {
  const out = [...list];
  let s = 0;
  for (const c of seed) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

interface Observer {
  ok: true;
  /** True when the expected event is observable on the screen right now. */
  present: () => Promise<boolean>;
  describe: string;
}

/** Turns the rule's expected event into something that can be read from the page, with its starting state remembered. */
async function makeObserver(page: Page, rule: BehaviorRule, t: Tracer): Promise<Observer | { ok: false; why: string }> {
  const ev: RuleEvent = rule.expectedEvent;
  const target = rule.eventTarget;
  const initial = { url: await urlKey(page), dialogs: await dialogCount(page) };
  switch (ev) {
    case 'next_enabled': {
      const found = await locate(page, target || 'Next');
      if (!found.ok) return { ok: false, why: `The control the event is observed on could not be used: ${found.why}` };
      return { ok: true, describe: `"${target || 'Next'}" becomes enabled`, present: async () => !(await isDisabled(found.loc)) && (await found.loc.isVisible().catch(() => false)) };
    }
    case 'message_shown': {
      if (!target) return { ok: false, why: 'The rule names no message text to look for.' };
      return { ok: true, describe: `the message "${truncate(target, 50)}" is shown`, present: async () => page.getByText(wholePhrase(target, 'iu')).filter({ visible: true }).count().then((n) => n > 0).catch(() => false) };
    }
    case 'layer_opened': {
      return {
        ok: true,
        describe: target ? `"${truncate(target, 50)}" appears` : 'a dialog or layer opens',
        present: async () => (target ? (await locate(page, target)).ok : (await dialogCount(page)) > initial.dialogs),
      };
    }
    case 'navigation_changed':
      return { ok: true, describe: 'the screen address changes', present: async () => (await urlKey(page)) !== initial.url };
    case 'progress_changed': {
      const found = await locate(page, target);
      if (!found.ok) return { ok: false, why: `The progress indicator could not be used: ${found.why}` };
      const start = (await found.loc.innerText().catch(() => '')).trim();
      return { ok: true, describe: `the progress indicator changes from "${truncate(start, 30)}"`, present: async () => (await found.loc.innerText().catch(() => start)).trim() !== start };
    }
    case 'completion_emitted': {
      const has = await page.evaluate(() => Boolean((window as unknown as { __cqaScorm?: unknown }).__cqaScorm)).catch(() => false);
      if (!has) return { ok: false, why: 'Completion is observed through the SCORM test harness, which is not running for this scan (scan the course as a SCORM package).' };
      const startSeq = await page.evaluate(() => (window as unknown as { __cqaScorm: { snapshot(): { calls: Array<{ seq: number }> } } }).__cqaScorm.snapshot().calls.length);
      t.add('observed', 'SCORM harness call count at start', { calls: startSeq });
      return {
        ok: true,
        describe: 'the course reports completion to the SCORM test harness',
        present: async () =>
          page.evaluate((from) => {
            const snap = (window as unknown as { __cqaScorm: { snapshot(): { calls: Array<{ fn: string; args: string[] }> } } }).__cqaScorm.snapshot();
            return snap.calls.slice(from).some((c) => /SetValue$/.test(c.fn) && /(completion_status|lesson_status|success_status)$/.test(c.args[0] ?? '') && /^(completed|passed)$/.test(c.args[1] ?? ''));
          }, startSeq),
      };
    }
  }
}

async function runScenario(page: Page, rule: BehaviorRule, sc: Scenario, obs: Observer, t: Tracer, navTimeout: number): Promise<Outcome> {
  t.add('note', `Scenario: ${sc.name}.`);
  if (await obs.present()) {
    t.add('observed', `Before any click, ${obs.describe} already.`);
    return sc.expect === 'fires'
      ? { status: 'blocked', reason: `The event was already present before any required item was activated (${obs.describe}), so the rule cannot be tested from a clean state. If it should not be present yet, that is itself a defect.`, actual: 'The event was present at the start.' }
      : { status: 'failed', reason: 'The event was present before any required item was activated.', actual: `Before any click, ${obs.describe}.` };
  }
  t.add('observed', `Before any click, ${obs.describe} is not true (as expected).`);
  const unique = new Set<string>();
  let started: ElementHandle<HTMLMediaElement> | null = null;
  const tooShort = async (): Promise<Outcome | undefined> =>
    started && (await started.evaluate((m) => m.ended)) ? { status: 'blocked', reason: 'The media finished before the check could tell whether starting it was enough.', actual: 'The scenario could not separate starting the media from finishing it.' } : undefined;
  for (const [k, item] of sc.clicks.entries()) {
    const name = itemName(item);
    const isMedia = Boolean(parseMediaItem(item.label));
    const found = await locate(page, item.locator || name);
    if (!found.ok) return { status: 'blocked', reason: `The item "${name}" could not be used: ${found.why}`, actual: 'The scenario could not be carried out.' };
    // Found before the click: a play control often renames itself once pressed.
    const media = isMedia ? await nearestMedia(found.loc) : null;
    if (isMedia && !media) return { status: 'blocked', reason: `No audio or video was found beside "${name}", so the rule cannot tell when it has finished.`, actual: 'The scenario could not be carried out.' };
    await found.loc.click({ timeout: STEP_TIMEOUT_MS });
    unique.add(name);
    t.add('action', `Activate "${name}"${sc.clicks.indexOf(item) !== k ? ' (again)' : ''}.`, { uniqueItemsActivated: [...unique], clickNumber: k + 1 });
    if (media && sc.startOnly === item) {
      started = media;
      t.add('note', `"${name}" was started and is deliberately not left to finish.`);
    } else if (media) {
      const ended = await page.waitForFunction((m) => m.ended, media, { timeout: MEDIA_WAIT_MS, polling: 100 }).then(() => true, () => false);
      if (!ended) {
        const at = await media.evaluate((m) => ({ position: m.currentTime, duration: m.duration, paused: m.paused }));
        t.add('observed', `"${name}" did not reach its end.`, at);
        return { status: 'blocked', reason: `"${name}" did not play to its end within ${MEDIA_WAIT_MS / 1000} seconds, so the rule could not be tested.`, actual: `The media stopped at ${at.position.toFixed(1)} of ${at.duration.toFixed(1)} seconds.` };
      }
      t.add('observed', `"${name}" played to its end.`);
    }
    await quick();
    const last = k === sc.clicks.length - 1;
    if (!last || sc.expect === 'absent') {
      // Give an event wired to a click a moment to show up before deciding it has not.
      await sleep(350);
      if (await obs.present()) {
        const blocked = await tooShort();
        if (blocked) return blocked;
        const early = !last || sc.expect === 'absent';
        t.add('observed', `After click ${k + 1} ("${name}"), ${obs.describe}.`, { uniqueItemsActivated: [...unique] });
        if (early && (sc.noEarlyFire || sc.expect === 'absent')) {
          return { status: 'failed', reason: sc.expect === 'absent' ? 'The event fired when it should not have.' : 'The event fired before the last required item.', actual: `After ${k + 1} click${k === 0 ? '' : 's'} (${unique.size} unique item${unique.size === 1 ? '' : 's'}: ${[...unique].map((u) => `"${u}"`).join(', ')}), ${obs.describe}. The rule requires ${rule.requiredItems.length} unique items.` };
        }
      }
    }
  }
  if (sc.expect === 'fires') {
    const deadline = Date.now() + rule.timingWindowMs;
    let fired = false;
    while (Date.now() < deadline) {
      if (await obs.present()) {
        fired = true;
        break;
      }
      await sleep(100);
    }
    t.add('observed', fired ? `After the final item, ${obs.describe}.` : `After the final item and ${rule.timingWindowMs} ms, ${obs.describe} did not happen.`);
    t.add('asserted', `Event present after the final required item: ${fired}.`);
    if (!fired) return { status: 'failed', reason: 'The event did not fire after the last required item.', actual: `After all ${rule.requiredItems.length} required items were activated, ${obs.describe} did not happen within ${rule.timingWindowMs} ms.` };
    if (rule.destination) {
      const target = rule.expectedEvent === 'next_enabled' ? await locate(page, rule.eventTarget || 'Next') : undefined;
      if (target?.ok) {
        await target.loc.click({ timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
        t.add('action', `Activate "${rule.eventTarget || 'Next'}".`);
        await quick();
        const text = (await page.evaluate(() => `${location.href}\n${document.body.innerText}`)).toLowerCase();
        const reached = text.includes(rule.destination.toLowerCase());
        t.add('asserted', `Destination "${rule.destination}" reached: ${reached}.`);
        if (!reached) return { status: 'failed', reason: 'The event fired but the destination was not the declared one.', actual: `After using "${rule.eventTarget || 'Next'}", the screen did not contain "${rule.destination}".` };
      }
    }
    return { status: 'passed', actual: `${obs.describe[0]!.toUpperCase()}${obs.describe.slice(1)} only after the last required item.` };
  }
  // Absence is judged over a window, never from one instant.
  // Kept short while media is playing, so the window closes before a short clip can finish by itself.
  const windowMs = sc.startOnly ? 800 : Math.min(Math.max(rule.timingWindowMs, 800), 3_000);
  const end = Date.now() + windowMs;
  while (Date.now() < end) {
    if (await obs.present()) {
      const blocked = await tooShort();
      if (blocked) return blocked;
      t.add('observed', `During the ${windowMs} ms observation window, ${obs.describe}.`);
      return { status: 'failed', reason: 'The event fired when it should not have.', actual: `${[...unique].length} unique of ${rule.requiredItems.length} required item(s) were activated, yet ${obs.describe}.` };
    }
    await sleep(100);
  }
  t.add('observed', `For ${windowMs} ms after the last click, ${obs.describe} stayed false.`, { uniqueItemsActivated: [...unique], windowMs });
  t.add('asserted', 'Event stayed absent through the observation window.');
  return { status: 'passed', actual: `${unique.size} of ${rule.requiredItems.length} required items activated; the event stayed absent for ${windowMs} ms.` };
}

// ---- run-level records ----

/**
 * Records, once for the run, every case that was not executed by an engine: the manual queue, cases that need a
 * configured expectation, and automated cases with nothing to apply to. None of these is a pass.
 */
export function recordRunLevelCases(args: { qa: QaStore; runId: string; definitions: ReadonlyMap<string, TestDefinition>; hasRules: boolean; hasAnswerKeys?: boolean; mappedIds: ReadonlySet<string>; engineVersion?: string; contentHash?: string; configHash?: string }): void {
  const { qa, runId } = args;
  const at = nowIso();
  const current = qa.currentExecutions(runId);
  const exercised = (id: string) => current.some((e) => e.definitionId === id);
  for (const def of args.definitions.values()) {
    if (def.reviewState === 'retired' || args.mappedIds.has(def.id) || exercised(def.id)) continue;
    const auto = effectiveAutomation(def);
    const base = { runId, definitionId: def.id, definitionVersion: def.version, externalId: def.externalId, expected: def.body.expectedResult, expectedSource: def.body.expectationSource, trace: [] as ExecutionTraceStep[], evidenceIds: [] as string[], scope: 'functional' as const, engineVersion: args.engineVersion ?? ENGINE_VERSION, contentHash: args.contentHash, configHash: args.configHash, startedAt: at, finishedAt: at };
    if (auto === 'manual') {
      qa.insertExecution({ ...base, status: 'manual_review_required', reason: def.body.requiredCapability ? `The case needs the capability "${def.body.requiredCapability}", which this scanner does not have.` : 'No automation exists for this case. A person checks it and records the result.', actual: 'Not executed by the scanner.' });
    } else if (def.body.requiredCapability?.startsWith('assess_') && args.hasAnswerKeys) {
      qa.insertExecution({ ...base, status: 'not_applicable', reason: 'The answer keys for this course do not cover this check (for example no retry, or no answer required), so it does not apply.', actual: 'Nothing to test.' });
    } else if (def.body.requiredCapability?.startsWith('assess_')) {
      qa.insertExecution({ ...base, status: 'manual_review_required', reason: 'No answer key is configured for this question. Correct answers are never guessed: add an answer key to test it automatically, or check it by hand.', actual: 'Not executed.' });
    } else if (def.id.startsWith('LOG-') && !args.hasRules) {
      qa.insertExecution({ ...base, status: 'manual_review_required', reason: 'The expected behavior is unknown: no behavior rule is configured for this course. Add a rule to test it automatically.', actual: 'Not executed.' });
    } else if (def.id === 'LOG-04' || def.id === 'LOG-05') {
      qa.insertExecution({ ...base, status: 'not_applicable', reason: def.id === 'LOG-04' ? 'No behavior rule is declared as order-independent, so representative orders are not tried.' : 'No behavior rule declares a required sequence, so sequence cases do not apply.', actual: 'Nothing to test.' });
    } else if (def.id.startsWith('LOG-')) {
      qa.insertExecution({ ...base, status: 'not_applicable', reason: 'The behavior rules configured for this course were not testable on any visited screen (see their blocked results).', actual: 'Nothing to test.' });
    } else {
      qa.insertExecution({ ...base, status: 'not_applicable', reason: `No ${def.interactionType === 'general' ? def.category.toLowerCase() : def.interactionType} control that this case applies to was detected on any visited screen.`, actual: 'Nothing to test.' });
    }
  }
}
