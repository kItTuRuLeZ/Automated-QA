import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import type { BehaviorRule, ProjectId, ScanRun } from '@cqa/shared';
import { QaStore, buildScanConfig, countStatuses, newId, nowIso } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
import { type Harness, createHarness } from './support/harness.js';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 120_000 });

const HOST = '127.0.0.1:4317';
const EVIL = '=HYPERLINK("http://example.com","x")<script>alert(1)</script>';
let fx: FixtureServer;
let h: Harness;
let qa: QaStore;
let app: ReturnType<typeof buildApp>;
let run: ScanRun;

beforeAll(async () => {
  fx = await startFixtureServer();
  h = createHarness({ exemptAddresses: [{ ip: '127.0.0.1', port: fx.port }] });
  qa = new QaStore(h.store.db);
  h.startWorker();
  app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`], webDist: undefined });
  // One confirmed rule that the course breaks (a failure), and one draft rule (inconclusive), whose title is hostile text.
  const project = h.store.createProject({ name: 'Report project' });
  const at = nowIso();
  const base = { projectId: project.id, unitMatch: '', requiredItems: ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((label) => ({ label })), optionalItems: [], prerequisites: [], expectedEvent: 'next_enabled', eventTarget: 'Next', timingWindowMs: 1000, orderPolicy: 'sequence', repeatPolicy: 'once', resetPolicy: 'fresh_context', expectationSource: 'approved_case', createdAt: at, updatedAt: at };
  qa.saveRule({ ...base, id: newId(), title: 'Next after every item', reviewState: 'reviewed' } as BehaviorRule);
  qa.saveRule({ ...base, id: newId(), title: EVIL, reviewState: 'draft' } as BehaviorRule);
  const url = `${fx.origin}/logic-allclick-early/`;
  const config = buildScanConfig({ projectId: project.id as ProjectId, url: new URL(url), explore: false, accessibility: false, layout: false, functional: true, qaProfile: 'functional', maxStates: 6, maxDepth: 2 });
  run = await h.waitForTerminal(h.store.createRun(config, url).id, 230_000);
  await h.worker!.idle();
  // A screen whose checks all passed but which has a control no check exercised: it must not read as passed anywhere.
  qa.addUnits(run.id, [{ id: 'u-extra', kind: 'lesson', title: 'Extra lesson with an untested control', titleIsFallback: false, source: 'runtime', confidence: 'high', order: 99 }]);
  qa.markVisited(run.id, 'u-extra', 'state-extra');
  qa.insertExecution({ runId: run.id, definitionId: 'NAV-02', definitionVersion: 1, unitId: 'u-extra', status: 'passed', trace: [], evidenceIds: [], scope: 'functional' });
  qa.addInteractions(run.id, [{ id: 'i-untested', unitId: 'u-extra', type: 'tab', label: 'tab "Untested"', confidence: 'high', capabilities: ['activate'], detectedBy: 'test' }]);
  // A reviewer overrides one failed result: the machine result must stay as it was.
  const failed = qa.currentExecutions(run.id).find((e) => e.status === 'failed')!;
  const res = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/dispositions`, headers: { host: HOST, 'x-qa-request': '1', 'content-type': 'application/json' }, payload: { targetKind: 'execution', targetId: failed.id, decision: 'false_positive', reason: 'Checked by hand: the unlock is intended', actor: 'Priya' } });
  expect(res.statusCode, res.body).toBe(201);
});
afterAll(async () => {
  await app?.close();
  await h?.close();
  await fx?.close();
});

const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: HOST } });

describe('reports a reviewer can trust', () => {
  it('the HTML report shows coverage with numerators and denominators, every screen including passed ones, and status counts that match what is stored', async () => {
    const html = (await get(`/api/runs/${run.id}/export.html`)).body;
    const counts = countStatuses(qa.currentExecutions(run.id));
    expect(html).toContain('Screens and checks');
    expect(html).toMatch(/visited<\/th><td>\d+ of \d+ \(\d+(\.\d+)?%\)|visited<\/th><td>Not available/);
    expect(html).toMatch(new RegExp(`Checks passed</th><td>${counts.passed}<`));
    expect(html).toMatch(new RegExp(`Checks failed</th><td>${counts.failed}<`));
    expect(html).toMatch(new RegExp(`Checks inconclusive</th><td>${counts.inconclusive}<`));
    expect(counts.inconclusive).toBeGreaterThan(0);
    expect(html).toMatch(/Automated status/);
  });

  it('a reviewer\'s decision is shown with who, why and when, beside the unchanged machine result', async () => {
    const html = (await get(`/api/runs/${run.id}/export.html`)).body;
    expect(html).toMatch(/false_positive/);
    expect(html).toContain('Priya');
    expect(html).toContain('Checked by hand: the unlock is intended');
    expect(qa.currentExecutions(run.id).some((e) => e.status === 'failed')).toBe(true);
    expect(html).toMatch(/<td>failed<\/td>[\s\S]*Priya/);
  });

  it('hostile course text is escaped in HTML and kept from acting as a formula in spreadsheets and CSV', async () => {
    const html = (await get(`/api/runs/${run.id}/export.html`)).body;
    expect(html).not.toContain('<script>alert(1)</script>');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await get(`/api/runs/${run.id}/qa-export.xlsx`)).rawPayload as never);
    const cells: string[] = [];
    wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => typeof c.value === 'string' && cells.push(c.value))));
    // The hostile title is present, but only as text: no text cell starts the way a formula does.
    expect(cells.some((c) => c.startsWith("'=HYPERLINK"))).toBe(true);
    expect(cells.filter((c) => /^[=+\-@]/.test(c))).toEqual([]);
    const csv = (await get(`/api/runs/${run.id}/qa-export.csv?table=Interaction%20Logic`)).body;
    expect(csv).toContain(`"'=HYPERLINK`);
  });

  it('the screen table and the summary judge each screen the same way, as the Screens tab does', async () => {
    const t = (await get(`/api/runs/${run.id}/qa-export.json`)).json() as { tables: Array<{ name: string; columns: string[]; rows: unknown[][] }> };
    const cov = t.tables.find((x) => x.name === 'Course Coverage')!;
    const counted = cov.rows.filter((r) => r[cov.columns.indexOf('Counted for visits')] === 'Yes');
    const inv = (await get(`/api/runs/${run.id}/inventory?search=1`)).json() as { units: Array<{ primary: boolean; unit: { title: string }; result?: { status: string }; search?: { own: string } }> };
    const words: Record<string, string> = { passed_automated: 'passed configured checks', issues_found: 'issues found', needs_manual_review: 'needs manual review', not_tested: 'not tested' };
    for (const u of inv.units.filter((x) => x.primary && x.result)) {
      const row = counted.find((r) => r[cov.columns.indexOf('Unit')] === u.unit.title)!;
      expect(String(row[cov.columns.indexOf('Automated status')]).toLowerCase()).toBe(words[u.result!.status]);
      // And the index can be searched by that same status.
      expect(u.search?.own).toContain(words[u.result!.status]);
    }
  });

  it('every stored status survives into the export', async () => {
    const t = (await get(`/api/runs/${run.id}/qa-export.json`)).json() as { tables: Array<{ name: string; columns: string[]; rows: unknown[][] }> };
    const results = t.tables.find((x) => x.name === 'Test Results')!;
    const col = results.columns.indexOf('Status');
    const exported = new Set(results.rows.map((r) => r[col]));
    for (const e of qa.listExecutions(run.id)) expect(exported.has(e.status), e.status).toBe(true);
  });

  it('a partial or cancelled scan is labelled as such at the top of the report', async () => {
    const config = buildScanConfig({ projectId: run.projectId, url: new URL(`${fx.origin}/logic-allclick-early/`) });
    for (const status of ['partial', 'cancelled'] as const) {
      const other = h.store.createRun(config, config.target.url!);
      h.store.finishRun(other.id, { status, reason: status === 'cancelled' ? 'cancelled' : 'budget_runtime' });
      const html = (await get(`/api/runs/${other.id}/export.html`)).body;
      expect(html).toMatch(status === 'partial' ? /class="banner"[^>]*>[\s\S]*Partial results/ : /class="banner"[^>]*>[\s\S]*Cancelled/);
      // This scan recorded no step-by-step results, so the report shows none rather than a table of zeros.
      expect(html).not.toContain('Screens and checks');
    }
  });
});
