import type { Page, Request, Response } from 'playwright';
import type {
  CaptureProvider,
  CheckOutcome,
  CourseState,
  EngineResult,
  EvidenceId,
  Finding,
  FindingLocation,
  ProviderContext,
  ReasonCode,
  RuleId,
  Severity,
  StateId,
} from '@cqa/shared';
import { type NetworkPolicy, PHASE1_RULES, fingerprint, newId, nowIso, sanitizeText, sanitizeUrl } from '@cqa/core';
import { type NewCheck, type NewFinding, capitalize, check, dedupe, finding, hostOf, truncate } from './helpers.js';
import type { BlockedConnection } from '../net/egress-proxy.js';
import { type PerfSample, collectPerf, detectPlatform } from '../adapters/layout-scripts.js';


export interface CaptureOutput extends EngineResult {
  state?: CourseState;
  /** True when the initial navigation produced no usable page (timeout, network error, blocked). */
  navigationFailed: boolean;
  navigationReason?: ReasonCode;
  /** Page-load sample from the first (cold-cache) navigation, for PERF-001. */
  perf?: PerfSample;
  platform?: 'storyline' | 'unknown';
  outOfScope: boolean;
}

const SETTLE_MS = 2_000;
const HIGH_SEVERITY_TYPES = new Set(['document', 'script', 'stylesheet']);

/**
 * Phase 1 capture: loads the initial page and records title, sanitized final
 * URL, screenshot, uncaught exceptions, console errors, failed requests,
 * policy blocks, redirect scope, and navigation timing.
 */
export class InitialCapture implements CaptureProvider {
  readonly id = 'initial-capture';
  readonly version = '1.0.0';
  readonly rules = PHASE1_RULES;

  constructor(
    private readonly deps: {
      policy: NetworkPolicy;
      targetUrl: string;
      blocked: () => readonly BlockedConnection[];
      /** Resource types reported by a more specific engine (images and media go to MED-001/002). */
      excludeResourceTypes?: readonly string[];
    },
  ) {}

  async capture(ctx: ProviderContext): Promise<CaptureOutput> {
    const started = Date.now();
    const page = ctx.page as Page;
    const redaction = ctx.config.redaction;
    const viewportName = ctx.viewport.name;
    const san = (u: string) => sanitizeUrl(u, redaction);
    const stateId = newId<StateId>();

    const exceptions: Array<{ message: string; stack?: string; at: string }> = [];
    const consoleErrors: Array<{ text: string; location?: string; at: string }> = [];
    const failedRequests: Array<{ url: string; resourceType: string; status?: number; error?: string }> = [];

    page.on('pageerror', (err) => exceptions.push({ message: sanitizeText(err.message, redaction), stack: err.stack ? sanitizeText(err.stack, redaction) : undefined, at: nowIso() }));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const loc = msg.location();
      // Chromium logs a console error for every request our policy blocked; those are NET-002, not course errors.
      if (loc.url && this.isBlockedByUs(loc.url)) return;
      // Chromium also logs every failed resource load; those are reported with more detail by RUN-004 / MED-001 / MED-002.
      if (msg.text().startsWith('Failed to load resource')) return;
      consoleErrors.push({ text: sanitizeText(msg.text(), redaction), location: loc.url ? `${san(loc.url)}:${loc.lineNumber}` : undefined, at: nowIso() });
    });
    let mainRequest: Request | undefined;
    const isMain = (r: Request) => r.isNavigationRequest() && r.frame() === page.mainFrame();
    page.on('response', (res: Response) => {
      const req = res.request();
      if (isMain(req)) return;
      if (this.deps.excludeResourceTypes?.includes(req.resourceType())) return;
      if (res.status() >= 400 && res.headers()['x-cqa-blocked'] !== '1') {
        failedRequests.push({ url: san(req.url()), resourceType: req.resourceType(), status: res.status() });
      }
    });
    page.on('requestfailed', (req) => {
      if (isMain(req)) return;
      if (this.isBlockedByUs(req.url())) return;
      // Requests cancelled by the page itself (AbortController, route change) are not failures.
      if (isAbort(req.failure()?.errorText)) return;
      if (this.deps.excludeResourceTypes?.includes(req.resourceType())) return;
      failedRequests.push({ url: san(req.url()), resourceType: req.resourceType(), error: req.failure()?.errorText ?? 'failed' });
    });
    page.on('request', (req) => {
      if (isMain(req) && !mainRequest) mainRequest = req;
    });

    const checks: NewCheck[] = [];
    const findings: NewFinding[] = [];
    const coverage: EngineResult['coverage'] = [];
    const errors: EngineResult['errors'] = [];
    const evidenceIds: EvidenceId[] = [];

    // ---- navigate ----
    let response: Response | null = null;
    let navError: Error | undefined;
    const navStart = Date.now();
    try {
      response = await page.goto(this.deps.targetUrl, { waitUntil: 'load', timeout: ctx.budgets.navigationTimeoutMs });
    } catch (err) {
      navError = err as Error;
    }
    const navMs = Date.now() - navStart;
    if (ctx.signal.aborted) throw new Error('aborted');
    if (!navError) await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => undefined);
    if (ctx.signal.aborted) throw new Error('aborted');

    const finalUrlRaw = safe(() => page.url()) ?? this.deps.targetUrl;
    const finalUrl = san(finalUrlRaw === 'about:blank' ? this.deps.targetUrl : finalUrlRaw);
    const status = response?.status();
    const location: FindingLocation = { stateId, url: finalUrl, viewportName, browser: 'chromium' };
    const reproBase = [`Open ${san(this.deps.targetUrl)} in Chromium with a ${ctx.viewport.width}×${ctx.viewport.height} CSS-pixel viewport.`];

    // ---- evidence: screenshot (best effort, also on failure) ----
    try {
      const bytes = await page.screenshot({ type: 'png', timeout: 10_000 });
      const artifactId = await ctx.evidence.writeArtifact({ kind: 'screenshot', mime: 'image/png', bytes });
      const ev = await ctx.evidence.addEvidence({ kind: 'screenshot', artifactId, caption: `Initial state at ${viewportName}`, stateId, viewportName, capturedAt: nowIso(), redacted: false });
      evidenceIds.push(ev.id);
    } catch (err) {
      errors.push({ reason: 'engine_error', message: `Screenshot failed: ${(err as Error).message}` });
    }
    const screenshotIds = [...evidenceIds];

    // ---- redirect chain ----
    const chain: string[] = [];
    for (let r: Request | null = response?.request() ?? mainRequest ?? null; r; r = r.redirectedFrom()) chain.unshift(r.url());
    const outOfScopeHop = chain.find((u) => {
      try {
        return !this.deps.policy.inScope(new URL(u), ctx.config.scope).ok;
      } catch {
        return true;
      }
    });

    // ---- RUN-001 ----
    const blockedTarget = this.deps.blocked().some((b) => b.host && hostOf(this.deps.targetUrl) === b.host);
    let navigationReason: ReasonCode | undefined;
    if (navError) navigationReason = blockedTarget ? 'blocked_by_policy' : /timeout/i.test(navError.message) ? 'timeout' : 'navigation_failed';
    const navigationFailed = navError !== undefined;
    const navEvidence = await ctx.evidence.addEvidence({
      kind: 'network_entry',
      caption: 'Initial navigation',
      data: { requestedUrl: san(this.deps.targetUrl), finalUrl, status: status ?? null, redirectChain: chain.map(san), durationMs: navMs, error: navError ? sanitizeText(navError.message.split('\n')[0] ?? '', redaction) : null },
      stateId,
      viewportName,
      capturedAt: nowIso(),
      redacted: true,
    });

    if (navigationFailed) {
      checks.push(check('RUN-001', 'failed', navMs, [navEvidence.id, ...screenshotIds], { stateId, viewportName, reason: navigationReason, reasonDetail: sanitizeText(navError!.message.split('\n')[0] ?? '', redaction) }));
      findings.push(
        finding('RUN-001', location, {
          title: navigationReason === 'timeout' ? 'Initial page did not finish loading within the timeout' : 'Initial page could not be loaded',
          observed: navigationReason === 'timeout' ? `Navigation did not reach the load event within ${ctx.budgets.navigationTimeoutMs} ms.` : `Navigation failed: ${sanitizeText(navError!.message.split('\n')[0] ?? '', redaction)}`,
          expected: 'The course URL loads and reaches the load event.',
          evidenceIds: [navEvidence.id, ...screenshotIds],
          reproductionSteps: reproBase,
          remediation: 'Confirm the URL is published and reachable, and that the server responds within the configured timeout.',
          targetKey: 'navigation',
        }),
      );
    } else if (status !== undefined && status >= 400) {
      checks.push(check('RUN-001', 'failed', navMs, [navEvidence.id, ...screenshotIds], { stateId, viewportName }));
      findings.push(
        finding('RUN-001', location, {
          title: `Initial page returned HTTP ${status}`,
          observed: `The course URL responded with HTTP ${status}.`,
          expected: 'The course URL responds with a successful status.',
          evidenceIds: [navEvidence.id, ...screenshotIds],
          reproductionSteps: reproBase,
          remediation: 'Check the published URL and server configuration.',
          targetKey: `status-${status}`,
        }),
      );
    } else {
      checks.push(check('RUN-001', 'passed', navMs, [navEvidence.id, ...screenshotIds], { stateId, viewportName }));
    }

    // ---- NET-003 redirect scope ----
    if (chain.length <= 1) {
      checks.push(check('NET-003', 'not_applicable', 0, [], { stateId, viewportName }));
    } else if (outOfScopeHop) {
      checks.push(check('NET-003', 'needs_review', 0, [navEvidence.id], { stateId, viewportName }));
      findings.push(
        finding('NET-003', location, {
          title: 'Redirect left the allowed scan scope',
          observed: `The redirect chain reached ${san(outOfScopeHop)}, which is outside the configured scope. Page checks for that destination were not run.`,
          expected: 'Redirects stay within the configured origins and path prefixes, or the scope is widened deliberately.',
          evidenceIds: [navEvidence.id],
          reproductionSteps: reproBase,
          remediation: 'Confirm the redirect is intended. If so, add the destination origin to the scan scope.',
          targetKey: san(outOfScopeHop),
        }),
      );
      coverage.push({ reason: 'out_of_scope', detail: `Redirect to ${san(outOfScopeHop)} is outside the scan scope.`, stateId });
    } else {
      checks.push(check('NET-003', 'passed', 0, [navEvidence.id], { stateId, viewportName }));
    }

    let perf: PerfSample | undefined;
    let platform: 'storyline' | 'unknown' | undefined;
    const pageUsable = !navigationFailed && !outOfScopeHop;
    const skipReason: ReasonCode = outOfScopeHop ? 'out_of_scope' : (navigationReason ?? 'state_unreachable');

    // ---- RUN-005 title, RUN-006 timing ----
    let title: string | undefined;
    if (pageUsable) {
      title = await settledTitle(page);
      const titleEv = await ctx.evidence.addEvidence({ kind: 'text_excerpt', caption: 'Document title', data: { title }, stateId, viewportName, capturedAt: nowIso(), redacted: false });
      if (title) {
        checks.push(check('RUN-005', 'passed', 0, [titleEv.id], { stateId, viewportName }));
      } else {
        checks.push(check('RUN-005', 'failed', 0, [titleEv.id], { stateId, viewportName }));
        findings.push(
          finding('RUN-005', location, {
            title: 'Page has no title',
            observed: 'The document title is empty or missing.',
            expected: 'Each page has a descriptive <title>.',
            evidenceIds: [titleEv.id],
            reproductionSteps: [...reproBase, 'Inspect the <title> element in the document head.'],
            remediation: 'Add a descriptive <title> to the course page.',
            targetKey: 'title',
          }),
        );
      }
      const timing = await page
        .evaluate(() => {
          const e = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
          if (!e) return null;
          return {
            responseEndMs: Math.round(e.responseEnd),
            domContentLoadedMs: Math.round(e.domContentLoadedEventEnd),
            loadEventEndMs: Math.round(e.loadEventEnd),
            durationMs: Math.round(e.duration),
            transferSize: e.transferSize,
            encodedBodySize: e.encodedBodySize,
          };
        })
        .catch(() => null);
      perf = await page.evaluate(collectPerf).catch(() => undefined);
      platform = await page.evaluate(detectPlatform).catch(() => 'unknown' as const);
      if (timing) {
        const ev = await ctx.evidence.addEvidence({
          kind: 'timing',
          caption: 'Navigation timing (single sample; machine, network, and cache dependent)',
          data: { ...timing, workerNavigationMs: navMs },
          stateId,
          viewportName,
          capturedAt: nowIso(),
          redacted: false,
        });
        checks.push(check('RUN-006', 'passed', 0, [ev.id], { stateId, viewportName }));
      } else {
        checks.push(check('RUN-006', 'not_tested', 0, [], { stateId, viewportName, reason: 'engine_error', reasonDetail: 'Navigation Timing entry was not available.' }));
      }
    } else {
      for (const ruleId of ['RUN-005', 'RUN-006'] as const) checks.push(check(ruleId, 'not_tested', 0, [], { stateId, viewportName, reason: skipReason }));
    }

    // ---- RUN-002 exceptions, RUN-003 console, RUN-004 failed requests ----
    // These are observed during loading even when the page itself failed, so
    // they are reported whenever navigation produced a document in scope.
    if (pageUsable || (status !== undefined && !outOfScopeHop)) {
      checks.push(check('RUN-002', exceptions.length ? 'failed' : 'passed', 0, [], { stateId, viewportName, itemsEvaluated: exceptions.length }));
      for (const ex of dedupe(exceptions, (e) => e.message)) {
        const ev = await ctx.evidence.addEvidence({ kind: 'console_entry', caption: 'Uncaught exception', data: { message: ex.message, stack: ex.stack ?? null }, stateId, viewportName, capturedAt: ex.at, redacted: true });
        findings.push(
          finding('RUN-002', location, {
            title: `Uncaught JavaScript exception: ${truncate(ex.message, 120)}`,
            observed: ex.message,
            expected: 'The page loads without uncaught JavaScript exceptions.',
            evidenceIds: [ev.id, ...screenshotIds],
            reproductionSteps: [...reproBase, 'Open the browser developer tools console and reload.', `Observe the exception: ${truncate(ex.message, 200)}`],
            remediation: 'Fix the script error shown in the stack trace, or guard the failing code path.',
            targetKey: ex.message.split('\n')[0],
          }),
        );
      }

      checks.push(check('RUN-003', consoleErrors.length ? 'failed' : 'passed', 0, [], { stateId, viewportName, itemsEvaluated: consoleErrors.length }));
      for (const ce of dedupe(consoleErrors, (c) => c.text)) {
        const ev = await ctx.evidence.addEvidence({ kind: 'console_entry', caption: 'Console error', data: { text: ce.text, location: ce.location ?? null }, stateId, viewportName, capturedAt: ce.at, redacted: true });
        findings.push(
          finding('RUN-003', location, {
            title: `Console error: ${truncate(ce.text, 120)}`,
            observed: ce.text,
            expected: 'No console errors during load. Some console errors are benign; review in context.',
            evidenceIds: [ev.id],
            reproductionSteps: [...reproBase, 'Open the developer tools console and reload.'],
            remediation: 'Investigate the logged error and fix it if it affects the course.',
            targetKey: ce.text.split('\n')[0],
          }),
        );
      }

      checks.push(check('RUN-004', failedRequests.length ? 'failed' : 'passed', 0, [], { stateId, viewportName, itemsEvaluated: failedRequests.length }));
      for (const fr of dedupe(failedRequests, (f) => f.url)) {
        const ev = await ctx.evidence.addEvidence({
          kind: 'network_entry',
          caption: 'Failed request',
          data: { url: fr.url, resourceType: fr.resourceType, status: fr.status ?? null, error: fr.error ?? null },
          stateId,
          viewportName,
          capturedAt: nowIso(),
          redacted: true,
        });
        const what = fr.status ? `HTTP ${fr.status}` : (fr.error ?? 'network error');
        const severity: Severity = HIGH_SEVERITY_TYPES.has(fr.resourceType) ? 'high' : 'medium';
        findings.push(
          finding(
            'RUN-004',
            { ...location, elementDescription: `${fr.resourceType} ${fr.url}` },
            {
              title: `${capitalize(fr.resourceType)} request failed (${what})`,
              observed: `${fr.url} failed with ${what}.`,
              expected: 'All resources the page requests load successfully.',
              evidenceIds: [ev.id, ...screenshotIds],
              reproductionSteps: [...reproBase, 'Open the developer tools Network panel and reload.', `Find the request to ${fr.url}.`],
              remediation: 'Restore the missing resource or remove the reference to it.',
              targetKey: fr.url,
              severity,
            },
          ),
        );
      }
    } else {
      for (const ruleId of ['RUN-002', 'RUN-003', 'RUN-004'] as const) checks.push(check(ruleId, 'not_tested', 0, [], { stateId, viewportName, reason: skipReason }));
    }

    // ---- NET-002 blocked by policy ----
    const blocked = this.deps.blocked().filter((b) => b.host);
    checks.push(check('NET-002', blocked.length ? 'needs_review' : 'passed', 0, [], { stateId, viewportName, itemsEvaluated: blocked.length }));
    for (const b of dedupe(blocked, (x) => `${x.host}:${x.port}`)) {
      const ev = await ctx.evidence.addEvidence({ kind: 'network_entry', caption: 'Blocked by scan policy', data: { url: b.url, reason: b.reason, detail: b.detail }, stateId, viewportName, capturedAt: nowIso(), redacted: true });
      findings.push(
        finding('NET-002', location, {
          title: `Request blocked by scan policy: ${b.host}`,
          observed: `${b.url} was blocked: ${b.detail}`,
          expected: 'Blocked destinations are reviewed; content that depends on them was not verified.',
          evidenceIds: [ev.id],
          reproductionSteps: reproBase,
          remediation: 'If the course legitimately needs this destination, it must be reachable publicly or covered by a future intranet policy.',
          targetKey: `${b.host}:${b.port}`,
        }),
      );
      coverage.push({ reason: b.reason, detail: `Blocked ${b.url}: ${b.detail}`, stateId });
    }

    let state: CourseState | undefined;
    if (!navigationFailed) {
      state = {
        id: stateId,
        runId: ctx.runId,
        url: finalUrl,
        title,
        signature: fingerprint({ ruleId: 'STATE', url: finalUrl, stateKey: 'initial' }),
        openDialogs: [],
        selectedTabs: [],
        depth: 0,
        pathFromRoot: [],
        surfaces: [{ kind: 'document' }],
        viewportName,
        capturedAt: nowIso(),
      };
    }

    return {
      engine: this.id,
      engineVersion: this.version,
      checkResults: checks,
      findings,
      coverage,
      errors,
      durationMs: Date.now() - started,
      state,
      navigationFailed,
      navigationReason,
      perf,
      platform,
      outOfScope: outOfScopeHop !== undefined,
    };
  }

  private isBlockedByUs(url: string): boolean {
    const host = hostOf(url);
    return this.deps.blocked().some((b) => b.host === host);
  }
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}


/** Single-page apps often set the title after load; wait briefly before judging it missing. */
async function settledTitle(page: Page, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const t = (await page.title().catch(() => '')).trim();
    if (t || Date.now() > deadline) return t;
    await page.waitForTimeout(250);
  }
}

export function isAbort(errorText: string | undefined): boolean {
  return errorText === 'net::ERR_ABORTED';
}
