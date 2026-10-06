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
  {
    version: 4,
    name: 'finding_workflow',
    sql: `
CREATE TABLE finding_workflow (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  assignee TEXT,
  reason TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, fingerprint)
);
CREATE TABLE finding_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  assignee TEXT,
  reason TEXT,
  run_id TEXT
);
CREATE INDEX idx_finding_history ON finding_history(project_id, fingerprint, at);
`,
  },
  {
    version: 5,
    name: 'client_profiles',
    sql: `
CREATE TABLE client_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 6,
    name: 'course_packages',
    sql: `
CREATE TABLE course_packages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  kind TEXT NOT NULL,
  inspection_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_course_packages_project ON course_packages(project_id, created_at);
`,
  },
  {
    // Additive: nothing here changes an existing table, so older scans open exactly as before and simply have no rows in these.
    version: 7,
    name: 'functional_qa',
    sql: `
CREATE TABLE run_events (
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE run_progress (
  run_id TEXT PRIMARY KEY REFERENCES scan_runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  activity TEXT,
  current_unit_id TEXT,
  current_test_id TEXT,
  inventory_revision INTEGER NOT NULL DEFAULT 0,
  counters_json TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  heartbeat_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE inventory_units (
  id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  title_is_fallback INTEGER NOT NULL DEFAULT 0,
  source_id TEXT,
  parent_id TEXT,
  source TEXT NOT NULL,
  confidence TEXT NOT NULL,
  revision INTEGER NOT NULL,
  discovered_at TEXT NOT NULL,
  visited_at TEXT,
  visited_state_ids_json TEXT NOT NULL DEFAULT '[]',
  not_reached_reason TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, id)
);
CREATE INDEX idx_inventory_units_run ON inventory_units(run_id, sort_order);
CREATE TABLE interaction_instances (
  id TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  locator TEXT,
  confidence TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  detected_by TEXT NOT NULL,
  PRIMARY KEY (run_id, id)
);
CREATE INDEX idx_interaction_instances_unit ON interaction_instances(run_id, unit_id);
CREATE TABLE test_definitions (
  id TEXT PRIMARY KEY,
  external_id TEXT,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  interaction_type TEXT NOT NULL,
  automation TEXT NOT NULL,
  review_state TEXT NOT NULL,
  origin TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_test_definitions_external ON test_definitions(external_id) WHERE external_id IS NOT NULL;
CREATE TABLE test_definition_history (
  definition_id TEXT NOT NULL REFERENCES test_definitions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (definition_id, version)
);
CREATE TABLE test_executions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  definition_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL,
  external_id TEXT,
  unit_id TEXT,
  instance_id TEXT,
  state_path TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  scope TEXT NOT NULL,
  data_json TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_test_executions_run ON test_executions(run_id, unit_id);
CREATE TABLE behavior_rules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  review_state TEXT NOT NULL,
  rule_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_behavior_rules_project ON behavior_rules(project_id);
CREATE TABLE review_dispositions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  original_status TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_review_dispositions_target ON review_dispositions(run_id, target_kind, target_id);
`,
  },
];
