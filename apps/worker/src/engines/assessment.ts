import type { Locator, Page } from 'playwright';
import type { AssessmentSpec, BehaviorRule, EvidenceId, TestStatus } from '@cqa/shared';
import { wholePhrase } from './helpers.js';

/**
 * Quiz checks driven by an answer key someone supplied. Correctness is never worked out from what the course shows: without
 * a key these checks do not run. Every attempt uses a fresh copy of the screen, so an earlier answer cannot affect a later check.
 */

export type AssessmentOutcome = { status: TestStatus; reason?: string; actual?: string; evidenceId?: EvidenceId; extraEvidence?: EvidenceId[]; reproSteps?: string[] };
export type LocateResult = { ok: true; loc: Locator } | { ok: false; why: string };

export interface AssessmentDeps {
  rule: BehaviorRule;
  /** The check being run: MCQ-03 uses the correct answers, MCQ-04 the incorrect ones. */
  caseId: string;
  /** A fresh copy of the screen. Closed by `close`. */
  /** `close(true)` keeps the attempt's browser trace and returns it as evidence. */
  fresh: () => Promise<{ ok: true; page: Page; close: (keepTrace: boolean) => Promise<EvidenceId | undefined> } | { ok: false; why: string }>;
  locate: (page: Page, spec: string) => Promise<LocateResult>;
  add: (step: 'action' | 'observed' | 'asserted' | 'note', detail: string, data?: Record<string, unknown>) => void;
  /** Takes the screenshot for a failed attempt, while that attempt's screen is still open. */
  capture: (page: Page, caption: string) => Promise<EvidenceId | undefined>;
}

const CLICK_TIMEOUT_MS = 4_000;
const POLL_MS = 100;
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** A short wait for an in-page state change to take effect, not a wait for the course's behavior: results are polled below. */
const settle = () => pause(250);

class Blocked extends Error {}

const textVisible = (page: Page, text: string) =>
  page
    .getByText(wholePhrase(text))
    .filter({ visible: true })
    .count()
    .then((n) => n > 0)
    .catch(() => false);

/** True as soon as the condition holds; false if it never does in the window. Animated players need a moment. */
async function eventually(condition: () => Promise<boolean>, windowMs: number): Promise<boolean> {
  const end = Date.now() + windowMs;
  do {
    if (await condition()) return true;
    await pause(POLL_MS);
  } while (Date.now() < end);
  return false;
}

const appears = (page: Page, text: string, windowMs: number) => eventually(() => textVisible(page, text), windowMs);

/** Finds an answer by its own words, so a shuffled order does not matter. */
async function findOption(page: Page, label: string, deps: AssessmentDeps): Promise<Locator> {
  for (const candidate of [page.getByRole('radio', { name: label, exact: true }), page.getByRole('checkbox', { name: label, exact: true }), page.getByLabel(label, { exact: true })]) {
    const visible = candidate.filter({ visible: true });
    if ((await visible.count().catch(() => 0)) === 1) return visible.first();
  }
  const found = await deps.locate(page, label);
  if (!found.ok) throw new Blocked(`The answer "${label}" could not be used: ${found.why} If the course randomizes its questions, the answer key may not match the one shown.`);
  return found.loc;
}

const isChecked = (option: Locator) => option.isChecked({ timeout: 1_000 }).catch(() => undefined);

async function choose(page: Page, answers: readonly string[], deps: AssessmentDeps): Promise<void> {
  for (const answer of answers) {
    const option = await findOption(page, answer, deps);
    await option.click({ timeout: CLICK_TIMEOUT_MS });
    deps.add('action', `Choose "${answer}".`);
    await settle();
  }
}

async function press(page: Page, name: string, deps: AssessmentDeps): Promise<void> {
  const found = await deps.locate(page, name);
  if (!found.ok) throw new Blocked(`"${name}" could not be used: ${found.why}`);
  await found.loc.click({ timeout: CLICK_TIMEOUT_MS });
  deps.add('action', `Activate "${name}".`);
  await settle();
}

/** Whether the control can be used. Several controls matching the name is a problem with the key, so it blocks rather than counting as absent. */
async function isAvailable(page: Page, name: string, deps: AssessmentDeps): Promise<boolean> {
  const found = await deps.locate(page, name);
  if (!found.ok) {
    if (/^(No visible control|Nothing on the screen)/.test(found.why)) return false;
    throw new Blocked(`"${name}" could not be used: ${found.why}`);
  }
  return !(await found.loc.isDisabled({ timeout: 1_000 }).catch(() => false));
}

/** The submit control must exist even if disabled: not finding it means the key names the wrong thing, not that blank answers are refused. */
async function submitDisabled(page: Page, name: string, deps: AssessmentDeps): Promise<boolean> {
  const found = await deps.locate(page, name);
  if (!found.ok) throw new Blocked(`"${name}" could not be used: ${found.why}`);
  return found.loc.isDisabled({ timeout: 1_000 }).catch(() => false);
}

const otherFeedback = (spec: AssessmentSpec, expected: string) => [...new Set(spec.cases.map((c) => c.feedback))].filter((f) => f !== expected);

export async function testAssessment(cap: string, deps: AssessmentDeps): Promise<AssessmentOutcome> {
  const spec = deps.rule.assessment;
  if (!spec) return { status: 'manual_review_required', reason: 'No answer key is configured for this question.' };
  deps.add('note', `Testing against the answer key in rule "${deps.rule.title}", version ${deps.rule.version ?? 1}.`, { ruleVersion: deps.rule.version ?? 1 });
  const windowMs = deps.rule.timingWindowMs;

  /** Runs one attempt on its own fresh screen. */
  const attempt = async <T>(body: (page: Page) => Promise<T>): Promise<T> => {
    const screen = await deps.fresh();
    if (!screen.ok) throw new Blocked(`A clean copy of the screen could not be opened: ${screen.why}`);
    const steps: string[] = [];
    const add = deps.add;
    deps = { ...deps, add: (step, detail, data) => (step === 'action' && steps.push(detail), add(step, detail, data)) };
    let result: T;
    let failed = false;
    let traceId: EvidenceId | undefined;
    try {
      result = await body(screen.page);
      const outcome = result as AssessmentOutcome | undefined;
      if (outcome?.status === 'failed') {
        failed = true;
        const evidenceId = await deps.capture(screen.page, `${deps.caseId}: ${outcome.reason ?? 'failed'}`);
        result = { ...outcome, reproSteps: steps, ...(evidenceId ? { evidenceId } : {}) } as T;
      }
    } finally {
      deps = { ...deps, add };
      traceId = await screen.close(failed);
    }
    if (failed && traceId) (result as AssessmentOutcome).extraEvidence = [traceId];
    return result;
  };

  try {
    switch (cap) {
      case 'assess_unanswered': {
        const required = spec.unanswered;
        if (!required) return { status: 'not_applicable', reason: 'The answer key does not say that an answer is required.' };
        return await attempt(async (page) => {
          if (await submitDisabled(page, spec.submit, deps)) {
            deps.add('observed', `"${spec.submit}" cannot be used before an answer is chosen.`);
            return { status: 'passed', actual: `"${spec.submit}" could not be used without an answer.` } as AssessmentOutcome;
          }
          await press(page, spec.submit, deps);
          const shown = required.message ? await appears(page, required.message, windowMs) : true;
          await pause(windowMs);
          const marked = (await Promise.all([...new Set(spec.cases.map((c) => c.feedback))].map(async (f) => ((await textVisible(page, f)) ? f : undefined)))).filter(Boolean);
          deps.add('observed', `After submitting with no answer: validation message ${required.message ? (shown ? 'shown' : 'not shown') : 'not specified'}; answer feedback shown: ${marked.join(', ') || 'none'}.`);
          if (marked.length) return { status: 'failed', reason: 'A blank submission was marked as an answer.', actual: `Submitting with no answer showed "${marked[0]}".` };
          if (!shown) return { status: 'failed', reason: 'The validation message did not appear.', actual: `Submitting with no answer did not show "${required.message}" within ${windowMs} ms.` };
          return { status: 'passed', actual: 'A blank submission was refused and not marked.' };
        });
      }
      case 'assess_answer_key': {
        const wanted = deps.caseId === 'MCQ-04' ? spec.cases.filter((c) => !c.correct) : spec.cases.filter((c) => c.correct);
        if (!wanted.length) return { status: 'not_applicable', reason: `The answer key has no ${deps.caseId === 'MCQ-04' ? 'incorrect' : 'correct'} case.` };
        for (const c of wanted) {
          deps.add('note', `Case: ${c.name}, from a fresh start.`);
          const result = await attempt(async (page): Promise<AssessmentOutcome | undefined> => {
            await choose(page, c.answers, deps);
            await press(page, spec.submit, deps);
            const shown = await appears(page, c.feedback, windowMs);
            deps.add('observed', shown ? `Feedback "${c.feedback}" appeared.` : `Feedback "${c.feedback}" did not appear within ${windowMs} ms.`);
            if (!shown) {
              const instead = (await Promise.all(otherFeedback(spec, c.feedback).map(async (f) => ((await textVisible(page, f)) ? f : undefined)))).find(Boolean);
              return { status: 'failed', reason: 'The expected feedback did not appear.', actual: `For "${c.name}" (${c.answers.join(', ')}), the course ${instead ? `showed "${instead}"` : 'showed no matching feedback'} instead of "${c.feedback}".` };
            }
            if (c.score) {
              const scored = await appears(page, c.score, windowMs);
              deps.add('observed', scored ? `Score "${c.score}" appeared.` : `Score "${c.score}" did not appear.`);
              if (!scored) return { status: 'failed', reason: 'The expected score did not appear.', actual: `For "${c.name}", "${c.score}" was not shown.` };
            }
            return undefined;
          });
          if (result) return result;
        }
        return { status: 'passed', actual: `Tested from a fresh start each: ${wanted.map((c) => c.name).join('; ')}.` };
      }
      case 'assess_selection':
        return await attempt(async (page) => {
          const unread = (label: string): AssessmentOutcome => ({ status: 'inconclusive', reason: `Whether "${label}" is selected could not be read. Custom-drawn answers do not expose it; check by hand.`, actual: 'Selection state unknown.' });
          if (spec.selection === 'single') {
            const labels = [...new Set(spec.cases.flatMap((c) => c.answers))];
            if (labels.length < 2) return { status: 'not_applicable', reason: 'The answer key names fewer than two answers, so switching cannot be tested.' } as AssessmentOutcome;
            const [first, second] = [labels[0]!, labels[1]!];
            await choose(page, [first, second], deps);
            const [a, b] = [await isChecked(await findOption(page, first, deps)), await isChecked(await findOption(page, second, deps))];
            if (a === undefined) return unread(first);
            if (b === undefined) return unread(second);
            deps.add('observed', `After choosing "${first}" then "${second}": ${first} selected=${a}, ${second} selected=${b}.`);
            return a || !b ? ({ status: 'failed', reason: 'A single-choice question did not keep exactly one answer selected.', actual: `After choosing "${first}" then "${second}", "${first}" selected=${a} and "${second}" selected=${b}.` } as AssessmentOutcome) : ({ status: 'passed', actual: 'Only the last chosen answer stayed selected.' } as AssessmentOutcome);
          }
          const set = [...spec.cases].sort((x, y) => y.answers.length - x.answers.length)[0]!.answers;
          if (set.length < 2) return { status: 'not_applicable', reason: 'No case in the answer key selects two or more answers.' } as AssessmentOutcome;
          await choose(page, set, deps);
          for (const label of set) {
            const on = await isChecked(await findOption(page, label, deps));
            if (on === undefined) return unread(label);
            if (!on) return { status: 'failed', reason: 'A chosen answer did not stay selected.', actual: `"${label}" was not selected after choosing ${set.join(', ')}.` } as AssessmentOutcome;
          }
          await choose(page, [set[0]!], deps);
          const off = await isChecked(await findOption(page, set[0]!, deps));
          const kept = await isChecked(await findOption(page, set[1]!, deps));
          if (off === undefined) return unread(set[0]!);
          if (kept === undefined) return unread(set[1]!);
          deps.add('observed', `After clearing "${set[0]}": ${set[0]} selected=${off}, ${set[1]} selected=${kept}.`);
          return off || !kept ? ({ status: 'failed', reason: 'Clearing one answer did not leave the others as they were.', actual: `After clearing "${set[0]}", it was selected=${off} and "${set[1]}" selected=${kept}.` } as AssessmentOutcome) : ({ status: 'passed', actual: `The selected set followed each choice (${set.join(', ')}).` } as AssessmentOutcome);
        });
      case 'assess_retry': {
        const retry = spec.retry;
        const wrong = spec.cases.find((c) => !c.correct);
        if (!retry || !wrong) return { status: 'not_applicable', reason: 'The answer key gives no retry control or no incorrect case.' };
        return await attempt(async (page): Promise<AssessmentOutcome> => {
          const limit = retry.maxAttempts ?? 1;
          for (let n = 1; n <= limit; n++) {
            await choose(page, wrong.answers, deps);
            await press(page, spec.submit, deps);
            if (!(await appears(page, wrong.feedback, windowMs))) return { status: 'failed', reason: 'The expected feedback did not appear.', actual: `Attempt ${n}: "${wrong.feedback}" was not shown.` };
            if (retry.maxAttempts && n === limit) {
              // "Gone" must hold for the whole window: a button can appear just after the feedback does.
              const gone = !(await eventually(() => isAvailable(page, retry.control, deps), windowMs));
              deps.add('observed', gone ? `"${retry.control}" is no longer offered after ${n} attempts.` : `"${retry.control}" is still offered after ${n} attempts.`);
              return gone ? { status: 'passed', actual: `Retry worked and ended after ${n} attempts, as the key says.` } : { status: 'failed', reason: 'More attempts were offered than allowed.', actual: `"${retry.control}" was still available after ${n} attempts; the limit is ${limit}.` };
            }
            if (!(await eventually(() => isAvailable(page, retry.control, deps), windowMs))) return { status: 'failed', reason: 'Retry was not offered.', actual: `After attempt ${n} of ${limit}, "${retry.control}" could not be used.` };
            await press(page, retry.control, deps);
            const cleared = await eventually(async () => !(await textVisible(page, wrong.feedback)), windowMs);
            for (const label of wrong.answers) {
              const option = await findOption(page, label, deps);
              const reset = await eventually(async () => (await isChecked(option)) !== true, windowMs);
              const state = await isChecked(option);
              if (state === undefined) return { status: 'inconclusive', reason: `Whether "${label}" was cleared could not be read. Custom-drawn answers do not expose it; check by hand.`, actual: 'Selection state unknown.' };
              if (!reset) return { status: 'failed', reason: 'Retry did not reset the question.', actual: `After "${retry.control}", "${label}" was still selected.` };
            }
            if (!cleared) return { status: 'failed', reason: 'Retry did not reset the question.', actual: `After "${retry.control}", the feedback "${wrong.feedback}" was still shown.` };
            deps.add('observed', 'The question was reset for another attempt.');
          }
          return { status: 'passed', actual: 'Retry reset the question.' };
        });
      }
      default:
        return { status: 'manual_review_required', reason: `Unsupported assessment check "${cap}".` };
    }
  } catch (err) {
    if (err instanceof Blocked) return { status: 'blocked', reason: err.message, actual: 'The attempt could not be carried out.' };
    throw err;
  }
}
