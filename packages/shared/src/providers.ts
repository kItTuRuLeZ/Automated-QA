import type { ArtifactId, RuleId, ScanRunId, StateId, Viewport } from './common.js';
import type { ReasonCode } from './enums.js';
import type { ClientProfile } from './profile.js';
import type { CheckResult, Evidence, Finding, RuleDefinition } from './results.js';
import type { CourseState, ScanBudgets, ScanConfig, TraversalAction } from './scan.js';

/**
 * Provider interfaces only. Implementations live in apps/worker and are added
 * phase by phase. Browser objects are typed as `unknown` here so the shared
 * package has no Playwright dependency; implementations narrow them.
 */

/** Persists evidence and binary artifacts, applying the redaction policy. */
export interface EvidenceSink {
  addEvidence(evidence: Omit<Evidence, 'id' | 'runId'>): Promise<Evidence>;
  writeArtifact(input: { kind: string; mime: string; bytes: Uint8Array }): Promise<ArtifactId>;
}

export interface ProviderContext {
  runId: ScanRunId;
  config: ScanConfig;
  profile?: ClientProfile;
  budgets: ScanBudgets;
  viewport: Viewport;
  state?: CourseState;
  /** Aborted on cancellation or runtime budget exhaustion. */
  signal: AbortSignal;
  evidence: EvidenceSink;
  /** Playwright Page/Frame for the current state, narrowed by implementations. */
  page?: unknown;
}

/** A note about what was or was not covered, shown in reports. */
export interface CoverageNote {
  reason: ReasonCode;
  detail: string;
  stateId?: StateId;
}

export interface EngineError {
  ruleId?: RuleId;
  reason: ReasonCode;
  message: string;
}

/**
 * Output of one engine invocation. Rules the engine owns but did not execute
 * must appear as `not_tested` CheckResults with a reason.
 */
export interface EngineResult {
  engine: string;
  engineVersion: string;
  checkResults: Array<Omit<CheckResult, 'id' | 'runId'>>;
  findings: Array<Omit<Finding, 'id' | 'runId' | 'reviewer' | 'createdAt'>>;
  coverage: CoverageNote[];
  errors: EngineError[];
  durationMs: number;
}

interface BaseProvider {
  readonly id: string;
  readonly version: string;
  /** Rules this provider can produce results for. */
  readonly rules: readonly RuleDefinition[];
}

/** Phase 1: initial load, screenshot, console, network, timing. */
export interface CaptureProvider extends BaseProvider {
  capture(ctx: ProviderContext): Promise<EngineResult>;
}

/** Phase 2: recognizes controls on a platform and defines their expected postconditions. */
export interface CourseAdapter {
  readonly id: string;
  readonly version: string;
  readonly platform: 'generic_html' | 'rise' | 'storyline' | 'custom';
  readonly supportedScenarios: readonly string[];
  /** Confidence that the adapter applies to the current page (0 to 1). */
  detect(ctx: ProviderContext): Promise<number>;
  /** Candidate actions for the current state, including skipped ones with reasons. */
  discoverActions(ctx: ProviderContext): Promise<Array<Omit<TraversalAction, 'id' | 'runId' | 'outcome'>>>;
  /** Computes the state signature used for loop detection. */
  signature(ctx: ProviderContext): Promise<string>;
}

/** Phase 2: bounded, state-aware traversal driven by adapters. */
export interface NavigationProvider extends BaseProvider {
  explore(
    ctx: ProviderContext,
    adapters: readonly CourseAdapter[],
    onState: (state: CourseState) => Promise<void>,
  ): Promise<EngineResult & { states: CourseState[]; actions: TraversalAction[] }>;
}

/** Phase 2: links, media, placeholder and terminology checks on a reached state. */
export interface ContentCheckProvider extends BaseProvider {
  checkState(ctx: ProviderContext): Promise<EngineResult>;
}

/** Phase 3: axe-core and keyboard journeys on a reached state. */
export interface AccessibilityProvider extends BaseProvider {
  checkState(ctx: ProviderContext): Promise<EngineResult>;
}

/** Phase 4: responsive geometry heuristics, performance evidence, baselines. */
export interface LayoutProvider extends BaseProvider {
  checkState(ctx: ProviderContext): Promise<EngineResult>;
}

/** Phase 6: static inspection of an uploaded package. Never executes package code. */
export interface PackageAnalysisProvider extends BaseProvider {
  analyze(input: { packageId: string; signal: AbortSignal; evidence: EvidenceSink }): Promise<EngineResult>;
}

/** Phase 9: storyboard-to-course fidelity comparison. */
export interface ContentComparisonProvider extends BaseProvider {
  compare(input: {
    runId: ScanRunId;
    storyboardId: string;
    states: readonly CourseState[];
    signal: AbortSignal;
    evidence: EvidenceSink;
  }): Promise<EngineResult>;
}

/**
 * Phase 8: optional advisory analysis. The default is `none`. Advisory output
 * only produces `ai_recommendation` findings and never changes CheckResults.
 * Failures must not affect run status.
 */
export interface AdvisoryProvider {
  readonly id: string;
  readonly enabled: boolean;
  review(input: {
    runId: ScanRunId;
    /** Exactly the content the user previewed and confirmed for transfer. */
    confirmedPayload: { text: string[]; artifactIds: ArtifactId[] };
    signal: AbortSignal;
  }): Promise<Pick<EngineResult, 'findings' | 'errors' | 'durationMs'>>;
}

/** Default advisory provider: performs no requests. */
export const NONE_ADVISORY_PROVIDER: AdvisoryProvider = {
  id: 'none',
  enabled: false,
  async review() {
    return { findings: [], errors: [], durationMs: 0 };
  },
};
