import type { RuleDefinition, RuleId } from '@cqa/shared';

/** Phase 1 rule definitions. Must stay consistent with docs/QA_RULE_CATALOG.md. */
export const PHASE1_RULES: readonly RuleDefinition[] = [
  {
    id: 'RUN-001',
    name: 'Initial page loads',
    category: 'runtime',
    defaultFindingType: 'automated_defect',
    defaultSeverity: 'critical',
    defaultConfidence: 'high',
    capability: 'implemented',
    phase: 1,
    applicability: 'Every URL target',
    evidenceCollected: ['Final sanitized URL', 'HTTP status', 'Screenshot', 'Navigation timing'],
    limitations: ['A successful response does not prove the page is the correct course page.'],
    standards: [],
  },
  {
    id: 'RUN-002',
    name: 'Uncaught JavaScript exceptions',
    category: 'runtime',
    defaultFindingType: 'automated_defect',
    defaultSeverity: 'high',
    defaultConfidence: 'high',
    capability: 'implemented',
    phase: 1,
    applicability: 'Every captured state',
    evidenceCollected: ['Exception message', 'Sanitized stack'],
    limitations: ['Impact on the learner is not determined; third-party scripts are included.'],
    standards: [],
  },
  {
    id: 'RUN-003',
    name: 'Console errors',
    category: 'runtime',
    defaultFindingType: 'heuristic_warning',
    defaultSeverity: 'low',
    defaultConfidence: 'medium',
    capability: 'implemented',
    phase: 1,
    applicability: 'Every captured state',
    evidenceCollected: ['Console text (sanitized)', 'Source location'],
    limitations: ['Many console errors are benign.'],
    standards: [],
  },
  {
    id: 'RUN-004',
    name: 'Failed subrequests',
    category: 'runtime',
    defaultFindingType: 'automated_defect',
    defaultSeverity: 'high',
    defaultConfidence: 'high',
    capability: 'implemented',
    phase: 1,
    applicability: 'Every captured state',
    evidenceCollected: ['Sanitized URL', 'Resource type', 'Status or network error'],
    limitations: ['Requests blocked by the scan policy are reported as NET-002, not as course defects.'],
    standards: [],
  },
  {
    id: 'RUN-005',
    name: 'Page title present',
    category: 'runtime',
    defaultFindingType: 'standards_warning',
    defaultSeverity: 'low',
    defaultConfidence: 'high',
    capability: 'implemented',
    phase: 1,
    applicability: 'Top document',
    evidenceCollected: ['Title text'],
    limitations: ['Title adequacy needs manual review.'],
    standards: [{ standard: 'WCAG', version: '2.2', criterion: '2.4.2', relation: 'relevant' }],
  },
  {
    id: 'RUN-006',
    name: 'Navigation timing captured',
    category: 'performance',
    defaultFindingType: 'heuristic_warning',
    defaultSeverity: 'informational',
    defaultConfidence: 'medium',
    capability: 'implemented',
    phase: 1,
    applicability: 'Top document',
    evidenceCollected: ['Navigation Timing entry'],
    limitations: ['Single sample; depends on machine, network, and cache.'],
    standards: [],
  },
  {
    id: 'NET-002',
    name: 'Subrequest blocked by policy',
    category: 'network',
    defaultFindingType: 'manual_review',
    defaultSeverity: 'informational',
    defaultConfidence: 'high',
    capability: 'implemented',
    phase: 1,
    applicability: 'Every captured state',
    evidenceCollected: ['Sanitized URL', 'Block reason'],
    limitations: ['Blocked content may hide course behavior; reported as a coverage gap.'],
    standards: [],
  },
  {
    id: 'NET-003',
    name: 'Redirect leaves allowed scope',
    category: 'network',
    defaultFindingType: 'manual_review',
    defaultSeverity: 'informational',
    defaultConfidence: 'high',
    capability: 'implemented',
    phase: 1,
    applicability: 'Initial navigation',
    evidenceCollected: ['Redirect chain'],
    limitations: [],
    standards: [],
  },
];

const BY_ID = new Map(PHASE1_RULES.map((r) => [r.id, r]));

export function getRule(id: RuleId): RuleDefinition {
  const rule = BY_ID.get(id);
  if (!rule) throw new Error(`Unknown rule ${id}`);
  return rule;
}

export function allRules(): readonly RuleDefinition[] {
  return PHASE1_RULES;
}
