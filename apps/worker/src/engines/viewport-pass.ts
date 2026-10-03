import type { Browser, Page } from 'playwright';
import type { CourseState, ProviderContext, ScanRun, Viewport } from '@cqa/shared';
import type { Annotator } from './annotate.js';
import { type NewCheck, type NewFinding, check, truncate } from './helpers.js';
import type { LayoutChecks } from './layout.js';
import type { ReplayPath } from './traversal.js';

const LAYOUT_RULES = ['LAY-001', 'LAY-002', 'LAY-003', 'LAY-004', 'LAY-005'] as const;
const STEP_TIMEOUT_MS = 4_000;

export interface ViewportPassInput {
  browser: Browser;
  run: ScanRun;
  targetUrl: string;
  replay: ReplayPath[];
  states: CourseState[];
  ctx: ProviderContext;
  layout: LayoutChecks;
  annotator: Annotator;
  persist: (r: { checks: NewCheck[]; findings: NewFinding[] }) => void;
  deadline: number;
}

async function settle(page: Page, navTimeout: number): Promise<void> {
  await page.waitForLoadState('load', { timeout: navTimeout }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: 1_500 }).catch(() => undefined);
  await page.waitForTimeout(300);
}

/**
 * Re-checks the first reached screens at every viewport after the primary one,
 * in a fresh browser context with that viewport's device settings. Screens are
 * reached again by replaying the same actions; if a layout hides a control
 * (for example a menu on mobile) the screen is reported as not reachable at
 * that size, never as passed.
 */
export async function runViewportPasses(input: ViewportPassInput): Promise<void> {
  const { run, ctx } = input;
  const settings = run.config.layout;
  if (!settings) return;
  const extra = run.config.viewports.slice(1);
  const selected = input.replay.slice(0, settings.maxStatesPerViewport);
  for (const v of extra) {
    if (ctx.signal.aborted) throw new Error('aborted');
    await passFor(input, v, selected);
  }
}

async function passFor(input: ViewportPassInput, v: Viewport, selected: ReplayPath[]): Promise<void> {
  const { run, ctx } = input;
  const navTimeout = run.config.budgets.navigationTimeoutMs;
  const context = await input.browser.newContext({
    viewport: { width: v.width, height: v.height },
    deviceScaleFactor: v.deviceScaleFactor,
    isMobile: v.isMobile,
    hasTouch: v.hasTouch,
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  try {
    await context.addInitScript({ content: 'globalThis.__name ??= (fn) => fn;' });
    const page = await context.newPage();
    for (const r of selected) {
      if (ctx.signal.aborted) throw new Error('aborted');
      const state = input.states.find((s) => s.id === r.stateId);
      if (!state) continue;
      const base = { stateId: state.id, viewportName: v.name };
      if (Date.now() > input.deadline) {
        input.persist({ checks: LAYOUT_RULES.map((id) => check(id, 'not_tested', 0, [], { ...base, reason: 'budget_runtime', reasonDetail: `Time limit reached before ${v.name} could be checked.` })), findings: [] });
        continue;
      }
      try {
        await page.goto(input.targetUrl, { waitUntil: 'load', timeout: navTimeout });
        await settle(page, navTimeout);
        for (const step of r.steps) {
          if (step.kind === 'navigate' && step.rawHref) await page.goto(step.rawHref, { waitUntil: 'load', timeout: navTimeout });
          else if (step.locator) await page.locator(step.locator).first().click({ timeout: STEP_TIMEOUT_MS });
          else throw new Error(`No way to repeat "${step.description}"`);
          await settle(page, navTimeout);
        }
      } catch (err) {
        const detail = `Could not reach this screen at ${v.name} (${v.width}×${v.height}) by repeating the same actions: ${truncate((err as Error).message, 140)}`;
        input.persist({ checks: LAYOUT_RULES.map((id) => check(id, 'not_tested', 0, [], { ...base, reason: 'state_unreachable', reasonDetail: detail })), findings: [] });
        continue;
      }
      const vctx: ProviderContext = { ...ctx, page, viewport: v, state };
      const repro = [`Open ${input.targetUrl}`, ...r.steps.map((s) => `Activate ${s.description}.`)];
      const result = await input.layout.checkState(vctx, state, repro, r.steps.map((s) => s.description).join(' > '));
      await input.annotator.annotateFindings(vctx, state.id, result.findings).catch(() => undefined);
      input.persist(result);
    }
  } finally {
    await context.close().catch(() => undefined);
  }
}
