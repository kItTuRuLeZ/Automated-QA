import { existsSync } from 'node:fs';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { classifyBrowserError, concurrencyFromEnv } from '@cqa/worker';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';
import { type Harness, createHarness } from './support/harness.js';

describe('classifyBrowserError', () => {
  it('a missing browser executable is "browser_unavailable" with steps the person can follow', () => {
    const err = new Error("browserType.launch: Executable doesn't exist at C:\\Users\\x\\.playwright-browsers\\chromium_headless_shell-1248\\chrome-headless-shell.exe\n╔═══╗");
    const c = classifyBrowserError(err);
    expect(c.reason).toBe('browser_unavailable');
    expect(c.detail).toContain('C:\\Users\\x\\.playwright-browsers\\chromium_headless_shell-1248\\chrome-headless-shell.exe');
    expect(c.detail).toContain('npm run browsers:install');
    expect(c.detail).toContain('PLAYWRIGHT_BROWSERS_PATH');
  });

  it('a browser that closed or crashed under the scan is "browser_crashed"', () => {
    expect(classifyBrowserError(new Error('page.goto: Target page, context or browser has been closed')).reason).toBe('browser_crashed');
    expect(classifyBrowserError(new Error('browser has disconnected')).reason).toBe('browser_crashed');
  });

  it('a Playwright timeout is "timeout"; anything else stays an engine error', () => {
    expect(classifyBrowserError(new Error('locator.click: Timeout 5000ms exceeded.')).reason).toBe('timeout');
    expect(classifyBrowserError(new Error('something else')).reason).toBe('engine_error');
  });
});

describe('concurrencyFromEnv', () => {
  it('defaults to 1, accepts 1–4, and caps larger values', () => {
    expect(concurrencyFromEnv(undefined)).toBe(1);
    expect(concurrencyFromEnv('')).toBe(1);
    expect(concurrencyFromEnv('abc')).toBe(1);
    expect(concurrencyFromEnv('0')).toBe(1);
    expect(concurrencyFromEnv('2.5')).toBe(1);
    expect(concurrencyFromEnv('3')).toBe(3);
    expect(concurrencyFromEnv('99')).toBe(4);
  });
});

describe('worker browser lifecycle', () => {
  let fx: FixtureServer;
  let h: Harness;

  beforeAll(async () => {
    fx = await startFixtureServer();
  });
  afterAll(async () => {
    await fx?.close();
  });
  afterEach(async () => {
    await h?.close();
  });

  const harness = () =>
    createHarness({
      exemptAddresses: [
        { ip: '127.0.0.1', port: fx.port },
        { ip: '127.0.0.1', port: fx.otherPort },
      ],
    });

  it('a missing browser fails the run with an actionable reason, marks checks not tested, and leaves no job or temp files behind', async () => {
    h = harness();
    h.startWorker({ launchBrowser: (opts) => chromium.launch({ ...opts, executablePath: 'C:\\no-such-folder\\chrome.exe' }) });
    const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/healthy/`).id);

    expect(run.status).toBe('failed');
    expect(run.statusReason).toBe('browser_unavailable');
    expect(run.statusDetail).toContain('npm run browsers:install');
    const checks = h.store.listCheckResults(run.id);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.outcome === 'not_tested' && c.reason === 'browser_unavailable')).toBe(true);
    const job = h.store.db.prepare('SELECT state FROM jobs WHERE run_id = ?').get(run.id) as { state: string };
    expect(job.state).toBe('done');
    expect(existsSync(`${h.tmpRoot}/${run.id}`)).toBe(false);
  });

  it('a browser that dies mid-scan ends the run as "browser_crashed" instead of hanging', async () => {
    h = harness();
    h.startWorker({
      launchBrowser: async (opts) => {
        const b = await chromium.launch(opts);
        setTimeout(() => void b.close(), 1_500);
        return b;
      },
    });
    const started = Date.now();
    const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/slow`, { navigationTimeoutMs: 30_000 }).id);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(run.status).toBe('failed');
    expect(run.statusReason).toBe('browser_crashed');
  });

  it('with a limit of 2, two queued scans run at the same time, each in its own browser', async () => {
    h = harness();
    h.startWorker({ concurrency: 2 });
    const a = h.queueScan(`${fx.origin}/slow`, { navigationTimeoutMs: 30_000 });
    const b = h.queueScan(`${fx.origin}/slow`, { navigationTimeoutMs: 30_000 });
    let both = false;
    const deadline = Date.now() + 20_000;
    while (!both && Date.now() < deadline) {
      both = h.store.getRun(a.id)?.status === 'running' && h.store.getRun(b.id)?.status === 'running';
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(both).toBe(true);
    h.store.requestCancel(a.id);
    h.store.requestCancel(b.id);
    expect((await h.waitForTerminal(a.id)).status).toBe('cancelled');
    expect((await h.waitForTerminal(b.id)).status).toBe('cancelled');
  });

  it('by default (limit 1) a second scan waits for the first', async () => {
    h = harness();
    h.startWorker();
    const a = h.queueScan(`${fx.origin}/slow`, { navigationTimeoutMs: 30_000 });
    const b = h.queueScan(`${fx.origin}/slow`, { navigationTimeoutMs: 30_000 });
    const deadline = Date.now() + 20_000;
    while (h.store.getRun(a.id)?.status !== 'running' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 1_000));
    expect(h.store.getRun(b.id)?.status).toBe('queued');
    h.store.requestCancel(a.id);
    h.store.requestCancel(b.id);
    await h.waitForTerminal(a.id);
    await h.waitForTerminal(b.id);
  });
});
