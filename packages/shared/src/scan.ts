import type { ProfileSnapshot } from './profile.js';
import type {
  ActionId,
  BrowserInfo,
  IsoTimestamp,
  ProfileId,
  ProjectId,
  SanitizedUrl,
  ScanRunId,
  StateId,
  ToolVersion,
  Viewport,
} from './common.js';
import type {
  ActionOutcome,
  CheckOutcome,
  FindingType,
  ReasonCode,
  RunStatus,
  Severity,
  SurfaceKind,
  TargetKind,
  TraversalActionKind,
} from './enums.js';
import type { TerminologyRule } from './profile.js';

/** Which URLs a scan may navigate to and which subrequests it may load. */
export interface ScanScope {
  /** Origins (scheme://host[:port]) navigation may visit. First entry is the target origin. */
  allowedOrigins: string[];
  /** Path prefixes within allowed origins; empty means the whole origin. */
  allowedPathPrefixes: string[];
  /**
   * `same_scope_only`: subrequests restricted to allowedOrigins.
   * `public_allowed`: other public origins (CDNs, fonts) allowed and logged.
   */
  subrequestPolicy: 'same_scope_only' | 'public_allowed';
  /** Non-default ports must be listed explicitly. */
  allowedPorts: number[];
}

/** Hard limits. Reaching one ends exploration predictably and is reported as coverage. */
export interface ScanBudgets {
  maxPages: number;
  maxStates: number;
  maxDepth: number;
  maxRuntimeMs: number;
  navigationTimeoutMs: number;
  actionTimeoutMs: number;
  maxRedirects: number;
  maxResponseBytes: number;
  maxTotalBytes: number;
  maxDownloads: number;
  /** Concurrent browser contexts per run. V1: 1. */
  concurrency: number;
  /** Unique link URLs checked per run (Phase 2b). */
  maxLinkChecks: number;
  /** Per-request timeout for link checks. */
  linkCheckTimeoutMs: number;
  /** Total time allowed for link checking after exploration. */
  linkCheckBudgetMs: number;
}

/** Rule-based text checks (Phase 2b). Not a grammar review. */
export interface TextRules {
  /** Case-insensitive regular expressions for placeholder or production-note text. */
  placeholderPatterns: string[];
  terminology: TerminologyRule[];
  /** Text (case-insensitive substrings) that must never be flagged. */
  exclusions: string[];
}

/** Size warnings for media (MED-005), with where each value came from. */
export interface MediaThresholds {
  maxImageBytes: number;
  maxMediaBytes: number;
  provenance: string;
}

/** Read-only exploration policy (Phase 2). Deny always wins over allow. */
export interface ActionPolicy {
  allowedKinds: TraversalActionKind[];
  /** Case-insensitive patterns matched against accessible name/text; matches are skipped as unsafe. */
  deniedNamePatterns: string[];
  allowFormSubmission: false;
  followExternalLinks: boolean;
}

export interface RedactionPolicy {
  stripQueryStrings: boolean;
  /** Query parameter names preserved when stripping. */
  preservedQueryParams: string[];
  /** Case-insensitive patterns for parameter names whose values are always redacted. */
  sensitiveParamPatterns: string[];
  stripFragments: boolean;
}

/** Warning thresholds for page-load evidence (PERF-001). Defaults are not a standard; see `provenance`. */
export interface PerfThresholds {
  loadMs: number;
  totalBytes: number;
  requestCount: number;
  provenance: string;
}

/** Settings for the responsive layout, performance, and baseline checks (Phase 4). */
export interface LayoutSettings {
  /** Reached screens re-checked at each additional viewport. */
  maxStatesPerViewport: number;
  perf: PerfThresholds;
  /** Fraction of pixels that may differ from the baseline before a diff is raised. */
  baselineDiffRatio: number;
  /**
   * Storyline output is a fixed-size stage and is not designed to be responsive, so by default
   * the extra screen sizes and the 320 px reflow check are skipped for it. Set true to test anyway.
   */
  testNonResponsive?: boolean;
}

export interface ScanTarget {
  kind: TargetKind;
  /** For `url` targets: user-supplied URL (validated, never contains credentials). */
  url?: string;
  /** For `package` targets (Phase 6): uploaded package reference and chosen launch entry. */
  packageId?: string;
  launchEntry?: string;
  /** Display name of the uploaded package. */
  packageName?: string;
}

/** Engines selected for a run. Unselected engines yield `not_tested` with reason, never `passed`. */
export interface EngineSelection {
  capture: boolean;
  traversal: boolean;
  links: boolean;
  media: boolean;
  content: boolean;
  accessibility: boolean;
  keyboard: boolean;
  layout: boolean;
  performance: boolean;
  visualBaseline: boolean;
  /** Optional AI advisory (Phase 8). Always false unless explicitly enabled per run. */
  advisory: boolean;
  /** Brand checks (BRD-*). Only on when the profile has user-supplied brand values. */
  brand?: boolean;
  /** SCORM test harness for this scan, and which version's API it provides (set only for SCORM packages). */
  scorm?: '1.2' | '2004';
}

/** One scripted action in a journey the person wrote. Targets are Playwright locators: `text=Start` or a CSS selector like `#next`. */
export interface ScormJourneyStep {
  action: 'click' | 'fill' | 'select' | 'press' | 'wait';
  target?: string;
  value?: string;
  ms?: number;
}

/** What the person expects the course to have recorded after a journey. Every field is optional and user-supplied. */
export interface ScormExpectation {
  /** SCORM 1.2 `cmi.core.lesson_status`. */
  status?: 'passed' | 'completed' | 'failed' | 'incomplete' | 'browsed' | 'not attempted';
  /** SCORM 2004 `cmi.completion_status`. */
  completion?: 'completed' | 'incomplete' | 'not attempted' | 'unknown';
  /** SCORM 2004 `cmi.success_status`. */
  success?: 'passed' | 'failed' | 'unknown';
  /** Raw score bounds (1.2 and 2004) the recorded score must fall within. */
  scoreMin?: number;
  scoreMax?: number;
  mustReportScore?: boolean;
}

export interface ScormJourney {
  name: string;
  steps: ScormJourneyStep[];
  expect?: ScormExpectation;
}

export interface ScormSettings {
  version: '1.2' | '2004';
  journeys: ScormJourney[];
  /** Reopen the course after a suspended session and check it asks for its bookmark. */
  checkResume: boolean;
  /** Seconds to let the course run after loading before leaving (journey steps run first). */
  observeSeconds: number;
  launchData?: string;
  masteryScore?: string;
  /** The manifest has sequencing rules, which the harness does not evaluate. */
  hasSequencing?: boolean;
}

export interface ScanConfig {
  projectId: ProjectId;
  target: ScanTarget;
  scope: ScanScope;
  budgets: ScanBudgets;
  viewports: Viewport[];
  engines: EngineSelection;
  actionPolicy: ActionPolicy;
  redaction: RedactionPolicy;
  textRules: TextRules;
  mediaThresholds: MediaThresholds;
  /** Absent on scans made before Phase 4. */
  layout?: LayoutSettings;
  /** Do not request links to other websites (set for uploaded packages, which must not make outside requests). */
  skipExternalLinks?: boolean;
  scorm?: ScormSettings;
  profileId?: ProfileId;
  /** Copy of the profile settings used for this scan, so the report stays true if the profile is edited later. */
  profile?: ProfileSnapshot;
  /** Configuration schema version for migrations and baseline compatibility. */
  configVersion: number;
}

export interface CoverageSummary {
  statesReached: number;
  actionsAttempted: number;
  actionsSkipped: number;
  inaccessibleFrames: number;
  unsupportedSurfaces: number;
  failedTransitions: number;
  budgetsReached: ReasonCode[];
  blockedRequests: number;
  /** Authoring platform recognized on the first page, when known. */
  platform?: 'storyline' | 'unknown';
}

export interface ScanRun {
  id: ScanRunId;
  projectId: ProjectId;
  status: RunStatus;
  /** Reason for `partial`, `failed`, or `cancelled`. */
  statusReason?: ReasonCode;
  statusDetail?: string;
  config: ScanConfig;
  /** Prior run this retest is based on (Phase 5). Runs are immutable. */
  retestOfRunId?: ScanRunId;
  queuedAt: IsoTimestamp;
  startedAt?: IsoTimestamp;
  finishedAt?: IsoTimestamp;
  browser?: BrowserInfo;
  toolVersions: ToolVersion[];
  coverage?: CoverageSummary;
  /** Demo data is flagged and stored separately; never mixed into real totals. */
  isDemo: boolean;
}

/** A frame or rendering surface observed in a state. */
export interface SurfaceInfo {
  kind: SurfaceKind;
  frameUrl?: SanitizedUrl;
  /** Why the surface could not be inspected, if applicable. */
  reason?: ReasonCode;
}

/**
 * An observed course state. SPA courses need more than URLs: the signature
 * combines URL, lesson ID (when observable), open dialogs, selected tabs,
 * and a normalized DOM hash.
 */
export interface CourseState {
  id: StateId;
  runId: ScanRunId;
  url: SanitizedUrl;
  title?: string;
  /** Stable key used for loop detection, fingerprints, and retest matching. */
  signature: string;
  /** Lesson/screen identifier, only when the scanner can actually observe one. */
  lessonId?: string;
  lessonTitle?: string;
  openDialogs: string[];
  selectedTabs: string[];
  depth: number;
  /** Action path from the initial state; empty for the initial state. */
  pathFromRoot: ActionId[];
  surfaces: SurfaceInfo[];
  viewportName: string;
  capturedAt: IsoTimestamp;
}

export interface TraversalAction {
  id: ActionId;
  runId: ScanRunId;
  kind: TraversalActionKind;
  fromStateId: StateId;
  toStateId?: StateId;
  /** Human-readable target description, e.g. `button "Next"`. */
  targetDescription: string;
  /** Robust locator used to replay the action for reproduction steps. */
  locator?: string;
  /** Postcondition the adapter expected, if it defines one. */
  expectedPostcondition?: string;
  outcome: ActionOutcome;
  /** Why the action was skipped or not attempted. */
  reason?: ReasonCode;
  reasonDetail?: string;
  /** Machine-checkable postconditions the adapter declares; all must hold. */
  postconditions?: PostconditionCheck[];
  /** For link navigation: the sanitized destination. */
  href?: string;
  durationMs?: number;
  adapter: string;
}

/**
 * An observable result an adapter expects from an action. The traversal
 * engine evaluates these; adapters never mark their own actions as passed.
 */
export type PostconditionCheck =
  | { type: 'attribute_equals'; locator: string; attribute: string; value: string }
  | { type: 'property_true'; locator: string; property: string }
  | { type: 'visible'; locator: string }
  | { type: 'hidden'; locator: string }
  | { type: 'dialog_count_increases' }
  | { type: 'signature_changes' }
  | { type: 'url_changes' };

export interface Project {
  id: ProjectId;
  name: string;
  description: string;
  /** Published course URL the project is about; scans may target it or other in-scope URLs. */
  courseUrl?: string;
  isDemo: boolean;
  createdAt: IsoTimestamp;
}

/**
 * Totals for one run. Unique rules and executions are separate denominators;
 * `not_tested` and `error` are never folded into passes.
 */
export interface RunSummary {
  uniqueRules: number;
  executions: number;
  byOutcome: Record<CheckOutcome, number>;
  findingsBySeverity: Record<Severity, number>;
  findingsByType: Record<FindingType, number>;
  findingCount: number;
}
