import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import type { EngineResult, EvidenceId, EvidenceSink, FindingOccurrence, ReasonCode, ScanConfig } from '@cqa/shared';
import { type NetworkPolicy, effectivePort, nowIso, sanitizeUrl } from '@cqa/core';
import type { LinkAppearance } from './content.js';
import { type NewCheck, type NewFinding, check, finding, truncate } from './helpers.js';

const USER_AGENT = 'CourseQA-LinkCheck/0.1 (+local QA scan)';
const CONCURRENCY = 4;

export type LinkVerdict = 'ok' | 'broken' | 'restricted' | 'unverified';

export interface LinkResult {
  url: string;
  verdict: LinkVerdict;
  status?: number;
  method?: 'HEAD' | 'GET';
  chain: string[];
  error?: string;
  reason?: ReasonCode;
  durationMs: number;
}

/**
 * Checks link destinations from the worker process. Every hop is validated
 * by the same network policy and connected to the validated IP (pinned), so
 * redirects cannot reach private addresses. Bodies are never downloaded:
 * HEAD first, then GET with the response closed as soon as headers arrive.
 */
export class LinkChecker {
  constructor(
    private readonly policy: NetworkPolicy,
    private readonly config: ScanConfig,
  ) {}

  async checkOne(raw: string): Promise<LinkResult> {
    const started = Date.now();
    const chain: string[] = [];
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { url: raw, verdict: 'unverified', chain, error: 'Invalid URL', reason: 'engine_error', durationMs: 0 };
    }
    for (let hop = 0; hop <= this.config.budgets.maxRedirects; hop++) {
      chain.push(url.toString());
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return { url: raw, verdict: 'unverified', chain, error: `Redirected to unsupported scheme ${url.protocol}`, reason: 'blocked_by_policy', durationMs: Date.now() - started };
      if (url.username || url.password) return { url: raw, verdict: 'unverified', chain, error: 'URL contains credentials', reason: 'blocked_by_policy', durationMs: Date.now() - started };
      const port = effectivePort(url);
      const resolved = await this.policy.resolveAllowed(url.hostname, port);
      if (!resolved.ok) {
        return { url: raw, verdict: 'unverified', chain, error: resolved.detail, reason: resolved.reason === 'blocked_by_policy' ? 'blocked_by_policy' : 'navigation_failed', durationMs: Date.now() - started };
      }
      const ip = resolved.addresses[0]!;
      let res = await this.request('HEAD', url, ip);
      if (res.status !== undefined && res.status >= 400 && res.status !== 429) res = await this.request('GET', url, ip);
      if (res.status !== undefined && res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1_000));
        res = await this.request('GET', url, ip);
      }
      if (res.error) return { url: raw, verdict: 'unverified', chain, error: res.error, reason: res.timedOut ? 'timeout' : 'navigation_failed', durationMs: Date.now() - started, method: res.method };
      const status = res.status!;
      if (status >= 300 && status < 400 && res.location) {
        try {
          url = new URL(res.location, url);
        } catch {
          return { url: raw, verdict: 'unverified', chain, status, error: 'Redirect Location is not a valid URL', durationMs: Date.now() - started, method: res.method };
        }
        continue;
      }
      const verdict: LinkVerdict = status < 400 ? 'ok' : status === 401 || status === 403 || status === 407 ? 'restricted' : status === 429 ? 'unverified' : 'broken';
      const reason: ReasonCode | undefined = verdict === 'restricted' ? 'access_restricted' : status === 429 ? 'rate_limited' : undefined;
      return { url: raw, verdict, status, chain, method: res.method, reason, durationMs: Date.now() - started, error: status === 429 ? 'Rate limited (HTTP 429)' : undefined };
    }
    return { url: raw, verdict: 'unverified', chain, error: `More than ${this.config.budgets.maxRedirects} redirects`, reason: 'budget_redirects', durationMs: Date.now() - started };
  }

  private request(method: 'HEAD' | 'GET', url: URL, ip: string): Promise<{ method: 'HEAD' | 'GET'; status?: number; location?: string; error?: string; timedOut?: boolean }> {
    const family = ip.includes(':') ? 6 : 4;
    const lookup: LookupFunction = (_host, options, cb) => {
      if ((options as { all?: boolean }).all) (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address: ip, family }]);
      else cb(null, ip, family);
    };
    const mod = url.protocol === 'https:' ? https : http;
    return new Promise((resolve) => {
      const req = mod.request(
        {
          method,
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          port: effectivePort(url),
          path: `${url.pathname}${url.search}`,
          headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
          lookup,
          timeout: this.config.budgets.linkCheckTimeoutMs,
          agent: false,
        },
        (res) => {
          const location = Array.isArray(res.headers.location) ? res.headers.location[0] : res.headers.location;
          resolve({ method, status: res.statusCode, location });
          res.destroy(); // never download the body
        },
      );
      req.on('timeout', () => {
        req.destroy();
        resolve({ method, error: `No response within ${this.config.budgets.linkCheckTimeoutMs} ms`, timedOut: true });
      });
      req.on('error', (err) => resolve({ method, error: truncate(err.message, 200) }));
      req.end();
    });
  }

  /** Checks unique link destinations seen in the run and turns them into results and findings. */
  async checkAll(appearances: LinkAppearance[], evidence: EvidenceSink, runId: string): Promise<Pick<EngineResult, 'checkResults' | 'findings' | 'coverage'> & { results: LinkResult[] }> {
    const san = (u: string) => sanitizeUrl(u, this.config.redaction);
    const byUrl = new Map<string, LinkAppearance[]>();
    for (const a of appearances) {
      if (a.link.kind !== 'http' || !a.link.resolved) continue;
      const u = new URL(a.link.resolved);
      u.hash = '';
      const key = u.toString();
      byUrl.set(key, [...(byUrl.get(key) ?? []), a]);
    }
    const urls = [...byUrl.keys()];
    const toCheck = urls.slice(0, this.config.budgets.maxLinkChecks);
    const overBudget = urls.slice(this.config.budgets.maxLinkChecks);
    const deadline = Date.now() + this.config.budgets.linkCheckBudgetMs;
    const results = new Map<string, LinkResult>();
    let next = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
      while (next < toCheck.length) {
        const u = toCheck[next++]!;
        if (Date.now() > deadline) {
          results.set(u, { url: u, verdict: 'unverified', chain: [], reason: 'budget_runtime', error: 'Link-check time budget reached', durationMs: 0 });
          continue;
        }
        results.set(u, await this.checkOne(u));
      }
    });
    await Promise.all(workers);

    const checks: NewCheck[] = [];
    const findings: NewFinding[] = [];
    const coverage: EngineResult['coverage'] = [];
    void runId;

    for (const u of overBudget) {
      checks.push(check('LNK-001', 'not_tested', 0, [], { reason: 'budget_pages', reasonDetail: `Link-check budget of ${this.config.budgets.maxLinkChecks} unique URLs reached: ${san(u)}` }));
    }
    if (overBudget.length) coverage.push({ reason: 'budget_pages', detail: `${overBudget.length} link destination(s) were not checked (budget ${this.config.budgets.maxLinkChecks}).` });

    for (const u of toCheck) {
      const r = results.get(u)!;
      const seen = byUrl.get(u)!;
      const first = seen[0]!;
      const shown = san(u);
      const statusText = r.status !== undefined ? `HTTP ${r.status}` : (r.error ?? 'no response');
      const ev: EvidenceId = (
        await evidence.addEvidence({
          kind: 'network_entry',
          caption: `Link check (${r.method ?? 'HEAD'})`,
          data: { url: shown, status: r.status ?? null, method: r.method ?? null, redirectChain: r.chain.map(san), error: r.error ?? null, durationMs: r.durationMs },
          capturedAt: nowIso(),
          redacted: true,
        })
      ).id;
      const occurrences: FindingOccurrence[] = dedupeBy(seen, (s) => `${s.stateId}|${s.link.text}`).map((s) => ({
        location: { stateId: s.stateId, url: s.stateUrl as never, viewportName: s.viewportName, selector: s.link.locator, elementDescription: `link "${s.link.text}"` },
        checkResultIds: [],
        evidenceIds: [ev],
        observed: `Link "${s.link.text}" → ${shown}: ${statusText}`,
      }));
      const location = occurrences[0]!.location;
      const repro = [...first.reproductionSteps, `Follow the link "${first.link.text}" (${shown}).`];
      const linkLabel = truncate(first.link.text || shown, 60);

      if (r.verdict === 'ok') {
        checks.push(check('LNK-001', 'passed', r.durationMs, [ev], { itemsEvaluated: seen.length }));
        continue;
      }
      if (r.verdict === 'broken') {
        checks.push(check('LNK-001', 'failed', r.durationMs, [ev], { itemsEvaluated: seen.length }));
        const f = finding('LNK-001', location, {
          title: `Broken link "${linkLabel}" (${statusText})`,
          observed: `${shown} answered ${statusText}${r.chain.length > 1 ? ` after redirects: ${r.chain.map(san).join(' → ')}` : ''}.`,
          expected: 'Links lead to an existing page.',
          evidenceIds: [ev],
          reproductionSteps: repro,
          remediation: 'Update the link to the correct destination or remove it.',
          targetKey: u,
          stateKey: '',
        });
        f.occurrences = occurrences;
        findings.push(f);
        continue;
      }
      // Restricted and unverified links are not counted as broken, and not as passed.
      checks.push(check('LNK-001', 'not_tested', r.durationMs, [ev], { reason: r.reason ?? 'navigation_failed', reasonDetail: `${shown}: ${statusText}` }));
      const ruleId = r.verdict === 'restricted' ? 'LNK-002' : 'LNK-003';
      checks.push(check(ruleId, 'needs_review', r.durationMs, [ev], { itemsEvaluated: seen.length }));
      const f = finding(ruleId, location, {
        title: r.verdict === 'restricted' ? `Link "${linkLabel}" needs sign-in or is forbidden (${statusText})` : `Link "${linkLabel}" could not be verified (${truncate(statusText, 60)})`,
        observed: `${shown}: ${statusText}.`,
        expected: r.verdict === 'restricted' ? 'Check that learners can reach this destination with their own access.' : 'Check the destination manually; the scanner could not confirm it either way.',
        evidenceIds: [ev],
        reproductionSteps: repro,
        remediation: r.verdict === 'restricted' ? 'Confirm the destination is meant to require sign-in.' : 'Open the link manually to confirm it works.',
        targetKey: u,
        stateKey: '',
      });
      f.occurrences = occurrences;
      findings.push(f);
    }
    // Rules with nothing to report still get an explicit result.
    for (const ruleId of ['LNK-002', 'LNK-003'] as const) {
      if (!checks.some((c) => c.ruleId === ruleId)) checks.push(check(ruleId, toCheck.length ? 'passed' : 'not_applicable', 0, [], { itemsEvaluated: toCheck.length }));
    }
    if (urls.length === 0) checks.push(check('LNK-001', 'not_applicable', 0, [], { reasonDetail: 'No http(s) links were found in the reached states.' }));
    return { checkResults: checks, findings, coverage, results: [...results.values()] };
  }
}

function dedupeBy<T>(items: T[], key: (t: T) => string): T[] {
  const m = new Map<string, T>();
  for (const i of items) if (!m.has(key(i))) m.set(key(i), i);
  return [...m.values()];
}
