import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AssessmentSpec, BehaviorRule, CheckResult, Finding, ProjectId, RuleItem, TestExecution } from '@cqa/shared';
import { QaStore, buildScanConfig, newId, nowIso } from '@cqa/core';
import { type Harness, createHarness } from './support/harness.js';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';

/**
 * Detection scorecard: every seeded defect in the local fixtures, whether the tool caught it for the right reason, every
 * known-good fixture, whether the tool wrongly failed anything there, and whether results repeat. Opt-in because it runs
 * about 30 scans: `npm run test:scorecard`.
 */
const flag = process.env.CQA_SCORECARD;
const ENABLED = Boolean(flag && flag !== '0' && flag.toLowerCase() !== 'false');
vi.setConfig({ testTimeout: 3_600_000, hookTimeout: 120_000 });

let fx: FixtureServer;
let h: Harness;
let qa: QaStore;
beforeAll(async () => {
  if (!ENABLED) return;
  fx = await startFixtureServer();
  h = createHarness({ exemptAddresses: [{ ip: '127.0.0.1', port: fx.port }] });
  qa = new QaStore(h.store.db);
  h.startWorker();
});
afterAll(async () => {
  await h?.close();
  await fx?.close();
});

interface Scan { status: string; execs: TestExecution[]; findings: Finding[]; checks: CheckResult[]; label: (e: TestExecution) => string }
interface Opts { explore?: boolean; rule?: Partial<BehaviorRule>; quiz?: AssessmentSpec; query?: string; plain?: boolean }

const items = (...labels: string[]): RuleItem[] => labels.map((label) => ({ label }));
const FOUR = items('Alpha', 'Bravo', 'Charlie', 'Delta');
const QUIZ: AssessmentSpec = {
  submit: 'Submit',
  selection: 'single',
  unanswered: {},
  cases: [
    { name: 'Right', answers: ['Paris'], correct: true, feedback: 'Well done.', score: 'Score: 100' },
    { name: 'Wrong', answers: ['London'], correct: false, feedback: 'Not quite.', score: 'Score: 0' },
  ],
  retry: { control: 'Try again', maxAttempts: 2 },
};

async function scan(path: string, o: Opts = {}): Promise<Scan> {
  const project = h.store.createProject({ name: `Scorecard ${path}${o.query ?? ''}` });
  const at = nowIso();
  if (o.rule || o.quiz) {
    qa.saveRule({ id: newId(), projectId: project.id, title: o.quiz ? 'Quiz' : 'Rule', unitMatch: '', requiredItems: o.quiz ? items('Paris', 'Submit') : FOUR, optionalItems: [], prerequisites: [], expectedEvent: o.quiz ? 'message_shown' : 'next_enabled', eventTarget: o.quiz ? 'Well done.' : 'Next', timingWindowMs: o.quiz ? 1000 : 2000, orderPolicy: o.quiz ? 'sequence' : 'any_order', repeatPolicy: 'once', resetPolicy: 'fresh_context', expectationSource: 'approved_case', reviewState: 'reviewed', createdAt: at, updatedAt: at, ...(o.quiz ? { assessment: o.quiz } : {}), ...o.rule } as BehaviorRule);
  }
  const url = `${fx.origin}/${path}/${o.query ?? ''}`;
  const config = o.plain
    ? buildScanConfig({ projectId: project.id as ProjectId, url: new URL(url) })
    : buildScanConfig({ projectId: project.id as ProjectId, url: new URL(url), explore: o.explore ?? false, accessibility: false, layout: false, functional: true, qaProfile: 'functional', maxStates: 12, maxDepth: 3 });
  const run = await h.waitForTerminal(h.store.createRun(config, url).id, 600_000);
  await h.worker!.idle();
  const interactions = qa.listInteractions(run.id);
  return { status: run.status, execs: qa.currentExecutions(run.id), findings: h.store.listFindings(run.id), checks: h.store.listCheckResults(run.id), label: (e) => interactions.find((i) => i.id === e.instanceId)?.label ?? '' };
}

/** A scan that did not finish proves nothing either way. */
const finished = (s: Scan) => s.status === 'completed' || s.status === 'partial';
/** Failing because an item could not be found is the scanner's problem, not the seeded defect. */
const SCANNER_PROBLEM = /could not be used|could not be found|was not found|could not be opened/i;
const status = (s: Scan, caseId: string, label?: RegExp) => s.execs.filter((e) => e.definitionId === caseId && (!label || label.test(s.label(e))));
/** Caught: the case failed, for the stated reason when one is given, and never because the scanner lost its way. */
const caught = (s: Scan, caseId: string, opts: { label?: RegExp; why?: RegExp } = {}) =>
  finished(s) && status(s, caseId, opts.label).some((e) => e.status === 'failed' && !SCANNER_PROBLEM.test(e.reason ?? '') && (!opts.why || opts.why.test(`${e.reason ?? ''} ${e.actual ?? ''}`)));

describe.runIf(ENABLED)('detection scorecard', () => {
  it('catches every seeded defect for the right reason, fails nothing that works, classifies what it cannot judge, and repeats its results', async () => {
    const rows: Array<{ kind: 'defect' | 'unsupported'; fixture: string; what: string; ok: boolean; note?: string }> = [];
    const kept = new Map<string, Scan>();
    /** Runs one scan; a scan that throws becomes a failed row instead of hiding the rest of the scorecard. */
    const attempt = async (fixture: string, o: Opts, record: (s: Scan) => void, what: string, kind: 'defect' | 'unsupported' = 'defect') => {
      try {
        const s = await scan(fixture, o);
        kept.set(`${fixture}${o.query ?? ''}`, s);
        record(s);
      } catch (err) {
        rows.push({ kind, fixture, what, ok: false, note: `scan error: ${(err as Error).message}` });
      }
    };
    const row = (fixture: string, what: string, ok: boolean, kind: 'defect' | 'unsupported' = 'defect') => rows.push({ kind, fixture, what, ok });

    await attempt('recipes-broken', { explore: true }, (s) => {
      for (const [caseId, label, why] of [['FLP-01', /Dead card/, /did not flip/i], ['FLP-01', /Empty back/, /empty/i], ['FLP-01', /Stuck card/, undefined], ['TIM-01', /Dead steps/, undefined], ['AUD-01', /Silent narration/, undefined], ['AUD-01', /Missing narration/, undefined]] as const) row('recipes-broken', `${caseId} ${label.source}`, caught(s, caseId, { label, why }));
      row('recipes-broken', 'FLP-01 one-sided card', finished(s) && status(s, 'FLP-01', /One sided/).some((e) => e.status === 'unsupported'), 'unsupported');
      row('recipes-broken', 'VID-01 undecodable format', finished(s) && status(s, 'VID-01', /Odd format video/).some((e) => e.status === 'unsupported'), 'unsupported');
    }, 'recipe defects');

    await attempt('functional-broken', { explore: true }, (s) => {
      for (const [caseId, why] of [['TAB-01', /was not visible/], ['ACC-01', undefined], ['LAY-02', /focus did not return/], ['NAV-02', undefined]] as const) row('functional-broken', caseId, caught(s, caseId, { why }));
    }, 'interaction defects');

    const logic: Array<[string, Opts, string, RegExp]> = [
      ['logic-allclick-early', { rule: {} }, 'LOG-01', /fired before the last required item/],
      ['logic-repeat-bug', { rule: { requiredItems: items('Alpha', 'Bravo', 'Charlie') } }, 'LOG-03', /repeat/i],
      ['logic-wrong-target', { rule: { requiredItems: items('Alpha', 'Bravo'), expectedEvent: 'message_shown', eventTarget: 'Well done, section complete' } }, 'LOG-01', /did not fire/],
      ['logic-never-fires', { rule: {} }, 'LOG-01', /did not happen within/],
      ['logic-optional-bug', { rule: { optionalItems: items('Extra reading') } }, 'LOG-02', /fired when it should not/],
      ['logic-duplicate-bug', { rule: {} }, 'LOG-03', /1 unique item/],
      ['logic-order-dependent', { rule: { orderPolicy: 'any_order' } }, 'LOG-04', /reverse order/],
      ['logic-delayed', { rule: { timingWindowMs: 500 } }, 'LOG-01', /did not happen within 500 ms/],
      ['logic-media-gate', { rule: { requiredItems: items('Open policy', 'media: Play narration'), timingWindowMs: 1500 }, query: '?early' }, 'LOG-02', /started but not finished/],
    ];
    for (const [fixture, o, caseId, why] of logic) await attempt(fixture, o, (s) => row(fixture + (o.query ?? ''), caseId, caught(s, caseId, { why })), caseId);

    for (const [bug, caseId, why] of [['blank', 'MCQ-02', /blank submission was marked/], ['feedback', 'MCQ-04', /expected feedback did not appear/], ['keeps', 'QUIZ-01', /still selected/], ['endless', 'QUIZ-01', /More attempts were offered/], ['both', 'MCQ-01', /single-choice/]] as const) {
      await attempt('assess-quiz', { quiz: QUIZ, query: `?bug=${bug}` }, (s) => row(`assess-quiz?bug=${bug}`, caseId, caught(s, caseId, { why })), caseId);
    }

    await attempt('missing-asset', { plain: true }, (s) => row('missing-asset', 'RUN-004 failed request', finished(s) && s.findings.some((f) => f.ruleId === 'RUN-004' && /missing\.js/.test(f.observed))), 'RUN-004');
    await attempt('broken-media', { plain: true }, (s) => row('broken-media', 'MED-002 audio and video', finished(s) && s.findings.filter((f) => f.ruleId === 'MED-002').length >= 2), 'MED-002');
    await attempt('js-exception', { plain: true }, (s) => row('js-exception', 'RUN-002 page error', finished(s) && s.findings.some((f) => f.ruleId === 'RUN-002')), 'RUN-002');
    await attempt('canvas', { plain: true }, (s) => row('canvas', 'COV-003 canvas content', finished(s) && s.checks.some((c) => c.ruleId === 'COV-003' && c.outcome === 'unsupported'), 'unsupported'), 'COV-003', 'unsupported');

    // Known-good courses: any failed check here is a false failure, and an unfinished scan is a failure of its own.
    const falseFailures: string[] = [];
    let goodChecks = 0;
    for (const [fixture, o] of [['recipes-good', { explore: true }], ['functional-good', { explore: true }], ['logic-allclick-correct', { rule: {} }], ['assess-quiz', { quiz: QUIZ }], ['healthy', { plain: true }]] as Array<[string, Opts]>) {
      try {
        const s = await scan(fixture, o);
        if (!finished(s)) falseFailures.push(`${fixture}: the scan ended ${s.status}`);
        goodChecks += s.execs.filter((e) => e.status === 'passed' || e.status === 'failed').length + s.checks.filter((c) => c.outcome === 'passed' || c.outcome === 'failed').length;
        for (const e of s.execs) if (e.status === 'failed') falseFailures.push(`${fixture}: ${e.definitionId} ${s.label(e)} — ${e.reason ?? ''}`);
        for (const c of s.checks) if (c.outcome === 'failed') falseFailures.push(`${fixture}: check ${c.ruleId} failed — ${c.reasonDetail ?? ''}`);
        for (const f of s.findings) if (f.type === 'automated_defect') falseFailures.push(`${fixture}: finding ${f.ruleId} ${f.title}`);
      } catch (err) {
        falseFailures.push(`${fixture}: scan error: ${(err as Error).message}`);
      }
    }

    // Reproducibility: one more scan of two courses already scanned above gives the same statuses.
    const differed: string[] = [];
    for (const [fixture, o] of [['assess-quiz', { quiz: QUIZ, query: '?bug=feedback' }], ['logic-allclick-early', { rule: {} }]] as Array<[string, Opts]>) {
      const key = (s: Scan) => s.execs.map((e) => `${e.definitionId}:${e.status}`).sort().join(',');
      const first = kept.get(`${fixture}${o.query ?? ''}`);
      try {
        const again = await scan(fixture, o);
        if (!first || !first.execs.length || key(first) !== key(again)) differed.push(`${fixture}: ${first ? key(first) : 'no first scan'} vs ${key(again)}`);
      } catch (err) {
        differed.push(`${fixture}: scan error: ${(err as Error).message}`);
      }
    }

    const defects = rows.filter((r) => r.kind === 'defect');
    const unsupported = rows.filter((r) => r.kind === 'unsupported');
    console.log(
      [
        'DETECTION SCORECARD',
        `Seeded defects caught for the right reason: ${defects.filter((r) => r.ok).length} of ${defects.length}`,
        ...defects.filter((r) => !r.ok).map((r) => `  MISSED ${r.fixture}: ${r.what}${r.note ? ` (${r.note})` : ''}`),
        `Unsupported content classified as unsupported: ${unsupported.filter((r) => r.ok).length} of ${unsupported.length}`,
        ...unsupported.filter((r) => !r.ok).map((r) => `  WRONG ${r.fixture}: ${r.what}${r.note ? ` (${r.note})` : ''}`),
        `Valid checks wrongly failed: ${falseFailures.length} of ${goodChecks} checks with a result on known-good courses`,
        ...falseFailures.map((f) => `  ${f}`),
        `Repeat scans that differed: ${differed.length} of 2`,
        ...differed.map((s) => `  ${s}`),
      ].join('\n'),
    );

    expect(defects.filter((r) => !r.ok)).toEqual([]);
    expect(unsupported.filter((r) => !r.ok)).toEqual([]);
    expect(goodChecks).toBeGreaterThan(0);
    expect(falseFailures).toEqual([]);
    expect(differed).toEqual([]);
  });
});
