import { describe, expect, it } from 'vitest';
import type { ContentUnit, InteractionInstance, ReviewDisposition, TestDefinition, TestExecution, TestStatus } from '@cqa/shared';
import { finalStage, ratio, screenStatus, summarizeCoverage } from '@cqa/core';

const unit = (over: Partial<ContentUnit> = {}): ContentUnit => ({
  id: 'u1',
  runId: 'r1',
  kind: 'slide',
  title: 'Slide 1',
  titleIsFallback: false,
  source: 'runtime',
  confidence: 'high',
  revision: 1,
  discoveredAt: '2026-10-06T00:00:00Z',
  visitedAt: '2026-10-06T00:00:01Z',
  visitedStateIds: ['s1'],
  order: 0,
  ...over,
});
let n = 0;
const exec = (status: TestStatus, over: Partial<TestExecution> = {}): TestExecution => ({
  id: `e${++n}`,
  runId: 'r1',
  definitionId: 'NAV-01',
  definitionVersion: 1,
  unitId: 'u1',
  attempt: 1,
  status,
  trace: [],
  evidenceIds: [],
  scope: 'functional',
  ...(status !== 'passed' && status !== 'failed' && status !== 'running' ? { reason: 'because' } : {}),
  ...over,
});
const def = (id: string, automation: TestDefinition['automation']): TestDefinition => ({ id, version: 1, title: id, category: 'x', interactionType: 'general', severity: 'medium', priority: 2, automation, reviewState: 'starter', origin: 'starter', createdAt: '', updatedAt: '', body: {} as never });

describe('screen status rules', () => {
  it('a screen with no findings and no checks is Not tested, never passed', () => {
    const r = screenStatus(unit(), []);
    expect(r.status).toBe('not_tested');
    expect(r.reasons.join(' ')).toMatch(/No findings here does not mean it was tested/);
  });

  it('Not tested stays Not tested when only excluded checks exist', () => {
    expect(screenStatus(unit(), [exec('not_applicable')]).status).toBe('not_tested');
  });

  it('a not-applicable case without a reason is a gap, not an exclusion', () => {
    const r = screenStatus(unit(), [exec('passed'), exec('not_applicable', { reason: undefined, definitionId: 'X' })]);
    expect(r.status).toBe('needs_manual_review');
  });

  it('passes only when something passed, nothing is open, and a browser showed the screen', () => {
    expect(screenStatus(unit(), [exec('passed'), exec('passed', { definitionId: 'NAV-02' })]).status).toBe('passed_automated');
    expect(screenStatus(unit({ visitedAt: undefined }), [exec('passed')]).status).toBe('needs_manual_review');
    expect(screenStatus(unit({ visitedAt: undefined }), [exec('passed')]).badges).toContain('runtime_not_visited');
  });

  it.each(['blocked', 'error', 'skipped', 'manual_review_required', 'pending'] as const)('one %s check keeps an otherwise passing screen from passing', (status) => {
    const r = screenStatus(unit(), [exec('passed'), exec(status, { definitionId: 'Z' })]);
    expect(r.status).toBe('needs_manual_review');
    expect(r.badges).toContain('partially_checked');
  });

  it('a failure wins, and gaps are still shown beside it', () => {
    const r = screenStatus(unit(), [exec('failed'), exec('blocked', { definitionId: 'B' }), exec('manual_review_required', { definitionId: 'M' })]);
    expect(r.status).toBe('issues_found');
    expect(r.badges).toEqual(expect.arrayContaining(['blocked_checks', 'manual_checks_pending']));
    expect(r.reasons.join(' ')).toMatch(/did not reach a result/);
  });

  it('a running check makes the screen In progress', () => {
    expect(screenStatus(unit(), [exec('passed'), exec('running', { definitionId: 'R' })]).status).toBe('in_progress');
  });

  it('only a manual-review case and nothing executed is Needs manual review, not Not tested', () => {
    expect(screenStatus(unit(), [exec('manual_review_required')]).status).toBe('needs_manual_review');
  });

  it('a runner error is not a failure', () => {
    const r = screenStatus(unit(), [exec('error')]);
    expect(r.status).toBe('needs_manual_review');
    expect(r.badges).toContain('runner_errors');
    expect(r.counts.failed).toBe(0);
  });

  it('static-only passes are labelled static and never become a functional pass', () => {
    const r = screenStatus(unit({ visitedAt: undefined, kind: 'lesson', source: 'manifest' }), [exec('passed', { scope: 'static' })]);
    expect(r.status).toBe('passed_automated');
    expect(r.scope).toBe('static');
    expect(r.badges).toContain('static_only');
    expect(r.reasons.join(' ')).toMatch(/Functional behavior was not tested/);
    expect(screenStatus(unit(), [exec('passed', { scope: 'static' }), exec('passed', { scope: 'functional', definitionId: 'F' })]).scope).toBe('functional');
  });

  it('a reviewer decision sits beside the automated status and does not change it', () => {
    const d: ReviewDisposition = { id: 'd1', runId: 'r1', targetKind: 'unit', targetId: 'u1', decision: 'manual_pass', actor: 'Sam', reason: 'Checked by hand', originalStatus: 'issues_found', createdAt: '2026-10-06T01:00:00Z' };
    const r = screenStatus(unit(), [exec('failed')], [d]);
    expect(r.status).toBe('issues_found');
    expect(r.reviewerDecision?.decision).toBe('manual_pass');
    expect(r.badges).toContain('reviewer_decision');
  });

  it('only counts executions that belong to the screen', () => {
    expect(screenStatus(unit({ id: 'u2' }), [exec('failed')]).status).toBe('not_tested');
  });
});

describe('coverage numbers', () => {
  it('never reports a percentage for an empty or unknown denominator', () => {
    expect(ratio(0, 0, 'none')).toEqual({ available: false, reason: 'none' });
    expect(ratio(3, undefined, 'unknown')).toEqual({ available: false, reason: 'unknown' });
    expect(ratio(24, 30, 'x')).toMatchObject({ available: true, percent: 80 });
  });

  it('keeps visit coverage, execution coverage and pass rate as separate numbers with their denominators', () => {
    const units = [unit({ id: 'a', source: 'manifest' }), unit({ id: 'b', source: 'manifest' }), unit({ id: 'c', source: 'manifest', visitedAt: undefined, notReachedReason: 'Behind a locked gate' })];
    const defs = new Map([['A', def('A', 'automated')], ['B', def('B', 'automated')], ['M', def('M', 'manual')]]);
    const ex = [
      exec('passed', { definitionId: 'A', unitId: 'a' }),
      exec('failed', { definitionId: 'B', unitId: 'a' }),
      exec('blocked', { definitionId: 'A', unitId: 'b' }),
      exec('error', { definitionId: 'B', unitId: 'b' }),
      exec('manual_review_required', { definitionId: 'M', unitId: 'b' }),
    ];
    const c = summarizeCoverage({ units, executions: ex, interactions: [], definitions: defs });
    expect(c.visit).toMatchObject({ available: true, numerator: 2, denominator: 3 });
    // 2 terminal of 4 mapped automated (the manual-only case is not in the denominator and is disclosed separately).
    expect(c.execution).toMatchObject({ available: true, numerator: 2, denominator: 4, percent: 50 });
    expect(c.passRate).toMatchObject({ available: true, numerator: 1, denominator: 2, percent: 50 });
    expect(c.manual).toEqual({ outstanding: 1, manualOnlyCases: 1 });
    expect(c.gaps).toMatchObject({ blocked: 1, errored: 1, unitsNotVisited: 1 });
    expect(c.gaps.unitsNotReached[0]).toEqual({ id: 'c', title: 'Slide 1', reason: 'Behind a locked gate' });
    expect(c.statement).toMatch(/2 of 3 discovered screens visited/);
    expect(c.statement).toMatch(/2 of 4 mapped automated checks executed \(1 passed, 1 failed\)/);
    expect(c.statement).toMatch(/1 manual check remains/);
  });

  it('says "found so far" and gives no visit percentage when the course total is unknown', () => {
    const c = summarizeCoverage({ units: [unit({ id: 'a' }), unit({ id: 'b' })], executions: [], interactions: [], definitions: new Map() });
    expect(c.discovery.completeness).toBe('unknown');
    expect(c.visit).toMatchObject({ available: false });
    expect(c.statement).toMatch(/2 screens visited of 2 found so far/);
    expect(c.execution).toMatchObject({ available: false });
  });

  it('is partial when the run found units the course list did not show', () => {
    const c = summarizeCoverage({ units: [unit({ id: 'a', source: 'manifest' }), unit({ id: 'b', source: 'runtime' })], executions: [], interactions: [], definitions: new Map() });
    expect(c.discovery.completeness).toBe('partial');
    expect(c.discovery.reason).toMatch(/appeared only at run time/);
  });

  it('counts an interaction as exercised only when a case actually executed on it', () => {
    const inter = (id: string): InteractionInstance => ({ id, runId: 'r1', unitId: 'u1', type: 'tab', label: id, confidence: 'high', capabilities: ['activate'], detectedBy: 't' });
    const c = summarizeCoverage({ units: [unit()], executions: [exec('passed', { instanceId: 'i1' }), exec('blocked', { instanceId: 'i2', definitionId: 'Q' })], interactions: [inter('i1'), inter('i2'), inter('i3')], definitions: new Map() });
    expect(c.interactions.exercised).toMatchObject({ available: true, numerator: 1, denominator: 3 });
  });

  it('a finished run with gaps is completed with gaps, never plain completed', () => {
    const base = { units: [unit({ source: 'manifest' })], interactions: [], definitions: new Map() };
    const clean = summarizeCoverage({ ...base, executions: [exec('passed')] });
    expect(finalStage({ runStatus: 'completed', coverage: clean })).toBe('completed');
    const gap = summarizeCoverage({ ...base, executions: [exec('passed'), exec('blocked', { definitionId: 'B' })] });
    expect(finalStage({ runStatus: 'completed', coverage: gap })).toBe('completed_with_gaps');
    const unknown = summarizeCoverage({ units: [unit()], executions: [exec('passed')], interactions: [], definitions: new Map() });
    expect(finalStage({ runStatus: 'completed', coverage: unknown })).toBe('completed_with_gaps');
    expect(finalStage({ runStatus: 'failed', coverage: clean })).toBe('failed');
    expect(finalStage({ runStatus: 'cancelled', coverage: clean })).toBe('cancelled');
  });
});
