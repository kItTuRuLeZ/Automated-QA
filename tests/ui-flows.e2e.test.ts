import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import ExcelJS from 'exceljs';
import { type Browser, type Locator, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CheckResultId, EvidenceId, FindingId, ProjectId } from '@cqa/shared';
import { buildScanConfig, newId, nowIso } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
import { type Harness, createHarness } from './support/harness.js';
import { makeZip, manifest2004, page as htmlPage } from './support/packages.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const WEB_DIST = path.resolve(import.meta.dirname, '../apps/web/dist');
// A valid 1×1 PNG, so the evidence viewer has a real image to open.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// Playwright-style waiting assertions on top of vitest (the project does not depend on @playwright/test).
const until = (check: () => Promise<boolean>, describe = 'condition') =>
  vi.waitFor(async () => {
    if (!(await check())) throw new Error(`${describe} not met yet`);
  }, { timeout: 12_000, interval: 100 });
const visible = (l: Locator) => l.first().waitFor({ state: 'visible', timeout: 12_000 });
const hidden = (l: Locator) => l.first().waitFor({ state: 'hidden', timeout: 12_000 });
const count = (l: Locator, n: number) => until(async () => (await l.count()) === n, `count of ${l} = ${n}`);
const focused = (l: Locator) => until(async () => l.evaluate((el) => el === document.activeElement));
const checked = (l: Locator) => until(async () => l.isChecked());
const enabled = (l: Locator) => until(async () => l.isEnabled());
const hasValue = (l: Locator, v: string) => until(async () => (await l.inputValue()) === v);
const hasAttr = (l: Locator, name: string, v: string | RegExp) => until(async () => { const a = await l.getAttribute(name); return a !== null && (typeof v === 'string' ? a === v : v.test(a)); });
const hasText = (l: Locator, v: string | string[]) =>
  until(async () => {
    if (Array.isArray(v)) return JSON.stringify((await l.allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim())) === JSON.stringify(v);
    return ((await l.first().textContent()) ?? '').trim() === v;
  }, `text of ${l} = ${JSON.stringify(v)}`);

let h: Harness;
let app: ReturnType<typeof buildApp>;
let browser: Browser;
let origin = '';
let seeded: { projectId: ProjectId; emptyProjectId: ProjectId; runId: string; findingId: string };

const api = async <T,>(p: string): Promise<T> => (await fetch(origin + p)).json() as Promise<T>;
const runsOf = (projectId: string) => h.store.listRuns(projectId as ProjectId);

async function newPage(width = 1366, height = 900): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
  return ctx.newPage();
}

beforeAll(async () => {
  if (!existsSync(path.join(WEB_DIST, 'index.html'))) execSync('npm run build -w @cqa/web', { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'ignore' });
  const hosts: string[] = [];
  const origins: string[] = [];
  const bootstrap = createHarness();
  app = buildApp({ store: bootstrap.store, artifacts: bootstrap.artifacts, policy: bootstrap.policy, allowedHosts: hosts, allowedOrigins: origins, webDist: WEB_DIST });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  hosts.push(`127.0.0.1:${port}`);
  origins.push(`http://127.0.0.1:${port}`);
  origin = `http://127.0.0.1:${port}`;
  await app.close();
  await bootstrap.close();

  // The app's own origin is allowed by test code only, so a wizard-started scan passes validation. No worker runs: queued scans stay queued.
  h = createHarness({ exemptAddresses: [{ ip: '127.0.0.1', port }] });
  app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: hosts, allowedOrigins: origins, webDist: WEB_DIST, packages: { dir: mkdtempSync(path.join(tmpdir(), 'cqa-ui-pkgs-')), port: port + 1 } });
  await app.listen({ host: '127.0.0.1', port });

  const project = h.store.createProject({ name: 'UI flow project', courseUrl: 'https://course.example.com/lessons/' });
  const empty = h.store.createProject({ name: 'UI flow empty project' });
  const run = h.store.createRun(buildScanConfig({ projectId: project.id, url: new URL('https://course.example.com/lessons/') }), 'https://course.example.com/lessons/');
  const shot = h.artifacts.write(run.id, { kind: 'screenshot', mime: 'image/png', bytes: PNG });
  const goodEvidence = { id: newId<EvidenceId>(), runId: run.id, kind: 'screenshot' as const, artifactId: shot.id, caption: 'Opening page', capturedAt: nowIso(), redacted: true };
  // A screenshot whose file was later removed (for example by the retention clean-up): the record stays, the file is gone.
  const gone = h.artifacts.write(run.id, { kind: 'screenshot', mime: 'image/png', bytes: PNG });
  rmSync(h.artifacts.absolutePath(gone));
  const missingEvidence = { id: newId<EvidenceId>(), runId: run.id, kind: 'screenshot' as const, artifactId: gone.id, caption: 'Removed screenshot', capturedAt: nowIso(), redacted: true };
  h.store.insertEvidence(goodEvidence);
  h.store.insertEvidence(missingEvidence);
  const mk = (ruleId: string, title: string, severity: 'high' | 'low', type: 'automated_defect' | 'heuristic_warning', evidenceIds: EvidenceId[]) => {
    const id = newId<FindingId>();
    h.store.upsertFinding({
      id,
      runId: run.id,
      ruleId: ruleId as never,
      category: 'runtime',
      type,
      severity,
      confidence: 'high',
      title,
      location: { url: 'https://course.example.com/lessons/' as never },
      occurrences: [],
      observed: `${title}: observed text.`,
      expected: 'The course works as designed.',
      evidenceIds,
      reproductionSteps: ['Open the page.'],
      remediation: 'Fix it.',
      standards: [],
      reviewer: { status: 'open', updatedAt: nowIso() },
      fingerprint: `ui-flow-${ruleId}-${title}`,
      createdAt: nowIso(),
    });
    return id;
  };
  const findingId = mk('RUN-005', 'Page has no title', 'high', 'automated_defect', [goodEvidence.id, missingEvidence.id]);
  mk('RUN-004', 'A request failed', 'low', 'automated_defect', []);
  mk('NAV-002', 'Next button may not change the page', 'low', 'heuristic_warning', []);
  // 120 check executions so pagination, search and result filters have something to work on.
  for (let i = 0; i < 120; i++) {
    h.store.insertCheckResult({ id: newId<CheckResultId>(), runId: run.id, ruleId: (i % 3 === 0 ? 'RUN-001' : i % 3 === 1 ? 'RUN-002' : 'KBD-001') as never, outcome: i % 10 === 0 ? 'not_tested' : 'passed', durationMs: 5, evidenceIds: [], executedAt: nowIso(), ...(i % 10 === 0 ? { reason: 'state_unreachable' as never } : {}) });
  }
  h.store.finishRun(run.id, { status: 'completed' });
  seeded = { projectId: project.id, emptyProjectId: empty.id, runId: run.id, findingId };
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await h?.close();
});

describe('guided scan setup', () => {
  it('lets a new user queue a scan from the recommended settings without opening Advanced settings, and a double click queues one scan', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/projects/${seeded.emptyProjectId}/new-scan`);
    await page.getByLabel('Course link').fill(`${origin}/`);
    await page.getByRole('button', { name: 'Next' }).click();
    await visible(page.getByRole('heading', { name: '2. Choose checks' }));
    await page.getByRole('button', { name: 'Next' }).click();
    await visible(page.getByRole('heading', { name: '3. Review and start' }));
    expect(await page.locator('details.advanced').count()).toBe(0); // Advanced settings live on step 2 and were never opened

    const posts: string[] = [];
    page.on('request', (r) => r.method() === 'POST' && r.url().endsWith('/scans') && posts.push(r.postData() ?? ''));
    await page.getByRole('button', { name: 'Start scan' }).dblclick();
    await page.waitForURL(/#\/runs\//);
    await visible(page.getByText('Waiting to start'));
    await visible(page.getByText(/One scan runs at a time/));
    expect(posts).toHaveLength(1);
    expect(runsOf(seeded.emptyProjectId)).toHaveLength(1);
    const body = JSON.parse(posts[0]!);
    expect(body).toMatchObject({ url: `${origin}/`, explore: true, accessibility: true, layout: true, maxStates: 25, maxDepth: 4, navigationTimeoutMs: 30_000, viewports: ['desktop'] });
    await page.context().close();
  });

  it('keeps every value across Back and Next, and sends Advanced values even when that section is closed', async () => {
    const project = h.store.createProject({ name: 'Advanced flow project' });
    const page = await newPage();
    await page.goto(`${origin}/#/projects/${project.id}/new-scan`);
    await page.getByLabel('Course link').fill(`${origin}/`);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByText('Advanced settings').click();
    await page.getByLabel('Time allowed to open a page (seconds)').fill('45');
    await page.getByLabel('Maximum screens or interaction views').fill('7');
    await page.getByLabel('Other websites this course needs').fill('https://cdn.example.com');
    await page.getByLabel('Tablet').check();
    await page.getByText('Advanced settings').click(); // close it again
    await page.getByRole('button', { name: 'Next' }).click();
    await visible(page.getByText(/Up to 7 screens or views/));
    await visible(page.getByText(/Up to 45 s to open a page/));
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('button', { name: 'Back' }).click();
    await hasValue(page.getByLabel('Course link'), `${origin}/`);
    await page.getByRole('button', { name: 'Next' }).click();
    await checked(page.getByLabel('Tablet'));
    await page.getByRole('button', { name: 'Next' }).click();

    const posted = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/scans'));
    await page.getByRole('button', { name: 'Start scan' }).click();
    const body = JSON.parse((await posted).postData() ?? '{}');
    expect(body).toMatchObject({ navigationTimeoutMs: 45_000, maxStates: 7, allowedOrigins: ['https://cdn.example.com'], viewports: ['desktop', 'tablet'] });
    await page.waitForURL(/#\/runs\//);
    await page.context().close();
  });

  it('explains a blocked address in plain language, creates no scan, and keeps what was typed', async () => {
    const project = h.store.createProject({ name: 'Blocked address project' });
    const page = await newPage();
    await page.goto(`${origin}/#/projects/${project.id}/new-scan`);
    await page.getByLabel('Course link').fill('http://169.254.169.254/latest/');
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Start scan' }).click();
    await visible(page.getByRole('alert').filter({ hasText: 'cannot be scanned' }));
    expect(runsOf(project.id)).toHaveLength(0);
    await enabled(page.getByRole('button', { name: 'Start scan' })); // can fix and retry
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('button', { name: 'Back' }).click();
    await hasValue(page.getByLabel('Course link'), 'http://169.254.169.254/latest/');
    await page.context().close();
  });

  it('validates the course link before moving on, beside the field', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/projects/${seeded.emptyProjectId}/new-scan`);
    await page.getByLabel('Course link').fill('not a link');
    await page.getByRole('button', { name: 'Next' }).click();
    await visible(page.getByText(/does not look like a web address/));
    await visible(page.getByRole('heading', { name: '1. Choose your course' }));
    await page.context().close();
  });
});

describe('results', () => {
  it('opens existing data through the same links, with tabs, course names and a result that is never labelled a pass', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/`);
    await visible(page.getByRole('link', { name: 'UI flow project' }));
    await visible(page.getByRole('link', { name: /View latest results for UI flow project/ })); // next action for a project with results
    await page.goto(`${origin}/#/runs/${seeded.runId}`);
    await visible(page.getByText('Scan finished — review the results'));
    expect(await page.getByText(/QA passed/i).count()).toBe(0);
    await hasText(page.getByRole('navigation', { name: 'Result sections' }).getByRole('link'), ['Summary', 'Issues 3', 'Coverage', 'Manual review', 'Technical details']);
    for (const tab of ['issues', 'coverage', 'manual', 'technical']) {
      await page.goto(`${origin}/#/runs/${seeded.runId}/${tab}`);
      await count(page.getByRole('navigation', { name: 'Result sections' }).locator('[aria-current="page"]'), 1);
    }
    await page.goto(`${origin}/#/findings/${seeded.findingId}`);
    await visible(page.getByRole('heading', { name: 'Page has no title' }));
    await page.context().close();
  });

  it('reconciles the summary tiles, the workbook and the report model, with each count in its own unit', async () => {
    const report = await api<{ counts: { fix: number; check: number; notChecked: number }; checkTotals: { executions: number; notTested: number; errors: number } }>(`/api/runs/${seeded.runId}/report`);
    const page = await newPage();
    await page.goto(`${origin}/#/runs/${seeded.runId}`);
    const tile = (label: string) => page.locator('a.big-count', { hasText: label }).locator('.big-number');
    await hasText(tile('Issues to fix'), String(report.counts.fix));
    await hasText(tile('Needs your review'), String(report.counts.check));
    await hasText(tile('Coverage gaps'), String(report.counts.notChecked));
    await visible(page.getByText(`${report.checkTotals.notTested + report.checkTotals.errors} of ${report.checkTotals.executions} check executions`));
    expect(report.checkTotals.notTested).toBe(12); // 12 executions did not run: a different unit from the coverage gaps above

    const buf = Buffer.from(await (await fetch(`${origin}/api/runs/${seeded.runId}/export.xlsx`)).arrayBuffer());
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as never);
    const summary = wb.getWorksheet('Summary')!;
    const header = (summary.getRow(4).values as unknown[]).slice(1);
    expect(header).toContain('Areas not checked');
    expect(header).toContain('Checks that did not run');
    const row = summary.getRow(5);
    expect([row.getCell(5).value, row.getCell(6).value, row.getCell(7).value]).toEqual([report.counts.fix, report.counts.check, report.counts.notChecked]);
    expect(row.getCell(9).value).toBe(12);
    await page.context().close();
  });

  it('shows Saving, Saved or the error, never Saved after a failed save, and offers no way to set Verified', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/runs/${seeded.runId}/issues`);
    const card = page.locator('.issue-card', { hasText: 'Page has no title' });
    const select = card.getByLabel('Status');
    expect(await select.locator('option').allTextContents()).not.toContain('Verified');
    await select.selectOption('fixed');
    await visible(card.getByText('Unsaved changes'));

    await page.route('**/workflow', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Disk full' }) }));
    await card.getByRole('button', { name: 'Save' }).click();
    await visible(card.getByText(/Not saved: Disk full/));
    await count(card.getByText('Saved', { exact: true }), 0);

    await page.unroute('**/workflow');
    await card.getByRole('button', { name: 'Save' }).click();
    await visible(card.getByText('Saved', { exact: true }));
    expect(h.store.getFinding(seeded.findingId as FindingId)?.reviewer.status).toBe('fixed');
    // Marked fixed is still open work until a retest verifies it; reset for later tests.
    await select.selectOption('open');
    await card.getByRole('button', { name: 'Save' }).click();
    await visible(card.getByText('Saved', { exact: true }));
    await page.context().close();
  });

  it('filters issues by type and search without losing records, and hides finished work until asked', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/runs/${seeded.runId}/issues`);
    await visible(page.getByText('Showing 3 of 3 open findings'));
    await page.getByLabel('Type').selectOption('check');
    await visible(page.getByText('Showing 1 of 3 open findings'));
    await page.getByLabel('Type').selectOption('all');
    await page.getByLabel('Search').fill('request failed');
    await visible(page.getByText('Showing 1 of 3 open findings'));
    await page.getByLabel('Search').fill('');
    await page.getByLabel('Include finished work').check();
    await visible(page.getByText('Showing 3 of 3 findings'));
    await page.context().close();
  });

  it('paginates check executions without discarding rows, and search and result filters keep their counts', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/runs/${seeded.runId}/technical`);
    await visible(page.getByText('Showing 120 of 120 check executions'));
    const rows = page.locator('table:has(caption:text("Check executions")) tbody tr');
    await count(rows, 50);
    await visible(page.getByText('1–50 of 120'));
    await page.getByRole('navigation', { name: 'Check executions pages' }).getByRole('button', { name: 'Next' }).click();
    await visible(page.getByText('51–100 of 120'));
    await page.getByLabel('Result', { exact: true }).selectOption('not_tested');
    await visible(page.getByText('Showing 12 of 120 check executions'));
    await count(rows, 12);
    await page.getByLabel('Result', { exact: true }).selectOption('all');
    await page.getByLabel('Search rule or reason').fill('KBD-001');
    await visible(page.getByText('Showing 40 of 120 check executions'));
    await page.context().close();
  });

  it('downloads the promised files from a menu, shows a recovery message when one fails, and closes with Escape returning focus', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/runs/${seeded.runId}`);
    const trigger = page.getByRole('button', { name: /Download report/ });
    await trigger.click();
    await visible(page.getByText(/This scan only: issues with owner and status columns/));
    await page.keyboard.press('Escape');
    await count(page.getByText('Excel issue tracker'), 0);
    await focused(trigger);

    await trigger.click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Excel issue tracker' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^course-qa-.*\.xlsx$/);

    await page.route('**/export.pdf', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Chromium is missing.' }) }));
    await trigger.click();
    await page.getByRole('button', { name: 'PDF report' }).click();
    await visible(page.getByText(/PDF report could not be created. Chromium is missing\..*Help → System status/));
    await page.context().close();
  });
});

describe('evidence viewer', () => {
  it('opens a screenshot at a useful size, closes with Escape, and explains a missing file without breaking the finding', async () => {
    const page = await newPage();
    await page.goto(`${origin}/#/findings/${seeded.findingId}`);
    await page.getByRole('button', { name: /Open full screenshot: Opening page/ }).click();
    const dialog = page.getByRole('dialog');
    await visible(dialog);
    await dialog.getByRole('button', { name: 'Actual size' }).click();
    await hasAttr(dialog.getByRole('button', { name: 'Actual size' }), 'aria-pressed', 'true');
    await hasAttr(dialog.getByRole('link', { name: /Open original/ }), 'href', /\/api\/artifacts\//);
    await page.keyboard.press('Escape');
    await hidden(dialog);
    await focused(page.getByRole('button', { name: /Open full screenshot: Opening page/ }));
    await visible(page.getByText(/This screenshot could not be loaded/)); // the removed one
    await visible(page.getByRole('heading', { name: 'Page has no title' }));
    await page.context().close();
  });
});

describe('small screens', () => {
  it('does not scroll the whole page sideways at 390 px on the main pages', async () => {
    const page = await newPage(390, 844);
    for (const hash of ['/', `/projects/${seeded.projectId}`, `/projects/${seeded.projectId}/new-scan`, `/runs/${seeded.runId}`, `/runs/${seeded.runId}/issues`, `/runs/${seeded.runId}/technical`, `/findings/${seeded.findingId}`, '/help']) {
      await page.goto(`${origin}/#${hash}`);
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${hash} overflows by ${overflow}px`).toBeLessThanOrEqual(1);
    }
    await page.context().close();
  });
});

describe('course ZIP upload and scan states', () => {
  it('inspects an uploaded ZIP without running it, then needs the acknowledgement before a scan can start', async () => {
    const project = h.store.createProject({ name: 'Upload flow project' });
    const page = await newPage();
    await page.goto(`${origin}/#/projects/${project.id}/new-scan`);
    await page.getByLabel('Upload course ZIP').check();
    await page.getByLabel('Or choose a ZIP file').setInputFiles({ name: 'not-a-zip.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
    await visible(page.getByText(/That file is not a ZIP/));
    await page.getByLabel('Or choose a ZIP file').setInputFiles({ name: 'course.zip', mimeType: 'application/zip', buffer: makeZip({ 'imsmanifest.xml': manifest2004(), 'index.html': htmlPage('Uploaded course') }) });
    await page.getByRole('button', { name: 'Upload course' }).click();
    await until(async () => /#\/packages\//.test(page.url()), `navigation to the package page; the page says: ${(await page.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300)}`).catch(async (e) => {
      throw new Error(`${e.message} | now: ${(await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(0, 400)}`);
    });
    await visible(page.getByText('Upload inspected. Nothing has been run yet.')).catch(async (e) => {
      throw new Error(`${e.message.slice(0, 80)} | page: ${(await page.locator('main').innerText()).replace(/s+/g, ' ').slice(0, 300)}`);
    });
    const start = page.getByRole('button', { name: /Scan 1 lesson/ });
    await visible(start);
    await until(async () => !(await start.isEnabled()), 'start disabled until acknowledged');
    await page.getByLabel(/I understand a scan runs/).check();
    await enabled(start);
    expect(runsOf(project.id)).toHaveLength(0); // nothing was queued by looking at it
    await page.context().close();
  });

  it('keeps Enter as "Next" in the course link field, never "Start scan"', async () => {
    const project = h.store.createProject({ name: 'Enter key project' });
    const page = await newPage();
    await page.goto(`${origin}/#/projects/${project.id}/new-scan`);
    await page.getByLabel('Course link').fill(`${origin}/`);
    await page.getByLabel('Course link').press('Enter');
    await visible(page.getByRole('heading', { name: '2. Choose checks' }));
    expect(runsOf(project.id)).toHaveLength(0);
    await page.context().close();
  });

  it('says plainly what happened for failed, cancelled, partial, queued and running scans, and never calls them a pass', async () => {
    const project = h.store.createProject({ name: 'Scan states project' });
    const mkRun = () => h.store.createRun(buildScanConfig({ projectId: project.id, url: new URL('https://course.example.com/states/') }), 'https://course.example.com/states/');
    const failed = mkRun();
    h.store.finishRun(failed.id, { status: 'failed', detail: 'The course page did not load within 30 seconds.' });
    const cancelled = mkRun();
    h.store.finishRun(cancelled.id, { status: 'cancelled' });
    const partial = mkRun();
    h.store.finishRun(partial.id, { status: 'partial', detail: 'Stopped at the screen limit.' });
    const queued = mkRun();
    const page = await newPage();
    const text = async (id: string) => {
      await page.goto(`${origin}/#/runs/${id}`);
      await page.waitForTimeout(500);
      return (await page.locator('.status-card').first().innerText()).replace(/\s+/g, ' ');
    };
    await until(async () => /could not be completed.*did not load within 30 seconds.*Nothing in the course is marked as passed.*Start a new scan of this course/.test(await text(failed.id)), 'failed state text');
    await until(async () => /Scan cancelled.*not tested, never passed.*Evidence collected before cancelling is kept/.test(await text(cancelled.id)), 'cancelled state text');
    await until(async () => /partial results.*Stopped at the screen limit/i.test(await text(partial.id)), 'partial state text');
    await until(async () => /Waiting to start.*One scan runs at a time/.test(await text(queued.id)), 'queued state text');
    const running = h.store.claimNextJob('ui-test-worker', 60_000);
    expect(running).toBeDefined();
    await until(async () => /Scanning the course.*Elapsed \d+:\d\d.*no progress percentage or time estimate/.test(await text(running!.id)), 'running state text');
    expect(await page.getByText(/QA passed|100%/).count()).toBe(0);
    await page.context().close();
  });
});
