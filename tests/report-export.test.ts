import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckResultId, CourseState, Finding, FindingId, ProjectId, RuleCategory, ScanRun, Severity, StateId, FindingType } from '@cqa/shared';
import { buildProjectReport, buildRunReport, buildScanConfig, newId, nowIso, plainFinding } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
import { buildWorkbook, safeCell } from '../apps/server/src/export/xlsx.js';
import { type Harness, createHarness } from './support/harness.js';

const COURSE = 'https://course.example.com/';
const HOST = '127.0.0.1:4317';

let h: Harness;
let projectId: ProjectId;

beforeEach(() => {
  h = createHarness({ resolver: async () => ['93.184.215.14'] });
  projectId = h.store.createProject({ name: 'Tracker project', courseUrl: COURSE }).id;
});
afterEach(async () => {
  await h.close();
});

const pause = () => new Promise((r) => setTimeout(r, 8));

function seedRun(opts: { findings: Array<Partial<Finding> & { ruleId: string; title: string; fingerprint: string }>; untested?: string[] }): ScanRun {
  const run = h.store.createRun(buildScanConfig({ projectId, url: new URL(COURSE) }), COURSE);
  const state: CourseState = {
    id: newId<StateId>(),
    runId: run.id,
    url: COURSE as never,
    title: 'Welcome',
    signature: 's1',
    openDialogs: [],
    selectedTabs: [],
    depth: 0,
    pathFromRoot: [],
    surfaces: [{ kind: 'document' }],
    viewportName: 'desktop',
    capturedAt: nowIso(),
  };
  h.store.insertState(state);
  for (const f of opts.findings) {
    h.store.upsertFinding({
      id: newId<FindingId>(),
      runId: run.id,
      category: 'runtime' as RuleCategory,
      type: 'automated_defect' as FindingType,
      severity: 'high' as Severity,
      confidence: 'high',
      location: { stateId: state.id, url: COURSE as never, selector: '#el', elementDescription: 'button "Go"' },
      occurrences: [{ location: { stateId: state.id, selector: '#el', elementDescription: 'button "Go"' }, checkResultIds: [], evidenceIds: [], observed: 'seen' }],
      observed: 'Technical observation.',
      expected: 'Expected.',
      evidenceIds: [],
      reproductionSteps: [`Open ${COURSE} in Chromium with a 1440×900 CSS-pixel viewport.`, 'Click the thing.'],
      remediation: 'Fix it. Then more words.',
      standards: [],
      reviewer: { status: 'open', updatedAt: nowIso() },
      createdAt: nowIso(),
      ...f,
    } as Finding);
  }
  for (const reason of opts.untested ?? []) {
    h.store.insertCheckResult({ id: newId<CheckResultId>(), runId: run.id, ruleId: 'MED-001', outcome: 'not_tested', reason: reason as never, durationMs: 0, evidenceIds: [], executedAt: nowIso() });
  }
  h.store.finishRun(run.id, { status: 'completed' });
  return run;
}

async function load(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as never);
  return wb;
}
const rows = (ws: ExcelJS.Worksheet) => {
  const out: Record<string, string>[] = [];
  const header = (ws.getRow(1).values as unknown[]).slice(1).map(String);
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const rec: Record<string, string> = {};
    header.forEach((hd, i) => (rec[hd] = String(row.getCell(i + 1).value ?? '')));
    out.push(rec);
  });
  return out;
};

describe('plain-language wording', () => {
  it('describes common axe rules in everyday words and keeps unknown ones readable', () => {
    const base = { type: 'standards_warning', category: 'accessibility', remediation: 'Do x. Guidance: https://x' } as Finding;
    expect(plainFinding({ ...base, ruleId: 'A11Y-AXE-image-alt', title: 'Images must have alternative text (3 elements)' } as Finding)).toMatchObject({
      issue: 'An image has no alternative text (3 places)',
      action: 'fix',
    });
    const unknown = plainFinding({ ...base, ruleId: 'A11Y-AXE-some-new-rule', title: 'Needs review: Something unusual', type: 'manual_review' } as Finding);
    expect(unknown.issue).toBe('Check by hand: Something unusual');
    expect(unknown.action).toBe('check');
  });
});

describe('Excel tracker', () => {
  it('has the sheets a developer needs, sorted Fix before Check before Not checked, in plain words', async () => {
    seedRun({
      findings: [
        { ruleId: 'COV-003', category: 'coverage', type: 'manual_review', severity: 'informational', title: 'Canvas content not inspectable (640×360)', fingerprint: 'c'.repeat(64) },
        { ruleId: 'A11Y-AXE-heading-order', category: 'accessibility', type: 'heuristic_warning', severity: 'medium', title: 'Heading levels should only increase by one', fingerprint: 'b'.repeat(64) },
        { ruleId: 'A11Y-AXE-image-alt', category: 'accessibility', type: 'standards_warning', severity: 'critical', title: 'Images must have alternative text', fingerprint: 'a'.repeat(64) },
      ],
      untested: ['budget_states', 'budget_states', 'out_of_scope'],
    });
    const wb = await load(await buildWorkbook(buildProjectReport(h.store, projectId)));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Issues', 'Not checked', 'Manual checks', 'Screens']);

    const issues = rows(wb.getWorksheet('Issues')!);
    expect(issues.map((r) => r.Action)).toEqual(['Fix', 'Check by hand', 'Not checked']);
    expect(issues[0]).toMatchObject({ Priority: 'Critical', Issue: 'An image has no alternative text', Screens: 'S1', Status: 'Open', 'Latest scan': 'Found' });
    expect(issues[0]!['What to change']).toContain('alt text');
    expect(issues[0]!['How to see it']).toBe(`1. Open ${COURSE}\n2. Click the thing.`);
    expect(issues[0]!.Where).toBe('button "Go"');
    // Reading level: no rule codes in the columns a developer reads first.
    for (const r of issues) expect(`${r.Issue} ${r['What to change']}`).not.toMatch(/A11Y-|RUN-0|COV-0|axe/i);

    const notChecked = rows(wb.getWorksheet('Not checked')!).map((r) => `${r.Course}|${r['What was not checked']}`).join('\n');
    expect(notChecked).toContain('Canvas content could not be checked');
    expect(notChecked).toContain('Screen limit reached');
    expect(notChecked).toContain('Outside the scanned site');
  });

  it('is built for tracking: status dropdown, owner and notes columns, filters, frozen header', async () => {
    seedRun({ findings: [{ ruleId: 'RUN-005', category: 'runtime', type: 'standards_warning', severity: 'low', title: 'Page has no title', fingerprint: 'd'.repeat(64) }] });
    const wb = await load(await buildWorkbook(buildProjectReport(h.store, projectId)));
    const ws = wb.getWorksheet('Issues')!;
    const header = (ws.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual(expect.arrayContaining(['ID', 'Status', 'Owner', 'Notes', 'First found', 'Last seen', 'Latest scan']));
    expect(ws.getCell('J2').dataValidation?.formulae?.[0]).toContain('Verified');
    expect(ws.getCell('J20').dataValidation?.type).toBe('list'); // room for rows added by hand
    expect(ws.autoFilter).toBeTruthy();
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    const manual = rows(wb.getWorksheet('Manual checks')!);
    expect(manual.length).toBeGreaterThanOrEqual(8);
    expect(manual.every((m) => m.Status === 'Not started')).toBe(true);
    const summary = wb.getWorksheet('Summary')!;
    const text = JSON.stringify(summary.getSheetValues());
    expect(text).toContain('does not mean the course is accessible');
    expect(text).toContain('Not found (confirm fixed)');
  });

  it('keeps IDs stable across scans and never calls a missing issue "fixed"', async () => {
    seedRun({
      findings: [
        { ruleId: 'RUN-005', category: 'runtime', type: 'standards_warning', severity: 'low', title: 'Page has no title', fingerprint: 'e'.repeat(64) },
        { ruleId: 'RUN-003', category: 'runtime', type: 'heuristic_warning', severity: 'low', title: 'Console error: gone later', fingerprint: 'f'.repeat(64) },
      ],
    });
    await pause();
    seedRun({
      findings: [
        { ruleId: 'RUN-005', category: 'runtime', type: 'standards_warning', severity: 'low', title: 'Page has no title', fingerprint: 'e'.repeat(64) },
        { ruleId: 'RUN-002', category: 'runtime', type: 'automated_defect', severity: 'high', title: 'Uncaught JavaScript exception: new', fingerprint: '1'.repeat(64) },
      ],
    });
    const report = buildProjectReport(h.store, projectId);
    expect(report.courses).toHaveLength(1);
    expect(report.courses[0]!.scans).toBe(2);
    const byTitle = Object.fromEntries(report.issues.map((i) => [i.issue, i]));
    expect(byTitle['The page has no title']).toMatchObject({ id: 'QA-EEEEEE', scansSeen: 2, inLatestScan: true });
    expect(byTitle['The browser reported an error']).toMatchObject({ scansSeen: 1, inLatestScan: false });
    expect(byTitle['A script error happens on this screen']).toMatchObject({ scansSeen: 1, inLatestScan: true });
    // Issues still present sort before those not found in the latest scan.
    expect(report.issues.at(-1)!.inLatestScan).toBe(false);

    const wb = await load(await buildWorkbook(report));
    const issues = rows(wb.getWorksheet('Issues')!);
    expect(issues.find((r) => r.ID === 'QA-EEEEEE')!['Latest scan']).toBe('Found');
    expect(issues.at(-1)!['Latest scan']).toBe('Not found (confirm fixed)');
    expect(issues.at(-1)!.Status).toBe('Open'); // never set to fixed automatically
  });

  it('stores untrusted course text as inert text (no formulas)', async () => {
    expect(safeCell('=HYPERLINK("http://evil.example","x")')).toBe(`'=HYPERLINK("http://evil.example","x")`);
    for (const lead of ['+', '-', '@', '\t', '\r']) expect(safeCell(`${lead}1+1`).startsWith("'")).toBe(true);
    expect(safeCell('normal text')).toBe('normal text');

    seedRun({
      findings: [
        {
          ruleId: 'TXT-001',
          category: 'content',
          type: 'automated_defect',
          severity: 'medium',
          title: '=cmd|\' /C calc\'!A0',
          fingerprint: '9'.repeat(64),
          occurrences: [{ location: { stateId: undefined, selector: '+SUM(1+1)', elementDescription: '@evil' }, checkResultIds: [], evidenceIds: [], observed: '=1+1' }],
          observed: '=1+1',
        },
      ],
    });
    const wb = await load(await buildWorkbook(buildProjectReport(h.store, projectId)));
    wb.eachSheet((ws) =>
      ws.eachRow((row) =>
        row.eachCell((cell) => {
          const v = cell.value as unknown;
          expect(typeof v === 'object' && v !== null && 'formula' in (v as object), `${ws.name}!${cell.address} is a formula`).toBe(false);
          if (typeof v === 'string') expect(/^[=+\-@]/.test(v), `${ws.name}!${cell.address} starts with a formula character: ${v}`).toBe(false);
        }),
      ),
    );
    const issue = rows(wb.getWorksheet('Issues')!)[0]!;
    expect(issue.Where).toBe("'@evil");
  });
});

describe('export endpoints', () => {
  it('serves the scan workbook, the project workbook, and the plain report as JSON', async () => {
    const run = seedRun({ findings: [{ ruleId: 'RUN-005', category: 'runtime', type: 'standards_warning', severity: 'low', title: 'Page has no title', fingerprint: '7'.repeat(64) }] });
    const app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`] });
    try {
      for (const url of [`/api/runs/${run.id}/export.xlsx`, `/api/projects/${projectId}/export.xlsx`]) {
        const res = await app.inject({ method: 'GET', url, headers: { host: HOST } });
        expect(res.statusCode, url).toBe(200);
        expect(res.headers['content-type']).toContain('spreadsheetml');
        expect(res.headers['content-disposition']).toMatch(/attachment; filename="course-qa-tracker-project-[^"]+\.xlsx"/);
        const wb = await load(res.rawPayload);
        expect(rows(wb.getWorksheet('Issues')!)).toHaveLength(1);
      }
      const json = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/report`, headers: { host: HOST } });
      expect(json.json()).toMatchObject({ counts: { fix: 1, check: 0, notChecked: 0 }, coverage: { screensScanned: 1 } });
      for (const bad of ['/api/runs/not-an-id/export.xlsx', '/api/projects/00000000-0000-0000-0000-000000000000/export.xlsx']) {
        expect((await app.inject({ method: 'GET', url: bad, headers: { host: HOST } })).statusCode).toBe(404);
      }
    } finally {
      await app.close();
    }
  });

  it('the report model and the workbook always agree on totals', async () => {
    const run = seedRun({
      findings: [
        { ruleId: 'RUN-005', category: 'runtime', type: 'standards_warning', severity: 'low', title: 'Page has no title', fingerprint: '5'.repeat(64) },
        { ruleId: 'COV-004', category: 'coverage', type: 'manual_review', severity: 'informational', title: 'Stopped at budget', fingerprint: '6'.repeat(64) },
      ],
    });
    const rep = buildRunReport(h.store, run.id);
    const wb = await load(await buildWorkbook(buildProjectReport(h.store, projectId)));
    const sum = wb.getWorksheet('Summary')!.getRow(5);
    expect([sum.getCell(5).value, sum.getCell(6).value, sum.getCell(7).value]).toEqual([rep.counts.fix, rep.counts.check, rep.counts.notChecked]);
    expect(rows(wb.getWorksheet('Issues')!)).toHaveLength(rep.issues.length);
  });
});

describe('readability details', () => {
  it('keeps long selectors out of the steps and replaces machine-made screen titles', async () => {
    const run = seedRun({
      findings: [
        {
          ruleId: 'A11Y-AXE-color-contrast',
          category: 'accessibility',
          type: 'standards_warning',
          severity: 'high',
          title: 'Elements must meet minimum color contrast ratio thresholds (2 elements)',
          fingerprint: '3'.repeat(64),
          reproductionSteps: [`Open ${COURSE} in Chromium with a 1440×900 CSS-pixel viewport.`, 'Run an inspector.', 'Affected element: div > div > div > span.very-long-generated-class-name-1234567890'],
        },
      ],
    });
    h.store.insertState({ id: newId<StateId>(), runId: run.id, url: COURSE as never, title: 'R2QXJAl4kVfzG8vlnL8yfIF-45qEXu8x', signature: 's2', openDialogs: [], selectedTabs: [], depth: 1, pathFromRoot: [], surfaces: [{ kind: 'document' }], viewportName: 'desktop', capturedAt: nowIso() });
    const rep = buildRunReport(h.store, run.id);
    expect(rep.issues[0]!.steps.some((s) => s.startsWith('Affected element'))).toBe(false);
    expect(rep.issues[0]!.issue).toBe('Text is hard to read (low contrast) (2 places)');
    expect(rep.screens.map((s) => s.title)).not.toContain('R2QXJAl4kVfzG8vlnL8yfIF-45qEXu8x');
  });
});
