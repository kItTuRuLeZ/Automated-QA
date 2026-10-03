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
  ReasonCode,
  RunStatus,
  SurfaceKind,
  TargetKind,
  TraversalActionKind,
} from './enums.js';

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

export interface ScanTarget {
  kind: TargetKind;
  /** For `url` targets: user-supplied URL (validated, never contains credentials). */
  url?: string;
  /** For `package` targets (Phase 6): uploaded package reference and chosen launch entry. */
  packageId?: string;
  launchEntry?: string;
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
  profileId?: ProfileId;
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
  durationMs?: number;
  adapter: string;
}
