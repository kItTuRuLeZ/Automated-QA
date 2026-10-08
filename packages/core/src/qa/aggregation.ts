import { isPrimaryUnit } from './inventory.js';
import type { ContentUnit, InteractionInstance, ReviewDisposition, ScreenBadge, ScreenStatus, TestDefinition, TestExecution, TestStatus } from '@cqa/shared';

/**
 * Deterministic rules that turn recorded executions into a status per screen and into coverage numbers.
 * Pure functions: the same rows always give the same answer, and nothing here can create a pass.
 */

export interface StatusCounts {
  passed: number;
  failed: number;
  blocked: number;
  error: number;
  skipped: number;
  manual: number;
  pending: number;
  running: number;
  notApplicable: number;
  /** Not-applicable cases that carry no reason. They are not excluded; they count as a gap. */
  notApplicableWithoutReason: number;
}

export function countStatuses(executions: readonly TestExecution[]): StatusCounts {
  const c: StatusCounts = { passed: 0, failed: 0, blocked: 0, error: 0, skipped: 0, manual: 0, pending: 0, running: 0, notApplicable: 0, notApplicableWithoutReason: 0 };
  for (const e of executions) {
    switch (e.status as TestStatus) {
      case 'passed':
        c.passed++;
        break;
      case 'failed':
        c.failed++;
        break;
      case 'blocked':
        c.blocked++;
        break;
      case 'error':
        c.error++;
        break;
      case 'skipped':
        c.skipped++;
        break;
      case 'manual_review_required':
        c.manual++;
        break;
      case 'pending':
        c.pending++;
        break;
      case 'running':
        c.running++;
        break;
      case 'not_applicable':
        if (e.reason && e.reason.trim()) c.notApplicable++;
        else c.notApplicableWithoutReason++;
        break;
    }
  }
  return c;
}

export interface ScreenResult {
  unitId: string;
  status: ScreenStatus;
  badges: ScreenBadge[];
  counts: StatusCounts;
  /** "static" means every executed check read files only; functional behaviour was not tested. */
  scope: 'none' | 'static' | 'functional';
  /** Plain reasons behind the status, for the detail panel. */
  reasons: string[];
  /** The latest reviewer decision, kept beside (never in place of) the automated status. */
  reviewerDecision?: ReviewDisposition;
}

/** A gap is anything that keeps a screen from being called passed. */
export const gapCount = (c: StatusCounts): number => c.blocked + c.error + c.skipped + c.manual + c.pending + c.notApplicableWithoutReason;

/**
 * The automated status of one screen.
 *
 *  - in progress: something is still running
 *  - issues found: at least one applicable check failed (gaps are shown too, as badges)
 *  - passed automated checks: at least one passed, nothing else is open, and the screen was really shown by a browser
 *    (or every executed check was a static one, which is then labelled static-only)
 *  - not tested: nothing executed and nothing waits for review
 *  - needs manual review: everything else (no failure, but gaps, or nothing executed while manual work is open)
 */
export function screenStatus(
  unit: ContentUnit,
  executions: readonly TestExecution[],
  dispositions: readonly ReviewDisposition[] = [],
  interactions: readonly InteractionInstance[] = [],
): ScreenResult {
  const mine = executions.filter((e) => e.unitId === unit.id);
  const counts = countStatuses(mine);
  const gaps = gapCount(counts);
  const executed = mine.filter((e) => e.status === 'passed' || e.status === 'failed');
  const staticOnly = executed.length > 0 && executed.every((e) => e.scope === 'static');
  const visited = Boolean(unit.visitedAt);
  const reasons: string[] = [];
  const badges: ScreenBadge[] = [];

  const unitInteractions = interactions.filter((i) => i.unitId === unit.id);
  const exercisedIds = new Set(
    executions
      .filter((e) => (e.status === 'passed' || e.status === 'failed') && e.instanceId)
      .map((e) => e.instanceId!),
  );
  const unexercisedInteractions = unitInteractions.filter((i) => !exercisedIds.has(i.id));

  if (!visited && !staticOnly) badges.push('runtime_not_visited');
  if (counts.passed > 0 && (gaps > 0 || unexercisedInteractions.length > 0)) badges.push('partially_checked');
  if (counts.manual > 0) badges.push('manual_checks_pending');
  if (counts.blocked > 0) badges.push('blocked_checks');
  if (counts.error > 0) badges.push('runner_errors');
  if (staticOnly && counts.passed > 0) badges.push('static_only');

  const decision = [...dispositions].filter((d) => d.targetKind === 'unit' && d.targetId === unit.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).pop();
  if (decision) badges.push('reviewer_decision');

  let status: ScreenStatus;
  if (counts.running > 0) {
    status = 'in_progress';
    reasons.push('A check is running on this screen.');
  } else if (counts.failed > 0) {
    status = 'issues_found';
    reasons.push(`${counts.failed} applicable check${counts.failed === 1 ? '' : 's'} failed.`);
    if (gaps > 0) reasons.push(`${gaps} more check${gaps === 1 ? '' : 's'} did not reach a result.`);
  } else if (counts.passed === 0 && gaps === 0) {
    status = 'not_tested';
    reasons.push(mine.length === 0 ? 'No check ran on this screen. No findings here does not mean it was tested.' : 'Every check that applies here was excluded or is not applicable.');
    if (!visited) reasons.push('No browser has shown this screen yet.');
  } else if (counts.passed > 0 && gaps === 0 && unexercisedInteractions.length === 0 && (visited || staticOnly)) {
    status = 'passed_automated';
    reasons.push(staticOnly ? 'The selected static checks passed. Functional behavior was not tested.' : `${counts.passed} applicable automated check${counts.passed === 1 ? '' : 's'} passed on a screen the browser visited.`);
  } else {
    status = 'needs_manual_review';
    if (unexercisedInteractions.length > 0) {
      reasons.push(`${unexercisedInteractions.length} detected interaction${unexercisedInteractions.length === 1 ? '' : 's'} on this screen ${unexercisedInteractions.length === 1 ? 'was' : 'were'} not tested by any automated check.`);
    }
    if (counts.manual) reasons.push(`${counts.manual} check${counts.manual === 1 ? ' needs' : 's need'} a person (no automation for it, or the expected result is unknown).`);
    if (counts.blocked) reasons.push(`${counts.blocked} check${counts.blocked === 1 ? ' was' : 's were'} blocked.`);
    if (counts.error) reasons.push(`${counts.error} check${counts.error === 1 ? '' : 's'} hit a runner error (not a confirmed course defect).`);
    if (counts.skipped) reasons.push(`${counts.skipped} check${counts.skipped === 1 ? ' was' : 's were'} skipped.`);
    if (counts.pending) reasons.push(`${counts.pending} check${counts.pending === 1 ? ' has' : 's have'} not run yet.`);
    if (counts.notApplicableWithoutReason) reasons.push(`${counts.notApplicableWithoutReason} check${counts.notApplicableWithoutReason === 1 ? ' was' : 's were'} marked not applicable without a reason.`);
    if (counts.passed > 0 && !visited && !staticOnly) reasons.push('The screen passed checks but a browser never showed it, so the result cannot be trusted as a screen result.');
  }

  const scope: ScreenResult['scope'] = executed.length === 0 ? 'none' : staticOnly ? 'static' : 'functional';
  return { unitId: unit.id, status, badges, counts, scope, reasons, reviewerDecision: decision };
}

// ---- coverage ----

export type Ratio = { available: true; numerator: number; denominator: number; percent: number } | { available: false; reason: string };

/** Never 100% for an empty or unknown denominator. */
export function ratio(numerator: number, denominator: number | undefined, unavailableReason: string): Ratio {
  if (denominator === undefined || denominator <= 0) return { available: false, reason: unavailableReason };
  return { available: true, numerator, denominator, percent: Math.round((numerator / denominator) * 1000) / 10 };
}

export type DiscoveryCompleteness = 'complete' | 'partial' | 'unknown';

export interface CoverageSummary {
  /** Strongest evidence of what the course contains. "unknown" means the inventory only holds what a browser happened to see. */
  discovery: { completeness: DiscoveryCompleteness; reason: string; byConfidence: Record<'high' | 'medium' | 'low', number>; bySource: Record<string, number>; revision: number };
  visit: Ratio;
  /** Terminal executed (passed + failed) over mapped applicable automated checks. */
  execution: Ratio;
  /** passed / (passed + failed). */
  passRate: Ratio;
  interactions: { total: number; exercised: Ratio };
  manual: { outstanding: number; manualOnlyCases: number };
  /** Blocks, layers, scenes and package items that are listed but not tracked one by one. */
  listedNotTracked: number;
  gaps: { blocked: number; errored: number; skipped: number; pending: number; unitsNotVisited: number; unitsNotReached: Array<{ id: string; title: string; reason: string }> };
  counts: StatusCounts;
  /** One statement built from the numbers above. */
  statement: string;
}

export interface CoverageInput {
  units: readonly ContentUnit[];
  executions: readonly TestExecution[];
  interactions: readonly InteractionInstance[];
  definitions: ReadonlyMap<string, TestDefinition>;
  unitNoun?: { singular: string; plural: string };
}

export function summarizeCoverage(input: CoverageInput): CoverageSummary {
  const { units, executions, interactions, definitions } = input;
  const noun = input.unitNoun ?? { singular: 'screen', plural: 'screens' };
  const byConfidence = { high: 0, medium: 0, low: 0 };
  const bySource: Record<string, number> = {};
  for (const u of units) {
    byConfidence[u.confidence]++;
    bySource[u.source] = (bySource[u.source] ?? 0) + 1;
  }
  const authoritative = units.some((u) => u.source === 'manifest' || u.source === 'authoring_export' || u.source === 'player_menu');
  const runtimeExtras = units.filter((u) => u.source === 'runtime').length;
  let completeness: DiscoveryCompleteness;
  let reason: string;
  if (units.length === 0) {
    completeness = 'unknown';
    reason = 'Nothing has been discovered yet.';
  } else if (!authoritative) {
    completeness = 'unknown';
    reason = `Only what a browser saw is listed (${units.length} found so far). The scanner has no independent list of what the course contains.`;
  } else if (runtimeExtras > 0 || byConfidence.low > 0) {
    completeness = 'partial';
    reason = `${runtimeExtras ? `${runtimeExtras} ${noun.plural} appeared only at run time, which the course's own list did not show. ` : ''}${byConfidence.low ? `${byConfidence.low} listed with low confidence.` : ''}`.trim();
  } else {
    completeness = 'complete';
    reason = 'Every listed item came from the course package or player menu, and nothing extra appeared at run time. This does not prove the list is exhaustive.';
  }

  // Visits are counted on lessons, slides and screens. Blocks, layers and scenes are listed, not tracked one by one.
  const primary = units.filter((u) => isPrimaryUnit(u, units));
  const visited = primary.filter((u) => u.visitedAt).length;
  const visit = ratio(visited, completeness === 'unknown' ? undefined : primary.length, completeness === 'unknown' ? `The total number of ${noun.plural} is not known, so there is no visit percentage. ${visited} found and visited so far.` : 'Nothing discovered.');

  const counts = countStatuses(executions);
  const mapped = executions.filter((e) => {
    if (e.status === 'not_applicable' && e.reason) return false;
    const def = definitions.get(e.definitionId);
    return !def || def.automation !== 'manual';
  });
  const terminal = mapped.filter((e) => e.status === 'passed' || e.status === 'failed').length;
  const execution = ratio(terminal, mapped.length, 'No automated check was mapped to this scan.');
  const passRate = ratio(counts.passed, counts.passed + counts.failed, 'No automated check reached a pass or fail result.');

  const exercisedIds = new Set(executions.filter((e) => (e.status === 'passed' || e.status === 'failed') && e.instanceId).map((e) => e.instanceId!));
  const exercised = interactions.filter((i) => exercisedIds.has(i.id)).length;
  const interactionRatio = ratio(exercised, interactions.length, 'No interactions were detected.');

  const manualOnlyCases = executions.filter((e) => definitions.get(e.definitionId)?.automation === 'manual' && e.status !== 'not_applicable').length;
  const unitsNotReached = primary.filter((u) => !u.visitedAt).map((u) => ({ id: u.id, title: u.title, reason: u.notReachedReason ?? 'No browser visit was recorded.' }));

  const gaps = {
    blocked: counts.blocked,
    errored: counts.error,
    skipped: counts.skipped,
    pending: counts.pending + counts.running,
    unitsNotVisited: unitsNotReached.length,
    unitsNotReached,
  };
  const manualOutstanding = counts.manual + counts.notApplicableWithoutReason;

  const parts: string[] = [];
  parts.push(
    completeness === 'unknown'
      ? `${visited} ${visited === 1 ? noun.singular : noun.plural} visited of ${primary.length} found so far (the course's total is not known).`
      : `${visited} of ${primary.length} discovered ${noun.plural} visited.`,
  );
  parts.push(
    mapped.length === 0
      ? 'No automated checks were mapped.'
      : `${terminal} of ${mapped.length} mapped automated checks executed (${counts.passed} passed, ${counts.failed} failed); ${counts.blocked + counts.error + counts.skipped + counts.pending + counts.running} blocked, errored, skipped or not run.`,
  );
  if (unitsNotReached.length) parts.push(`${unitsNotReached.length} ${unitsNotReached.length === 1 ? noun.singular : noun.plural} not reached.`);
  if (interactionRatio.available && interactionRatio.numerator < interactionRatio.denominator) {
    const unexercised = interactionRatio.denominator - interactionRatio.numerator;
    parts.push(`${interactionRatio.numerator} of ${interactionRatio.denominator} detected interactions exercised (${unexercised} untested).`);
  }
  parts.push(manualOutstanding > 0 ? `${manualOutstanding} manual check${manualOutstanding === 1 ? ' remains' : 's remain'}.` : 'No manual checks are outstanding.');
  parts.push(completeness === 'complete' ? 'Inventory discovery: complete as far as the course package shows.' : completeness === 'partial' ? 'Inventory discovery: partial.' : 'Inventory discovery: unknown.');

  return {
    discovery: { completeness, reason, byConfidence, bySource, revision: units.reduce((m, u) => Math.max(m, u.revision), 0) },
    visit,
    execution,
    passRate,
    interactions: { total: interactions.length, exercised: interactionRatio },
    manual: { outstanding: manualOutstanding, manualOnlyCases },
    listedNotTracked: units.length - primary.length,
    gaps,
    counts,
    statement: parts.join(' '),
  };
}

/** The lifecycle word for a finished run: the worker finishing is not the same as the whole course being covered. */
export function finalStage(args: { runStatus: 'completed' | 'partial' | 'failed' | 'cancelled'; coverage: CoverageSummary }): 'completed' | 'completed_with_gaps' | 'failed' | 'cancelled' {
  if (args.runStatus === 'failed') return 'failed';
  if (args.runStatus === 'cancelled') return 'cancelled';
  const c = args.coverage;
  const unexercisedInteractions = c.interactions.exercised.available ? c.interactions.exercised.denominator - c.interactions.exercised.numerator : 0;
  const gaps = c.gaps.blocked + c.gaps.errored + c.gaps.skipped + c.gaps.pending + c.gaps.unitsNotVisited + c.manual.outstanding + unexercisedInteractions;
  return args.runStatus === 'partial' || gaps > 0 || c.discovery.completeness !== 'complete' ? 'completed_with_gaps' : 'completed';
}
