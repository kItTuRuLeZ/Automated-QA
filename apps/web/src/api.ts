import type { CheckResult, CourseState, Evidence, Finding, Project, RunSummary, ScanRun, TraversalAction } from '@cqa/shared';

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
      maxStates?: number;
      maxDepth?: number;
    },
  ) => request<ScanRun>('POST', `/api/projects/${encodeURIComponent(projectId)}/scans`, input),
  getRun: (id: string) => request<RunDetail>('GET', `/api/runs/${encodeURIComponent(id)}`),
  cancelRun: (id: string) => request<{ status: ScanRun['status'] }>('POST', `/api/runs/${encodeURIComponent(id)}/cancel`, {}),
  deleteRun: (id: string) => request<void>('DELETE', `/api/runs/${encodeURIComponent(id)}`),
  listFindings: (runId: string) => request<Finding[]>('GET', `/api/runs/${encodeURIComponent(runId)}/findings`),
  listActions: (runId: string) => request<TraversalAction[]>('GET', `/api/runs/${encodeURIComponent(runId)}/actions`),
  listChecks: (runId: string) => request<CheckResult[]>('GET', `/api/runs/${encodeURIComponent(runId)}/checks`),
  getFinding: (id: string) => request<FindingDetail>('GET', `/api/findings/${encodeURIComponent(id)}`),
  artifactUrl: (id: string) => `/api/artifacts/${encodeURIComponent(id)}`,
};
