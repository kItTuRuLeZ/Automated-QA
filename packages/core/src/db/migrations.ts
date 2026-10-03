/**
 * Numbered, forward-only migrations. Never edit an applied migration; add a new one.
 */
export const MIGRATIONS: ReadonlyArray<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  course_url TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE scan_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','partial','failed','cancelled')),
  status_reason TEXT,
  status_detail TEXT,
  target_url TEXT NOT NULL,
  config_json TEXT NOT NULL,
  retest_of_run_id TEXT REFERENCES scan_runs(id) ON DELETE SET NULL,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  browser_json TEXT,
  tool_versions_json TEXT NOT NULL DEFAULT '[]',
  coverage_json TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_scan_runs_project ON scan_runs(project_id, queued_at);

CREATE TABLE jobs (
  run_id TEXT PRIMARY KEY REFERENCES scan_runs(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('queued','claimed','done')),
  worker_id TEXT,
  lease_expires_at INTEGER,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  enqueued_at INTEGER NOT NULL
);
CREATE INDEX idx_jobs_state ON jobs(state, enqueued_at);

CREATE TABLE course_states (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  signature TEXT NOT NULL,
  depth INTEGER NOT NULL,
  viewport_name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
CREATE INDEX idx_states_run ON course_states(run_id);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_artifacts_run ON artifacts(run_id);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  artifact_id TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  data_json TEXT,
  caption TEXT NOT NULL,
  state_id TEXT,
  viewport_name TEXT,
  captured_at TEXT NOT NULL
);
CREATE INDEX idx_evidence_run ON evidence(run_id);

CREATE TABLE check_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  state_id TEXT,
  viewport_name TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('passed','failed','needs_review','not_applicable','not_tested','error')),
  reason TEXT,
  reason_detail TEXT,
  duration_ms INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  executed_at TEXT NOT NULL,
  CHECK (outcome NOT IN ('not_tested','error') OR reason IS NOT NULL)
);
CREATE INDEX idx_checks_run ON check_results(run_id);

CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  confidence TEXT NOT NULL,
  title TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  reviewer_status TEXT NOT NULL DEFAULT 'open',
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, fingerprint)
);
CREATE INDEX idx_findings_run ON findings(run_id);
`,
  },
  {
    version: 2,
    name: 'traversal_actions',
    sql: `
CREATE TABLE traversal_actions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  from_state_id TEXT NOT NULL,
  to_state_id TEXT,
  outcome TEXT NOT NULL,
  reason TEXT,
  data_json TEXT NOT NULL
);
CREATE INDEX idx_actions_run ON traversal_actions(run_id, seq);
`,
  },
  {
    version: 3,
    name: 'baselines',
    sql: `
CREATE TABLE baselines (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  course_url TEXT NOT NULL,
  key TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, course_url, key)
);
`,
  },
];
