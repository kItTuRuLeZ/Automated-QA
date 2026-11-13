import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AssessmentSpec, BehaviorRule, ProjectId, ScanRun } from '@cqa/shared';
import { QaStore, buildScanConfig, newId, nowIso } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
import { type Harness, createHarness } from './support/harness.js';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

const HOST = '127.0.0.1:4317';
const QUIZ: AssessmentSpec = {
  submit: 'Submit',
  selection: 'single',
  cases: [
    { name: 'Right', answers: ['Paris'], correct: true, feedback: 'Well done.' },
    { name: 'Wrong', answers: ['London'], correct: false, feedback: 'Not quite.' },
  ],
  retry: { control: 'Try again', maxAttempts: 2 },
};
let fx: FixtureServer;
let h: Harness;
let qa: QaStore;
let app: ReturnType<typeof buildApp>;
let projectId: ProjectId;
let ruleId = '';

beforeAll(async () => {
  fx = await startFixtureServer();
  h = createHarness({ exemptAddresses: [{ ip: '127.0.0.1', port: fx.port }] });
  qa = new QaStore(h.store.db);
  h.startWorker();
  app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`], webDist: undefined, capabilities: { probeBrowser: false } });
  projectId = h.store.createProject({ name: 'Course versions' }).id as ProjectId;
  const at = nowIso();
  ruleId = qa.saveRule({ id: newId(), projectId, title: 'Capital quiz', unitMatch: '', requiredItems: [{ label: 'Paris' }, { label: 'Submit' }], optionalItems: [], prerequisites: [], expectedEvent: 'message_shown', eventTarget: 'Well done.', timingWindowMs: 1000, orderPolicy: 'sequence', repeatPolicy: 'once', resetPolicy: 'fresh_context', expectationSource: 'specification', reviewState: 'reviewed', assessment: QUIZ, createdAt: at, updatedAt: at } as BehaviorRule).id;
});
afterAll(async () => {
  await app?.close();
  await h?.close();
  await fx?.close();
});

/** One version of the course: the same address, with a query that switches its seeded fault on or off. */
async function version(query: string): Promise<ScanRun> {
  const url = `${fx.origin}/assess-quiz/${query}`;
  const config = buildScanConfig({ projectId, url: new URL(url), explore: false, accessibility: false, layout: false, functional: true, qaProfile: 'functional', maxStates: 6, maxDepth: 2 });
  const run = await h.waitForTerminal(h.store.createRun(config, url).id, 230_000);
  await h.worker!.idle();
  return run;
}
const compare = async (before: ScanRun, after: ScanRun) => (await app.inject({ method: 'GET', url: `/api/runs/${after.id}/compare?with=${before.id}`, headers: { host: HOST } })).json() as { counts: Record<string, number>; findings: Array<{ status: string; title: string; reason: string }> };
const titled = (c: Awaited<ReturnType<typeof compare>>, re: RegExp) => c.findings.filter((f) => re.test(f.title));

describe('comparing versions of a real course', () => {
  let broken: ScanRun;
  beforeAll(async () => {
    broken = await version('?bug=both');
  });

  it('a real fix is resolved, because the same check ran again and passed', async () => {
    const fixed = await version('');
    const c = await compare(broken, fixed);
    expect(titled(c, /MCQ-01/)).toMatchObject([{ status: 'resolved' }]);
    expect(c.counts.new).toBe(0);
  });

  it('a new defect in the later version is new', async () => {
    const c = await compare(broken, await version('?bug=keeps'));
    expect(titled(c, /QUIZ-01/)).toMatchObject([{ status: 'new' }]);
    expect(titled(c, /MCQ-01/)).toMatchObject([{ status: 'resolved' }]);
  });

  it('a previously failed check that did not run again is not retested, never resolved', async () => {
    // Several answers allowed: MCQ-01 (one answer stays selected) no longer applies, so it does not run.
    qa.saveRule({ ...qa.getRule(ruleId)!, assessment: { ...QUIZ, selection: 'multiple' } });
    try {
      const c = await compare(broken, await version(''));
      expect(titled(c, /MCQ-01/)).toMatchObject([{ status: 'not_retested' }]);
      expect(c.counts.resolved).toBe(0);
    } finally {
      qa.saveRule({ ...qa.getRule(ruleId)!, assessment: QUIZ });
    }
  });

  it('a later scan in different conditions is not comparable for that check', async () => {
    const fixed = await version('');
    h.store.setRunEnvironment(fixed.id, { engine: 'chromium', version: '1.0.0', userAgent: 'x', headless: true }, []);
    const c = await compare(broken, fixed);
    expect(titled(c, /MCQ-01/)).toMatchObject([{ status: 'incomparable', reason: expect.stringMatching(/conditions differ/) }]);
  });
});
