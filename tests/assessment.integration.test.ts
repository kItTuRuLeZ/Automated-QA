import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AssessmentSpec, BehaviorRule, ProjectId } from '@cqa/shared';
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

const single: AssessmentSpec = {
  submit: 'Submit',
  selection: 'single',
  unanswered: { message: 'Please choose an answer.' },
  cases: [
    { name: 'The right answer', answers: ['Paris'], correct: true, feedback: 'Well done.', score: 'Score: 100' },
    { name: 'A wrong answer', answers: ['London'], correct: false, feedback: 'Not quite.', score: 'Score: 0' },
  ],
  retry: { control: 'Try again', maxAttempts: 2 },
};
const multiple: AssessmentSpec = {
  submit: 'Submit',
  selection: 'multiple',
  cases: [
    { name: 'Both right answers', answers: ['Red', 'Blue'], correct: true, feedback: 'Well done.' },
    { name: 'Only one of them', answers: ['Red'], correct: false, feedback: 'Not quite.' },
  ],
};

async function scan(query: string, assessment: AssessmentSpec | undefined) {
  const project = h.store.createProject({ name: `Quiz ${query}` });
  const at = nowIso();
  if (assessment) {
    qa.saveRule({ id: newId<string & { __brand: 'rule' }>(), projectId: project.id, title: 'Knowledge check', unitMatch: '', requiredItems: [{ label: 'Paris' }, { label: 'Submit' }], optionalItems: [], prerequisites: [], expectedEvent: 'message_shown', eventTarget: 'Well done.', timingWindowMs: 1000, orderPolicy: 'sequence', repeatPolicy: 'once', resetPolicy: 'fresh_context', expectationSource: 'specification', reviewState: 'reviewed', assessment, createdAt: at, updatedAt: at } as BehaviorRule);
  }
  const url = `${fx.origin}/assess-quiz/${query}`;
  const config = buildScanConfig({ projectId: project.id as ProjectId, url: new URL(url), explore: false, accessibility: false, layout: false, functional: true, qaProfile: 'functional', maxStates: 6, maxDepth: 2 });
  const run = await h.waitForTerminal(h.store.createRun(config, url).id, 230_000);
  await h.worker!.idle();
  const execs = qa.currentExecutions(run.id);
  return { run, one: (id: string) => execs.find((e) => e.definitionId === id)! };
}

describe('a quiz tested against a supplied answer key', () => {
  it('a correct quiz passes every check, and each answer is tried from a fresh start', async () => {
    const { one } = await scan('', single);
    for (const id of ['MCQ-01', 'MCQ-02', 'MCQ-03', 'MCQ-04', 'QUIZ-01']) expect(one(id).status, `${id}: ${one(id).reason}`).toBe('passed');
    expect(one('MCQ-03').trace.some((t) => /Score: 100/.test(t.detail))).toBe(true);
    // A passing quiz check keeps no picture of an untouched question.
    expect(one('MCQ-03').evidenceIds).toEqual([]);
    expect(one('LOG-01')).toMatchObject({ status: expect.not.stringMatching(/passed|failed/) });
  });

  it('multiple select: the selected set is what was asked for', async () => {
    const { one } = await scan('?multi', multiple);
    for (const id of ['MSQ-01', 'MCQ-03', 'MCQ-04']) expect(one(id).status, `${id}: ${one(id).reason}`).toBe('passed');
    // This key has no retry and does not require an answer: those checks do not apply, which is not the same as having no key.
    for (const id of ['QUIZ-01', 'MCQ-02']) expect(one(id)).toMatchObject({ status: 'not_applicable', reason: expect.stringMatching(/do not cover/) });
  });

  it('catches a blank answer being marked, even when no validation message is specified', async () => {
    const { one } = await scan('?bug=blank', { ...single, unanswered: {} });
    expect(one('MCQ-02').status).toBe('failed');
    expect(one('MCQ-02').reason).toMatch(/blank submission was marked/);
  });

  it('catches a wrong answer getting the right-answer feedback', async () => {
    const { one } = await scan('?bug=feedback', single);
    expect(one('MCQ-04').status).toBe('failed');
    expect(one('MCQ-03').status).toBe('passed');
  });

  it('catches a retry that keeps the old answer', async () => {
    const { one } = await scan('?bug=keeps', single);
    expect(one('QUIZ-01').status).toBe('failed');
    expect(one('QUIZ-01').actual).toMatch(/still selected/i);
  });

  it('catches retries beyond the attempt limit', async () => {
    const { one } = await scan('?bug=endless', single);
    expect(one('QUIZ-01').status).toBe('failed');
    expect(one('QUIZ-01').actual).toMatch(/after 2 attempts/i);
  });

  it('catches a single-choice question that lets two answers stay selected', async () => {
    expect((await scan('?bug=both', single)).one('MCQ-01').status).toBe('failed');
  });

  it('an answer that is not on screen is blocked, never failed: the questions may be randomized', async () => {
    const { one } = await scan('', { ...single, cases: [{ name: 'Answer from another pool', answers: ['Madrid'], correct: true, feedback: 'Well done.' }] });
    expect(one('MCQ-03').status).toBe('blocked');
    expect(one('MCQ-03').reason).toMatch(/Madrid/);
    expect(one('MCQ-03').reason).toMatch(/randomizes its questions/i);
  });

  it('feedback is matched as a whole phrase: "Quite" does not match "Not quite."', async () => {
    const { one } = await scan('', { ...single, cases: [{ name: 'A wrong answer', answers: ['London'], correct: false, feedback: 'quit' }] });
    expect(one('MCQ-04').status).toBe('failed');
  });

  it('a mistyped Submit button blocks the check, and is never taken as "blank answers are refused"', async () => {
    const { one } = await scan('', { ...single, submit: 'Sbmit' });
    expect(one('MCQ-02').status).toBe('blocked');
  });

  it('a failure carries the screenshot of the failing attempt and only that attempt\'s steps', async () => {
    // The first case passes on its own screen; the second fails on another.
    const { run, one } = await scan('', { ...single, cases: [single.cases[0]!, { name: 'Also accepted', answers: ['London'], correct: true, feedback: 'Well done.' }] });
    const e = one('MCQ-03');
    expect(e.status).toBe('failed');
    const kept = h.store.getEvidence(e.evidenceIds);
    expect(kept.find((x) => x.kind === 'screenshot')?.caption).toMatch(/MCQ-03: The expected feedback did not appear/);
    // The trace is of the failing attempt's own screen, not an untouched one.
    expect(kept.filter((x) => x.kind === 'trace')).toHaveLength(1);
    const f = h.store.listFindings(run.id).find((x) => x.ruleId === 'FUN-002')!;
    expect(f.reproductionSteps.join(' ')).toMatch(/Choose "London"/);
    expect(f.reproductionSteps.join(' ')).not.toMatch(/Choose "Paris"/);
  });

  it('with no answer key nothing is guessed: the cases go to a person', async () => {
    const { one } = await scan('', undefined);
    expect(one('MCQ-03').status).toBe('manual_review_required');
    expect(one('MCQ-03').reason).toMatch(/answer key/i);
  });
});
