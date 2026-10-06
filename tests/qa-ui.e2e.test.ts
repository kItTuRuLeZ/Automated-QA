import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProjectId } from '@cqa/shared';
import { QaStore, buildScanConfig, seedStarterLibrary } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
import { type Harness, createHarness } from './support/harness.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });
const WEB_DIST = path.resolve(import.meta.dirname, '../apps/web/dist');
const until = (check: () => Promise<boolean>) => vi.waitFor(async () => { if (!(await check())) throw new Error('not yet'); }, { timeout: 12_000, interval: 100 });

let h: Harness;
let app: ReturnType<typeof buildApp>;
let browser: Browser;
let origin = '';
let runId = '';

beforeAll(async () => {
  const hosts: string[] = [];
  const origins: string[] = [];
  const probe = createHarness();
  app = buildApp({ store: probe.store, artifacts: probe.artifacts, policy: probe.policy, allowedHosts: hosts, allowedOrigins: origins, webDist: WEB_DIST });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  hosts.push(`127.0.0.1:${port}`);
  origins.push(`http://127.0.0.1:${port}`);
  origin = `http://127.0.0.1:${port}`;
  await app.close();
  await probe.close();

  h = createHarness({ exemptAddresses: [{ ip: '127.0.0.1', port }] });
  app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: hosts, allowedOrigins: origins, webDist: WEB_DIST, packages: { dir: mkdtempSync(path.join(tmpdir(), 'cqa-qaui-')), port: port + 1 } });
  await app.listen({ host: '127.0.0.1', port });

  const qa = new QaStore(h.store.db);
  seedStarterLibrary(qa);
  const project = h.store.createProject({ name: 'QA UI project' });
  const run = h.store.createRun(buildScanConfig({ projectId: project.id as ProjectId, url: new URL('https://course.example.com/') }), 'https://course.example.com/');
  runId = run.id;
  const unit = (id: string, title: string, visited: boolean) => ({ id, kind: 'screen' as const, title, titleIsFallback: false, source: 'runtime' as const, confidence: 'high' as const, order: 0, ...(visited ? { visitedAt: new Date().toISOString() } : {}) });
  qa.ensureProgress(run.id, 'running');
  qa.addUnits(run.id, [unit('u-bad', 'Lesson with a broken tab', true), unit('u-ok', 'Lesson that passed', true), unit('u-never', 'Lesson never opened', false)]);
  const base = { runId: run.id, definitionVersion: 1, trace: [], evidenceIds: [], scope: 'functional' as const };
  qa.insertExecution({ ...base, definitionId: 'TAB-01', unitId: 'u-bad', status: 'failed', reason: 'The panel did not appear.', expected: 'Panel shows', actual: 'Nothing changed' });
  qa.insertExecution({ ...base, definitionId: 'TAB-01', unitId: 'u-ok', status: 'passed' });
  qa.recount(run.id);
  qa.setStage(run.id, 'completed_with_gaps');
  h.store.finishRun(run.id, { status: 'completed' });
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
  await app?.close();
  await h?.close();
});

describe('functional QA screens', () => {
  it('lists the starter test library with automation classes and a nav link', async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${origin}/#/library`);
    await page.getByRole('heading', { name: /test library/i }).first().waitFor();
    await until(async () => /ACC-01/.test(await page.locator('main').innerText()));
    expect(await page.getByRole('link', { name: 'Test library' }).count()).toBe(1);
    expect(await page.content()).toMatch(/Automated/);
    expect(await page.content()).toMatch(/starter baseline/i);
    await page.close();
  });

  it('shows the Screens tab with the failing screen first, and never lists an unopened screen as passed', async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${origin}/#/runs/${runId}/screens`);
    await until(async () => /Issues found/.test(await page.locator('main').innerText()));
    const text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    expect(text).toMatch(/Issues found/);
    expect(text).toMatch(/Lesson never opened/);
    await page.getByLabel(/Passed automated checks/).check();
    await until(async () => /Lesson that passed/.test(await page.locator('main').innerText()));
    expect(await page.locator('main').innerText()).not.toMatch(/Lesson never opened/);
    await page.close();
  });

  it('shows coverage with its denominators and not a single score', async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${origin}/#/runs/${runId}/coverage`);
    await page.getByRole('heading', { name: /What this scan covered/i }).waitFor({ timeout: 15_000 });
    const t = await page.locator('main').innerText();
    // Denominators are explicit: each percentage appears beside its "X of Y" count, never as a lone score
    expect(t).toMatch(/2 of 2 mapped automated checks \(100%\)/);
    expect(t).toMatch(/1 of 2 executed checks \(50%\)/);
    // When total is not known (e.g. runtime-only discovery), no false 100% visit is claimed
    expect(t).toMatch(/no visit percentage/i);
    await page.close();
  });
});







