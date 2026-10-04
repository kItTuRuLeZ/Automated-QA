import type { CourseState, Finding, ReviewerStatus, ScanRun, Severity, TraversalAction } from '@cqa/shared';
import type { Store } from './db/store.js';
import { ACTION_LABEL, type IssueAction, plainFinding } from './plain-language.js';

/**
 * One canonical, plain-language model of a scan. The UI summary and the Excel
 * export are both built from this, so their totals always match.
 */
export interface ReportIssue {
  /** Stable across scans of the same page and problem, so it can be tracked. */
  id: string;
  /** Rule category (accessibility, links, layout, …). */
  category: string;
  /** `static` for results read from a package's files (no code was run); `runtime` for everything observed in the browser. */
  source: 'static' | 'runtime';
  /** True for AI-written recommendations; reported separately and never counted with checked results. */
  advisory: boolean;
  /** Why the reviewer status is what it is (required for accepted risk and false positive). */
  statusReason?: string;
  assignee?: string;
  findingId: string;
  action: IssueAction;
  priority: Severity;
  issue: string;
  change: string;
  /** Screens (S1, S2, …) the problem appears on. */
  screens: string[];
  /** Screen sizes (viewport names) at which it was observed. */
  viewports: string[];
  /** Up to three affected elements, plus a count of the rest. */
  elements: string[];
  moreElements: number;
  steps: string[];
  url: string;
  /** Artifact id of the best screenshot: a crop with the element outlined if there is one, else the whole screen. */
  screenshotId?: string;
  screenshotKind?: 'element' | 'screen';
  status: ReviewerStatus;
  technical: { ruleId: string; observed: string; remediation: string; standards: string[]; confidence: string; type: string };
  foundAt: string;
}

export interface ReportScreen {
  label: string;
  title: string;
  url: string;
  depth: number;
  reachedBy: string;
  screenshotId?: string;
}

export interface ReportViewport {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  /** Screens checked at this size, and screens that could not be reached again at it. */
  screensChecked: number;
  screensNotReached: number;
  layoutIssues: number;
  /** Why this size was not tested at all (for example a non-responsive Storyline course). */
  skipped?: string;
}

export interface ReportPerformance {
  loadMs: number | null;
  transferredBytes: number;
  requests: number;
  largest: Array<{ url: string; bytes: number }>;
  unavailable: string[];
  conditions: string[];
  thresholds: { loadMs: number; totalBytes: number; requestCount: number; provenance: string };
}

export interface ReportPackage {
  name: string;
  /** Which lesson (launch point) this scan opened. */
  launchTitle?: string;
  launchPoints: number;
  kind?: string;
  scormVersionDeclared?: string;
  inventory?: { files: number; bytes: number; byType: Array<{ type: string; files: number; bytes: number }>; largest: Array<{ path: string; bytes: number }> };
  externalDependencies: Array<{ host: string; urls: string[] }>;
  /** Whether the uploaded package still exists; its inventory is gone with it. */
  available: boolean;
}

export interface RunReport {
  run: { id: string; targetUrl: string; queuedAt: string; finishedAt?: string; status: ScanRun['status']; statusPlain: string; statusDetail?: string; browser?: string };
  counts: { fix: number; check: number; notChecked: number; bySeverity: Record<Severity, number> };
  screens: ReportScreen[];
  issues: ReportIssue[];
  /** Present when screen-size checks were on. These are viewport simulations, not real devices. */
  viewports?: ReportViewport[];
  performance?: ReportPerformance;
  baselinesStored: number;
  /** Checks that did not run, grouped by reason (never counted as passed). */
  untested: Array<{ reason: string; count: number }>;
  /** How the scan was configured, when it ran, and with which tools. */
  scan: {
    startedAt?: string;
    finishedAt?: string;
    scope: { origins: string[]; pathPrefixes: string[] };
    budgets: { maxStates: number; maxDepth: number; maxRuntimeSeconds: number };
    checksEnabled: string[];
    screenSizes: string[];
    toolVersions: Array<{ name: string; version: string }>;
    platform?: string;
    aiUsed: false;
    /** Client profile used for this scan, if any (a person's settings, not built-in rules). */
    profile?: { name: string; brandSource?: string; rulesSwitchedOff: Array<{ ruleId: string; reason: string }>; severityChanges: Array<{ ruleId: string; severity: string; reason: string }> };
  };
  /** Present for scans of an uploaded package: what it contains, kept apart from what the browser observed. */
  package?: ReportPackage;
  /** Findings by rule category, grouped by what to do about them. */
  byCategory: Array<{ category: string; fix: number; check: number; notChecked: number }>;
  /** Controls and areas the scanner skipped, with the reason. Skipped is not passed. */
  skippedActions: Array<{ what: string; reason: string; detail?: string }>;
  /** Checks that hit an error (not a result about the course). */
  errors: Array<{ rule: string; detail: string }>;
  /** AI-written recommendations, kept separate from deterministic findings. */
  advisory: ReportIssue[];
  coverage: { screensScanned: number; budgetsReached: string[]; blockedRequests: number };
  checkTotals: { uniqueRules: number; executions: number; passed: number; failed: number; needsReview: number; notApplicable: number; notTested: number; errors: number };
}

const SEVERITY_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 };
const ACTION_ORDER: Record<IssueAction, number> = { fix: 0, check: 1, not_checked: 2 };

const STATUS_PLAIN: Record<ScanRun['status'], string> = {
  queued: 'Waiting to start',
  running: 'In progress',
  completed: 'Finished',
  partial: 'Finished, but not everything could be checked',
  failed: 'Could not scan the course',
  cancelled: 'Cancelled',
};

/** Short ID that stays the same when the same problem is found again. */
export function stableIssueId(fingerprint: string): string {
  return `QA-${fingerprint.slice(0, 6).toUpperCase()}`;
}

function reachedBy(state: CourseState, actions: Map<string, TraversalAction>): string {
  const steps = state.pathFromRoot.map((id) => actions.get(id)).filter((a): a is TraversalAction => Boolean(a));
  if (steps.length === 0) return 'Opening page';
  return steps.map((a) => a.targetDescription.replace(/^(link|tab|expandable section|dialog opener|dialog close control|Next control|Back control|button) /, '')).join(' › ');
}

function shortSteps(steps: string[]): string[] {
  // Long element selectors stay in the technical details; the steps stay short enough to follow.
  return steps.filter((s) => !s.startsWith('Affected element:')).map((s) => s.replace(/^Open (.+?) in Chromium.*$/, 'Open $1'));
}

export function buildRunReport(store: Store, runId: string): RunReport {
  const run = store.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  const states = store.listStates(runId);
  const actions = new Map(store.listActions(runId).map((a) => [a.id as string, a]));
  const findings = store.listFindings(runId);
  const summary = store.summarizeRun(runId);

  const screenIndex = new Map(states.map((s, i) => [s.id as string, i + 1]));
  // First screenshot of each screen, used when a finding has no screenshot of its own.
  const stateShots = new Map<string, string>();
  for (const e of store.listEvidenceByKind(runId, 'screenshot')) if (e.artifactId && e.stateId && !stateShots.has(e.stateId as string)) stateShots.set(e.stateId as string, e.artifactId as string);
  const screens: ReportScreen[] = states.map((s, i) => ({
    label: `S${i + 1}`,
    // Some courses set machine-made page titles (long strings with no spaces); describe the screen by how it was reached instead.
    title: s.title && !/^\S{16,}$/.test(s.title) ? s.title : s.lessonId || reachedBy(s, actions) || new URL(s.url).pathname,
    url: s.url,
    depth: s.depth,
    reachedBy: reachedBy(s, actions),
    screenshotId: stateShots.get(s.id as string),
  }));

  const issues: ReportIssue[] = findings.map((f) => toIssue(f, screenIndex, run.config.target.url ?? '', store, stateShots));
  issues.sort((a, b) => ACTION_ORDER[a.action] - ACTION_ORDER[b.action] || SEVERITY_ORDER[a.priority] - SEVERITY_ORDER[b.priority] || a.issue.localeCompare(b.issue));

  const bySeverity = Object.fromEntries((Object.keys(SEVERITY_ORDER) as Severity[]).map((s) => [s, 0])) as Record<Severity, number>;
  for (const i of issues) if (i.action === 'fix' && !i.advisory) bySeverity[i.priority]++;

  const reasons = new Map<string, number>();
  for (const c of store.listCheckResults(runId)) {
    if ((c.outcome === 'not_tested' || c.outcome === 'error') && c.reason) reasons.set(c.reason, (reasons.get(c.reason) ?? 0) + 1);
  }

  const layoutOn = run.config.engines.layout;
  const layoutChecks = layoutOn ? store.listCheckResults(runId).filter((c) => c.ruleId === 'LAY-001') : [];
  const viewports: ReportViewport[] | undefined = layoutOn
    ? run.config.viewports.map((v) => ({
        name: v.name,
        width: v.width,
        height: v.height,
        deviceScaleFactor: v.deviceScaleFactor,
        isMobile: v.isMobile,
        hasTouch: v.hasTouch,
        screensChecked: layoutChecks.filter((c) => c.viewportName === v.name && (c.outcome === 'passed' || c.outcome === 'needs_review')).length,
        screensNotReached: layoutChecks.filter((c) => c.viewportName === v.name && c.outcome === 'not_tested').length,
        layoutIssues: issues.filter((i) => i.viewports.includes(v.name) && /^LAY-/.test(i.technical.ruleId)).length,
        skipped: layoutChecks.find((c) => c.viewportName === v.name && c.outcome === 'not_applicable')?.reasonDetail,
      }))
    : undefined;
  const timing = run.config.engines.performance ? store.listEvidenceByKind(runId, 'timing').find((e) => e.data && 'thresholds' in e.data) : undefined;
  const performance: ReportPerformance | undefined = timing?.data
    ? {
        loadMs: (timing.data.loadMs as number | null) ?? null,
        transferredBytes: Number(timing.data.transferredBytes ?? 0),
        requests: Number(timing.data.requests ?? 0),
        largest: ((timing.data.largest as Array<{ url: string; bytes: number }>) ?? []).slice(0, 3),
        unavailable: (timing.data.unavailable as string[]) ?? [],
        conditions: (timing.data.conditions as string[]) ?? [],
        thresholds: timing.data.thresholds as ReportPerformance['thresholds'],
      }
    : undefined;

  const engineNames: Array<[keyof typeof run.config.engines, string]> = [
    ['capture', 'first page'],
    ['traversal', 'click-through'],
    ['links', 'links'],
    ['media', 'images and media'],
    ['content', 'placeholder text'],
    ['accessibility', 'accessibility'],
    ['keyboard', 'keyboard'],
    ['layout', 'screen sizes and layout'],
    ['performance', 'page load'],
    ['visualBaseline', 'baseline comparison'],
    ['brand', 'brand (from client profile)'],
  ];
  const allChecks = store.listCheckResults(runId);
  const axeVersion = allChecks.find((c) => c.engineVersion)?.engineVersion;
  const toolVersions = [...run.toolVersions, ...(axeVersion && !run.toolVersions.some((t) => axeVersion.startsWith(t.name)) ? [{ name: axeVersion.split(' ')[0]!, version: axeVersion.split(' ').slice(1).join(' ') }] : [])];
  const categories = new Map<string, { fix: number; check: number; notChecked: number }>();
  for (const i of issues) {
    if (i.advisory) continue;
    const c = categories.get(i.category) ?? { fix: 0, check: 0, notChecked: 0 };
    if (i.action === 'fix') c.fix++;
    else if (i.action === 'check') c.check++;
    else c.notChecked++;
    categories.set(i.category, c);
  }
  const skippedActions = [...actions.values()]
    .filter((a) => a.outcome === 'skipped' || a.outcome === 'not_attempted')
    .slice(0, 200)
    .map((a) => ({ what: a.targetDescription, reason: a.reason ?? 'skipped', detail: a.reasonDetail }));
  const errors = allChecks.filter((c) => c.outcome === 'error').slice(0, 100).map((c) => ({ rule: c.ruleId, detail: c.reasonDetail ?? c.reason ?? 'error' }));
  const advisory = issues.filter((i) => i.advisory);
  const core = issues.filter((i) => !i.advisory);

  return {
    run: {
      id: run.id,
      targetUrl: run.config.target.url ?? '',
      queuedAt: run.queuedAt,
      finishedAt: run.finishedAt,
      status: run.status,
      statusPlain: STATUS_PLAIN[run.status],
      statusDetail: run.statusDetail,
      browser: run.browser ? `${run.browser.engine} ${run.browser.version}` : undefined,
    },
    counts: { fix: core.filter((i) => i.action === 'fix').length, check: core.filter((i) => i.action === 'check').length, notChecked: core.filter((i) => i.action === 'not_checked').length, bySeverity },
    screens,
    issues: core,
    advisory,
    scan: {
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      scope: { origins: run.config.scope.allowedOrigins, pathPrefixes: run.config.scope.allowedPathPrefixes },
      budgets: { maxStates: run.config.budgets.maxStates, maxDepth: run.config.budgets.maxDepth, maxRuntimeSeconds: Math.round(run.config.budgets.maxRuntimeMs / 1000) },
      checksEnabled: engineNames.filter(([k]) => run.config.engines[k]).map(([, label]) => label),
      screenSizes: run.config.viewports.map((v) => `${v.name} ${v.width}×${v.height}`),
      toolVersions,
      platform: run.coverage?.platform,
      aiUsed: false,
      profile: run.config.profile
        ? { name: run.config.profile.name, brandSource: run.config.profile.brand.provenance?.note, rulesSwitchedOff: run.config.profile.ruleExclusions, severityChanges: run.config.profile.severityOverrides.map((o) => ({ ruleId: o.ruleId, severity: o.severity, reason: o.reason })) }
        : undefined,
    },
    package: packageSection(store, run),
    byCategory: [...categories.entries()].map(([category, c]) => ({ category, ...c })).sort((a, b) => b.fix - a.fix || a.category.localeCompare(b.category)),
    skippedActions,
    errors,
    viewports,
    performance,
    baselinesStored: store.countBaselines(run.projectId, run.config.target.url ?? ''),
    untested: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    coverage: { screensScanned: states.length, budgetsReached: run.coverage?.budgetsReached ?? [], blockedRequests: run.coverage?.blockedRequests ?? 0 },
    checkTotals: {
      uniqueRules: summary.uniqueRules,
      executions: summary.executions,
      passed: summary.byOutcome.passed,
      failed: summary.byOutcome.failed,
      needsReview: summary.byOutcome.needs_review,
      notApplicable: summary.byOutcome.not_applicable,
      notTested: summary.byOutcome.not_tested,
      errors: summary.byOutcome.error,
    },
  };
}

function pickScreenshot(f: Finding, stateIds: string[], store: Store, stateShots: Map<string, string>): { id?: string; kind?: 'element' | 'screen' } {
  const ids = [...new Set([...f.evidenceIds, ...f.occurrences.flatMap((o) => o.evidenceIds)])];
  const evidence = store.getEvidence(ids).filter((e) => e.artifactId);
  const element = evidence.find((e) => e.kind === 'annotated_screenshot');
  if (element?.artifactId) return { id: element.artifactId, kind: 'element' };
  const own = evidence.find((e) => e.kind === 'screenshot');
  if (own?.artifactId) return { id: own.artifactId, kind: 'screen' };
  for (const sid of stateIds) {
    const shot = stateShots.get(sid);
    if (shot) return { id: shot, kind: 'screen' };
  }
  return {};
}

function toIssue(f: Finding, screenIndex: Map<string, number>, fallbackUrl: string, store: Store, stateShots: Map<string, string>): ReportIssue {
  const plain = plainFinding(f);
  const stateIds = [f.location.stateId, ...f.occurrences.map((o) => o.location.stateId)].filter((x): x is NonNullable<typeof x> => Boolean(x));
  const screens = [...new Set(stateIds.map((id) => screenIndex.get(id as string)).filter((n): n is number => n !== undefined))].sort((a, b) => a - b).map((n) => `S${n}`);
  const shot = pickScreenshot(f, stateIds as string[], store, stateShots);
  const described = [...new Set(f.occurrences.map((o) => o.location.elementDescription ?? o.location.selector).filter((x): x is string => Boolean(x)))];
  return {
    id: stableIssueId(f.fingerprint),
    category: f.category,
    source: f.category === 'package' ? 'static' : 'runtime',
    advisory: f.type === 'ai_recommendation',
    statusReason: f.reviewer.reason,
    assignee: f.reviewer.assignee,
    findingId: f.id,
    action: plain.action,
    priority: f.severityOverride?.to ?? f.severity,
    issue: plain.issue,
    change: plain.change,
    screens,
    viewports: [...new Set([f.location.viewportName, ...f.occurrences.map((o) => o.location.viewportName)].filter((v): v is string => Boolean(v)))],
    // Raw HTML snippets are long; show enough to find the element. Full detail stays in the technical view.
    elements: described.slice(0, 3).map((d) => (d.length > 90 ? `${d.slice(0, 89)}…` : d)),
    moreElements: Math.max(0, described.length - 3),
    steps: shortSteps(f.reproductionSteps),
    url: f.location.url ?? fallbackUrl,
    screenshotId: shot.id,
    screenshotKind: shot.kind,
    status: f.reviewer.status,
    technical: {
      ruleId: f.ruleId,
      observed: f.observed,
      remediation: f.remediation,
      standards: f.standards.map((s) => `${s.standard}${s.criterion ? ` ${s.criterion}` : ''}`),
      confidence: f.confidence,
      type: f.type,
    },
    foundAt: f.createdAt,
  };
}

/** Plain summary sentence for the top of a report. */
export function summaryLine(r: RunReport): string {
  const parts = [`${r.counts.fix} to fix`, `${r.counts.check} to check by hand`, `${r.counts.notChecked} areas not checked`];
  return `${parts.join(', ')}. ${r.coverage.screensScanned} screen${r.coverage.screensScanned === 1 ? '' : 's'} scanned.`;
}

export { ACTION_LABEL };

// ---- consolidated report across a project's scans ----

export interface ConsolidatedIssue extends ReportIssue {
  /** The scanned course address the issue belongs to. */
  course: string;
  firstFound: string;
  lastSeen: string;
  scansSeen: number;
  /** False means the latest scan of this course did not find it; this is not proof that it was fixed. */
  inLatestScan: boolean;
}

export interface ProjectReport {
  project: { id: string; name: string; description: string };
  generatedAt: string;
  courses: Array<{ targetUrl: string; scans: number; latest: RunReport }>;
  issues: ConsolidatedIssue[];
}

/**
 * Merges every finished scan of a project into one list of trackable issues.
 * Issues are matched by course address and stable ID. An issue missing from
 * the latest scan is reported as "not found in latest scan", never as fixed.
 */
export function buildProjectReport(store: Store, projectId: string): ProjectReport {
  const project = store.getProject(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);
  const runs = store
    .listRuns(projectId)
    .filter((r) => r.status === 'completed' || r.status === 'partial' || r.status === 'failed')
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));

  const byCourse = new Map<string, ScanRun[]>();
  for (const r of runs) {
    const key = r.config.target.url ?? '';
    byCourse.set(key, [...(byCourse.get(key) ?? []), r]);
  }

  const courses: ProjectReport['courses'] = [];
  const merged = new Map<string, ConsolidatedIssue>();
  for (const [course, courseRuns] of byCourse) {
    const reports = courseRuns.map((r) => buildRunReport(store, r.id));
    const latest = reports[reports.length - 1]!;
    courses.push({ targetUrl: course, scans: reports.length, latest });
    const latestIds = new Set(latest.issues.map((i) => i.id));
    for (const rep of reports) {
      for (const issue of rep.issues) {
        const key = `${course}|${issue.id}`;
        const seenAt = rep.run.finishedAt ?? rep.run.queuedAt;
        const prev = merged.get(key);
        merged.set(key, {
          ...issue, // later scans overwrite details so the text reflects the newest evidence
          course,
          firstFound: prev?.firstFound ?? seenAt,
          lastSeen: seenAt,
          scansSeen: (prev?.scansSeen ?? 0) + 1,
          inLatestScan: latestIds.has(issue.id),
        });
      }
    }
  }

  const issues = [...merged.values()].sort(
    (a, b) =>
      Number(b.inLatestScan) - Number(a.inLatestScan) ||
      ACTION_ORDER[a.action] - ACTION_ORDER[b.action] ||
      SEVERITY_ORDER[a.priority] - SEVERITY_ORDER[b.priority] ||
      a.course.localeCompare(b.course) ||
      a.issue.localeCompare(b.issue),
  );
  return { project: { id: project.id, name: project.name, description: project.description }, generatedAt: new Date().toISOString(), courses, issues };
}

/** Wraps a single scan in the project report shape so one exporter handles both. */
export function runReportAsProject(rep: RunReport, projectName: string, projectId = ''): ProjectReport {
  const seenAt = rep.run.finishedAt ?? rep.run.queuedAt;
  const issues: ConsolidatedIssue[] = rep.issues.map((i) => ({ ...i, course: rep.run.targetUrl, firstFound: seenAt, lastSeen: seenAt, scansSeen: 1, inLatestScan: true }));
  return { project: { id: projectId, name: projectName, description: '' }, generatedAt: new Date().toISOString(), courses: [{ targetUrl: rep.run.targetUrl, scans: 1, latest: rep }], issues };
}

/** One course's slice of a project report (its latest scan, issues, and screens). */
export function reportForCourse(report: ProjectReport, course: string): ProjectReport | undefined {
  const courses = report.courses.filter((c) => c.targetUrl === course);
  if (courses.length === 0) return undefined;
  return { ...report, courses, issues: report.issues.filter((i) => i.course === course) };
}

function packageSection(store: Store, run: ScanRun): ReportPackage | undefined {
  const t = run.config.target;
  if (t.kind !== 'package') return undefined;
  const pkg = t.packageId ? store.getPackage(t.packageId) : undefined;
  const choice = pkg?.inspection.launchChoices.find((c) => c.key === t.launchEntry);
  return {
    name: pkg?.name ?? t.packageName ?? 'Uploaded package',
    launchTitle: choice?.title ?? t.launchEntry,
    launchPoints: pkg?.inspection.launchChoices.length ?? 0,
    kind: pkg?.inspection.kind,
    scormVersionDeclared: pkg?.inspection.scormVersionDeclared,
    inventory: pkg?.inspection.inventory,
    externalDependencies: (pkg?.inspection.externalDependencies ?? []).map((d) => ({ host: d.host, urls: d.urls })),
    available: Boolean(pkg),
  };
}
