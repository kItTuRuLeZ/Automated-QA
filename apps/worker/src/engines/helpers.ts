import type { CheckOutcome, EngineResult, EvidenceId, Finding, FindingLocation, ReasonCode, RuleId, Severity, StateId } from '@cqa/shared';
import { fingerprint, getRule, nowIso } from '@cqa/core';

export type NewCheck = EngineResult['checkResults'][number];
export type NewFinding = EngineResult['findings'][number];

export function check(
  ruleId: RuleId,
  outcome: CheckOutcome,
  durationMs: number,
  evidenceIds: EvidenceId[],
  extra: { stateId?: StateId; viewportName?: string; reason?: ReasonCode; reasonDetail?: string; itemsEvaluated?: number; engineVersion?: string },
): NewCheck {
  const c: NewCheck = { ruleId, outcome, durationMs, evidenceIds, executedAt: nowIso() };
  if (extra.stateId) c.stateId = extra.stateId;
  if (extra.viewportName) c.viewportName = extra.viewportName;
  if (extra.reason) c.reason = extra.reason;
  if (extra.reasonDetail) c.reasonDetail = extra.reasonDetail;
  if (extra.itemsEvaluated !== undefined) c.itemsEvaluated = extra.itemsEvaluated;
  if (extra.engineVersion) c.engineVersion = extra.engineVersion;
  return c;
}

export function finding(
  ruleId: RuleId,
  location: FindingLocation,
  f: {
    title: string;
    observed: string;
    expected: string;
    evidenceIds: EvidenceId[];
    reproductionSteps: string[];
    remediation: string;
    targetKey?: string;
    /** Defaults to 'initial'; pass '' to merge the same issue across states into one finding. */
    stateKey?: string;
    severity?: Severity;
    /** Overrides for rules whose type/confidence/standards depend on the individual result (axe-core). */
    type?: Finding['type'];
    confidence?: Finding['confidence'];
    standards?: Finding['standards'];
    /** Extra occurrences beyond the primary one (all affected locations are retained). */
    occurrences?: Finding['occurrences'];
  },
): NewFinding {
  const rule = getRule(ruleId);
  return {
    ruleId,
    category: rule.category,
    type: f.type ?? rule.defaultFindingType,
    severity: f.severity ?? rule.defaultSeverity,
    confidence: f.confidence ?? rule.defaultConfidence,
    title: f.title,
    location,
    occurrences: f.occurrences ?? [{ location, checkResultIds: [], evidenceIds: f.evidenceIds, observed: f.observed }],
    observed: f.observed,
    expected: f.expected,
    evidenceIds: f.evidenceIds,
    reproductionSteps: f.reproductionSteps,
    remediation: f.remediation,
    standards: f.standards ?? rule.standards,
    fingerprint: fingerprint({ ruleId, url: location.url, stateKey: f.stateKey ?? 'initial', targetKey: f.targetKey }),
  } satisfies Omit<Finding, 'id' | 'runId' | 'reviewer' | 'createdAt'>;
}

export function dedupe<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const i of items) if (!seen.has(key(i))) seen.set(key(i), i);
  return [...seen.values()];
}

export function hostOf(url: string): string {
  try {
    const h = new URL(url).hostname;
    return h.startsWith('[') ? h.slice(1, -1) : h;
  } catch {
    return '';
  }
}

export function truncate(s: string, n: number): string {
  const line = s.split('\n')[0] ?? '';
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
