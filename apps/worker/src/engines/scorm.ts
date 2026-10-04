import type { Browser } from 'playwright';
import type { EvidenceId, FindingLocation, ProviderContext, ScanRun, ScormJourney, ScormSettings } from '@cqa/shared';
import { nowIso } from '@cqa/core';
import { type HarnessCall, type HarnessConfig, type ScormVersion, harnessInitScript } from '../adapters/scorm-harness.js';
import { type NewCheck, type NewFinding, check, finding, truncate } from './helpers.js';
import { type RuleResult, type SessionResult, analyzeExpectation, analyzeResume, analyzeSession, toChecks } from './scorm-analysis.js';

const MAX_JOURNEYS = 6;
const STEP_TIMEOUT_MS = 5_000;
const FAKE_LEARNER = { id: 'cqa-test-learner', name: 'Test Learner' };

export interface ScormRunInput {
  browser: Browser;
  run: ScanRun;
  targetUrl: string;
  settings: ScormSettings;
  ctx: ProviderContext;
  persist: (r: { checks: NewCheck[]; findings: NewFinding[] }) => void;
  deadline: number;
}

/** What goes into a scan's evidence and report for one harness session. */
export interface ScormSessionSummary {
  name: string;
  kind: 'journey' | 'resume';
  version: ScormVersion;
  stepsTotal: number;
  stepsRun: number;
  stepFailure?: string;
  callCount: number;
  finalStatus: string;
  outcomes: Array<{ rule: string; outcome: string }>;
}

const REDACT = /suspend_data|comments|student_response|learner_response|launch_data|student_name|learner_name|student_id|learner_id/;
const redactMap = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, REDACT.test(k) ? `[${v.length} characters]` : v]));

function secondsOf(version: ScormVersion, value: string | undefined): number {
  if (!value) return 0;
  if (version === '1.2') {
    const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  }
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

/** One fresh browser context, one harness, one scripted visit. */
async function runSession(input: ScormRunInput, opts: { name: string; kind: 'journey' | 'resume'; journey?: ScormJourney; restore?: Record<string, string>; priorTotalSeconds?: number }): Promise<SessionResult> {
  const { browser, run, settings, ctx } = input;
  const version = settings.version;
  const navTimeout = run.config.budgets.navigationTimeoutMs;
  const cfg: HarnessConfig = {
    version,
    learner: FAKE_LEARNER,
    restore: opts.restore ?? {},
    entry: opts.restore ? 'resume' : 'ab-initio',
    launchData: settings.launchData,
    masteryScore: settings.masteryScore,
    priorTotalSeconds: opts.priorTotalSeconds ?? 0,
  };
  const context = await browser.newContext({ viewport: { width: ctx.viewport.width, height: ctx.viewport.height }, serviceWorkers: 'block', acceptDownloads: false });
  const emitted = new Map<number, HarnessCall>();
  const lookups: Array<{ name: string; t: number }> = [];
  let lastPersist: { committed: Record<string, string>; cmi: Record<string, string> } | undefined;
  const steps = opts.journey?.steps ?? [];
  let stepsRun = 0;
  let stepFailure: string | undefined;
  try {
    await context.exposeBinding('__cqaScormEmit', (_src, e: { kind: string; call?: HarnessCall; name?: string; t?: number; committed?: Record<string, string>; cmi?: Record<string, string> }) => {
      if (e.kind === 'call' && e.call) emitted.set(e.call.seq, e.call);
      else if (e.kind === 'lookup' && e.name) lookups.push({ name: e.name, t: e.t ?? 0 });
      else if (e.kind === 'persist' && e.committed && e.cmi) lastPersist = { committed: e.committed, cmi: e.cmi };
    });
    await context.addInitScript({ content: harnessInitScript(cfg) });
    const page = await context.newPage();
    await page.goto(input.targetUrl, { waitUntil: 'load', timeout: navTimeout }).catch(() => undefined);
    // Give the course a moment to find the API and initialize.
    for (let i = 0; i < 40 && emitted.size === 0 && !ctx.signal.aborted; i++) await page.waitForTimeout(100);

    for (const step of steps) {
      if (ctx.signal.aborted) throw new Error('aborted');
      try {
        if (step.action === 'wait') await page.waitForTimeout(Math.min(step.ms ?? 1000, 10_000));
        else if (step.action === 'press') await page.keyboard.press(step.value ?? 'Enter');
        else if (!step.target) throw new Error(`"${step.action}" needs a target`);
        else if (step.action === 'click') await page.locator(step.target).first().click({ timeout: STEP_TIMEOUT_MS });
        else if (step.action === 'fill') await page.locator(step.target).first().fill(step.value ?? '', { timeout: STEP_TIMEOUT_MS });
        else if (step.action === 'select') await page.locator(step.target).first().selectOption(step.value ?? '', { timeout: STEP_TIMEOUT_MS });
        stepsRun++;
        await page.waitForTimeout(250);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        stepFailure = `step ${stepsRun + 1} (${step.action}${step.target ? ` ${truncate(step.target, 60)}` : ''}) failed: ${truncate((err as Error).message.split('\n')[0] ?? '', 120)}`;
        break;
      }
    }
    if (!stepFailure) {
      const end = Date.now() + Math.min(Math.max(settings.observeSeconds, 0), 15) * 1000;
      while (Date.now() < end && !ctx.signal.aborted) await page.waitForTimeout(200);
    }

    // Read the state while the page is still there, then leave and let unload handlers run.
    const snap = await page.evaluate(() => (window as unknown as { __cqaScorm?: { snapshot(): { calls: HarnessCall[]; cmi: Record<string, string>; committed: Record<string, string>; lookups: Array<{ name: string; t: number }> } } }).__cqaScorm?.snapshot()).catch(() => undefined);
    for (const c of snap?.calls ?? []) emitted.set(c.seq, c);
    for (const l of snap?.lookups ?? []) if (!lookups.some((x) => x.name === l.name && x.t === l.t)) lookups.push(l);
    const callsBeforeLeave = Math.max(0, ...[...emitted.keys()]);
    await page.goto('about:blank').catch(() => undefined);
    await page.waitForTimeout(500);
    const calls = [...emitted.values()].sort((a, b) => a.seq - b.seq);
    return {
      name: opts.name,
      kind: opts.kind,
      version,
      calls,
      lookups,
      cmi: lastPersist?.cmi && (!snap || calls.some((c) => c.seq > callsBeforeLeave)) ? lastPersist.cmi : (snap?.cmi ?? lastPersist?.cmi ?? {}),
      committed: lastPersist?.committed && (!snap || calls.some((c) => c.seq > callsBeforeLeave)) ? lastPersist.committed : (snap?.committed ?? lastPersist?.committed ?? {}),
      callsBeforeLeave,
      stepsTotal: steps.length,
      stepsRun,
      stepFailure,
      expect: opts.journey?.expect,
      restoredFrom: opts.restore,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

const RULE_NAMES = ['001', '002', '003', '004', '005', '006', '007', '008'];

/**
 * Runs the scripted visits against the harness and turns what the course did
 * into rule results. Each journey is a fresh visit with fresh learner state;
 * resume is a separate reopened visit that only happens when the course asked
 * to be resumed. Results describe the harness, never an LMS.
 */
export async function runScormScenarios(input: ScormRunInput): Promise<void> {
  const { run, settings, ctx } = input;
  const version = settings.version;
  const prefix = version === '1.2' ? 'SCO12' : 'SCO04';
  const url = input.targetUrl;
  const loc = (screenLabel: string): FindingLocation => ({ url: url as never, screenLabel });
  const journeys: ScormJourney[] = (settings.journeys.length ? settings.journeys : [{ name: 'Open and leave', steps: [] }]).slice(0, MAX_JOURNEYS);

  const sessions: SessionResult[] = [];
  const notRun: string[] = [];
  for (const j of journeys) {
    if (ctx.signal.aborted) throw new Error('aborted');
    if (Date.now() > input.deadline) {
      notRun.push(j.name);
      continue;
    }
    try {
      sessions.push(await runSession(input, { name: j.name, kind: 'journey', journey: j }));
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      notRun.push(`${j.name} (${truncate((err as Error).message, 100)})`);
    }
  }

  // Resume: reopen after the first session if it asked to be resumed.
  let reopened: SessionResult | undefined;
  const first = sessions[0];
  const exitEl = version === '1.2' ? 'cmi.core.exit' : 'cmi.exit';
  if (settings.checkResume && first && first.cmi[exitEl] === 'suspend' && Date.now() < input.deadline) {
    try {
      const totalEl = version === '1.2' ? 'cmi.core.total_time' : 'cmi.total_time';
      reopened = await runSession(input, { name: `${first.name}, reopened`, kind: 'resume', restore: first.committed, priorTotalSeconds: secondsOf(version, first.cmi[totalEl]) });
    } catch (err) {
      if (ctx.signal.aborted) throw err;
    }
  }

  const checks: NewCheck[] = [];
  const findings: NewFinding[] = [];
  const perRule = new Map<string, Array<{ session: string; result: RuleResult }>>();
  const add = (session: string, r: RuleResult) => perRule.set(r.rule, [...(perRule.get(r.rule) ?? []), { session, result: r }]);
  for (const s of sessions) {
    for (const r of analyzeSession(s)) add(s.name, r);
    const e = analyzeExpectation(s);
    if (e) add(s.name, e);
  }
  add(first?.name ?? 'Open and leave', first ? analyzeResume(version, first, reopened, settings) : { rule: '007', outcome: 'not_tested', detail: 'No session ran.', issues: [] });

  const summaries: ScormSessionSummary[] = [];
  const evidenceBySession = new Map<string, EvidenceId>();
  const all = reopened ? [...sessions, reopened] : sessions;
  for (const s of all) {
    const mine = [...perRule.values()].flat().filter((x) => x.session === s.name || (s === first && x.session === first.name));
    const status = version === '1.2' ? (s.committed['cmi.core.lesson_status'] ?? 'not attempted') : `completion ${s.committed['cmi.completion_status'] ?? 'unknown'}, success ${s.committed['cmi.success_status'] ?? 'unknown'}`;
    const score = s.committed[version === '1.2' ? 'cmi.core.score.raw' : 'cmi.score.raw'];
    const summary: ScormSessionSummary = {
      name: s.name,
      kind: s.kind,
      version,
      stepsTotal: s.stepsTotal,
      stepsRun: s.stepsRun,
      stepFailure: s.stepFailure,
      callCount: s.calls.length,
      finalStatus: `${status}${score ? `, score ${score}` : ''}`,
      outcomes: mine.map((m) => ({ rule: `${prefix}-${m.result.rule}`, outcome: m.result.outcome })),
    };
    summaries.push(summary);
    const ev = await ctx.evidence.addEvidence({
      kind: 'scorm_api_call',
      caption: `${version === '1.2' ? 'SCORM 1.2' : 'SCORM 2004'} test harness calls: ${s.name}`,
      data: { summary, truncated: s.calls.length > 400, calls: s.calls.slice(0, 400), committed: redactMap(s.committed), lookedForOtherApi: s.lookups.map((l) => l.name), harness: 'Test harness, not an LMS' },
      capturedAt: nowIso(),
      redacted: true,
    });
    evidenceBySession.set(s.name, ev.id);
  }

  for (const rule of RULE_NAMES) {
    const list = perRule.get(rule) ?? [];
    const ruleId = `${prefix}-${rule}`;
    if (list.length === 0) {
      checks.push(check(ruleId, 'not_applicable', 0, [], { reasonDetail: rule === '008' ? 'No expected tracking settings were supplied for any journey.' : 'Not applicable to this scan.' }));
      continue;
    }
    for (const c of toChecks(prefix, list.map((x) => ({ session: x.session, result: x.result })), {})) checks.push(c);
    for (const { session, result } of list) {
      for (const issue of result.issues) {
        const evId = evidenceBySession.get(session);
        const type = result.outcome === 'needs_review' ? ('heuristic_warning' as const) : undefined;
        findings.push(
          finding(ruleId, loc(session), {
            title: issue.title,
            observed: issue.observed,
            expected: issue.expected,
            evidenceIds: evId ? [evId] : [],
            reproductionSteps: [
              `Open the course in the ${version === '1.2' ? 'SCORM 1.2' : 'SCORM 2004'} test harness (this tool) or an LMS.`,
              ...(session.includes('reopened') ? ['Leave the course part-way, then open it again with the saved progress.'] : []),
              ...(sessions.find((x) => x.name === session)?.stepsTotal ? [`Follow the journey "${session}".`] : [`Open the course and leave after a few seconds ("${session}").`]),
              'Compare the course\'s SCORM calls with what is expected (the call log is attached as evidence).',
            ],
            remediation: issue.remediation,
            targetKey: issue.targetKey,
            stateKey: '',
            type,
            severity: result.outcome === 'needs_review' && rule !== '007' && rule !== '006' ? 'low' : undefined,
          }),
        );
      }
    }
  }
  for (const name of notRun) {
    for (const rule of RULE_NAMES) checks.push(check(`${prefix}-${rule}`, 'not_tested', 0, [], { reason: 'budget_runtime', reasonDetail: `The journey "${name}" did not run before the scan's time limit or failed to start.` }));
  }
  // Limits are part of every result, not a footnote.
  if (settings.hasSequencing) {
    findings.push(
      finding(`${prefix}-001`, loc('Package'), {
        title: 'Manifest has sequencing rules that this harness does not evaluate',
        observed: 'The manifest contains sequencing and navigation rules. The harness runs the one lesson you scanned; it does not apply those rules, move between lessons, or decide what an LMS would unlock.',
        expected: 'Sequencing and navigation across lessons are tested in the target LMS.',
        evidenceIds: [],
        reproductionSteps: ['Open the manifest and look for sequencing elements.'],
        remediation: 'Test navigation and unlocking in your LMS.',
        targetKey: 'sequencing',
        stateKey: '',
        type: 'manual_review',
        severity: 'informational',
      }),
    );
  }
  input.persist({ checks, findings });
  void run;
}
