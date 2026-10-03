import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CheckResult, Finding } from '@cqa/shared';
import { VIEWPORT_PRESETS, baselineKey, buildProjectReport, buildRunReport, recordBaselineFromRun } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
import { buildWorkbook } from '../apps/server/src/export/xlsx.js';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';
import { type Harness, createHarness } from './support/harness.js';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

let fx: FixtureServer;
let h: Harness;

beforeAll(async () => {
  fx = await startFixtureServer();
  h = createHarness({
    exemptAddresses: [
      { ip: '127.0.0.1', port: fx.port },
      { ip: '127.0.0.1', port: fx.otherPort },
    ],
  });
  h.startWorker();
});
afterAll(async () => {
  await h?.close();
  await fx?.close();
});

const ALL = ['desktop', 'tablet', 'mobile'];
async function scan(path: string, opts: Parameters<Harness['queueScan']>[1] = {}) {
  const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/${path}`, { layout: true, explore: false, viewports: ALL, ...opts }).id, 240_000);
  return { run, checks: h.store.listCheckResults(run.id), findings: h.store.listFindings(run.id) };
}
const at = (checks: CheckResult[], rule: string, viewport: string) => checks.filter((c) => c.ruleId === rule && c.viewportName === viewport).map((c) => c.outcome);
const of = (findings: Finding[], rule: string) => findings.filter((f) => f.ruleId === rule);
const layoutFindings = (findings: Finding[]) => findings.filter((f) => /^(LAY|PERF)-/.test(f.ruleId));

describe('responsive layout at several viewports', () => {
  it('flags sideways scrolling only at the viewports where it happens, with measured widths', async () => {
    const { checks, findings } = await scan('layout-overflow/');
    expect(at(checks, 'LAY-001', 'desktop')).toEqual(['passed']);
    expect(at(checks, 'LAY-001', 'tablet')).toEqual(['needs_review']);
    expect(at(checks, 'LAY-001', 'mobile')).toEqual(['needs_review']);
    const f = of(findings, 'LAY-001');
    expect(f.map((x) => x.title).sort()).toEqual(['Page scrolls sideways at mobile (390×844)', 'Page scrolls sideways at tablet (768×1024)']);
    expect(f[0]).toMatchObject({ type: 'heuristic_warning' });
    expect(f.find((x) => x.title.includes('mobile'))!.observed).toMatch(/924 px wide but the screen is 390 px/);
    expect(f.every((x) => x.reproductionSteps.some((s) => s.includes('CSS pixels')))).toBe(true);
  });

  it('records the device settings and browser used, and keeps the original screenshot for every screen and viewport', async () => {
    const { run } = await scan('layout-overflow/');
    expect(run.config.viewports.map((v) => [v.name, v.width, v.height, v.isMobile, v.hasTouch])).toEqual([
      ['desktop', 1440, 900, false, false],
      ['tablet', 768, 1024, true, true],
      ['mobile', 390, 844, true, true],
    ]);
    expect(run.browser).toMatchObject({ engine: 'chromium' });
    const shots = h.store.listEvidenceByKind(run.id, 'screenshot').filter((e) => e.data?.layoutCapture);
    expect(shots.map((s) => s.viewportName).sort()).toEqual(['desktop', 'mobile', 'tablet']);
    const mobile = shots.find((s) => s.viewportName === 'mobile')!;
    expect(mobile.data).toMatchObject({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true } });
    const bytes = readFileSync(h.artifacts.absolutePath(h.store.getArtifact(mobile.artifactId!)!));
    expect(bytes.readUInt32BE(16)).toBe(390); // the screenshot really is at the mobile width
    const geometry = h.store.listEvidenceByKind(run.id, 'geometry').find((g) => g.viewportName === 'mobile');
    expect(geometry?.data).toMatchObject({ browser: { engine: 'chromium' }, viewport: { isMobile: true } });
  });

  it('outlines the affected element in a screenshot taken at that viewport', async () => {
    const { run, findings } = await scan('layout-clipped/', { viewports: ['desktop', 'tablet'] });
    const tablet = of(findings, 'LAY-002').find((f) => f.title.includes('tablet'))!;
    const ev = h.store.getEvidence(tablet.evidenceIds).find((e) => e.kind === 'annotated_screenshot');
    expect(ev?.viewportName).toBe('tablet');
    expect(ev?.data).toMatchObject({ selector: '#clipped', bounds: { width: 202 } }); // 200 px plus the 1 px border on each side
    expect(run.status).toBe('completed');
  });

  it('reports a screen it cannot reach at a smaller viewport as not tested, never as passed', async () => {
    const { checks, run } = await scan('responsive-hidden/', { explore: true, maxStates: 4, maxDepth: 1 });
    const mobile = checks.filter((c) => c.ruleId === 'LAY-001' && c.viewportName === 'mobile');
    // Panel one is the opening page (reachable); the screen after clicking tab "Two" is not reachable on mobile.
    expect(mobile.map((c) => c.outcome).sort()).toEqual(['not_tested', 'passed']);
    const lost = mobile.find((c) => c.outcome === 'not_tested')!;
    expect(lost.reason).toBe('state_unreachable');
    expect(lost.reasonDetail).toContain('Could not reach this screen at mobile');
    expect(at(checks, 'LAY-001', 'desktop').every((o) => o === 'passed')).toBe(true);
    // The gap makes the scan partial, with the reason stated.
    expect(run.status).toBe('partial');
    expect(run.statusDetail).toContain('could not be reached again at a smaller viewport');
  });
});

describe('visual heuristics ignore intentional design', () => {
  it('tooltips, badges, scrollers, carousels, sticky headers, and modal backdrops produce no layout findings at any viewport', async () => {
    const { checks, findings } = await scan('layout-intentional/');
    expect(layoutFindings(findings)).toEqual([]);
    for (const vp of ALL) for (const rule of ['LAY-001', 'LAY-002', 'LAY-003', 'LAY-004']) expect(at(checks, rule, vp), `${rule}@${vp}`).not.toContain('needs_review');
  });

  it('clipped text is flagged but ellipsis, line clamps, scrolling boxes, and screen-reader-only text are not', async () => {
    const { findings } = await scan('layout-clipped/', { viewports: ['desktop'] });
    const [f] = of(findings, 'LAY-002');
    expect(f.occurrences).toHaveLength(1);
    expect(f.occurrences[0]!.location.selector).toBe('#clipped');
    expect(f.observed).toContain('shows 200×28 px of 200×72 px');
    expect(f).toMatchObject({ type: 'heuristic_warning', confidence: 'low' });
  });

  it('flags a control covered by a banner, but not one under a click-through overlay or an uncovered one', async () => {
    const { findings } = await scan('layout-obscured/', { viewports: ['desktop'] });
    const [f] = of(findings, 'LAY-003');
    expect(f.occurrences.map((o) => o.location.selector)).toEqual(['#covered']);
    expect(f.observed).toContain('"Submit order" is covered by "A fixed banner');
  });

  it('flags a dialog that extends past the screen edge and leaves a well-placed one alone', async () => {
    const { findings } = await scan('layout-dialog/', { viewports: ['desktop'] });
    const dialogs = of(findings, 'LAY-004');
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]!.title).toContain('Misplaced dialog');
    expect(dialogs[0]!.observed).toContain('extends 200 px past the left edge');
  });

  it('reports web fonts that failed to load as a defect', async () => {
    const { findings, checks } = await scan('layout-fonts/', { viewports: ['desktop'] });
    expect(of(findings, 'LAY-005').map((f) => f.title)).toEqual(['Web font "Missing Face" did not load']);
    expect(of(findings, 'LAY-005')[0]!.type).toBe('automated_defect');
    expect(at(checks, 'LAY-005', 'desktop')).toEqual(['failed']);
    // The font request is covered by LAY-005, not duplicated as a failed request.
    expect(of(findings, 'RUN-004')).toEqual([]);
  });
});

describe('performance evidence', () => {
  it('records load time, transfer, requests, and largest assets with the test conditions, and warns only over the thresholds', async () => {
    const heavy = await scan('perf-heavy/', { viewports: ['desktop'], perf: { totalBytes: 500_000 } });
    const [f] = of(heavy.findings, 'PERF-001');
    expect(f.type).toBe('heuristic_warning');
    expect(f.observed).toMatch(/MB transferred \(limit 0\.5 MB\)/);
    expect(f.observed).toContain('large.png');
    expect(f.expected).toContain('not a published standard');
    const ev = h.store.getEvidence(f.evidenceIds).find((e) => e.kind === 'timing')!;
    const data = ev.data as { conditions: string[]; requests: number; transferredBytes: number; largest: Array<{ url: string }>; thresholds: { provenance: string } };
    expect(data.requests).toBeGreaterThanOrEqual(2);
    expect(data.transferredBytes).toBeGreaterThan(1_000_000);
    expect(data.conditions.join(' ')).toMatch(/empty cache.*machine running the scan.*not a full performance audit/s);

    const light = await scan('healthy/', { viewports: ['desktop'] });
    expect(of(light.findings, 'PERF-001')).toEqual([]);
    expect(at(light.checks, 'PERF-001', 'desktop')).toEqual(['passed']);
  });
});

describe('baseline screenshot comparison', () => {
  it('only compares identical settings, detects a known visual change, and never treats it as proof of a defect', async () => {
    fx.setBaselineVariant('v1');
    const first = await scan('baseline/', { viewports: ['desktop'] });
    const recorded = recordBaselineFromRun(h.store, first.run.id)!;
    expect(recorded.recorded).toBe(1);
    // Without the option, no baseline check is even owned.
    expect(first.checks.some((c) => c.ruleId === 'VIS-001')).toBe(false);

    const same = await scan('baseline/', { viewports: ['desktop'], compareBaseline: true });
    expect(at(same.checks, 'VIS-001', 'desktop')).toEqual(['passed']);
    expect(of(same.findings, 'VIS-001')).toEqual([]);

    fx.setBaselineVariant('v2');
    const changed = await scan('baseline/', { viewports: ['desktop'], compareBaseline: true });
    expect(at(changed.checks, 'VIS-001', 'desktop')).toEqual(['needs_review']);
    const [f] = of(changed.findings, 'VIS-001');
    expect(f).toMatchObject({ type: 'manual_review', severity: 'informational' });
    expect(f!.expected).toContain('also cause differences');
    const diff = h.store.getEvidence(f!.evidenceIds).find((e) => e.kind === 'diff_image')!;
    expect((diff.data as { ratio: number }).ratio).toBeGreaterThan(0.05); // a 400×200 block of a 1440×900 page
    const png = readFileSync(h.artifacts.absolutePath(h.store.getArtifact(diff.artifactId!)!));
    expect(png.subarray(1, 4).toString()).toBe('PNG');

    // A different viewport is a different baseline key: never compared.
    const tablet = await scan('baseline/', { viewports: ['tablet'], compareBaseline: true });
    expect(tablet.checks.filter((c) => c.ruleId === 'VIS-001').map((c) => [c.outcome, c.reason])).toEqual([['not_tested', 'no_baseline']]);
    fx.setBaselineVariant('v1');
  });

  it('baseline identity changes with viewport, path, browser major version, and settings, but not browser minor version', () => {
    const base = { courseUrl: 'https://c.example/', pathKey: '', viewport: VIEWPORT_PRESETS[0]!, browser: { engine: 'chromium' as const, version: '153.0.8010.12' }, configVersion: 1 };
    const k = baselineKey(base);
    expect(baselineKey({ ...base, browser: { engine: 'chromium', version: '153.0.9999.1' } })).toBe(k);
    for (const changed of [
      { ...base, viewport: VIEWPORT_PRESETS[2]! },
      { ...base, pathKey: 'Start > Next' },
      { ...base, browser: { engine: 'chromium' as const, version: '154.0.1.1' } },
      { ...base, browser: { engine: 'firefox' as const, version: '153.0' } },
      { ...base, configVersion: 2 },
      { ...base, courseUrl: 'https://other.example/' },
    ]) {
      expect(baselineKey(changed)).not.toBe(k);
    }
  });
});

describe('reports and API for screen sizes', () => {
  it('shows screen sizes, their device settings, and page-load conditions in the report model and the Excel workbook', async () => {
    const { run } = await scan('layout-overflow/');
    const rep = buildRunReport(h.store, run.id);
    expect(rep.viewports?.map((v) => [v.name, v.screensChecked, v.layoutIssues])).toEqual([
      ['desktop', 1, 0],
      ['tablet', 1, 1],
      ['mobile', 1, 1],
    ]);
    expect(rep.performance?.conditions.join(' ')).toContain('empty cache');
    const issue = rep.issues.find((i) => i.technical.ruleId === 'LAY-001' && i.viewports.includes('mobile'))!;
    expect(issue.viewports).toEqual(['mobile']);
    expect(issue.issue).toBe('Page scrolls sideways at mobile (390×844)');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildWorkbook(buildProjectReport(h.store, run.projectId))) as never);
    const summary = JSON.stringify(wb.getWorksheet('Summary')!.getSheetValues());
    expect(summary).toContain('tablet 768×1024');
    expect(summary).toContain('not real devices');
    expect(summary).toContain('mobile emulation, touch');
    expect(summary).toContain('Page-load evidence');
    const issues = wb.getWorksheet('Issues')!;
    const header = (issues.getRow(1).values as unknown[]).slice(1) as string[];
    const sizeCol = header.indexOf('Screen size') + 1;
    const sizes: string[] = [];
    issues.eachRow((row, n) => n > 1 && sizes.push(String(row.getCell(sizeCol).value ?? '')));
    expect(sizes).toEqual(expect.arrayContaining(['tablet', 'mobile']));
  });

  it('saves a baseline through the API and refuses scans without layout screenshots', async () => {
    const app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: ['127.0.0.1:4317'], allowedOrigins: ['http://127.0.0.1:4317'] });
    const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'content-type': 'application/json', 'x-qa-request': '1' };
    try {
      const withLayout = await scan('baseline/', { viewports: ['desktop', 'mobile'] });
      const ok = await app.inject({ method: 'POST', url: `/api/runs/${withLayout.run.id}/baseline`, headers, payload: {} });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ recorded: 2 });
      expect(h.store.countBaselines(withLayout.run.projectId, ok.json().courseUrl)).toBe(2);

      const without = await scan('healthy/', { layout: false });
      const refused = await app.inject({ method: 'POST', url: `/api/runs/${without.run.id}/baseline`, headers, payload: {} });
      expect(refused.statusCode).toBe(422);
      const noHeader = await app.inject({ method: 'POST', url: `/api/runs/${withLayout.run.id}/baseline`, headers: { host: headers.host, 'content-type': 'application/json' }, payload: {} });
      expect(noHeader.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
