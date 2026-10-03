import type { Page } from 'playwright';
import type { CourseState, EvidenceId, FindingLocation, FindingOccurrence, ProviderContext, StandardReference } from '@cqa/shared';
import { axeRuleDefinition, nowIso, sanitizeText, severityForAxeImpact, wcagCriteriaFromTags } from '@cqa/core';
import { AXE_TAGS, type AxeRuleResult, type AxeRun, measureOverflow, runAxe } from '../adapters/a11y-scripts.js';
import { type NewCheck, type NewFinding, check, finding, truncate } from './helpers.js';

export interface StateA11yResult {
  checks: NewCheck[];
  findings: NewFinding[];
}

const MAX_NODES_PER_RULE = 25;
const AXE_TIMEOUT_MS = 45_000;

/**
 * Runs axe-core on a reached state (including frames axe can reach) and a
 * 320 CSS pixel reflow check. Rule outcomes follow the catalog:
 * violations → failed, incomplete → needs_review, passes → passed,
 * inapplicable → not_applicable. Surfaces axe could not test are never passes.
 */
export class AccessibilityChecks {
  readonly id = 'accessibility';
  readonly version = '1.0.0';

  async checkState(ctx: ProviderContext, state: CourseState, repro: string[]): Promise<StateA11yResult> {
    const page = ctx.page as Page;
    const viewportName = ctx.viewport.name;
    const redaction = ctx.config.redaction;
    const base = { stateId: state.id, viewportName };
    const checks: NewCheck[] = [];
    const findings: NewFinding[] = [];
    const loc = (extra: Partial<FindingLocation> = {}): FindingLocation => ({ stateId: state.id, url: state.url, lessonId: state.lessonId, viewportName, browser: 'chromium', ...extra });
    const t0 = Date.now();

    const run = await Promise.race([
      page.evaluate(runAxe, { tags: AXE_TAGS, maxNodes: MAX_NODES_PER_RULE }),
      new Promise<{ error: string }>((r) => setTimeout(() => r({ error: `axe-core did not finish within ${AXE_TIMEOUT_MS} ms` }), AXE_TIMEOUT_MS)),
    ]).catch((err: Error) => ({ error: truncate(err.message, 300) }));
    const ms = Date.now() - t0;

    if ('error' in run) {
      checks.push(check('A11Y-ENG', 'error', ms, [], { ...base, reason: 'engine_error', reasonDetail: run.error }));
    } else {
      const axe: AxeRun = run;
      const engineVersion = `axe-core ${axe.version}`;
      const evaluated = axe.violations.length + axe.incomplete.length + axe.passes.length + axe.inapplicable.length;
      checks.push(check('A11Y-ENG', 'passed', ms, [], { ...base, itemsEvaluated: evaluated, engineVersion, reasonDetail: `${evaluated} rules evaluated; ${axe.violations.length} with violations, ${axe.incomplete.length} needing review.` }));

      const perRuleMs = Math.round(ms / Math.max(evaluated, 1));
      for (const p of axe.passes) checks.push(check(`A11Y-AXE-${p.id}`, 'passed', perRuleMs, [], { ...base, engineVersion }));
      for (const p of axe.inapplicable) checks.push(check(`A11Y-AXE-${p.id}`, 'not_applicable', perRuleMs, [], { ...base, engineVersion }));

      for (const kind of ['violations', 'incomplete'] as const) {
        for (const r of axe[kind]) {
          const outcome = kind === 'violations' ? 'failed' : 'needs_review';
          const evidenceId = await this.evidence(ctx, state, r, engineVersion, kind);
          checks.push(check(`A11Y-AXE-${r.id}`, outcome, perRuleMs, [evidenceId], { ...base, engineVersion, itemsEvaluated: r.totalNodes }));
          findings.push(this.toFinding(r, kind, evidenceId, loc, repro, redaction, engineVersion));
        }
      }
    }

    // ---- reflow at 320 CSS px (heuristic) ----
    const original = page.viewportSize();
    try {
      await page.setViewportSize({ width: 320, height: 568 });
      await page.waitForTimeout(400);
      const o = await page.evaluate(measureOverflow);
      const evId = await ctx.evidence
        .addEvidence({ kind: 'geometry', caption: 'Horizontal overflow at 320 CSS px', data: { ...o, viewport: '320×568' }, stateId: state.id, viewportName, capturedAt: nowIso(), redacted: false })
        .then((e) => e.id);
      if (o.scrollWidth > o.clientWidth + 1) {
        checks.push(check('A11Y-008', 'needs_review', 0, [evId], { ...base }));
        findings.push(
          finding('A11Y-008', loc(), {
            title: `Content scrolls horizontally at 320 CSS px (${o.scrollWidth} px wide)`,
            observed: `At a 320 px wide viewport the page is ${o.scrollWidth} px wide, so horizontal scrolling is needed.${o.offenders.length ? ` Elements extending past the edge: ${o.offenders.map((x) => `${x.selector}${x.text ? ` "${x.text}"` : ''}`).join(', ')}.` : ''}`,
            expected: 'Content reflows to a single column at 320 CSS px without horizontal scrolling, except content that needs two-dimensional layout.',
            evidenceIds: [evId],
            reproductionSteps: [...repro, 'Set the browser window or device emulation to 320 CSS px wide and look for horizontal scrolling.'],
            remediation: 'Use responsive layout (flexible widths, wrapping) so content fits 320 px, or confirm the wide content is exempt.',
            targetKey: 'reflow',
            stateKey: '',
          }),
        );
      } else {
        checks.push(check('A11Y-008', 'passed', 0, [evId], { ...base }));
      }
    } catch (err) {
      checks.push(check('A11Y-008', 'error', 0, [], { ...base, reason: 'engine_error', reasonDetail: truncate((err as Error).message, 200) }));
    } finally {
      if (original) await page.setViewportSize(original).catch(() => undefined);
      await page.waitForTimeout(200);
    }

    return { checks, findings };
  }

  private async evidence(ctx: ProviderContext, state: CourseState, r: AxeRuleResult, engineVersion: string, kind: string): Promise<EvidenceId> {
    const { redaction } = ctx.config;
    const e = await ctx.evidence.addEvidence({
      kind: 'axe_node',
      caption: `${engineVersion}: ${r.id} (${kind === 'violations' ? 'violation' : 'needs review'}${r.impact ? `, ${r.impact}` : ''})`,
      data: {
        engine: engineVersion,
        ruleId: r.id,
        impact: r.impact,
        help: r.help,
        helpUrl: r.helpUrl,
        tags: r.tags,
        totalNodes: r.totalNodes,
        nodes: r.nodes.map((n) => ({ target: n.target, html: sanitizeText(n.html, redaction, 300), failureSummary: n.failureSummary })),
      },
      stateId: state.id,
      viewportName: ctx.viewport.name,
      capturedAt: nowIso(),
      redacted: true,
    });
    return e.id;
  }

  private toFinding(
    r: AxeRuleResult,
    kind: 'violations' | 'incomplete',
    evidenceId: EvidenceId,
    loc: (extra?: Partial<FindingLocation>) => FindingLocation,
    repro: string[],
    redaction: ProviderContext['config']['redaction'],
    engineVersion: string,
  ): NewFinding {
    const def = axeRuleDefinition(r.id, { help: r.help, impact: r.impact, tags: r.tags });
    const wcag = wcagCriteriaFromTags(r.tags);
    const standards: StandardReference[] = wcag.map((criterion) => ({ standard: 'WCAG', criterion, relation: 'relevant' }));
    const isViolation = kind === 'violations';
    const occurrences: FindingOccurrence[] = r.nodes.map((n) => ({
      location: loc({ selector: n.target, elementDescription: truncate(sanitizeText(n.html, redaction, 160), 160) }),
      checkResultIds: [],
      evidenceIds: [evidenceId],
      observed: n.failureSummary ? truncate(n.failureSummary.replace(/\s+/g, ' '), 300) : r.help,
    }));
    const more = r.totalNodes > r.nodes.length ? ` (${r.totalNodes - r.nodes.length} more not listed)` : '';
    return finding(`A11Y-AXE-${r.id}`, loc(), {
      title: `${isViolation ? '' : 'Needs review: '}${r.help}${r.totalNodes > 1 ? ` (${r.totalNodes} elements)` : ''}`,
      observed: `${engineVersion} rule "${r.id}" ${isViolation ? 'reported' : 'could not decide'} ${r.totalNodes} element(s)${more}. First: ${r.nodes[0]?.target ?? '—'}`,
      expected: isViolation ? r.help : `${r.help} Automated analysis was inconclusive; check manually.`,
      evidenceIds: [evidenceId],
      reproductionSteps: [...repro, `Run an accessibility inspector (for example axe DevTools) on this state and look for "${r.id}".`, ...r.nodes.slice(0, 3).map((n) => `Affected element: ${n.target}`)],
      remediation: `${r.help}. Guidance: ${r.helpUrl}`,
      severity: isViolation ? severityForAxeImpact(r.impact) : 'informational',
      type: isViolation ? def.defaultFindingType : 'manual_review',
      confidence: isViolation ? def.defaultConfidence : 'medium',
      standards,
      occurrences,
      targetKey: `${r.id}|${kind}`,
      stateKey: '',
    });
  }
}
