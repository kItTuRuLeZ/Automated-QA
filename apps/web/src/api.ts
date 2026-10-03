import type { CheckResult, CourseState, Evidence, Finding, Project, RunSummary, ScanRun, Severity, TraversalAction } from '@cqa/shared';

export interface ProjectListItem extends Project {
  runCount: number;
  lastRun?: { id: string; status: ScanRun['status']; queuedAt: string };
}
export type RunWithSummary = ScanRun & { summary: RunSummary };
export type RunDetail = RunWithSummary & { states: CourseState[]; screenshots: Array<{ artifactId: string; caption: string; viewportName?: string; stateId?: string }> };
export interface FindingDetail {
  finding: Finding;
  evidence: Evidence[];
}

export interface RunReport {
  run: { id: string; targetUrl: string; queuedAt: string; finishedAt?: string; status: ScanRun['status']; statusPlain: string };
  counts: { fix: number; check: number; notChecked: number; bySeverity: Record<Severity, number> };
  coverage: { screensScanned: number; budgetsReached: string[]; blockedRequests: number };
  viewports?: Array<{ name: string; width: number; height: number; deviceScaleFactor: number; isMobile: boolean; hasTouch: boolean; screensChecked: number; screensNotReached: number; layoutIssues: number; skipped?: string }>;
  performance?: {
    loadMs: number | null;
    transferredBytes: number;
    requests: number;
    largest: Array<{ url: string; bytes: number }>;
    unavailable: string[];
    conditions: string[];
    thresholds: { loadMs: number; totalBytes: number; requestCount: number; provenance: string };
  };
  baselinesStored: number;
  issues: Array<{
    id: string;
    findingId: string;
    action: 'fix' | 'check' | 'not_checked';
    priority: Severity;
    issue: string;
    change: string;
    screens: string[];
    viewports: string[];
    elements: string[];
    moreElements: number;
    steps: string[];
    screenshotId?: string;
    screenshotKind?: 'element' | 'screen';
    status: string;
    statusReason?: string;
    assignee?: string;
    technical: { ruleId: string; observed: string };
  }>;
}

export interface ProfileForm {
  name: string;
  brand: { approvedFonts: string[]; approvedColors: Array<{ name: string; value: string }>; colorTolerance?: number; minTextSizePx?: number; source: string };
  terminology: Array<{ term: string; preferred?: string }>;
  textExclusions: string[];
  linkPolicy: { checkExternalLinks: boolean; excludedUrlPatterns: string[] };
  viewports: string[];
  thresholds: { loadMs?: number; totalBytes?: number; requestCount?: number };
  scopeRules: { allowedOrigins: string[]; allowedPathPrefixes: string[] };
  ruleExclusions: Array<{ ruleId: string; reason: string }>;
  severityOverrides: Array<{ ruleId: string; severity: string; reason: string }>;
}

/** A saved profile as the API returns it. */
export interface ProfileView extends Omit<ProfileForm, 'brand' | 'viewports' | 'thresholds'> {
  id: string;
  updatedAt: string;
  brand: Omit<ProfileForm['brand'], 'source'> & { provenance?: { note?: string } };
  presets?: { viewports: string[]; thresholds: ProfileForm['thresholds'] };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues?: Array<{ path: Array<string | number>; message: string }>,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['X-QA-Request'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: ApiError['issues'] };
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data.issues);
  return data as T;
}

export const api = {
  listProjects: () => request<ProjectListItem[]>('GET', '/api/projects'),
  createProject: (input: { name: string; description?: string; courseUrl?: string }) => request<Project>('POST', '/api/projects', input),
  getProject: (id: string) => request<Project>('GET', `/api/projects/${encodeURIComponent(id)}`),
  deleteProject: (id: string) => request<void>('DELETE', `/api/projects/${encodeURIComponent(id)}`),
  listRuns: (projectId: string) => request<RunWithSummary[]>('GET', `/api/projects/${encodeURIComponent(projectId)}/runs`),
  createScan: (
    projectId: string,
    input: {
      url: string;
      allowedOrigins?: string[];
      allowedPathPrefixes?: string[];
      navigationTimeoutMs?: number;
      viewport?: { name: string; width: number; height: number };
      explore?: boolean;
      accessibility?: boolean;
      layout?: boolean;
      compareBaseline?: boolean;
      testNonResponsive?: boolean;
      viewports?: Array<'desktop' | 'laptop' | 'tablet' | 'mobile'>;
      maxStates?: number;
      maxDepth?: number;
      terminology?: Array<{ term: string; preferred?: string }>;
      textExclusions?: string[];
      profileId?: string;
    },
  ) => request<ScanRun>('POST', `/api/projects/${encodeURIComponent(projectId)}/scans`, input),
  getRun: (id: string) => request<RunDetail>('GET', `/api/runs/${encodeURIComponent(id)}`),
  cancelRun: (id: string) => request<{ status: ScanRun['status'] }>('POST', `/api/runs/${encodeURIComponent(id)}/cancel`, {}),
  deleteRun: (id: string) => request<void>('DELETE', `/api/runs/${encodeURIComponent(id)}`),
  listFindings: (runId: string) => request<Finding[]>('GET', `/api/runs/${encodeURIComponent(runId)}/findings`),
  setBaseline: (runId: string) => request<{ recorded: number; courseUrl: string }>('POST', `/api/runs/${encodeURIComponent(runId)}/baseline`, {}),
  listProfiles: () => request<ProfileView[]>('GET', '/api/profiles'),
  getProfile: (id: string) => request<ProfileView>('GET', `/api/profiles/${encodeURIComponent(id)}`),
  createProfile: (input: ProfileForm) => request<ProfileView>('POST', '/api/profiles', input),
  updateProfile: (id: string, input: ProfileForm) => request<ProfileView>('PUT', `/api/profiles/${encodeURIComponent(id)}`, input),
  deleteProfile: (id: string) => request<void>('DELETE', `/api/profiles/${encodeURIComponent(id)}`),
  setWorkflow: (findingId: string, input: { status?: string; assignee?: string | null; reason?: string | null }) => request<Finding>('PATCH', `/api/findings/${encodeURIComponent(findingId)}/workflow`, input),
  findingHistory: (findingId: string) => request<Array<{ at: string; actor: string; from: string; to: string; assignee?: string; reason?: string }>>('GET', `/api/findings/${encodeURIComponent(findingId)}/history`),
  retestRun: (runId: string) => request<ScanRun>('POST', `/api/runs/${encodeURIComponent(runId)}/retest`, {}),
  runReport: (runId: string) => request<RunReport>('GET', `/api/runs/${encodeURIComponent(runId)}/report`),
  listActions: (runId: string) => request<TraversalAction[]>('GET', `/api/runs/${encodeURIComponent(runId)}/actions`),
  listChecks: (runId: string) => request<CheckResult[]>('GET', `/api/runs/${encodeURIComponent(runId)}/checks`),
  getFinding: (id: string) => request<FindingDetail>('GET', `/api/findings/${encodeURIComponent(id)}`),
  manualChecklist: () => request<{ disclaimer: string; items: Array<{ id: string; title: string; howToCheck: string; whyManual: string; standards?: string[] }> }>('GET', '/api/manual-checklist'),
  artifactUrl: (id: string) => `/api/artifacts/${encodeURIComponent(id)}`,
};
