import type { BehaviorRule, ContentUnit, InteractionInstance, ReviewDisposition, RunEvent, RunProgress, ScreenBadge, ScreenStatus, TestDefinition, TestExecution } from '@cqa/shared';
import { request } from './api';

/** Shapes the server returns for the functional-QA layer. Numbers are always stored ones, with their denominators. */
export type Ratio = { available: true; numerator: number; denominator: number; percent: number } | { available: false; reason: string };

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
  notApplicableWithoutReason: number;
}

export interface ScreenResult {
  unitId: string;
  status: ScreenStatus;
  badges: ScreenBadge[];
  counts: StatusCounts;
  scope: 'none' | 'static' | 'functional';
  reasons: string[];
  reviewerDecision?: ReviewDisposition;
}

export interface CoverageSummary {
  discovery: { completeness: 'complete' | 'partial' | 'unknown'; reason: string; byConfidence: Record<'high' | 'medium' | 'low', number>; bySource: Record<string, number>; revision: number };
  visit: Ratio;
  execution: Ratio;
  passRate: Ratio;
  interactions: { total: number; exercised: Ratio };
  manual: { outstanding: number; manualOnlyCases: number };
  listedNotTracked: number;
  gaps: { blocked: number; errored: number; skipped: number; pending: number; unitsNotVisited: number; unitsNotReached: Array<{ id: string; title: string; reason: string }> };
  counts: StatusCounts;
  statement: string;
}

export type ProgressResponse =
  | { recorded: false; note: string; run: { status: string } }
  | { recorded: true; progress: RunProgress; run: { status: string; statusDetail?: string }; stalled: boolean; silentSeconds: number; stallSeconds: number; serverTime: string };

export interface ScreenRow {
  unit: ContentUnit;
  primary: boolean;
  result?: ScreenResult;
  interactions: number;
}
export type InventoryResponse = { recorded: false; note: string } | { recorded: true; revision: number; units: ScreenRow[]; coverage: CoverageSummary; unitNoun: { singular: string; plural: string } };

export type ExecutionRow = TestExecution & { definition?: { title: string; category: string; automation: string; reviewState?: string }; decisions?: ReviewDisposition[] };

export interface UnitDetail {
  unit: ContentUnit;
  result: ScreenResult;
  interactions: InteractionInstance[];
  findings: Array<{ id: string; ruleId: string; severity: string; type: string; title: string; observed: string; expected: string; remediation: string; status: string }>;
  executions: ExecutionRow[];
  decisions: ReviewDisposition[];
  attempts: number;
}

export type LibraryCase = TestDefinition & { effectiveAutomation: string };

export interface ImportPreview {
  headers: string[];
  mapping: Record<string, string>;
  columns: string[];
  summary: { rows: number; new: number; duplicates: number; invalid: number };
  rows: Array<{ row: number; id: string; externalId?: string; status: 'new' | 'duplicate' | 'invalid'; problems: string[]; title?: string; existing?: { id: string; version: number; title: string } }>;
}

export const qaApi = {
  progress: (runId: string) => request<ProgressResponse>('GET', `/api/runs/${encodeURIComponent(runId)}/progress`),
  events: (runId: string, after: number) => request<{ events: RunEvent[]; lastSeq: number }>('GET', `/api/runs/${encodeURIComponent(runId)}/events?after=${after}`),
  inventory: (runId: string) => request<InventoryResponse>('GET', `/api/runs/${encodeURIComponent(runId)}/inventory`),
  unit: (runId: string, unitId: string) => request<UnitDetail>('GET', `/api/runs/${encodeURIComponent(runId)}/units/${encodeURIComponent(unitId)}`),
  evidence: (runId: string, ids: string[]) => request<Array<{ id: string; kind: string; caption: string; artifactId?: string; capturedAt: string }>>('GET', `/api/runs/${encodeURIComponent(runId)}/evidence?ids=${ids.join(',')}`),
  courseWide: (runId: string) => request<ExecutionRow[]>('GET', `/api/runs/${encodeURIComponent(runId)}/course-wide`),
  executions: (runId: string, history = false) => request<{ executions: ExecutionRow[] }>('GET', `/api/runs/${encodeURIComponent(runId)}/executions${history ? '?history=1' : ''}`),
  decide: (runId: string, body: { targetKind: 'execution' | 'finding' | 'unit'; targetId: string; decision: string; reason: string; actor?: string }) => request<ReviewDisposition>('POST', `/api/runs/${encodeURIComponent(runId)}/dispositions`, body),
  library: () => request<{ definitions: LibraryCase[]; total: number }>('GET', '/api/test-library'),
  libraryCase: (id: string) => request<{ definition: LibraryCase; history: Array<{ version: number; at: string; actor: string; note: string; title: string; reviewState: string }>; steps: string }>('GET', `/api/test-library/${encodeURIComponent(id)}`),
  saveCase: (id: string, definition: unknown, actor: string, note: string) => request<LibraryCase>('PUT', `/api/test-library/${encodeURIComponent(id)}`, { definition, actor, note }),
  createCase: (definition: unknown, actor: string) => request<LibraryCase>('POST', '/api/test-library', { definition, actor }),
  previewImport: (body: { format: 'csv' | 'json' | 'xlsx'; content: string; mapping?: Record<string, string> }) => request<ImportPreview>('POST', '/api/test-library/import/preview', body),
  commitImport: (body: { format: 'csv' | 'json' | 'xlsx'; content: string; mapping?: Record<string, string>; duplicates: 'skip' | 'replace'; actor?: string }) => request<{ created: number; replaced: number; skipped: number; invalid: number }>('POST', '/api/test-library/import/commit', body),
  rules: (projectId: string) => request<BehaviorRule[]>('GET', `/api/projects/${encodeURIComponent(projectId)}/behavior-rules`),
  saveRule: (projectId: string, rule: Record<string, unknown>, id?: string) => (id ? request<BehaviorRule>('PUT', `/api/behavior-rules/${encodeURIComponent(id)}`, rule) : request<BehaviorRule>('POST', `/api/projects/${encodeURIComponent(projectId)}/behavior-rules`, rule)),
  deleteRule: (id: string) => request<void>('DELETE', `/api/behavior-rules/${encodeURIComponent(id)}`),
  discovered: (projectId: string) => request<{ runId?: string; units: Array<{ id: string; title: string }>; items: Array<{ id: string; unitId: string; unitTitle: string; type: string; label: string; locator?: string; canBeActivated: boolean }> }>('GET', `/api/projects/${encodeURIComponent(projectId)}/discovered-items`),
};

export const SCREEN_STATUS_LABEL: Record<ScreenStatus, string> = {
  not_tested: 'Not tested',
  in_progress: 'In progress',
  issues_found: 'Issues found',
  needs_manual_review: 'Needs manual review',
  passed_automated: 'Passed automated checks',
};

export const BADGE_LABEL: Record<ScreenBadge, string> = {
  partially_checked: 'Partially checked',
  runtime_not_visited: 'Not visited by a browser',
  manual_checks_pending: 'Manual checks pending',
  static_only: 'Static checks only',
  blocked_checks: 'Blocked checks',
  runner_errors: 'Runner errors',
  reviewer_decision: 'Reviewer decision recorded',
};

export const TEST_STATUS_LABEL: Record<string, string> = {
  pending: 'Not run yet',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  error: 'Runner error',
  skipped: 'Skipped',
  not_applicable: 'Not applicable',
  manual_review_required: 'Needs manual review',
};
