import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import type { BehaviorRule, ContentUnit, CourseState, EvidenceId, EvidenceSink, ExecutionTraceStep, InteractionInstance, RuleEvent, RuleItem, ScanRun, TestDefinition, TestExecution, TestStatus } from '@cqa/shared';
import { type QaStore, effectiveAutomation, isPrimaryUnit, nowIso } from '@cqa/core';
import type { NewCheck, NewFinding } from './helpers.js';
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
const MAX_OMISSIONS = 6;

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
}

interface Planned {
  executionId: string;
  def: TestDefinition;
  unit: ContentUnit;
  stateId: string;
  instance?: InteractionInstance;
  rule?: BehaviorRule;
}

type Outcome = { status: TestStatus; reason?: string; actual?: string };

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
  };

  for (const unit of units) {
    const stateId = baseStateOf(unit);
    if (!stateId || !replayByState.has(stateId)) continue;
    const inter = qa.listInteractions(run.id, unit.id).filter((i) => i.capabilities.includes('activate'));
    let count = 0;
    const room = () => count < MAX_TESTS_PER_UNIT;
    const plan = (id: string, i?: InteractionInstance) => {
      const def = usable(id);
      if (!def || !room()) return;
      addPlan(def, unit, stateId, { instance: i });
      count++;
    };
    for (const i of inter) {
      if (i.type === 'tab') plan('TAB-01', i);
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
    if (!unit) {
      for (const id of ['LOG-01', 'LOG-02', 'LOG-03']) {
        const def = input.definitions.get(id);
        if (def) qa.insertExecution({ runId: run.id, definitionId: id, definitionVersion: def.version, instanceId: `rule:${rule.id}`, status: 'blocked', reason: `The rule "${rule.title}" names a screen ("${rule.unitMatch || 'the launch page'}") that no browser visit reached, so it could not be tested.`, expected: def.body.expectedResult, expectedSource: rule.expectationSource, trace: [], evidenceIds: [], scope: 'functional', engineVersion: ENGINE_VERSION, startedAt: nowIso(), finishedAt: nowIso() });
      }
      continue;
    }
    const stateId = baseStateOf(unit)!;
    const ids = ['LOG-01', 'LOG-02', 'LOG-03', rule.orderPolicy === 'any_order' ? 'LOG-04' : 'LOG-05'];
    for (const id of ids) {
      const def = usable(id);
      if (def) addPlan(def, unit, stateId, { rule });
    }
  }
  qa.recount(run.id);

  // ---- run, one unit at a time, each test at a clean copy of its screen ----
  const byUnit = new Map<string, Planned[]>();
  for (const p of planned) byUnit.set(p.unit.id, [...(byUnit.get(p.unit.id) ?? []), p]);

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
  qa.recount(run.id);
  return { checks, findings };
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
  let context: BrowserContext | undefined;
  try {
    context = await input.newContext();
    const page = await context.newPage();
    const reached = await replay(page, input.targetUrl, path, navTimeout, tracer);
    if (!reached.ok) {
      outcome = { status: 'blocked', reason: `The screen could not be reached again to run this check: ${reached.why}`, actual: 'No result.' };
    } else {
      outcome = await dispatch(page, p, input, navTimeout, tracer);
    }
    if (outcome.status === 'failed' || outcome.status === 'manual_review_required') shot = await screenshot(page, input, state, `${p.def.id}: ${p.def.title}`);
  } catch (err) {
    if (input.signal.aborted) throw err;
    outcome = { status: 'error', reason: `The test runner failed: ${truncate((err as Error).message, 200)}. This is not a confirmed defect in the course.`, actual: 'No result.' };
  } finally {
    await context?.close().catch(() => undefined);
  }

  const done = qa.updateExecution(p.executionId, {
    status: outcome.status,
    reason: outcome.status === 'passed' ? undefined : (outcome.reason ?? 'No reason was recorded.'),
    actual: outcome.actual,
    trace: tracer.steps,
    evidenceIds: shot ? [shot] : [],
    finishedAt: nowIso(),
  })!;
  qa.appendEvent(run.id, 'test_finished', { executionId: p.executionId, caseId: p.def.id, unitId: p.unit.id, status: done.status });
  qa.recount(run.id);

  // Failures become findings so they flow into the issue list, statuses and reports. Errors and blocks do not.
  const ruleId = p.rule ? 'FUN-002' : 'FUN-001';
  if (done.status === 'passed' || done.status === 'failed') {
    checks.push(check(ruleId, done.status === 'passed' ? 'passed' : 'failed', 0, shot ? [shot] : [], { stateId: state?.id, viewportName: run.config.viewports[0]?.name }));
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
          evidenceIds: shot ? [shot] : [],
          reproductionSteps: [`Open ${input.targetUrl}.`, ...path.steps.map((s) => `Activate ${s.description}.`), ...tracer.steps.filter((t) => t.step === 'action').map((t) => t.detail)],
          remediation: p.rule ? `Check the trigger logic for "${subject}". The ordered action trace shows the click sequence and when the event appeared.` : `Check how "${subject}" is built or authored. The trace in the test result shows what was done and what was observed.`,
          targetKey: `${p.def.id}|${p.instance?.id ?? p.rule?.id ?? ''}`,
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
    tracer.add('entered_unit', `Opened ${targetUrl}`);
    for (const step of path.steps) {
      if (step.kind === 'navigate' && step.rawHref) await page.goto(step.rawHref, { waitUntil: 'load', timeout: navTimeout });
      else if (step.locator) await page.locator(step.locator).first().click({ timeout: STEP_TIMEOUT_MS });
      else return { ok: false, why: `No way to repeat "${step.description}".` };
      await settle(page, navTimeout);
      tracer.add('action', `Activate ${step.description}.`, { replay: true });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, why: truncate((err as Error).message, 160) };
  }
}

async function screenshot(page: Page, input: FunctionalInput, state: CourseState | undefined, caption: string): Promise<EvidenceId | undefined> {
  try {
    const bytes = await page.screenshot({ type: 'png', timeout: 8_000 });
    const artifactId = await input.evidence.writeArtifact({ kind: 'screenshot', mime: 'image/png', bytes });
    return (await input.evidence.addEvidence({ kind: 'screenshot', artifactId, caption, stateId: state?.id, viewportName: input.run.config.viewports[0]?.name, capturedAt: nowIso(), redacted: false })).id;
  } catch {
    return undefined;
  }
}

async function dispatch(page: Page, p: Planned, input: FunctionalInput, navTimeout: number, t: Tracer): Promise<Outcome> {
  const cap = p.def.body.requiredCapability;
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
    case 'rule_all_click':
    case 'rule_premature':
    case 'rule_duplicate':
    case 'rule_order':
    case 'rule_sequence':
      return testRule(page, p, cap, input, navTimeout, t);
    default:
      return { status: 'manual_review_required', reason: `This case names the capability "${cap ?? 'none'}", which the scanner does not implement.` };
  }
}

// ---- interaction tests ----

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
      return { expanded, visible, readable: text.length > 0, hasRegion: Boolean(region) };
    });
  const before = await read();
  t.add('observed', 'State before', before);
  if (!before.expanded) {
    await loc.click({ timeout: STEP_TIMEOUT_MS });
    t.add('action', `Open ${i.label}.`);
    await quick();
  } else t.add('note', 'The item was already open, so it was not clicked.');
  const after = await read();
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
  const before = await snap();
  await loc.click({ timeout: STEP_TIMEOUT_MS });
  t.add('action', `Activate ${next.label}.`);
  await quick();
  const forward = await snap();
  const changed = forward.key !== before.key || forward.text !== before.text;
  t.add('observed', 'After Next', { addressChanged: forward.key !== before.key, textChanged: forward.text !== before.text });
  if (!changed) return { status: 'failed', reason: 'Next did not change the content.', actual: 'After Next the address and the visible text were unchanged.' };
  const prev = page.getByRole('button', { name: /^(previous|back)\b/i }).or(page.getByRole('link', { name: /^(previous|back)\b/i }));
  if ((await prev.count()) === 0) return { status: 'manual_review_required', reason: 'Next worked, but no Previous or Back control was found on the next screen, so the way back could not be tested.', actual: 'Next changed the content.' };
  await prev.first().click({ timeout: STEP_TIMEOUT_MS });
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
}

async function testRule(page: Page, p: Planned, cap: string, input: FunctionalInput, navTimeout: number, t: Tracer): Promise<Outcome> {
  const rule = p.rule!;
  const required = rule.requiredItems;
  if (required.length === 0) return { status: 'blocked', reason: `The rule "${rule.title}" lists no required items.` };
  const observer = await makeObserver(page, rule, t);
  if (!observer.ok) return { status: 'blocked', reason: observer.why };

  let scenarios: Scenario[];
  switch (cap) {
    case 'rule_all_click':
      scenarios = [{ name: 'Activate every required item in the listed order', clicks: required, expect: 'fires', noEarlyFire: true }];
      break;
    case 'rule_premature':
      scenarios = [
        ...required.slice(0, MAX_OMISSIONS).map((omit) => ({ name: `Leave "${omit.label}" untouched`, clicks: required.filter((_, j) => j !== required.indexOf(omit)), expect: 'absent' as const, noEarlyFire: false })),
        ...(rule.optionalItems.length
          ? [
              { name: 'Activate only the optional items', clicks: rule.optionalItems, expect: 'absent' as const, noEarlyFire: false },
              { name: `Leave "${required[required.length - 1]!.label}" untouched but activate the optional items`, clicks: [...required.slice(0, -1), ...rule.optionalItems], expect: 'absent' as const, noEarlyFire: false },
            ]
          : []),
      ];
      break;
    case 'rule_duplicate':
      scenarios = [required[0]!, required[required.length - 1]!].filter((x, k, a) => a.indexOf(x) === k).map((item) => ({ name: `Activate "${item.label}" four times, leaving the other items untouched`, clicks: [item, item, item, item], expect: 'absent' as const, noEarlyFire: false }));
      if (required.length === 1) return { status: 'not_applicable', reason: 'The rule has a single required item, so repeated clicks on it are the requirement.' };
      break;
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
      if (r.status !== 'passed') return { ...r, actual: `${r.actual ?? ''} (scenario: ${sc.name}; ${done.length} of ${scenarios.length} run${required.length > MAX_OMISSIONS && cap === 'rule_premature' ? `; only the first ${MAX_OMISSIONS} omissions were tried` : ''})`.trim() };
    } finally {
      await useCtx?.close().catch(() => undefined);
    }
  }
  const limited = cap === 'rule_premature' && required.length > MAX_OMISSIONS ? ` Only the first ${MAX_OMISSIONS} of ${required.length} omissions were tried.` : '';
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
      return { ok: true, describe: `the message "${truncate(target, 50)}" is shown`, present: async () => page.getByText(target).filter({ visible: true }).count().then((n) => n > 0).catch(() => false) };
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
  for (const [k, item] of sc.clicks.entries()) {
    const found = await locate(page, item.locator || item.label);
    if (!found.ok) return { status: 'blocked', reason: `The item "${item.label}" could not be used: ${found.why}`, actual: 'The scenario could not be carried out.' };
    await found.loc.click({ timeout: STEP_TIMEOUT_MS });
    unique.add(item.label);
    t.add('action', `Activate "${item.label}"${sc.clicks.indexOf(item) !== k ? ' (again)' : ''}.`, { uniqueItemsActivated: [...unique], clickNumber: k + 1 });
    await quick();
    const last = k === sc.clicks.length - 1;
    if (!last || sc.expect === 'absent') {
      // Give an event wired to a click a moment to show up before deciding it has not.
      await sleep(350);
      if (await obs.present()) {
        const early = !last || sc.expect === 'absent';
        t.add('observed', `After click ${k + 1} ("${item.label}"), ${obs.describe}.`, { uniqueItemsActivated: [...unique] });
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
  const windowMs = Math.min(Math.max(rule.timingWindowMs, 800), 3_000);
  const end = Date.now() + windowMs;
  while (Date.now() < end) {
    if (await obs.present()) {
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
export function recordRunLevelCases(args: { qa: QaStore; runId: string; definitions: ReadonlyMap<string, TestDefinition>; hasRules: boolean; mappedIds: ReadonlySet<string>; engineVersion?: string; contentHash?: string; configHash?: string }): void {
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
