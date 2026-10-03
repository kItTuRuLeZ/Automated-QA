import type {
  ArtifactId,
  CheckResultId,
  EvidenceId,
  FindingId,
  IsoTimestamp,
  Rect,
  RuleId,
  SanitizedUrl,
  ScanRunId,
  StateId,
} from './common.js';
import type {
  CapabilityStatus,
  CheckOutcome,
  Confidence,
  EvidenceKind,
  FindingType,
  ReasonCode,
  ReviewerStatus,
  RuleCategory,
  Severity,
} from './enums.js';

/** A reference to an external standard. Only include mappings that are justified. */
export interface StandardReference {
  standard: 'WCAG' | 'SCORM_1_2' | 'SCORM_2004' | 'SECTION_508' | 'INTERNAL';
  /** e.g. WCAG `2.2`. */
  version?: string;
  /** e.g. WCAG success criterion `1.1.1`. Never invented. */
  criterion?: string;
  /** `relevant` = related to; `fails` only when the rule establishes failure. */
  relation: 'relevant' | 'fails';
}

/** A unique rule in the catalog (docs/QA_RULE_CATALOG.md). */
export interface RuleDefinition {
  id: RuleId;
  name: string;
  category: RuleCategory;
  defaultFindingType: FindingType;
  defaultSeverity: Severity;
  defaultConfidence: Confidence;
  capability: CapabilityStatus;
  phase: number;
  applicability: string;
  evidenceCollected: string[];
  limitations: string[];
  standards: StandardReference[];
  /** For engine-backed rules (e.g. axe-core), the engine's own rule ID. */
  engineRuleId?: string;
}

/** Where something was observed. Fields the scanner cannot determine are omitted, never guessed. */
export interface FindingLocation {
  stateId?: StateId;
  url?: SanitizedUrl;
  courseTitle?: string;
  lessonId?: string;
  lessonTitle?: string;
  screenLabel?: string;
  frameUrl?: SanitizedUrl;
  /** CSS/role-based selector for the element, when applicable. */
  selector?: string;
  elementDescription?: string;
  bounds?: Rect;
  viewportName?: string;
  browser?: string;
}

/**
 * One execution of one rule against one state × viewport × frame.
 * Unique rules and executions are counted separately.
 */
export interface CheckResult {
  id: CheckResultId;
  runId: ScanRunId;
  ruleId: RuleId;
  stateId?: StateId;
  viewportName?: string;
  frameUrl?: SanitizedUrl;
  outcome: CheckOutcome;
  /** Required for `not_tested` and `error`. */
  reason?: ReasonCode;
  reasonDetail?: string;
  durationMs: number;
  /** Number of elements/items evaluated, when meaningful. */
  itemsEvaluated?: number;
  evidenceIds: EvidenceId[];
  executedAt: IsoTimestamp;
  /** Engine version that produced this result (e.g. axe-core 4.x). */
  engineVersion?: string;
}

export interface Evidence {
  id: EvidenceId;
  runId: ScanRunId;
  kind: EvidenceKind;
  /** File-backed evidence (screenshots, diffs) references an opaque artifact. */
  artifactId?: ArtifactId;
  /** Small structured evidence stored inline (already redacted). */
  data?: Record<string, unknown>;
  caption: string;
  stateId?: StateId;
  viewportName?: string;
  capturedAt: IsoTimestamp;
  redacted: boolean;
}

/** One concrete place where a finding occurs. */
export interface FindingOccurrence {
  location: FindingLocation;
  checkResultIds: CheckResultId[];
  evidenceIds: EvidenceId[];
  observed: string;
}

export interface SeverityOverride {
  from: Severity;
  to: Severity;
  reviewer: string;
  reason: string;
  at: IsoTimestamp;
}

export interface ReviewerState {
  status: ReviewerStatus;
  /** Local owner name; metadata only, never triggers messages. */
  assignee?: string;
  /** Required for `accepted_risk` and `false_positive`. */
  reason?: string;
  updatedAt: IsoTimestamp;
}

/**
 * A grouped issue. Repeated failures with the same fingerprint are one finding
 * with multiple occurrences.
 */
export interface Finding {
  id: FindingId;
  runId: ScanRunId;
  ruleId: RuleId;
  category: RuleCategory;
  type: FindingType;
  severity: Severity;
  severityOverride?: SeverityOverride;
  confidence: Confidence;
  title: string;
  /** Primary location; all locations are in `occurrences`. */
  location: FindingLocation;
  occurrences: FindingOccurrence[];
  observed: string;
  /** Expected behavior or the rule being applied. */
  expected: string;
  evidenceIds: EvidenceId[];
  reproductionSteps: string[];
  remediation: string;
  standards: StandardReference[];
  reviewer: ReviewerState;
  /** SHA-256 of ruleId | normalized origin+path | state key | target key. */
  fingerprint: string;
  /** For `ai_recommendation` only: provider/model/prompt version and scope (Phase 8). */
  advisory?: {
    provider: string;
    model: string;
    promptVersion: string;
    scope: string;
    uncertainty: string;
  };
  createdAt: IsoTimestamp;
}
