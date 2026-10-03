import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { type Browser, type LaunchOptions, chromium } from 'playwright';
import type { CheckResultId, CoverageSummary, Evidence, EvidenceId, EvidenceSink, FindingId, ProviderContext, ReasonCode, RunStatus, ScanRun } from '@cqa/shared';
import { type ArtifactStore, type Logger, type NetworkPolicy, TRAVERSAL_RULES, type Store, newId, nowIso, rulesForEngines } from '@cqa/core';
import { Traversal, type TraversalOutput } from './engines/traversal.js';
import { InitialCapture } from './engines/capture.js';
import { type BlockedConnection, EgressProxy } from './net/egress-proxy.js';

const require = createRequire(import.meta.url);
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
  const ownedRules = rulesForEngines(run.config.engines);

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
    const page = await context.newPage();
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
    store.setRunEnvironment(run.id, { engine: 'chromium', version: browser.version(), userAgent, headless: true }, [
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
    const ctx: ProviderContext = { runId: run.id, config: run.config, budgets: run.config.budgets, viewport, signal: controller.signal, evidence: sink, page };
    const capture = new InitialCapture({ policy: deps.policy, targetUrl, blocked: () => blocked });
    const out = await capture.capture(ctx);

    if (out.state) store.insertState(out.state);
    for (const c of out.checkResults) store.insertCheckResult({ ...c, id: newId<CheckResultId>(), runId: run.id });
    for (const f of out.findings) store.upsertFinding({ ...f, id: newId<FindingId>(), runId: run.id, reviewer: { status: 'open', updatedAt: nowIso() }, createdAt: nowIso() });

    // ---- bounded traversal ----
    let traversal: TraversalOutput | undefined;
    let traversalError: string | undefined;
    if (run.config.engines.traversal) {
      if (out.state && !out.navigationFailed && !out.outOfScope) {
        try {
          const engine = new Traversal({ targetUrl, rootState: out.state, deadline: runStartedAt + run.config.budgets.maxRuntimeMs, blocked: () => blocked });
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

    const budgetsReached: ReasonCode[] = [...(proxy.byteBudgetExceeded ? (['budget_bytes'] as ReasonCode[]) : []), ...(traversal?.budgetsReached ?? [])];
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
    };

    let status: RunStatus = 'completed';
    let reason: ReasonCode | undefined;
    let detail: string | undefined;
    if (out.navigationFailed) {
      status = 'failed';
      reason = out.navigationReason;
      detail = 'The initial page could not be loaded, so page checks were not run.';
    } else if (out.outOfScope || budgetsReached.length || out.errors.length || traversalError || coverage.failedTransitions) {
      status = 'partial';
      reason = out.outOfScope ? 'out_of_scope' : budgetsReached[0] ?? (coverage.failedTransitions ? 'state_unreachable' : 'engine_error');
      const parts = [
        out.outOfScope ? 'The target redirected outside the scan scope.' : '',
        budgetsReached.length ? `Exploration stopped at a scan budget (${budgetsReached.join(', ')}).` : '',
        coverage.failedTransitions ? `${coverage.failedTransitions} action(s) or state restorations failed.` : '',
        traversalError ? `Traversal error: ${traversalError}` : '',
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
  for (const rule of rulesForEngines(run.config.engines)) {
    if (done.has(rule.id)) continue;
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
