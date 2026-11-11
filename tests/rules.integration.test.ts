import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BehaviorRule, ProjectId, RuleItem } from '@cqa/shared';
import { QaStore, buildScanConfig, newId, nowIso } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
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

const three: RuleItem[] = [{ label: 'Alpha' }, { label: 'Bravo' }, { label: 'Charlie' }];

function rule(projectId: string, over: Partial<BehaviorRule>): BehaviorRule {
  const at = nowIso();
  return { id: newId<string & { __brand: 'rule' }>(), projectId, title: 'Next unlocks after every item', unitMatch: '', requiredItems: three, optionalItems: [], prerequisites: [], expectedEvent: 'next_enabled', eventTarget: 'Next', timingWindowMs: 2000, orderPolicy: 'any_order', repeatPolicy: 'once', resetPolicy: 'fresh_context', expectationSource: 'approved_case', reviewState: 'reviewed', createdAt: at, updatedAt: at, ...over } as BehaviorRule;
}

async function scan(path: string, over: Partial<BehaviorRule>, query = '') {
  const project = h.store.createProject({ name: `Rules ${path}` });
  const saved = qa.saveRule(rule(project.id, over));
  const url = `${fx.origin}/${path}/${query}`;
  const config = buildScanConfig({ projectId: project.id as ProjectId, url: new URL(url), explore: false, accessibility: false, layout: false, functional: true, qaProfile: 'functional', maxStates: 6, maxDepth: 2 });
  const run = await h.waitForTerminal(h.store.createRun(config, url).id, 230_000);
  await h.worker!.idle();
  const execs = qa.currentExecutions(run.id);
  return { run, saved, by: (id: string) => execs.filter((e) => e.definitionId === id) };
}

describe('repeating an item must not stand in for a missing one', () => {
  it('all items but one, then a repeat, stays locked on a correct course, and the last item then unlocks it', async () => {
    const { by } = await scan('logic-allclick-correct', { requiredItems: [{ label: 'Alpha' }, { label: 'Bravo' }, { label: 'Charlie' }, { label: 'Delta' }] });
    const dup = by('LOG-03')[0]!;
    expect(dup.status, dup.reason).toBe('passed');
    expect(dup.actual).toMatch(/all but "Delta".*repeat/is);
    const clicks = dup.trace.filter((t) => t.step === 'action').map((t) => t.detail).join(' | ');
    expect(clicks).toMatch(/Activate "Charlie"\..*Activate "Alpha" \(again\)\..*Activate "Delta"\./s);
  });

  it('a course that counts a repeat as progress is caught', async () => {
    const { by, run } = await scan('logic-repeat-bug', {});
    const dup = by('LOG-03')[0]!;
    expect(dup.status, dup.reason).toBe('failed');
    expect(dup.actual).toMatch(/repeat/i);
    // A retest has to be able to tell this exact check from the rule's other checks.
    const found = h.store.listFindings(run.id).find((f) => f.ruleId === 'FUN-002')!;
    expect(found.checkKey).toBeTruthy();
    const results = h.store.listCheckResults(run.id).filter((c) => c.ruleId === 'FUN-002');
    expect(results.find((c) => c.outcome === 'failed')?.targetKey).toBe(found.checkKey);
    expect(results.filter((c) => c.outcome === 'passed').length).toBeGreaterThan(0);
    expect(results.filter((c) => c.outcome === 'passed').every((c) => c.targetKey && c.targetKey !== found.checkKey)).toBe(true);
  });
});

describe('the outcome must be the one the rule names', () => {
  it('finishing every item but showing a different message fails', async () => {
    const { by } = await scan('logic-wrong-target', { requiredItems: [{ label: 'Alpha' }, { label: 'Bravo' }], expectedEvent: 'message_shown', eventTarget: 'Well done, section complete' });
    expect(by('LOG-01')[0]!.status).toBe('failed');
    expect(by('LOG-01')[0]!.reason).toMatch(/did not fire/);
  });
});

describe('a rule can require media to finish, combined with other items', () => {
  const items: RuleItem[] = [{ label: 'Open policy' }, { label: 'media: Play narration' }];

  it('passes when Next unlocks only after the narration has ended, and the trace says it waited', async () => {
    const { by } = await scan('logic-media-gate', { requiredItems: items, timingWindowMs: 1500 });
    const all = by('LOG-01')[0]!;
    expect(all.status, all.reason).toBe('passed');
    expect(all.trace.some((t) => /played to its end/i.test(t.detail))).toBe(true);
    expect(by('LOG-02')[0]!.status, by('LOG-02')[0]!.reason).toBe('passed');
  });

  it('a course that unlocks as soon as play is pressed is caught', async () => {
    const { by } = await scan('logic-media-gate', { requiredItems: items, timingWindowMs: 1500 }, '?early');
    const early = by('LOG-02')[0]!;
    expect(early.status, early.reason).toBe('failed');
    expect(early.actual).toMatch(/started but not finished/i);
  });
});

describe('an inferred rule stays provisional', () => {
  it('a rule only guessed from behaviour never produces a defect, even when the course breaks it', async () => {
    const { run, by } = await scan('logic-allclick-early', { requiredItems: [{ label: 'Alpha' }, { label: 'Bravo' }, { label: 'Charlie' }, { label: 'Delta' }], expectationSource: 'observed_hypothesis' });
    const e = by('LOG-01')[0]!;
    expect(e.status).toBe('inconclusive');
    expect(e.reason).toMatch(/provisional/i);
    expect(e.reason).toMatch(/fired before the last/i);
    expect(h.store.listFindings(run.id).filter((f) => f.ruleId === 'FUN-002')).toEqual([]);
  });

  it('a draft rule gives no verdict until it is approved, even with a confirmed source', async () => {
    const { run, by } = await scan('logic-allclick-early', { requiredItems: [{ label: 'Alpha' }, { label: 'Bravo' }, { label: 'Charlie' }, { label: 'Delta' }], reviewState: 'draft', expectationSource: 'specification' });
    const e = by('LOG-01')[0]!;
    expect(e.status).toBe('inconclusive');
    expect(e.reason).toMatch(/draft/i);
    expect(h.store.listFindings(run.id).filter((f) => f.ruleId === 'FUN-002')).toEqual([]);
  });

  it('nor does it produce a pass', async () => {
    const { by } = await scan('logic-allclick-correct', { requiredItems: [{ label: 'Alpha' }, { label: 'Bravo' }, { label: 'Charlie' }, { label: 'Delta' }], expectationSource: 'observed_hypothesis' });
    expect(by('LOG-01')[0]!.status).toBe('inconclusive');
  });
});

describe('rules are versioned', () => {
  it('saving a rule again raises its version, and a test records the version it ran against', async () => {
    const project = h.store.createProject({ name: 'Versions' });
    const first = qa.saveRule(rule(project.id, {}));
    expect(first.version).toBe(1);
    const second = qa.saveRule({ ...first, title: 'Changed' });
    expect(second.version).toBe(2);

    const { by, saved } = await scan('logic-allclick-early', { requiredItems: [{ label: 'Alpha' }, { label: 'Bravo' }, { label: 'Charlie' }, { label: 'Delta' }] });
    expect(by('LOG-01')[0]!.trace.some((t) => t.detail.includes(`version ${saved.version}`))).toBe(true);
  });
});

describe('importing rules treats them as data', () => {
  const HOST = '127.0.0.1:4317';
  const json = { host: HOST, 'x-qa-request': '1', 'content-type': 'application/json' };
  const good = { title: 'Imported', requiredItems: [{ label: 'Alpha' }], expectedEvent: 'next_enabled', eventTarget: 'Next' };
  let app: ReturnType<typeof buildApp>;
  let projectId = '';
  beforeAll(() => {
    app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`], webDist: undefined });
    projectId = h.store.createProject({ name: 'Import' }).id;
  });
  afterAll(async () => {
    await app.close();
  });
  const send = (rules: unknown[]) => app.inject({ method: 'POST', url: `/api/projects/${projectId}/behavior-rules/import`, headers: json, payload: { rules } as object });

  it('imports valid rules as drafts that a reviewer still has to approve', async () => {
    const res = await send([{ ...good, reviewState: 'approved' }]);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().imported).toBe(1);
    const rules = qa.listRules(projectId);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ title: 'Imported', reviewState: 'draft', version: 1 });
  });

  it('refuses a file with anything that is not rule data, and saves none of it', async () => {
    const before = qa.listRules(projectId).length;
    const res = await send([good, { ...good, onFire: 'fetch("https://example.com")' }]);
    expect(res.statusCode).toBe(400);
    expect(qa.listRules(projectId)).toHaveLength(before);
  });

  it('exports what it imports', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${projectId}/behavior-rules/export`, headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
    expect(res.json().rules[0]).toMatchObject({ title: 'Imported' });
    expect(res.json().rules[0].id).toBeUndefined();
  });
});
