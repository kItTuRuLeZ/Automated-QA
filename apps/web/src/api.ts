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
  run: { id: string; targetUrl: string; queuedAt: string; finishedAt?: string; status: ScanRun['status']; statusPlain: string; statusDetail?: string; browser?: string };
  /** Units: fix/check/notChecked count LISTED ISSUES (areas), not check executions. */
  counts: { fix: number; check: number; notChecked: number; bySeverity: Record<Severity, number> };
  coverage: { screensScanned: number; budgetsReached: string[]; blockedRequests: number };
  /** Screens reached, with captured titles. */
  screens: Array<{ label: string; title: string; url: string; depth: number; reachedBy: string; screenshotId?: string }>;
  /** Check EXECUTIONS that did not run, by reason. A different unit from counts.notChecked. */
  untested: Array<{ reason: string; count: number }>;
  checkTotals: { uniqueRules: number; executions: number; passed: number; failed: number; needsReview: number; notApplicable: number; notTested: number; errors: number };
  skippedActions: Array<{ what: string; reason: string; detail?: string }>;
  errors: Array<{ rule: string; detail: string }>;
  scan: { startedAt?: string; finishedAt?: string; scope: { origins: string[]; pathPrefixes: string[] }; budgets: { maxStates: number; maxDepth: number; maxRuntimeSeconds: number }; checksEnabled: string[]; screenSizes: string[]; toolVersions: Array<{ name: string; version: string }>; platform?: string; aiUsed: false; profile?: { name: string } };
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
  scorm?: { version: '1.2' | '2004'; source: string; sessions: Array<{ name: string; kind: string; stepsTotal: number; stepsRun: number; stepFailure?: string; callCount: number; finalStatus: string }>; limitations: string[]; lmsChecklist: Array<{ id: string; title: string; howToCheck: string }> };
  package?: { name: string; launchTitle?: string; launchPoints: number; kind?: string; scormVersionDeclared?: string; inventory?: { files: number; bytes: number }; externalDependencies: Array<{ host: string }>; available: boolean };
  issues: Array<{
    id: string;
    findingId: string;
    url: string;
    category?: string;
    source: 'static' | 'runtime';
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
    technical: { ruleId: string; observed: string; remediation?: string; standards?: string[]; confidence?: string; type?: string };
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

export interface PackageView {
  id: string;
  projectId: string;
  name: string;
  originalFilename: string;
  sizeBytes: number;
  createdAt: string;
  inspection: {
    kind: 'scorm12' | 'scorm2004' | 'scorm_unknown' | 'html5';
    scormVersionDeclared?: string;
    inventory: { files: number; bytes: number; byType: Array<{ type: string; files: number; bytes: number }>; largest: Array<{ path: string; bytes: number }> };
    launchChoices: Array<{ key: string; title: string; path: string }>;
    externalDependencies: Array<{ host: string; urls: string[] }>;
    runtimeReferences?: Array<{ host: string; urls: string[] }>;
    authoringTool?: { tool: 'rise' | 'storyline'; product: string; version?: string; facts: Array<{ label: string; value: string }>; scenarios: string[]; adapterVersion: string; defaultJourney?: { name: string } };
    issues: Array<{ ruleId: string; outcome: 'passed' | 'failed' | 'needs_review' | 'not_applicable' | 'not_tested'; title?: string; detail: string }>;
    limits: string[];
  };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues?: Array<{ path: Array<string | number>; message: string }>,
    /** Rule id or reason the server attached (for example NET-001 for a blocked address). */
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['X-QA-Request'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  // LAN demo mode: a session that ended sends the person back to the sign-in page.
  if (res.status === 401 && url !== '/api/session') {
    window.location.assign('/login');
    throw new ApiError('Sign in again.', 401);
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string; issues?: ApiError['issues']; ruleId?: string; reason?: string };
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data.issues, data.ruleId ?? data.reason);
  return data as T;
}

export const api = {
  session: () => request<{ lan: boolean; user?: string }>('GET', '/api/session'),
  logout: () => request<{ ok: boolean }>('POST', '/api/auth/logout', {}),
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
  capabilities: () => request<Array<{ id: string; name: string; status: 'available' | 'blocked' | 'unavailable' | 'not_included'; detail: string }>>('GET', '/api/capabilities'),
  packageLimits: () => request<{ maxUploadBytes: number; maxEntries: number; maxExpandedBytes: number; maxLessonsPerScan: number; formats: string[] }>('GET', '/api/package-limits'),
  listPackages: (projectId: string) => request<PackageView[]>('GET', `/api/projects/${encodeURIComponent(projectId)}/packages`),
  getPackage: (id: string) => request<PackageView>('GET', `/api/packages/${encodeURIComponent(id)}`),
  uploadPackage: async (projectId: string, file: File) => {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/packages?filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'X-QA-Request': '1', 'Content-Type': 'application/zip' }, body: file });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(data.error ?? `Upload failed (${res.status})`, res.status);
    return data as unknown as PackageView;
  },
  scanPackage: (id: string, input: { launch?: 'all' | string[]; acknowledgeLocalExecution: boolean; allowedExternalOrigins?: string[]; scorm?: { enabled?: boolean; journeys?: Array<{ name: string; steps: Array<{ action: string; target?: string; value?: string; ms?: number }>; expect?: Record<string, unknown> }> } }) =>
    request<{ runs: ScanRun[]; scanned: string[]; notScanned: string[] }>('POST', `/api/packages/${encodeURIComponent(id)}/scans`, input),
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
