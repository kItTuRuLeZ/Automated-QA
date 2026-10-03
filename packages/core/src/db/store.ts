import Database from 'better-sqlite3';
import type {
  ArtifactId,
  BrowserInfo,
  CheckOutcome,
  CheckResult,
  CourseState,
  CoverageSummary,
  Evidence,
  EvidenceId,
  Finding,
  FindingId,
  FindingType,
  Project,
  ProjectId,
  ReasonCode,
  RunStatus,
  RunSummary,
  ScanConfig,
  ScanRun,
  ScanRunId,
  Severity,
  ToolVersion,
} from '@cqa/shared';
import { CHECK_OUTCOMES, FINDING_TYPES, SEVERITIES } from '@cqa/shared';
import { newId, nowIso } from '../fingerprint.js';
import { MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

export function openDatabase(file: string): Db {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, nowIso());
    })();
  }
}

interface RunRow {
  id: string;
  project_id: string;
  status: RunStatus;
  status_reason: string | null;
  status_detail: string | null;
  target_url: string;
  config_json: string;
  retest_of_run_id: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  browser_json: string | null;
  tool_versions_json: string;
  coverage_json: string | null;
  is_demo: number;
}

function toRun(r: RunRow): ScanRun {
  const run: ScanRun = {
    id: r.id as ScanRunId,
    projectId: r.project_id as ProjectId,
    status: r.status,
    config: JSON.parse(r.config_json) as ScanConfig,
    queuedAt: r.queued_at,
    toolVersions: JSON.parse(r.tool_versions_json) as ToolVersion[],
    isDemo: r.is_demo === 1,
  };
  if (r.status_reason) run.statusReason = r.status_reason as ReasonCode;
  if (r.status_detail) run.statusDetail = r.status_detail;
  if (r.retest_of_run_id) run.retestOfRunId = r.retest_of_run_id as ScanRunId;
  if (r.started_at) run.startedAt = r.started_at;
  if (r.finished_at) run.finishedAt = r.finished_at;
  if (r.browser_json) run.browser = JSON.parse(r.browser_json) as BrowserInfo;
  if (r.coverage_json) run.coverage = JSON.parse(r.coverage_json) as CoverageSummary;
  return run;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  course_url: string | null;
  is_demo: number;
  created_at: string;
}

function toProject(r: ProjectRow): Project {
  const p: Project = { id: r.id as ProjectId, name: r.name, description: r.description, isDemo: r.is_demo === 1, createdAt: r.created_at };
  if (r.course_url) p.courseUrl = r.course_url;
  return p;
}

export interface ArtifactRecord {
  id: ArtifactId;
  runId: ScanRunId;
  kind: string;
  mime: string;
  bytes: number;
  sha256: string;
  relPath: string;
  createdAt: string;
}

export interface ProjectListItem extends Project {
  runCount: number;
  lastRun?: { id: ScanRunId; status: RunStatus; queuedAt: string };
}

export class Store {
  constructor(readonly db: Db) {}

  // ---- projects ----

  createProject(input: { name: string; description?: string; courseUrl?: string; isDemo?: boolean }): Project {
    const row: ProjectRow = {
      id: newId(),
      name: input.name,
      description: input.description ?? '',
      course_url: input.courseUrl ?? null,
      is_demo: input.isDemo ? 1 : 0,
      created_at: nowIso(),
    };
    this.db
      .prepare('INSERT INTO projects (id, name, description, course_url, is_demo, created_at) VALUES (@id, @name, @description, @course_url, @is_demo, @created_at)')
      .run(row);
    return toProject(row);
  }

  getProject(id: string): Project | undefined {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return r ? toProject(r) : undefined;
  }

  listProjects(): ProjectListItem[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[];
    const countStmt = this.db.prepare('SELECT COUNT(*) AS n FROM scan_runs WHERE project_id = ?');
    const lastStmt = this.db.prepare('SELECT id, status, queued_at FROM scan_runs WHERE project_id = ? ORDER BY queued_at DESC LIMIT 1');
    return rows.map((r) => {
      const item: ProjectListItem = { ...toProject(r), runCount: (countStmt.get(r.id) as { n: number }).n };
      const last = lastStmt.get(r.id) as { id: string; status: RunStatus; queued_at: string } | undefined;
      if (last) item.lastRun = { id: last.id as ScanRunId, status: last.status, queuedAt: last.queued_at };
      return item;
    });
  }

  deleteProject(id: string): boolean {
    return this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  }

  // ---- runs and jobs ----

  createRun(config: ScanConfig, targetUrl: string): ScanRun {
    const id = newId<ScanRunId>();
    const queuedAt = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO scan_runs (id, project_id, status, target_url, config_json, queued_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, config.projectId, 'queued', targetUrl, JSON.stringify(config), queuedAt);
      this.db.prepare("INSERT INTO jobs (run_id, state, enqueued_at) VALUES (?, 'queued', ?)").run(id, Date.now());
    })();
    return this.getRun(id)!;
  }

  getRun(id: string): ScanRun | undefined {
    const r = this.db.prepare('SELECT * FROM scan_runs WHERE id = ?').get(id) as RunRow | undefined;
    return r ? toRun(r) : undefined;
  }

  getRunTargetUrl(id: string): string | undefined {
    return (this.db.prepare('SELECT target_url FROM scan_runs WHERE id = ?').get(id) as { target_url: string } | undefined)?.target_url;
  }

  listRuns(projectId: string): ScanRun[] {
    return (this.db.prepare('SELECT * FROM scan_runs WHERE project_id = ? ORDER BY queued_at DESC').all(projectId) as RunRow[]).map(toRun);
  }

  /**
   * Cancels a queued run immediately, or flags a running run for the worker
   * to stop. Terminal runs are unchanged.
   */
  requestCancel(runId: string): RunStatus | undefined {
    return this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run) return undefined;
      if (run.status === 'queued') {
        this.db.prepare("UPDATE jobs SET state = 'done', cancel_requested = 1 WHERE run_id = ?").run(runId);
        this.db
          .prepare("UPDATE scan_runs SET status = 'cancelled', status_reason = 'cancelled', status_detail = ?, finished_at = ? WHERE id = ?")
          .run('Cancelled before the scan started.', nowIso(), runId);
        return 'cancelled' as RunStatus;
      }
      if (run.status === 'running') {
        this.db.prepare('UPDATE jobs SET cancel_requested = 1 WHERE run_id = ?').run(runId);
      }
      return run.status;
    })();
  }

  /** Atomically claims the oldest queued job and marks its run running. */
  claimNextJob(workerId: string, leaseMs: number): ScanRun | undefined {
    return this.db.transaction(() => {
      const job = this.db.prepare("SELECT run_id FROM jobs WHERE state = 'queued' ORDER BY enqueued_at LIMIT 1").get() as { run_id: string } | undefined;
      if (!job) return undefined;
      const claimed = this.db
        .prepare("UPDATE jobs SET state = 'claimed', worker_id = ?, lease_expires_at = ? WHERE run_id = ? AND state = 'queued'")
        .run(workerId, Date.now() + leaseMs, job.run_id);
      if (claimed.changes === 0) return undefined;
      this.db.prepare("UPDATE scan_runs SET status = 'running', started_at = ? WHERE id = ?").run(nowIso(), job.run_id);
      return this.getRun(job.run_id);
    })();
  }

  /** Extends the lease and reports whether cancellation was requested. */
  heartbeat(runId: string, workerId: string, leaseMs: number): { cancelRequested: boolean; leaseLost: boolean } {
    const res = this.db
      .prepare("UPDATE jobs SET lease_expires_at = ? WHERE run_id = ? AND worker_id = ? AND state = 'claimed'")
      .run(Date.now() + leaseMs, runId, workerId);
    const row = this.db.prepare('SELECT cancel_requested FROM jobs WHERE run_id = ?').get(runId) as { cancel_requested: number } | undefined;
    return { cancelRequested: row?.cancel_requested === 1, leaseLost: res.changes === 0 };
  }

  isCancelRequested(runId: string): boolean {
    const row = this.db.prepare('SELECT cancel_requested FROM jobs WHERE run_id = ?').get(runId) as { cancel_requested: number } | undefined;
    return row?.cancel_requested === 1;
  }

  setRunEnvironment(runId: string, browser: BrowserInfo, toolVersions: ToolVersion[]): void {
    this.db.prepare('UPDATE scan_runs SET browser_json = ?, tool_versions_json = ? WHERE id = ?').run(JSON.stringify(browser), JSON.stringify(toolVersions), runId);
  }

  finishRun(runId: string, input: { status: RunStatus; reason?: ReasonCode; detail?: string; coverage?: CoverageSummary }): void {
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE scan_runs SET status = ?, status_reason = ?, status_detail = ?, coverage_json = COALESCE(?, coverage_json), finished_at = ? WHERE id = ?')
        .run(input.status, input.reason ?? null, input.detail ?? null, input.coverage ? JSON.stringify(input.coverage) : null, nowIso(), runId);
      this.db.prepare("UPDATE jobs SET state = 'done', lease_expires_at = NULL WHERE run_id = ?").run(runId);
    })();
  }

  /**
   * Marks runs whose worker disappeared. With `all`, every claimed job is
   * treated as orphaned (used at single-worker startup); otherwise only
   * expired leases. Orphans are not re-run automatically.
   */
  recoverOrphanedRuns(opts: { all: boolean }): ScanRunId[] {
    return this.db.transaction(() => {
      const rows = (
        opts.all
          ? this.db.prepare("SELECT run_id FROM jobs WHERE state = 'claimed'").all()
          : this.db.prepare("SELECT run_id FROM jobs WHERE state = 'claimed' AND lease_expires_at < ?").all(Date.now())
      ) as Array<{ run_id: string }>;
      for (const { run_id } of rows) {
        const hasResults = (this.db.prepare('SELECT COUNT(*) AS n FROM check_results WHERE run_id = ?').get(run_id) as { n: number }).n > 0;
        this.finishRun(run_id, {
          status: hasResults ? 'partial' : 'failed',
          reason: 'worker_lost',
          detail: 'The worker stopped before this scan finished. Results recorded before that point are kept. Start a new scan to re-run it.',
        });
      }
      return rows.map((r) => r.run_id as ScanRunId);
    })();
  }

  deleteRun(runId: string): boolean {
    return this.db.prepare('DELETE FROM scan_runs WHERE id = ?').run(runId).changes > 0;
  }

  // ---- results ----

  insertState(state: CourseState): void {
    this.db
      .prepare('INSERT INTO course_states (id, run_id, url, title, signature, depth, viewport_name, data_json, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(state.id, state.runId, state.url, state.title ?? null, state.signature, state.depth, state.viewportName, JSON.stringify(state), state.capturedAt);
  }

  listStates(runId: string): CourseState[] {
    return (this.db.prepare('SELECT data_json FROM course_states WHERE run_id = ? ORDER BY captured_at').all(runId) as Array<{ data_json: string }>).map(
      (r) => JSON.parse(r.data_json) as CourseState,
    );
  }

  insertArtifact(a: ArtifactRecord): void {
    this.db
      .prepare('INSERT INTO artifacts (id, run_id, kind, mime, bytes, sha256, rel_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.runId, a.kind, a.mime, a.bytes, a.sha256, a.relPath, a.createdAt);
  }

  getArtifact(id: string): ArtifactRecord | undefined {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as
      | { id: string; run_id: string; kind: string; mime: string; bytes: number; sha256: string; rel_path: string; created_at: string }
      | undefined;
    if (!r) return undefined;
    return { id: r.id as ArtifactId, runId: r.run_id as ScanRunId, kind: r.kind, mime: r.mime, bytes: r.bytes, sha256: r.sha256, relPath: r.rel_path, createdAt: r.created_at };
  }

  listArtifacts(runId: string): ArtifactRecord[] {
    return (this.db.prepare('SELECT id FROM artifacts WHERE run_id = ?').all(runId) as Array<{ id: string }>).map((r) => this.getArtifact(r.id)!);
  }

  insertEvidence(e: Evidence): void {
    this.db
      .prepare('INSERT INTO evidence (id, run_id, kind, artifact_id, data_json, caption, state_id, viewport_name, captured_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.id, e.runId, e.kind, e.artifactId ?? null, e.data ? JSON.stringify(e.data) : null, e.caption, e.stateId ?? null, e.viewportName ?? null, e.capturedAt);
  }

  getEvidence(ids: readonly string[]): Evidence[] {
    if (ids.length === 0) return [];
    const stmt = this.db.prepare('SELECT * FROM evidence WHERE id = ?');
    const out: Evidence[] = [];
    for (const id of ids) {
      const r = stmt.get(id) as
        | { id: string; run_id: string; kind: Evidence['kind']; artifact_id: string | null; data_json: string | null; caption: string; state_id: string | null; viewport_name: string | null; captured_at: string }
        | undefined;
      if (!r) continue;
      const e: Evidence = { id: r.id as EvidenceId, runId: r.run_id as ScanRunId, kind: r.kind, caption: r.caption, capturedAt: r.captured_at, redacted: true };
      if (r.artifact_id) e.artifactId = r.artifact_id as ArtifactId;
      if (r.data_json) e.data = JSON.parse(r.data_json) as Record<string, unknown>;
      if (r.state_id) e.stateId = r.state_id as Evidence['stateId'] & string;
      if (r.viewport_name) e.viewportName = r.viewport_name;
      out.push(e);
    }
    return out;
  }

  listEvidenceByKind(runId: string, kind: Evidence['kind']): Evidence[] {
    const ids = (this.db.prepare('SELECT id FROM evidence WHERE run_id = ? AND kind = ? ORDER BY captured_at').all(runId, kind) as Array<{ id: string }>).map((r) => r.id);
    return this.getEvidence(ids);
  }

  insertCheckResult(c: CheckResult): void {
    this.db
      .prepare(
        'INSERT INTO check_results (id, run_id, rule_id, state_id, viewport_name, outcome, reason, reason_detail, duration_ms, data_json, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(c.id, c.runId, c.ruleId, c.stateId ?? null, c.viewportName ?? null, c.outcome, c.reason ?? null, c.reasonDetail ?? null, Math.round(c.durationMs), JSON.stringify(c), c.executedAt);
  }

  listCheckResults(runId: string): CheckResult[] {
    return (this.db.prepare('SELECT data_json FROM check_results WHERE run_id = ? ORDER BY executed_at, rule_id').all(runId) as Array<{ data_json: string }>).map(
      (r) => JSON.parse(r.data_json) as CheckResult,
    );
  }

  /** Inserts a finding, or merges occurrences/evidence into an existing one with the same fingerprint. */
  upsertFinding(f: Finding): Finding {
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT data_json FROM findings WHERE run_id = ? AND fingerprint = ?').get(f.runId, f.fingerprint) as { data_json: string } | undefined;
      if (existing) {
        const merged = JSON.parse(existing.data_json) as Finding;
        merged.occurrences.push(...f.occurrences);
        merged.evidenceIds = [...new Set([...merged.evidenceIds, ...f.evidenceIds])];
        this.db.prepare('UPDATE findings SET data_json = ? WHERE id = ?').run(JSON.stringify(merged), merged.id);
        return merged;
      }
      this.db
        .prepare(
          'INSERT INTO findings (id, run_id, rule_id, category, type, severity, confidence, title, fingerprint, reviewer_status, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(f.id, f.runId, f.ruleId, f.category, f.type, f.severity, f.confidence, f.title, f.fingerprint, f.reviewer.status, JSON.stringify(f), f.createdAt);
      return f;
    })();
  }

  listFindings(runId: string): Finding[] {
    const order = "CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";
    return (this.db.prepare(`SELECT data_json FROM findings WHERE run_id = ? ORDER BY ${order}, rule_id`).all(runId) as Array<{ data_json: string }>).map(
      (r) => JSON.parse(r.data_json) as Finding,
    );
  }

  getFinding(id: string): Finding | undefined {
    const r = this.db.prepare('SELECT data_json FROM findings WHERE id = ?').get(id) as { data_json: string } | undefined;
    return r ? (JSON.parse(r.data_json) as Finding) : undefined;
  }

  summarizeRun(runId: string): RunSummary {
    const byOutcome = Object.fromEntries(CHECK_OUTCOMES.map((o) => [o, 0])) as Record<CheckOutcome, number>;
    for (const r of this.db.prepare('SELECT outcome, COUNT(*) AS n FROM check_results WHERE run_id = ? GROUP BY outcome').all(runId) as Array<{ outcome: CheckOutcome; n: number }>) {
      byOutcome[r.outcome] = r.n;
    }
    const findingsBySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
    const findingsByType = Object.fromEntries(FINDING_TYPES.map((t) => [t, 0])) as Record<FindingType, number>;
    let findingCount = 0;
    for (const r of this.db.prepare('SELECT severity, type, COUNT(*) AS n FROM findings WHERE run_id = ? GROUP BY severity, type').all(runId) as Array<{
      severity: Severity;
      type: FindingType;
      n: number;
    }>) {
      findingsBySeverity[r.severity] += r.n;
      findingsByType[r.type] += r.n;
      findingCount += r.n;
    }
    const uniqueRules = (this.db.prepare('SELECT COUNT(DISTINCT rule_id) AS n FROM check_results WHERE run_id = ?').get(runId) as { n: number }).n;
    const executions = Object.values(byOutcome).reduce((a, b) => a + b, 0);
    return { uniqueRules, executions, byOutcome, findingsBySeverity, findingsByType, findingCount };
  }

  findingExists(id: FindingId): boolean {
    return this.db.prepare('SELECT 1 FROM findings WHERE id = ?').get(id) !== undefined;
  }
}
