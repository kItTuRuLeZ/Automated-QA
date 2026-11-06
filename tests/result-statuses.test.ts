import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckResult, ContentUnit, TestExecution, TestStatus } from '@cqa/shared';
import { CHECK_OUTCOMES, TEST_STATUSES } from '@cqa/shared';
import { MIGRATIONS, Store, buildRunReport, buildScanConfig, migrate, newId, nowIso, openDatabase, screenStatus, statusFromChecks } from '@cqa/core';
import { buildHtmlReport } from '../apps/server/src/export/html.js';

const check = (outcome: CheckResult['outcome'], over: Partial<CheckResult> = {}): CheckResult =>
  ({ id: newId(), runId: 'r1', ruleId: 'COV-003', outcome, durationMs: 0, evidenceIds: [], executedAt: nowIso(), ...(outcome === 'passed' || outcome === 'failed' ? {} : { reason: 'unsupported_surface' }), ...over }) as CheckResult;

const unit: ContentUnit = { id: 'u1', runId: 'r1', kind: 'slide', title: 'Slide 1', titleIsFallback: false, source: 'runtime', confidence: 'high', revision: 1, discoveredAt: nowIso(), visitedAt: nowIso(), visitedStateIds: ['s1'], order: 0 };
let n = 0;
const exec = (status: TestStatus): TestExecution => ({ id: `e${++n}`, runId: 'r1', definitionId: `T-${n}`, definitionVersion: 1, unitId: 'u1', attempt: 1, status, trace: [], evidenceIds: [], scope: 'functional', ...(status === 'passed' || status === 'failed' ? {} : { reason: 'because' }) });

describe('new result statuses', () => {
  it('"unsupported" and "inconclusive" exist for checks and for test executions', () => {
    expect(CHECK_OUTCOMES).toContain('unsupported');
    expect(CHECK_OUTCOMES).toContain('inconclusive');
    expect(TEST_STATUSES).toContain('unsupported');
    expect(TEST_STATUSES).toContain('inconclusive');
  });

  it('a case whose only result is unsupported is unsupported, never passed', () => {
    expect(statusFromChecks([check('unsupported')]).status).toBe('unsupported');
  });

  it('a pass next to an unsupported or inconclusive result does not make the case a pass', () => {
    expect(statusFromChecks([check('passed'), check('unsupported')]).status).toBe('unsupported');
    expect(statusFromChecks([check('passed'), check('inconclusive', { reason: 'timeout' })]).status).toBe('inconclusive');
  });

  it('a failure still wins over unsupported and inconclusive', () => {
    expect(statusFromChecks([check('unsupported'), check('inconclusive', { reason: 'timeout' }), check('failed')]).status).toBe('failed');
  });

  it('a screen with passes plus an unsupported or inconclusive check is not "passed"', () => {
    expect(screenStatus(unit, [exec('passed'), exec('unsupported')]).status).toBe('needs_manual_review');
    expect(screenStatus(unit, [exec('passed'), exec('inconclusive')]).status).toBe('needs_manual_review');
  });

  it('a screen whose only checks are unsupported is not "not tested" either: the gap is shown', () => {
    const r = screenStatus(unit, [exec('unsupported')]);
    expect(r.status).toBe('needs_manual_review');
    expect(r.reasons.join(' ')).toMatch(/not supported/);
  });

  it('an exception or an exhausted timeout cannot become a pass', () => {
    expect(statusFromChecks([check('passed'), check('error', { reason: 'engine_error' })]).status).toBe('error');
    expect(statusFromChecks([check('passed'), check('not_tested', { reason: 'timeout' })]).status).toBe('blocked');
  });
});

describe('storing the new statuses', () => {
  let dir: string | undefined;
  let open: Store | undefined;
  afterEach(() => {
    if (open?.db.open) open.db.close();
    open = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const freshStore = () => {
    dir = mkdtempSync(path.join(tmpdir(), 'cqa-status-'));
    open = new Store(openDatabase(path.join(dir, 'qa.sqlite')));
    return open;
  };
  const runIn = (store: Store) => {
    const project = store.createProject({ name: 'p' }).id;
    return store.createRun(buildScanConfig({ projectId: project, url: new URL('https://example.com/') }), 'https://example.com/');
  };

  it('saves unsupported and inconclusive results with their reason', () => {
    const store = freshStore();
    const run = runIn(store);
    store.insertCheckResult(check('unsupported', { runId: run.id }));
    store.insertCheckResult(check('inconclusive', { runId: run.id, reason: 'timeout' }));
    expect(store.listCheckResults(run.id).map((c) => c.outcome).sort()).toEqual(['inconclusive', 'unsupported']);
  });

  it('refuses an unsupported or inconclusive result without a reason', () => {
    const store = freshStore();
    const run = runIn(store);
    expect(() => store.insertCheckResult(check('unsupported', { runId: run.id, reason: undefined }))).toThrow();
    expect(() => store.insertCheckResult(check('inconclusive', { runId: run.id, reason: undefined }))).toThrow();
  });

  it('keeps retry history: a pass on the second attempt says so and keeps the first outcome', () => {
    const store = freshStore();
    const run = runIn(store);
    store.insertCheckResult(check('passed', { runId: run.id, ruleId: 'NAV-001', attempt: 2, firstAttemptOutcome: 'failed' }));
    expect(store.listCheckResults(run.id)[0]).toMatchObject({ outcome: 'passed', attempt: 2, firstAttemptOutcome: 'failed' });
  });

  it('the run report and its HTML export count unsupported and inconclusive results separately, never as passed', () => {
    const store = freshStore();
    const run = runIn(store);
    store.insertCheckResult(check('passed', { runId: run.id, ruleId: 'RUN-001' }));
    store.insertCheckResult(check('unsupported', { runId: run.id }));
    store.insertCheckResult(check('inconclusive', { runId: run.id, ruleId: 'NAV-001', reason: 'timeout' }));
    const report = buildRunReport(store, run.id);
    expect(report.checkTotals).toMatchObject({ passed: 1, unsupported: 1, inconclusive: 1 });
    expect(report.untested.map((u) => u.reason).sort()).toEqual(['timeout', 'unsupported_surface']);
    const html = buildHtmlReport(report);
    expect(html).toContain('1 not supported');
    expect(html).toContain('1 inconclusive');
  });

  it('upgrading an existing database keeps its check results', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'cqa-upgrade-'));
    const file = path.join(dir, 'qa.sqlite');
    const db = new Database(file);
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const latest = Math.max(...MIGRATIONS.map((m) => m.version));
    for (const m of MIGRATIONS.filter((x) => x.version < latest)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, nowIso());
    }
    const store = new Store(db);
    const run = runIn(store);
    store.insertCheckResult(check('needs_review', { runId: run.id, reason: undefined }));
    store.insertCheckResult(check('not_tested', { runId: run.id, reason: 'cancelled' }));
    migrate(db);
    expect(store.listCheckResults(run.id).map((c) => c.outcome).sort()).toEqual(['needs_review', 'not_tested']);
    store.insertCheckResult(check('unsupported', { runId: run.id }));
    expect(store.listCheckResults(run.id)).toHaveLength(3);
    db.close();
  });
});
