import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { type Browser, type LaunchOptions, chromium } from 'playwright';
import type { BrowserInfo, CheckResult, CheckResultId, CourseState, CoverageSummary, EngineResult, Evidence, EvidenceId, EvidenceSink, Finding, FindingId, ProviderContext, ReasonCode, RunStatus, ScanRun } from '@cqa/shared';
import { DEFAULT_LAYOUT_SETTINGS, applyRetestOutcome, type ArtifactStore, type Logger, type NetworkPolicy, TRAVERSAL_RULES, type Store, newId, nowIso, rulesForEngines } from '@cqa/core';
import { Traversal, type TraversalOutput } from './engines/traversal.js';
import { ContentChecks, type LinkAppearance } from './engines/content.js';
import { BrandChecks } from './engines/brand.js';
import { LinkChecker } from './engines/links.js';
import { AccessibilityChecks } from './engines/accessibility.js';
import { KeyboardChecks } from './engines/keyboard.js';
import { Annotator } from './engines/annotate.js';
import { LayoutChecks } from './engines/layout.js';
import { runViewportPasses } from './engines/viewport-pass.js';
import { InitialCapture } from './engines/capture.js';
import { type BlockedConnection, EgressProxy } from './net/egress-proxy.js';

const require = createRequire(import.meta.url);
let axeCache: string | undefined;
/** axe-core source from the installed package, read once. */
function axeSource(): string {
  axeCache ??= readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  return axeCache;
}

const PLAYWRIGHT_VERSION = (require('playwright/package.json') as { version: string }).version;

export interface WorkerDeps {
  store: Store;
  artifacts: ArtifactStore;
  policy: NetworkPolicy;
  tmpRoot: string;
  log: Logger;
  workerId: string;
  leaseMs?: number;
  heartbeatMs?: number;
}

/** Chromium flags that keep traffic inside the egress proxy. The sandbox stays enabled. */
export const CHROMIUM_ARGS = ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp'];

/**
 * Launch options for scan browsers: sandbox on, all traffic through the
 * per-run egress proxy (including loopback, via '<-loopback>'), QUIC off,
 * and WebRTC restricted to proxied connections.
 */
export function chromiumLaunchOptions(proxy: { port: number; username: string; password: string }, downloadsPath: string): LaunchOptions {
  return {
    headless: true,
    chromiumSandbox: true,
    args: CHROMIUM_ARGS,
    proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: '<-loopback>', username: proxy.username, password: proxy.password },
    downloadsPath,
  };
}

type AbortReason = 'cancelled' | 'budget_runtime' | 'worker_lost';

/**
 * Executes one claimed run end to end. Always finishes the run with a terminal
 * status and cleans up the browser, proxy, and temp directory.
 */
export async function runScan(deps: WorkerDeps, run: ScanRun): Promise<RunStatus> {
  const status = await runScanInner(deps, run);
  if (run.retestOfRunId) {
    try {
      applyRetestOutcome(deps.store, run.id);
    } catch (err) {
      console.error("retest outcome could not be applied", err);
    }
  }
  return status;
}

async function runScanInner(deps: WorkerDeps, run: ScanRun): Promise<RunStatus> {
  const { store, log } = deps;
  const leaseMs = deps.leaseMs ?? 30_000;
  const heartbeatMs = deps.heartbeatMs ?? 1_000;
  const targetUrl = store.getRunTargetUrl(run.id)!;
  const controller = new AbortController();
  const abort = (reason: AbortReason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  let browser: Browser | undefined;
  let proxy: EgressProxy | undefined;
  const tmpDir = path.join(deps.tmpRoot, run.id);
  const blocked: BlockedConnection[] = [];

  controller.signal.addEventListener('abort', () => {
    // Closing the browser interrupts any in-flight navigation immediately.
    void browser?.close().catch(() => undefined);
    void proxy?.stop();
  });

  const heartbeat = setInterval(() => {
    try {
      const hb = store.heartbeat(run.id, deps.workerId, leaseMs);
      if (hb.cancelRequested) abort('cancelled');
      else if (hb.leaseLost) abort('worker_lost');
    } catch (err) {
      log.error({ err, runId: run.id }, 'heartbeat failed');
    }
  }, heartbeatMs);
  const runStartedAt = Date.now();
  // Traversal stops itself at the runtime budget; this hard stop is a backstop.
  const runtimeTimer = setTimeout(() => abort('budget_runtime'), run.config.budgets.maxRuntimeMs + 30_000);
  const profile = run.config.profile;
  const excludedRules = new Map((profile?.ruleExclusions ?? []).map((x) => [x.ruleId, x.reason]));
  const severityOverrides = new Map((profile?.severityOverrides ?? []).map((x) => [x.ruleId, x]));
  const ownedRules = rulesForEngines(run.config.engines).filter((r) => !excludedRules.has(r.id));
  // Rules a client profile switches off are shown as not applicable with the reason, never as passed.
  for (const rule of rulesForEngines(run.config.engines)) {
    const why = excludedRules.get(rule.id);
    if (why) store.insertCheckResult({ id: newId<CheckResultId>(), runId: run.id, ruleId: rule.id, outcome: 'not_applicable', reason: 'excluded_by_profile', reasonDetail: `Switched off by client profile "${profile?.name}": ${why}`, durationMs: 0, evidenceIds: [], executedAt: nowIso() });
  }

  const persistCheckNotTested = (reason: ReasonCode, detail?: string) => {
    for (const rule of ownedRules) {
      store.insertCheckResult({ id: newId<CheckResultId>(), runId: run.id, ruleId: rule.id, outcome: 'not_tested', reason, reasonDetail: detail, durationMs: 0, evidenceIds: [], executedAt: nowIso() });
    }
  };

  try {
    // Re-validate at run time: DNS may differ from submission time.
    const decision = await deps.policy.validateTarget(targetUrl, run.config.scope);
    if (!decision.ok) {
      persistCheckNotTested(decision.reason, decision.detail);
      store.finishRun(run.id, { status: 'failed', reason: decision.reason, detail: decision.detail });
      log.warn({ runId: run.id, reason: decision.reason }, 'target rejected at run start; browser not launched');
      return 'failed';
    }
    if (store.isCancelRequested(run.id)) abort('cancelled');
    if (controller.signal.aborted) throw new Error('aborted');

    mkdirSync(tmpDir, { recursive: true });
    proxy = new EgressProxy({ policy: deps.policy, scope: run.config.scope, maxTotalBytes: run.config.budgets.maxTotalBytes, onBlocked: (b) => blocked.push(b) });
    const proxyPort = await proxy.start();

    const viewport = run.config.viewports[0]!;
    browser = await chromium.launch(chromiumLaunchOptions({ port: proxyPort, username: proxy.username, password: proxy.password }, tmpDir));
    if (controller.signal.aborted) throw new Error('aborted');
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.deviceScaleFactor,
      isMobile: viewport.isMobile,
      hasTouch: viewport.hasTouch,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    // tsx/esbuild may wrap serialized functions with a `__name` helper; define a no-op so page.evaluate works.
    await context.addInitScript({ content: 'globalThis.__name ??= (fn) => fn;' });
    // axe-core is injected into every frame before page scripts run (also works under a restrictive CSP).
    if (run.config.engines.accessibility) await context.addInitScript({ content: axeSource() });
    const page = await context.newPage();
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
    const browserInfo: BrowserInfo = { engine: 'chromium', version: browser.version(), userAgent, headless: true };
    store.setRunEnvironment(run.id, browserInfo, [
      { name: 'course-qa-automation', version: '0.1.0' },
      { name: 'playwright', version: PLAYWRIGHT_VERSION },
      { name: 'chromium', version: browser.version() },
    ]);

    const sink: EvidenceSink = {
      addEvidence: async (e) => {
        const ev: Evidence = { ...e, id: newId<EvidenceId>(), runId: run.id };
        store.insertEvidence(ev);
        return ev;
      },
      writeArtifact: async (a) => deps.artifacts.write(run.id, a).id,
    };
    // Images and media failures are reported with element context by MED-001/MED-002 instead of RUN-004.
    const excludeResourceTypes = [...(run.config.engines.media ? ['image', 'media'] : []), ...(run.config.engines.layout ? ['font'] : [])];
    const ctx: ProviderContext = { runId: run.id, config: run.config, budgets: run.config.budgets, viewport, signal: controller.signal, evidence: sink, page };
    const capture = new InitialCapture({ policy: deps.policy, targetUrl, blocked: () => blocked, excludeResourceTypes });
    const out = await capture.capture(ctx);

    if (out.state) store.insertState(out.state);
    for (const c of out.checkResults) store.insertCheckResult({ ...c, id: newId<CheckResultId>(), runId: run.id });
    for (const f of out.findings) store.upsertFinding({ ...f, id: newId<FindingId>(), runId: run.id, reviewer: { status: 'open', updatedAt: nowIso() }, createdAt: nowIso() });

    // ---- per-state content checks (links collected, media, text) ----
    const persistResults = (r: { checkResults?: Array<Omit<CheckResult, 'id' | 'runId'>>; checks?: Array<Omit<CheckResult, 'id' | 'runId'>>; findings: Array<Omit<Finding, 'id' | 'runId' | 'reviewer' | 'createdAt'>> }) => {
      for (const c of r.checkResults ?? r.checks ?? []) if (!excludedRules.has(c.ruleId)) store.insertCheckResult({ ...c, id: newId<CheckResultId>(), runId: run.id });
      for (const f of r.findings) {
        if (excludedRules.has(f.ruleId)) continue;
        const ov = severityOverrides.get(f.ruleId);
        const withOverride = ov && ov.severity !== f.severity ? { ...f, severityOverride: { from: f.severity, to: ov.severity, reviewer: `client profile "${profile?.name}"`, reason: ov.reason, at: nowIso() } } : f;
        store.upsertFinding({ ...withOverride, id: newId<FindingId>(), runId: run.id, reviewer: { status: 'open', updatedAt: nowIso() }, createdAt: nowIso() });
      }
    };
    const contentEngine = new ContentChecks();
    const contentOn = run.config.engines.links || run.config.engines.media || run.config.engines.content;
    const linkAppearances: LinkAppearance[] = [];
    const contentErrors: string[] = [];
    const layoutEngine =
      run.config.engines.layout || run.config.engines.performance
        ? new LayoutChecks({
            courseUrl: targetUrl,
            browser: () => browserInfo,
            settings: run.config.layout ?? DEFAULT_LAYOUT_SETTINGS,
            baselines: {
              lookup: (key) => store.getBaseline(run.projectId, targetUrl, key)?.artifactId,
              read: (id) => {
                const rec = store.getArtifact(id);
                try {
                  return rec ? readFileSync(deps.artifacts.absolutePath(rec)) : undefined;
                } catch {
                  return undefined;
                }
              },
            },
          })
        : undefined;
    // Storyline is a fixed-size stage that scales instead of reflowing: other screen sizes and the 320 px reflow check do not apply.
    const nonResponsive = out.platform === 'storyline' && !run.config.layout?.testNonResponsive;
    const SKIP_SIZE_TEXT = 'Storyline output is a fixed-size stage that is not designed to be responsive, so this screen size was not tested. Use "test other screen sizes anyway" to override.';
    const a11yEngine = new AccessibilityChecks();
    const keyboardEngine = new KeyboardChecks();
    const annotator = new Annotator();
    const brandEngine = run.config.engines.brand && profile ? new BrandChecks(profile) : undefined;
    const onStateReady = async (state: CourseState, repro: string[], pathKey = '') => {
      const guarded = async (fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (err) {
          if (controller.signal.aborted) throw err;
          contentErrors.push(truncateLine((err as Error).message));
        }
      };
      // Run every engine first, then outline the affected elements while the page still shows this state, then save.
      const batches: Array<Parameters<typeof persistResults>[0]> = [];
      if (contentOn) {
        await guarded(async () => {
          const r = await contentEngine.checkState({ ...ctx, state }, state, repro);
          batches.push(r);
          linkAppearances.push(...r.links);
        });
      }
      if (run.config.engines.accessibility) await guarded(async () => void batches.push(await a11yEngine.checkState({ ...ctx, state }, state, repro, { skipReflow: nonResponsive ? 'Storyline output is a fixed-size stage that is not designed to reflow at narrow widths, so the 320 px reflow check does not apply.' : undefined })));
      if (run.config.engines.keyboard) await guarded(async () => void batches.push(await keyboardEngine.journey({ ...ctx, state }, state, repro)));
      if (layoutEngine && run.config.engines.layout) await guarded(async () => void batches.push(await layoutEngine.checkState({ ...ctx, state }, state, repro, pathKey)));
      if (brandEngine) await guarded(async () => void batches.push(await brandEngine.checkState({ ...ctx, state }, state, repro)));
      await guarded(async () => annotator.annotateFindings({ ...ctx, state }, state.id, batches.flatMap((b) => b.findings)));
      for (const b of batches) persistResults(b);
    };
    const pageUsable = Boolean(out.state) && !out.navigationFailed && !out.outOfScope;
    // Page-load evidence comes from the first, cold-cache navigation.
    if (layoutEngine && run.config.engines.performance && pageUsable && out.state) persistResults(await layoutEngine.perf(ctx, out.state, out.perf, [`Open ${targetUrl}`]));

    // ---- bounded traversal ----
    let traversal: TraversalOutput | undefined;
    let traversalError: string | undefined;
    if (run.config.engines.traversal) {
      if (out.state && !out.navigationFailed && !out.outOfScope) {
        try {
          const engine = new Traversal({
            targetUrl,
            rootState: out.state,
            deadline: runStartedAt + run.config.budgets.maxRuntimeMs,
            blocked: () => blocked,
            excludeResourceTypes,
            onStateReady,
            keyboardPass: run.config.engines.keyboard ? (input) => keyboardEngine.activate(input) : undefined,
          });
          traversal = await engine.explore({ ...ctx, state: out.state }, (state) => store.insertState(state));
          store.insertActions(traversal.actions);
          for (const c of traversal.checkResults) store.insertCheckResult({ ...c, id: newId<CheckResultId>(), runId: run.id });
          for (const f of traversal.findings) store.upsertFinding({ ...f, id: newId<FindingId>(), runId: run.id, reviewer: { status: 'open', updatedAt: nowIso() }, createdAt: nowIso() });
        } catch (err) {
          if (controller.signal.aborted) throw err;
          traversalError = truncateLine((err as Error).message);
          log.error({ err, runId: run.id }, 'traversal failed');
          for (const rule of TRAVERSAL_RULES) store.insertCheckResult({ id: newId<CheckResultId>(), runId: run.id, ruleId: rule.id, outcome: 'error', reason: 'engine_error', reasonDetail: traversalError, durationMs: 0, evidenceIds: [], executedAt: nowIso() });
        }
      } else {
        const why: ReasonCode = out.outOfScope ? 'out_of_scope' : (out.navigationReason ?? 'state_unreachable');
        for (const rule of TRAVERSAL_RULES) store.insertCheckResult({ id: newId<CheckResultId>(), runId: run.id, ruleId: rule.id, outcome: 'not_tested', reason: why, durationMs: 0, evidenceIds: [], executedAt: nowIso() });
      }
    }

    // Without traversal, content checks run once on the captured page.
    if (!run.config.engines.traversal && pageUsable && out.state) await onStateReady(out.state, [`Open ${targetUrl} in Chromium.`], '');

    // ---- the same screens at the other viewports (separate contexts with their own device settings) ----
    if (layoutEngine && run.config.engines.layout && pageUsable && out.state && run.config.viewports.length > 1 && nonResponsive) {
      for (const v of run.config.viewports.slice(1)) {
        persistResults({
          checks: (['LAY-001', 'LAY-002', 'LAY-003', 'LAY-004', 'LAY-005'] as const).map((id) => ({ ruleId: id, stateId: out.state!.id, viewportName: v.name, outcome: 'not_applicable' as const, reasonDetail: SKIP_SIZE_TEXT, durationMs: 0, evidenceIds: [], executedAt: nowIso() })),
          findings: [],
        });
      }
    } else if (layoutEngine && run.config.engines.layout && pageUsable && out.state && run.config.viewports.length > 1) {
      try {
        await runViewportPasses({
          browser,
          run,
          targetUrl,
          replay: traversal?.replay ?? [{ stateId: out.state.id, steps: [] }],
          states: traversal?.states ?? [out.state],
          ctx,
          layout: layoutEngine,
          annotator,
          persist: persistResults,
          deadline: runStartedAt + run.config.budgets.maxRuntimeMs,
        });
      } catch (err) {
        if (controller.signal.aborted) throw err;
        contentErrors.push(`Viewport checks failed: ${truncateLine((err as Error).message)}`);
      }
    }

    // ---- link destinations (once per run, from every reached state) ----
    let linkCoverage: EngineResult['coverage'] = [];
    if (run.config.engines.links && pageUsable) {
      const checker = new LinkChecker(deps.policy, run.config);
      const policyLinks = applyLinkPolicy(linkAppearances, run.config.skipExternalLinks ? { checkExternalLinks: false, excludedUrlPatterns: profile?.linkPolicy.excludedUrlPatterns ?? [] } : profile?.linkPolicy, targetUrl);
      const lr = await checker.checkAll(policyLinks.kept, sink, run.id);
      if (policyLinks.skipped) lr.checkResults?.push?.({ ruleId: 'LNK-001', outcome: 'not_applicable', reason: 'excluded_by_profile', reasonDetail: `${policyLinks.skipped} link(s) were not requested: ${run.config.skipExternalLinks ? 'uploaded packages are not allowed to make outside requests' : `the link policy in client profile "${profile?.name}" excludes them`}.`, durationMs: 0, evidenceIds: [], executedAt: nowIso() } as never);
      persistResults(lr);
      linkCoverage = lr.coverage;
    }

    // Every owned rule ends with a result or a reason; never an implicit pass.
    const have = new Set(store.listCheckResults(run.id).map((c) => c.ruleId));
    const fallbackReason: ReasonCode = out.outOfScope ? 'out_of_scope' : out.navigationFailed ? (out.navigationReason ?? 'navigation_failed') : 'state_unreachable';
    for (const rule of ownedRules) {
      if (!have.has(rule.id)) store.insertCheckResult({ id: newId<CheckResultId>(), runId: run.id, ruleId: rule.id, outcome: 'not_tested', reason: fallbackReason, reasonDetail: 'This check did not run for this scan.', durationMs: 0, evidenceIds: [], executedAt: nowIso() });
    }

    const budgetsReached: ReasonCode[] = [...(proxy.byteBudgetExceeded ? (['budget_bytes'] as ReasonCode[]) : []), ...(traversal?.budgetsReached ?? []), ...linkCoverage.map((c) => c.reason)];
    const actions = traversal?.actions ?? [];
    const coverage: CoverageSummary = {
      statesReached: traversal?.states.length ?? (out.state ? 1 : 0),
      actionsAttempted: actions.filter((a) => a.outcome !== 'skipped' && a.outcome !== 'not_attempted').length,
      actionsSkipped: actions.filter((a) => a.outcome === 'skipped' || a.outcome === 'not_attempted').length,
      inaccessibleFrames: traversal?.inaccessibleFrames ?? 0,
      unsupportedSurfaces: traversal?.unsupportedSurfaces ?? 0,
      failedTransitions: traversal?.failedTransitions ?? 0,
      budgetsReached,
      blockedRequests: new Set(blocked.filter((b) => b.host).map((b) => b.url)).size,
      platform: out.platform,
    };

    // Screens that could not be reached again at another viewport leave that viewport only partly checked.
    const viewportGaps = run.config.engines.layout ? store.listCheckResults(run.id).filter((c) => c.ruleId === 'LAY-001' && c.reason === 'state_unreachable').length : 0;

    let status: RunStatus = 'completed';
    let reason: ReasonCode | undefined;
    let detail: string | undefined;
    if (out.navigationFailed) {
      status = 'failed';
      reason = out.navigationReason;
      detail = 'The initial page could not be loaded, so page checks were not run.';
    } else if (out.outOfScope || budgetsReached.length || out.errors.length || traversalError || coverage.failedTransitions || contentErrors.length || viewportGaps) {
      status = 'partial';
      reason = out.outOfScope ? 'out_of_scope' : budgetsReached[0] ?? (coverage.failedTransitions || viewportGaps ? 'state_unreachable' : 'engine_error');
      const parts = [
        out.outOfScope ? 'The target redirected outside the scan scope.' : '',
        budgetsReached.length ? `Exploration stopped at a scan budget (${budgetsReached.join(', ')}).` : '',
        coverage.failedTransitions ? `${coverage.failedTransitions} action(s) or state restorations failed.` : '',
        traversalError ? `Traversal error: ${traversalError}` : '',
        viewportGaps ? `${viewportGaps} screen(s) could not be reached again at a smaller viewport and were not checked there.` : '',
        contentErrors.length ? `Content checks failed on ${contentErrors.length} state(s): ${contentErrors[0]}` : '',
        ...out.errors.map((e) => e.message),
      ].filter(Boolean);
      detail = parts.join(' ') || 'Some content could not be checked.';
    }
    store.finishRun(run.id, { status, reason, detail, coverage });
    return status;
  } catch (err) {
    const why = (controller.signal.reason as AbortReason | undefined) ?? undefined;
    if (why === 'cancelled') {
      recordUnfinished(store, run.id, 'cancelled');
      store.finishRun(run.id, { status: 'cancelled', reason: 'cancelled', detail: 'Cancelled by the user. Checks not yet run are marked not tested.' });
      return 'cancelled';
    }
    if (why === 'budget_runtime') {
      recordUnfinished(store, run.id, 'budget_runtime');
      const partial = store.listCheckResults(run.id).some((c) => c.outcome !== 'not_tested');
      store.finishRun(run.id, { status: partial ? 'partial' : 'failed', reason: 'budget_runtime', detail: `Stopped at the ${run.config.budgets.maxRuntimeMs} ms runtime budget.` });
      return partial ? 'partial' : 'failed';
    }
    if (why === 'worker_lost') {
      log.error({ runId: run.id }, 'lease lost; abandoning run');
      return 'failed';
    }
    log.error({ err, runId: run.id }, 'scan failed');
    recordUnfinished(store, run.id, 'engine_error', (err as Error).message.split('\n')[0]);
    store.finishRun(run.id, { status: 'failed', reason: 'engine_error', detail: (err as Error).message.split('\n')[0] });
    return 'failed';
  } finally {
    clearInterval(heartbeat);
    clearTimeout(runtimeTimer);
    await browser?.close().catch(() => undefined);
    await proxy?.stop().catch(() => undefined);
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Every Phase 1 rule without a result gets `not_tested` (or `error`) with a reason, never an implicit pass. */
function recordUnfinished(store: Store, runId: ScanRun['id'], reason: ReasonCode, detail?: string): void {
  const run = store.getRun(runId)!;
  const done = new Set(store.listCheckResults(runId).map((c) => c.ruleId));
  const excluded = new Set((run.config.profile?.ruleExclusions ?? []).map((x) => x.ruleId));
  for (const rule of rulesForEngines(run.config.engines)) {
    if (done.has(rule.id) || excluded.has(rule.id)) continue;
    store.insertCheckResult({
      id: newId<CheckResultId>(),
      runId,
      ruleId: rule.id,
      outcome: reason === 'engine_error' ? 'error' : 'not_tested',
      reason,
      reasonDetail: detail,
      durationMs: 0,
      evidenceIds: [],
      executedAt: nowIso(),
    });
  }
}

function truncateLine(s: string): string {
  const line = s.split('\n')[0] ?? '';
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

/** Applies a client profile's link policy; skipped links are counted so the report can say so. */
function applyLinkPolicy(links: LinkAppearance[], policy: { checkExternalLinks: boolean; excludedUrlPatterns: string[] } | undefined, courseUrl: string): { kept: LinkAppearance[]; skipped: number } {
  if (!policy || (policy.checkExternalLinks && policy.excludedUrlPatterns.length === 0)) return { kept: links, skipped: 0 };
  let origin = '';
  try {
    origin = new URL(courseUrl).origin;
  } catch {
    /* keep empty */
  }
  const patterns = policy.excludedUrlPatterns.map((p) => p.toLowerCase());
  const kept = links.filter((l) => {
    const href = String((l.link as { href?: string }).href ?? '');
    if (patterns.some((p) => href.toLowerCase().includes(p))) return false;
    if (!policy.checkExternalLinks) {
      try {
        if (new URL(href).origin !== origin) return false;
      } catch {
        return true;
      }
    }
    return true;
  });
  return { kept, skipped: links.length - kept.length };
}
