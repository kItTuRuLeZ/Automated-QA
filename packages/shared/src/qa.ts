/**
 * Contracts for the functional-QA layer: durable run progress, an honest course inventory, reusable test definitions,
 * test executions and reviewer decisions. Everything here is recorded from a real event, an executed test, or a person's
 * decision. Nothing is derived from a timer or a guess.
 */

// ---- run lifecycle ----

/** Where a run is. Separate from the run's terminal status: a finished run can still have coverage gaps. */
export const RUN_STAGES = ['queued', 'validating', 'discovering', 'running', 'finalizing', 'completed', 'completed_with_gaps', 'failed', 'cancelled'] as const;
export type RunStage = (typeof RUN_STAGES)[number];
export const TERMINAL_STAGES: readonly RunStage[] = ['completed', 'completed_with_gaps', 'failed', 'cancelled'];

export const RUN_EVENT_TYPES = [
  'stage_changed',
  'unit_discovered',
  'unit_entered',
  'interaction_discovered',
  'test_started',
  'test_finished',
  'path_blocked',
  'note',
  'run_finalized',
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export interface RunEvent {
  runId: string;
  /** Strictly increasing per run. Consumers ignore anything at or below the last sequence they applied. */
  seq: number;
  at: string;
  type: RunEventType;
  payload: Record<string, unknown>;
}

/** What the progress panel shows. Always a snapshot of persisted counters, never a client-side estimate. */
export interface RunProgress {
  runId: string;
  stage: RunStage;
  /** Plain text such as "Opening Module 2". */
  activity?: string;
  currentUnitId?: string;
  currentTestId?: string;
  inventoryRevision: number;
  counters: ProgressCounters;
  lastSeq: number;
  startedAt?: string;
  /** The worker's last sign of life. */
  heartbeatAt?: string;
  updatedAt: string;
}

export interface ProgressCounters {
  unitsDiscovered: number;
  unitsVisited: number;
  interactionsDiscovered: number;
  testsPassed: number;
  testsFailed: number;
  testsBlocked: number;
  testsErrored: number;
  testsSkipped: number;
  testsManual: number;
  testsPending: number;
  testsRunning: number;
}

export const EMPTY_COUNTERS: ProgressCounters = {
  unitsDiscovered: 0,
  unitsVisited: 0,
  interactionsDiscovered: 0,
  testsPassed: 0,
  testsFailed: 0,
  testsBlocked: 0,
  testsErrored: 0,
  testsSkipped: 0,
  testsManual: 0,
  testsPending: 0,
  testsRunning: 0,
};

// ---- inventory ----

/** Rise uses lesson and block, Storyline uses scene and slide, with layer and state beneath. */
export const UNIT_KINDS = ['sco', 'lesson', 'block', 'scene', 'slide', 'layer', 'state', 'screen'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

export const DISCOVERY_SOURCES = ['manifest', 'authoring_export', 'player_menu', 'runtime'] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];
export type UnitConfidence = 'high' | 'medium' | 'low';

/** A content unit: something a learner can be shown. Separate from interaction instances and execution states. */
export interface ContentUnit {
  id: string;
  runId: string;
  kind: UnitKind;
  title: string;
  /** True when no title was available and a readable fallback was used. Titles are never invented. */
  titleIsFallback: boolean;
  /** The identifier the source uses (manifest item id, Rise lesson id, Storyline slide id), when there is one. */
  sourceId?: string;
  parentId?: string;
  source: DiscoverySource;
  confidence: UnitConfidence;
  /** The inventory revision in which this unit first appeared. */
  revision: number;
  discoveredAt: string;
  /** Set when a browser actually showed this unit. Discovery alone never sets it. */
  visitedAt?: string;
  visitedStateIds: string[];
  /** Why a known unit was not reached, when known. */
  notReachedReason?: string;
  order: number;
}

export const INTERACTION_TYPES = [
  'next',
  'previous',
  'menu',
  'tab',
  'accordion',
  'details',
  'dialog',
  'hotspot',
  'click_reveal',
  'flip_card',
  'timeline',
  'carousel',
  'mcq',
  'msq',
  'dnd',
  'text_input',
  'slider',
  'audio',
  'video',
  'link',
  'resource',
  'required_item_group',
  'unknown_control',
] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

/** A concrete control or group of controls on a unit that tests can act on. */
export interface InteractionInstance {
  id: string;
  runId: string;
  unitId: string;
  type: InteractionType;
  label: string;
  /** A robust locator the runner can use. Never shown as the normal way to identify an item. */
  locator?: string;
  confidence: UnitConfidence;
  /** Capabilities an adapter really implements for this instance ("activate", "observe_expanded", ...). Empty means manual only. */
  capabilities: string[];
  detectedBy: string;
}

// ---- test definitions ----

export const TEST_STATUSES = ['pending', 'running', 'passed', 'failed', 'blocked', 'error', 'skipped', 'not_applicable', 'manual_review_required'] as const;
export type TestStatus = (typeof TEST_STATUSES)[number];
/** Statuses that count as an executed result. Everything else is a gap. */
export const EXECUTED_STATUSES: readonly TestStatus[] = ['passed', 'failed'];

export const AUTOMATION_CLASSES = ['automated', 'partially_automated', 'manual'] as const;
export type AutomationClass = (typeof AUTOMATION_CLASSES)[number];

export const REVIEW_STATES = ['starter', 'draft', 'reviewed', 'approved', 'retired'] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const EXPECTATION_SOURCES = ['approved_case', 'specification', 'extracted_metadata', 'starter_baseline', 'observed_hypothesis'] as const;
export type ExpectationSource = (typeof EXPECTATION_SOURCES)[number];

/** Constrained, data-only steps. Imported cases can never carry code. */
export type TestAction =
  | { kind: 'open_launch' }
  | { kind: 'activate'; target: string; times?: number }
  | { kind: 'activate_all'; group: string; order?: 'listed' | 'reverse' | 'shuffle'; skip?: string[] }
  | { kind: 'press_key'; key: string }
  | { kind: 'wait'; ms: number }
  | { kind: 'reload' }
  | { kind: 'reset'; policy: 'fresh_context' | 'reload' | 'none' }
  | { kind: 'observe'; note?: string }
  | { kind: 'manual'; instruction: string };

export type TestAssertion =
  | { kind: 'visible'; target: string }
  | { kind: 'hidden'; target: string }
  | { kind: 'enabled'; target: string }
  | { kind: 'disabled'; target: string }
  | { kind: 'expanded'; target: string; value: boolean }
  | { kind: 'selected'; target: string; value: boolean }
  | { kind: 'text_contains'; target: string; text: string }
  | { kind: 'url_changes' }
  | { kind: 'event_fires'; event: string; withinMs: number }
  | { kind: 'event_absent'; event: string; observeMs: number }
  | { kind: 'manual_review'; question: string };

export interface TestDefinitionBody {
  preconditions: string[];
  /** Plain words describing when the case applies, shown to reviewers. */
  applicability: string;
  actions: TestAction[];
  assertions: TestAssertion[];
  inputData?: Record<string, string>;
  resetPolicy: 'fresh_context' | 'reload' | 'none';
  timeoutMs: number;
  expectedResult: string;
  expectationSource: ExpectationSource;
  evidence: string[];
  /** The adapter capability the automation needs, or empty for manual cases. */
  requiredCapability?: string;
  courseTypes: string[];
  environments: string[];
}

export interface TestDefinition {
  /** Internal, stable. */
  id: string;
  /** The team's own ID when one was imported. Preserved exactly. */
  externalId?: string;
  version: number;
  title: string;
  category: string;
  interactionType: InteractionType | 'general';
  severity: 'critical' | 'high' | 'medium' | 'low';
  priority: 1 | 2 | 3;
  automation: AutomationClass;
  reviewState: ReviewState;
  body: TestDefinitionBody;
  /** "starter" for the seeded baseline, "import" for team cases, "user" for hand-written ones. */
  origin: 'starter' | 'import' | 'user';
  createdAt: string;
  updatedAt: string;
}

export interface TestDefinitionChange {
  definitionId: string;
  version: number;
  at: string;
  actor: string;
  note: string;
  snapshot: TestDefinition;
}

// ---- executions ----

export interface TestExecution {
  id: string;
  runId: string;
  definitionId: string;
  definitionVersion: number;
  externalId?: string;
  unitId?: string;
  instanceId?: string;
  /** The state or path the case ran in. */
  statePath?: string;
  attempt: number;
  status: TestStatus;
  /** Required for every status other than passed. */
  reason?: string;
  expected?: string;
  expectedSource?: ExpectationSource;
  actual?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Ordered trace of what the runner did: entered, acted, observed, asserted. */
  trace: ExecutionTraceStep[];
  evidenceIds: string[];
  /** "static" results never claim functional behaviour was tested. */
  scope: 'static' | 'functional';
  /** Hashes recorded so a later run on changed content cannot inherit this result. */
  contentHash?: string;
  configHash?: string;
  engineVersion?: string;
}

export interface ExecutionTraceStep {
  at: string;
  step: 'entered_unit' | 'action' | 'observed' | 'asserted' | 'note';
  detail: string;
  data?: Record<string, unknown>;
}

// ---- behavior rules ----

export const RULE_EVENTS = ['next_enabled', 'message_shown', 'layer_opened', 'navigation_changed', 'progress_changed', 'completion_emitted'] as const;
export type RuleEvent = (typeof RULE_EVENTS)[number];

/** "After every required item has been visited, enable Next." Entered by a reviewer in a form, not as code. */
export interface BehaviorRule {
  id: string;
  projectId: string;
  title: string;
  /** Which content unit the rule applies to (a title or source id fragment), or empty for the launch page. */
  unitMatch: string;
  /** Items the learner must activate. Each is a visible label or a locator the reviewer picked. */
  requiredItems: RuleItem[];
  optionalItems: RuleItem[];
  prerequisites: string[];
  expectedEvent: RuleEvent;
  /** What the event is observed on (a label, locator, or text). */
  eventTarget: string;
  timingWindowMs: number;
  orderPolicy: 'any_order' | 'sequence';
  repeatPolicy: 'once' | 'repeatable';
  resetPolicy: 'fresh_context' | 'reload' | 'none';
  /** The expected destination after the event, when the rule has one. */
  destination?: string;
  expectationSource: ExpectationSource;
  reviewState: ReviewState;
  createdAt: string;
  updatedAt: string;
}

export interface RuleItem {
  label: string;
  locator?: string;
}

// ---- review ----

export const DISPOSITIONS = ['accepted', 'false_positive', 'retest_requested', 'manual_pass', 'manual_fail'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** A person's decision. It sits beside the automated result and never replaces it. */
export interface ReviewDisposition {
  id: string;
  runId: string;
  targetKind: 'execution' | 'finding' | 'unit';
  targetId: string;
  decision: Disposition;
  actor: string;
  reason: string;
  /** The automated status at the time, so the original result is never lost. */
  originalStatus: string;
  note?: string;
  createdAt: string;
}

// ---- derived screen status ----

export const SCREEN_STATUSES = ['not_tested', 'in_progress', 'issues_found', 'needs_manual_review', 'passed_automated'] as const;
export type ScreenStatus = (typeof SCREEN_STATUSES)[number];

export const SCREEN_BADGES = ['partially_checked', 'runtime_not_visited', 'manual_checks_pending', 'static_only', 'blocked_checks', 'runner_errors', 'reviewer_decision'] as const;
export type ScreenBadge = (typeof SCREEN_BADGES)[number];
