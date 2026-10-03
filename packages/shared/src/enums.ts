/**
 * Closed vocabularies shared by server, worker, web, and reports.
 * Each is exported as a readonly tuple (for runtime validation and UI lists)
 * and as a string-literal union type.
 */

/** Outcome of one execution of one rule against one state × viewport × frame. */
export const CHECK_OUTCOMES = [
  'passed',
  'failed',
  'needs_review',
  'not_applicable',
  'not_tested',
  'error',
] as const;
export type CheckOutcome = (typeof CHECK_OUTCOMES)[number];

/** Outcomes that must carry a reason. */
export const OUTCOMES_REQUIRING_REASON = ['not_tested', 'error'] as const satisfies readonly CheckOutcome[];

/**
 * Lifecycle of a scan run. `completed` means the configured scan finished,
 * not that the course passed QA.
 */
export const RUN_STATUSES = ['queued', 'running', 'completed', 'partial', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES = ['completed', 'partial', 'failed', 'cancelled'] as const satisfies readonly RunStatus[];

export const FINDING_TYPES = [
  'automated_defect',
  'standards_warning',
  'heuristic_warning',
  'ai_recommendation',
  'manual_review',
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const RULE_CATEGORIES = [
  'runtime',
  'network',
  'navigation',
  'coverage',
  'links',
  'media',
  'content',
  'accessibility',
  'keyboard',
  'layout',
  'visual',
  'performance',
  'brand',
  'package',
  'scorm',
  'fidelity',
  'manual',
] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];

/** How a rule is (or will be) delivered; drives the capability matrix. */
export const CAPABILITY_STATUSES = ['implemented', 'planned', 'heuristic', 'manual'] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/**
 * Reviewer workflow (Phase 5). `not_reproduced` and `not_retested` keep
 * "fixed" distinct from "not examined again".
 */
export const REVIEWER_STATUSES = [
  'open',
  'assigned',
  'fixed',
  'retest',
  'verified',
  'accepted_risk',
  'false_positive',
  'not_reproduced',
  'not_retested',
] as const;
export type ReviewerStatus = (typeof REVIEWER_STATUSES)[number];

/** Statuses that require a reviewer-supplied reason. */
export const REVIEWER_STATUSES_REQUIRING_REASON = ['accepted_risk', 'false_positive'] as const satisfies readonly ReviewerStatus[];

export const EVIDENCE_KINDS = [
  'screenshot',
  'screenshot_crop',
  'annotated_screenshot',
  'dom_snippet',
  'console_entry',
  'network_entry',
  'timing',
  'geometry',
  'focus_sequence',
  'axe_node',
  'action_path',
  'diff_image',
  'text_excerpt',
  'package_entry',
  'scorm_api_call',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const TRAVERSAL_ACTION_KINDS = [
  'navigate',
  'click',
  'select_tab',
  'expand',
  'collapse',
  'open_dialog',
  'close_dialog',
  'next',
  'back',
  'key_press',
  'scroll',
  'wait',
] as const;
export type TraversalActionKind = (typeof TRAVERSAL_ACTION_KINDS)[number];

/** Result of attempting a traversal action. */
export const ACTION_OUTCOMES = ['succeeded', 'no_observable_change', 'failed', 'skipped', 'not_attempted'] as const;
export type ActionOutcome = (typeof ACTION_OUTCOMES)[number];

/** Standard reasons for `not_tested`, `error`, skipped actions, and run endings. */
export const REASON_CODES = [
  'cancelled',
  'budget_pages',
  'budget_states',
  'budget_depth',
  'budget_runtime',
  'budget_bytes',
  'budget_redirects',
  'out_of_scope',
  'blocked_by_policy',
  'unsafe_action',
  'ambiguous_action',
  'inaccessible_frame',
  'unsupported_surface',
  'state_unreachable',
  'not_applicable_to_surface',
  'engine_error',
  'timeout',
  'navigation_failed',
  'worker_lost',
  'not_implemented',
  'access_restricted',
  'rate_limited',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const SURFACE_KINDS = ['document', 'frame_same_origin', 'frame_cross_origin', 'frame_inaccessible', 'canvas', 'shadow_root'] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export const TARGET_KINDS = ['url', 'package'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const BROWSER_ENGINES = ['chromium', 'firefox', 'webkit'] as const;
export type BrowserEngine = (typeof BROWSER_ENGINES)[number];
