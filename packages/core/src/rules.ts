import type { EngineSelection, RuleDefinition, RuleId } from '@cqa/shared';

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

const rule = (r: Omit<RuleDefinition, 'capability' | 'standards'> & Partial<Pick<RuleDefinition, 'capability' | 'standards'>>): RuleDefinition => ({
  capability: 'implemented',
  standards: [],
  ...r,
});

/** Phase 2a: traversal and coverage rules. */
export const TRAVERSAL_RULES: readonly RuleDefinition[] = [
  rule({
    id: 'NAV-001',
    name: 'Recognized control produces its expected result',
    category: 'navigation',
    defaultFindingType: 'automated_defect',
    defaultSeverity: 'high',
    defaultConfidence: 'medium',
    phase: 2,
    applicability: 'Tabs, accordions, and dialog openers the adapter recognizes and defines a result for',
    evidenceCollected: ['Action path', 'Expected and observed result', 'Screenshot after the action'],
    limitations: ['Only for controls whose expected result the adapter defines; other no-change clicks are NAV-002.'],
  }),
  rule({
    id: 'NAV-002',
    name: 'Action produced no observable change',
    category: 'navigation',
    defaultFindingType: 'manual_review',
    defaultSeverity: 'low',
    defaultConfidence: 'low',
    phase: 2,
    applicability: 'Attempted actions without a defined expected result (for example Next/Back)',
    evidenceCollected: ['Action path', 'State signature before and after'],
    limitations: ['Inconclusive: the control may be gated, already at the end, or rely on behavior the scanner cannot observe.'],
  }),
  rule({
    id: 'NAV-003',
    name: 'Dialog can be closed',
    category: 'navigation',
    defaultFindingType: 'automated_defect',
    defaultSeverity: 'medium',
    defaultConfidence: 'medium',
    phase: 2,
    applicability: 'Open dialogs with a recognized close control',
    evidenceCollected: ['Action path', 'Dialog visibility after the close action'],
    limitations: ['Requires a recognizable close control (Close, Dismiss, ×, OK, Done, Cancel).'],
  }),
  rule({
    id: 'COV-001',
    name: 'Unsafe or ambiguous action skipped',
    category: 'coverage',
    defaultFindingType: 'manual_review',
    defaultSeverity: 'informational',
    defaultConfidence: 'high',
    phase: 2,
    applicability: 'Controls discovered in reached states',
    evidenceCollected: ['Control description', 'Skip reason'],
    limitations: ['Skipped controls and anything behind them are unverified.'],
  }),
  rule({
    id: 'COV-002',
    name: 'Frame not inspected',
    category: 'coverage',
    defaultFindingType: 'manual_review',
    defaultSeverity: 'informational',
    defaultConfidence: 'high',
    phase: 2,
    applicability: 'Frames in reached states',
    evidenceCollected: ['Frame URL (sanitized)', 'Reason'],
    limitations: ['Content inside the frame is unverified.'],
  }),
  rule({
    id: 'COV-003',
    name: 'Canvas or unsupported rendering surface',
    category: 'coverage',
    defaultFindingType: 'manual_review',
    defaultSeverity: 'informational',
    defaultConfidence: 'high',
    phase: 2,
    applicability: 'Reached states',
    evidenceCollected: ['Canvas size and position'],
    limitations: ['DOM-based checks cannot inspect canvas-rendered content (for example parts of Storyline).'],
  }),
  rule({
    id: 'COV-004',
    name: 'Scan budget reached',
    category: 'coverage',
    defaultFindingType: 'manual_review',
    defaultSeverity: 'informational',
    defaultConfidence: 'high',
    phase: 2,
    applicability: 'Each run with traversal enabled',
    evidenceCollected: ['Budget', 'Counts when it was reached'],
    limitations: ['States beyond the budget are unverified.'],
  }),
];

export const ALL_RULES: readonly RuleDefinition[] = [...PHASE1_RULES, ...TRAVERSAL_RULES];

const BY_ID = new Map(ALL_RULES.map((r) => [r.id, r]));

export function getRule(id: RuleId): RuleDefinition {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown rule ${id}`);
  return found;
}

export function allRules(): readonly RuleDefinition[] {
  return ALL_RULES;
}

/** Rules a run owns given its engine selection; each must end with a result or a reason. */
export function rulesForEngines(engines: EngineSelection): readonly RuleDefinition[] {
  return engines.traversal ? ALL_RULES : PHASE1_RULES;
}
