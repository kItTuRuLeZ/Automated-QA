import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckResultId, CourseState, EvidenceId, Finding, FindingId, ProjectId, ScanRun, StateId } from '@cqa/shared';
import { buildRunReport, buildScanConfig, newId, nowIso } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
import { buildHtmlReport } from '../apps/server/src/export/html.js';
import { renderPdf } from '../apps/server/src/export/pdf.js';
import { type Harness, createHarness } from './support/harness.js';

const COURSE = 'https://course.example.com/';
const HOST = '127.0.0.1:4317';
// A valid 1x1 PNG.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

let h: Harness;
let projectId: ProjectId;
beforeEach(() => {
  h = createHarness({ resolver: async () => ['93.184.215.14'] });
  projectId = h.store.createProject({ name: 'Formats project', courseUrl: COURSE }).id;
});
afterEach(async () => {
  await h.close();
});

type Seed = Partial<Finding> & { ruleId: string; title: string; fingerprint: string };

function seedRun(findings: Seed[], untested: string[] = []): ScanRun {
  const run = h.store.createRun(buildScanConfig({ projectId, url: new URL(COURSE) }), COURSE);
  const state: CourseState = { id: newId<StateId>(), runId: run.id, url: COURSE as never, title: 'Welcome', signature: 's1', openDialogs: [], selectedTabs: [], depth: 0, pathFromRoot: [], surfaces: [{ kind: 'document' }], viewportName: 'desktop', capturedAt: nowIso() };
  h.store.insertState(state);
  for (const f of findings) {
    h.store.upsertFinding({
      id: newId<FindingId>(),
      runId: run.id,
      category: 'runtime',
      type: 'automated_defect',
      severity: 'high',
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
  for (const reason of untested) h.store.insertCheckResult({ id: newId<CheckResultId>(), runId: run.id, ruleId: 'MED-001', outcome: 'not_tested', reason: reason as never, durationMs: 0, evidenceIds: [], executedAt: nowIso() });
  h.store.finishRun(run.id, { status: 'completed' });
  return run;
}

const loadImage = (id: string) => {
  const rec = h.store.getArtifact(id);
  return rec ? readFileSync(h.artifacts.absolutePath(rec)) : undefined;
};
const appFor = () => buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`] });

describe('report formats from one model', () => {
  it('JSON export is the report model with its scan details and no AI', async () => {
    const run = seedRun([{ ruleId: 'RUN-005', type: 'standards_warning', severity: 'low', title: 'Page has no title', fingerprint: '1a'.repeat(32) }], ['budget_states']);
    const app = appFor();
    try {
      const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/export.json`, headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="course-qa-course-example-com-\d{4}-\d{2}-\d{2}\.json"/);
      const json = res.json() as { schemaVersion: number; report: ReturnType<typeof buildRunReport> };
      expect(json.schemaVersion).toBe(1);
      expect(json.report.counts).toEqual(buildRunReport(h.store, run.id).counts);
      expect(json.report.scan).toMatchObject({ aiUsed: false, scope: { origins: [COURSE.replace(/\/$/, '')] }, screenSizes: ['desktop 1440×900'] });
      expect(json.report.advisory).toEqual([]);
      expect(json.report.untested).toEqual([{ reason: 'budget_states', count: 1 }]);
      expect(json.report.byCategory).toEqual([{ category: 'runtime', fix: 1, check: 0, notChecked: 0 }]);
    } finally {
      await app.close();
    }
  });

  it('HTML escapes everything from the course and cannot run script, even when opened with JavaScript on', async () => {
    const run = seedRun([
      {
        ruleId: 'TXT-001',
        category: 'content',
        severity: 'medium',
        title: '<script>window.__xss=1</script>Placeholder "quoted" & <b>bold</b>',
        fingerprint: '2b'.repeat(32),
        observed: '"><img src=x onerror=window.__xss=2>',
        occurrences: [{ location: { selector: '</style><script>window.__xss=3</script>', elementDescription: '<svg onload=window.__xss=4>' }, checkResultIds: [], evidenceIds: [], observed: '<script>' }],
        reproductionSteps: ['Open <script>alert(1)</script>'],
      },
    ]);
    const html = buildHtmlReport(buildRunReport(h.store, run.id), { loadImage });
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).toContain('&lt;script&gt;window.__xss=1&lt;/script&gt;');
    expect(html).toContain('http-equiv="Content-Security-Policy"');

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage(); // JavaScript is ON here on purpose
      const requests: string[] = [];
      await page.route('**/*', (route) => {
        requests.push(route.request().url());
        return route.abort();
      });
      await page.setContent(html);
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
      expect(requests.filter((u) => !u.startsWith('data:'))).toEqual([]);
      expect(await page.locator('script').count()).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it('embeds each screenshot once, and the embedded bytes are the stored evidence', async () => {
    const run = seedRun([
      { ruleId: 'RUN-005', type: 'standards_warning', severity: 'low', title: 'Page has no title', fingerprint: '3c'.repeat(32) },
      { ruleId: 'RUN-003', type: 'heuristic_warning', severity: 'low', title: 'Console error: x', fingerprint: '4d'.repeat(32) },
    ]);
    const state = h.store.listStates(run.id)[0]!;
    const art = h.artifacts.write(run.id, { kind: 'screenshot', mime: 'image/png', bytes: PNG });
    h.store.insertEvidence({ id: newId<EvidenceId>(), runId: run.id, kind: 'screenshot', artifactId: art.id, caption: 'Initial state', stateId: state.id, capturedAt: nowIso(), redacted: false });
    const html = buildHtmlReport(buildRunReport(h.store, run.id), { loadImage });
    // Both issues use the same screen screenshot: it is in the file once and shown twice.
    expect(html.split('data:image/png;base64,').length - 1).toBe(1);
    expect(html.split('class="shot im1"').length - 1).toBe(2);
    const embedded = /data:image\/png;base64,([A-Za-z0-9+/=]+)\)/.exec(html)![1]!;
    expect(createHash('sha256').update(Buffer.from(embedded, 'base64')).digest('hex')).toBe(art.sha256);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Screenshot of the screen where this was found');
  });

  it('HTML totals match the report model, and denominators are explained', () => {
    const run = seedRun(
      [
        { ruleId: 'RUN-005', type: 'standards_warning', severity: 'low', title: 'Page has no title', fingerprint: '5e'.repeat(32) },
        { ruleId: 'RUN-003', type: 'heuristic_warning', severity: 'low', title: 'Console error: x', fingerprint: '6f'.repeat(32) },
        { ruleId: 'COV-004', category: 'coverage', type: 'manual_review', severity: 'informational', title: 'Stopped at budget', fingerprint: '7a'.repeat(32) },
      ],
      ['budget_states', 'out_of_scope'],
    );
    const rep = buildRunReport(h.store, run.id);
    const html = buildHtmlReport(rep, {});
    const num = (key: string, attr = 'data-count') => Number(new RegExp(`${attr}="${key}">(\\d+)<`).exec(html)![1]);
    expect([num('fix'), num('check'), num('not_checked')]).toEqual([rep.counts.fix, rep.counts.check, rep.counts.notChecked]);
    expect(num('rules', 'data-total')).toBe(rep.checkTotals.uniqueRules);
    expect(num('executions', 'data-total')).toBe(rep.checkTotals.executions);
    expect(html).toContain('Not tested and errored checks are never counted as passed');
    expect(html).toContain('Screen limit reached');
    expect(html).toContain('Manual review checklist');
    expect(html).toContain('AI was not used for any result in this report');
  });

  it('PDF is produced offline from the same HTML and never touches the network', async () => {
    const hits: string[] = [];
    const probe = http.createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'image/png' }).end(PNG);
    });
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    try {
      const run = seedRun([{ ruleId: 'RUN-005', type: 'standards_warning', severity: 'low', title: 'Page has no title', fingerprint: '8b'.repeat(32) }]);
      const hostile = buildHtmlReport(buildRunReport(h.store, run.id), {}).replace('</body>', `<img src="http://127.0.0.1:${port}/probe.png"><link rel="stylesheet" href="http://127.0.0.1:${port}/x.css"></body>`);
      const pdf = await renderPdf(hostile);
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(5_000);
      expect(hits).toEqual([]);

      const app = appFor();
      try {
        const res = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/export.pdf`, headers: { host: HOST } });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('application/pdf');
        expect(res.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
        const page = await app.inject({ method: 'GET', url: `/api/runs/${run.id}/export.html`, headers: { host: HOST } });
        expect(page.headers['content-type']).toContain('text/html');
        expect(page.body).toContain('Course QA report');
      } finally {
        await app.close();
      }
    } finally {
      await new Promise((r) => probe.close(r));
    }
  });
});
