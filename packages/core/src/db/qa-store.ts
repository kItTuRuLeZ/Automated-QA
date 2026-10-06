import type {
  BehaviorRule,
  ContentUnit,
  InteractionInstance,
  ProgressCounters,
  ReviewDisposition,
  RunEvent,
  RunEventType,
  RunProgress,
  RunStage,
  TestDefinition,
  TestDefinitionChange,
  TestExecution,
  TestStatus,
} from '@cqa/shared';
import { EMPTY_COUNTERS } from '@cqa/shared';
import { newId, nowIso } from '../fingerprint.js';
import type { Db } from './store.js';

/**
 * Persistence for the functional-QA layer. It works on the same database as `Store` and only touches the tables added
 * by migration 7, so scans made before it simply have no rows here.
 *
 * Counters are recomputed from the rows themselves rather than incremented, so a retry or a replayed event can never
 * make a number grow twice.
 */
export class QaStore {
  constructor(readonly db: Db) {}

  // ---- events and progress ----

  /** Appends an event with the next sequence number. Sequence assignment and the progress update are one transaction. */
  appendEvent(runId: string, type: RunEventType, payload: Record<string, unknown> = {}): RunEvent {
    return this.db.transaction(() => {
      const last = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM run_events WHERE run_id = ?').get(runId) as { m: number }).m;
      const ev: RunEvent = { runId, seq: last + 1, at: nowIso(), type, payload };
      this.db.prepare('INSERT INTO run_events (run_id, seq, at, type, payload_json) VALUES (?, ?, ?, ?, ?)').run(runId, ev.seq, ev.at, ev.type, JSON.stringify(ev.payload));
      this.db.prepare('UPDATE run_progress SET last_seq = ?, updated_at = ? WHERE run_id = ?').run(ev.seq, ev.at, runId);
      return ev;
    })();
  }

  /** Events after a sequence number, oldest first. A client that missed some asks again with the last sequence it applied. */
  listEvents(runId: string, afterSeq = 0, limit = 500): RunEvent[] {
    return (this.db.prepare('SELECT seq, at, type, payload_json FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(runId, afterSeq, limit) as Array<{ seq: number; at: string; type: RunEventType; payload_json: string }>).map((r) => ({
      runId,
      seq: r.seq,
      at: r.at,
      type: r.type,
      payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    }));
  }

  getProgress(runId: string): RunProgress | undefined {
    const r = this.db.prepare('SELECT * FROM run_progress WHERE run_id = ?').get(runId) as ProgressRow | undefined;
    return r ? toProgress(r) : undefined;
  }

  /** Creates the progress row on first use. */
  ensureProgress(runId: string, stage: RunStage = 'queued'): RunProgress {
    const existing = this.getProgress(runId);
    if (existing) return existing;
    const at = nowIso();
    this.db.prepare('INSERT OR IGNORE INTO run_progress (run_id, stage, counters_json, last_seq, updated_at) VALUES (?, ?, ?, 0, ?)').run(runId, stage, JSON.stringify(EMPTY_COUNTERS), at);
    return this.getProgress(runId)!;
  }

  setStage(runId: string, stage: RunStage, activity?: string): void {
    this.ensureProgress(runId);
    const at = nowIso();
    this.db.prepare('UPDATE run_progress SET stage = ?, activity = ?, updated_at = ?, started_at = COALESCE(started_at, ?) WHERE run_id = ?').run(stage, activity ?? null, at, stage === 'queued' ? null : at, runId);
  }

  setActivity(runId: string, activity: string | undefined, current: { unitId?: string; testId?: string } = {}): void {
    this.ensureProgress(runId);
    this.db.prepare('UPDATE run_progress SET activity = ?, current_unit_id = ?, current_test_id = ?, updated_at = ? WHERE run_id = ?').run(activity ?? null, current.unitId ?? null, current.testId ?? null, nowIso(), runId);
  }

  /** The worker's sign of life, so a stalled run can be told apart from a slow one. */
  touchHeartbeat(runId: string): void {
    this.ensureProgress(runId);
    this.db.prepare('UPDATE run_progress SET heartbeat_at = ? WHERE run_id = ?').run(nowIso(), runId);
  }

  /** Recomputes every counter from the stored rows. Safe to call any number of times. */
  recount(runId: string): ProgressCounters {
    this.ensureProgress(runId);
    const units = this.db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN visited_at IS NOT NULL THEN 1 ELSE 0 END) AS v FROM inventory_units WHERE run_id = ?').get(runId) as { n: number; v: number | null };
    const inter = (this.db.prepare('SELECT COUNT(*) AS n FROM interaction_instances WHERE run_id = ?').get(runId) as { n: number }).n;
    const counters: ProgressCounters = { ...EMPTY_COUNTERS, unitsDiscovered: units.n, unitsVisited: units.v ?? 0, interactionsDiscovered: inter };
    for (const e of this.currentExecutions(runId)) {
      const k = STATUS_COUNTER[e.status];
      if (k) counters[k] += 1;
    }
    const revision = (this.db.prepare('SELECT COALESCE(MAX(revision), 0) AS r FROM inventory_units WHERE run_id = ?').get(runId) as { r: number }).r;
    this.db.prepare('UPDATE run_progress SET counters_json = ?, inventory_revision = ?, updated_at = ? WHERE run_id = ?').run(JSON.stringify(counters), revision, nowIso(), runId);
    return counters;
  }

  // ---- inventory ----

  inventoryRevision(runId: string): number {
    return (this.db.prepare('SELECT COALESCE(MAX(revision), 0) AS r FROM inventory_units WHERE run_id = ?').get(runId) as { r: number }).r;
  }

  /**
   * Adds units the run has not seen. A new batch gets the next revision, so a reviewer can be told what changed in the
   * denominator. Units already present keep their data (a source id never silently changes identity).
   */
  addUnits(runId: string, units: Array<Omit<ContentUnit, 'runId' | 'revision' | 'discoveredAt' | 'visitedStateIds'> & { visitedAt?: string }>): { added: ContentUnit[]; revision: number } {
    return this.db.transaction(() => {
      const known = new Set((this.db.prepare('SELECT id FROM inventory_units WHERE run_id = ?').all(runId) as Array<{ id: string }>).map((r) => r.id));
      const fresh = units.filter((u) => !known.has(u.id));
      const base = this.inventoryRevision(runId);
      if (fresh.length === 0) return { added: [], revision: base };
      const revision = base + 1;
      const at = nowIso();
      const stmt = this.db.prepare(
        'INSERT INTO inventory_units (id, run_id, kind, title, title_is_fallback, source_id, parent_id, source, confidence, revision, discovered_at, visited_at, visited_state_ids_json, not_reached_reason, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      const added: ContentUnit[] = [];
      for (const u of fresh) {
        stmt.run(u.id, runId, u.kind, u.title, u.titleIsFallback ? 1 : 0, u.sourceId ?? null, u.parentId ?? null, u.source, u.confidence, revision, at, u.visitedAt ?? null, '[]', u.notReachedReason ?? null, u.order);
        added.push({ ...u, runId, revision, discoveredAt: at, visitedStateIds: [] });
      }
      return { added, revision };
    })();
  }

  markVisited(runId: string, unitId: string, stateId: string): boolean {
    const row = this.db.prepare('SELECT visited_state_ids_json, visited_at FROM inventory_units WHERE run_id = ? AND id = ?').get(runId, unitId) as { visited_state_ids_json: string; visited_at: string | null } | undefined;
    if (!row) return false;
    const ids = JSON.parse(row.visited_state_ids_json) as string[];
    if (!ids.includes(stateId)) ids.push(stateId);
    this.db.prepare('UPDATE inventory_units SET visited_at = COALESCE(visited_at, ?), visited_state_ids_json = ?, not_reached_reason = NULL WHERE run_id = ? AND id = ?').run(nowIso(), JSON.stringify(ids), runId, unitId);
    return true;
  }

  setNotReached(runId: string, unitId: string, reason: string): void {
    this.db.prepare('UPDATE inventory_units SET not_reached_reason = ? WHERE run_id = ? AND id = ? AND visited_at IS NULL').run(reason, runId, unitId);
  }

  listUnits(runId: string): ContentUnit[] {
    return (this.db.prepare('SELECT * FROM inventory_units WHERE run_id = ? ORDER BY sort_order, discovered_at, id').all(runId) as UnitRow[]).map(toUnit);
  }

  getUnit(runId: string, unitId: string): ContentUnit | undefined {
    const r = this.db.prepare('SELECT * FROM inventory_units WHERE run_id = ? AND id = ?').get(runId, unitId) as UnitRow | undefined;
    return r ? toUnit(r) : undefined;
  }

  addInteractions(runId: string, items: Array<Omit<InteractionInstance, 'runId'>>): InteractionInstance[] {
    return this.db.transaction(() => {
      const known = new Set((this.db.prepare('SELECT id FROM interaction_instances WHERE run_id = ?').all(runId) as Array<{ id: string }>).map((r) => r.id));
      const stmt = this.db.prepare('INSERT INTO interaction_instances (id, run_id, unit_id, type, label, locator, confidence, capabilities_json, detected_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const added: InteractionInstance[] = [];
      for (const i of items) {
        if (known.has(i.id)) continue;
        stmt.run(i.id, runId, i.unitId, i.type, i.label, i.locator ?? null, i.confidence, JSON.stringify(i.capabilities), i.detectedBy);
        known.add(i.id);
        added.push({ ...i, runId });
      }
      return added;
    })();
  }

  listInteractions(runId: string, unitId?: string): InteractionInstance[] {
    const rows = (unitId ? this.db.prepare('SELECT * FROM interaction_instances WHERE run_id = ? AND unit_id = ?').all(runId, unitId) : this.db.prepare('SELECT * FROM interaction_instances WHERE run_id = ?').all(runId)) as InteractionRow[];
    return rows.map((r) => ({ id: r.id, runId: r.run_id, unitId: r.unit_id, type: r.type as InteractionInstance['type'], label: r.label, locator: r.locator ?? undefined, confidence: r.confidence as InteractionInstance['confidence'], capabilities: JSON.parse(r.capabilities_json) as string[], detectedBy: r.detected_by }));
  }

  // ---- test definitions ----

  getDefinition(id: string): TestDefinition | undefined {
    const r = this.db.prepare('SELECT definition_json FROM test_definitions WHERE id = ?').get(id) as { definition_json: string } | undefined;
    return r ? (JSON.parse(r.definition_json) as TestDefinition) : undefined;
  }

  getDefinitionByExternalId(externalId: string): TestDefinition | undefined {
    const r = this.db.prepare('SELECT definition_json FROM test_definitions WHERE external_id = ?').get(externalId) as { definition_json: string } | undefined;
    return r ? (JSON.parse(r.definition_json) as TestDefinition) : undefined;
  }

  listDefinitions(): TestDefinition[] {
    return (this.db.prepare('SELECT definition_json FROM test_definitions ORDER BY id').all() as Array<{ definition_json: string }>).map((r) => JSON.parse(r.definition_json) as TestDefinition);
  }

  /** Saves a definition. A change to an existing one bumps its version and keeps the earlier version in the history. */
  saveDefinition(def: TestDefinition, actor: string, note: string): TestDefinition {
    return this.db.transaction(() => {
      const existing = this.getDefinition(def.id);
      const at = nowIso();
      const next: TestDefinition = { ...def, version: existing ? existing.version + 1 : def.version || 1, createdAt: existing?.createdAt ?? def.createdAt ?? at, updatedAt: at };
      if (existing) {
        this.db
          .prepare('UPDATE test_definitions SET external_id = ?, version = ?, title = ?, category = ?, interaction_type = ?, automation = ?, review_state = ?, origin = ?, definition_json = ?, updated_at = ? WHERE id = ?')
          .run(next.externalId ?? null, next.version, next.title, next.category, next.interactionType, next.automation, next.reviewState, next.origin, JSON.stringify(next), at, next.id);
      } else {
        this.db
          .prepare('INSERT INTO test_definitions (id, external_id, version, title, category, interaction_type, automation, review_state, origin, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(next.id, next.externalId ?? null, next.version, next.title, next.category, next.interactionType, next.automation, next.reviewState, next.origin, JSON.stringify(next), next.createdAt, at);
      }
      this.db.prepare('INSERT INTO test_definition_history (definition_id, version, at, actor, note, snapshot_json) VALUES (?, ?, ?, ?, ?, ?)').run(next.id, next.version, at, actor, note, JSON.stringify(next));
      return next;
    })();
  }

  definitionHistory(id: string): TestDefinitionChange[] {
    return (this.db.prepare('SELECT version, at, actor, note, snapshot_json FROM test_definition_history WHERE definition_id = ? ORDER BY version DESC').all(id) as Array<{ version: number; at: string; actor: string; note: string; snapshot_json: string }>).map((r) => ({
      definitionId: id,
      version: r.version,
      at: r.at,
      actor: r.actor,
      note: r.note,
      snapshot: JSON.parse(r.snapshot_json) as TestDefinition,
    }));
  }

  // ---- executions ----

  insertExecution(e: Omit<TestExecution, 'id' | 'attempt'> & { id?: string; attempt?: number }): TestExecution {
    const attempt = e.attempt ?? this.nextAttempt(e.runId, e.definitionId, e.unitId, e.instanceId, e.statePath);
    const full: TestExecution = { ...e, id: e.id ?? newId<string & { __brand: 'exec' }>(), attempt } as TestExecution;
    this.db
      .prepare('INSERT INTO test_executions (id, run_id, definition_id, definition_version, external_id, unit_id, instance_id, state_path, attempt, status, scope, data_json, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(full.id, full.runId, full.definitionId, full.definitionVersion, full.externalId ?? null, full.unitId ?? null, full.instanceId ?? null, full.statePath ?? null, full.attempt, full.status, full.scope, JSON.stringify(full), full.startedAt ?? null, full.finishedAt ?? null);
    return full;
  }

  updateExecution(id: string, patch: Partial<TestExecution>): TestExecution | undefined {
    const cur = this.getExecution(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id: cur.id, runId: cur.runId, attempt: cur.attempt } as TestExecution;
    this.db.prepare('UPDATE test_executions SET status = ?, scope = ?, data_json = ?, finished_at = ?, unit_id = ?, instance_id = ? WHERE id = ?').run(next.status, next.scope, JSON.stringify(next), next.finishedAt ?? null, next.unitId ?? null, next.instanceId ?? null, id);
    return next;
  }

  getExecution(id: string): TestExecution | undefined {
    const r = this.db.prepare('SELECT data_json FROM test_executions WHERE id = ?').get(id) as { data_json: string } | undefined;
    return r ? (JSON.parse(r.data_json) as TestExecution) : undefined;
  }

  nextAttempt(runId: string, definitionId: string, unitId?: string, instanceId?: string, statePath?: string): number {
    const r = this.db
      .prepare('SELECT COALESCE(MAX(attempt), 0) AS a FROM test_executions WHERE run_id = ? AND definition_id = ? AND COALESCE(unit_id, \'\') = ? AND COALESCE(instance_id, \'\') = ? AND COALESCE(state_path, \'\') = ?')
      .get(runId, definitionId, unitId ?? '', instanceId ?? '', statePath ?? '') as { a: number };
    return r.a + 1;
  }

  /** Every attempt, oldest first. Older attempts stay as history. */
  listExecutions(runId: string, unitId?: string): TestExecution[] {
    const rows = (unitId ? this.db.prepare('SELECT data_json FROM test_executions WHERE run_id = ? AND unit_id = ? ORDER BY started_at, rowid').all(runId, unitId) : this.db.prepare('SELECT data_json FROM test_executions WHERE run_id = ? ORDER BY started_at, rowid').all(runId)) as Array<{ data_json: string }>;
    return rows.map((r) => JSON.parse(r.data_json) as TestExecution);
  }

  /** The latest attempt of each case on each instance. This is what counts and statuses are built from. */
  currentExecutions(runId: string, unitId?: string): TestExecution[] {
    const latest = new Map<string, TestExecution>();
    for (const e of this.listExecutions(runId, unitId)) {
      const key = [e.definitionId, e.unitId ?? '', e.instanceId ?? '', e.statePath ?? ''].join('|');
      const prev = latest.get(key);
      if (!prev || e.attempt >= prev.attempt) latest.set(key, e);
    }
    return [...latest.values()];
  }

  /** A run that stopped part-way leaves running cases behind. They become errors, never passes and never silently dropped. */
  failInterrupted(runId: string, reason: string): number {
    let n = 0;
    for (const e of this.listExecutions(runId)) {
      if (e.status === 'running' || e.status === 'pending') {
        this.updateExecution(e.id, { status: e.status === 'running' ? 'error' : 'skipped', reason, finishedAt: nowIso() });
        n++;
      }
    }
    return n;
  }

  // ---- behavior rules ----

  saveRule(rule: BehaviorRule): BehaviorRule {
    const at = nowIso();
    const exists = this.db.prepare('SELECT 1 FROM behavior_rules WHERE id = ?').get(rule.id);
    const next = { ...rule, updatedAt: at, createdAt: rule.createdAt || at };
    if (exists) this.db.prepare('UPDATE behavior_rules SET title = ?, review_state = ?, rule_json = ?, updated_at = ? WHERE id = ?').run(next.title, next.reviewState, JSON.stringify(next), at, next.id);
    else this.db.prepare('INSERT INTO behavior_rules (id, project_id, title, review_state, rule_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(next.id, next.projectId, next.title, next.reviewState, JSON.stringify(next), next.createdAt, at);
    return next;
  }

  getRule(id: string): BehaviorRule | undefined {
    const r = this.db.prepare('SELECT rule_json FROM behavior_rules WHERE id = ?').get(id) as { rule_json: string } | undefined;
    return r ? (JSON.parse(r.rule_json) as BehaviorRule) : undefined;
  }

  listRules(projectId: string): BehaviorRule[] {
    return (this.db.prepare('SELECT rule_json FROM behavior_rules WHERE project_id = ? ORDER BY created_at').all(projectId) as Array<{ rule_json: string }>).map((r) => JSON.parse(r.rule_json) as BehaviorRule);
  }

  deleteRule(id: string): boolean {
    return this.db.prepare('DELETE FROM behavior_rules WHERE id = ?').run(id).changes > 0;
  }

  // ---- reviewer decisions ----

  addDisposition(d: Omit<ReviewDisposition, 'id' | 'createdAt'>): ReviewDisposition {
    const full: ReviewDisposition = { ...d, id: newId<string & { __brand: 'disp' }>(), createdAt: nowIso() } as ReviewDisposition;
    this.db
      .prepare('INSERT INTO review_dispositions (id, run_id, target_kind, target_id, decision, actor, reason, original_status, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(full.id, full.runId, full.targetKind, full.targetId, full.decision, full.actor, full.reason, full.originalStatus, full.note ?? null, full.createdAt);
    return full;
  }

  listDispositions(runId: string): ReviewDisposition[] {
    return (this.db.prepare('SELECT * FROM review_dispositions WHERE run_id = ? ORDER BY created_at, rowid').all(runId) as DispositionRow[]).map((r) => ({
      id: r.id,
      runId: r.run_id,
      targetKind: r.target_kind as ReviewDisposition['targetKind'],
      targetId: r.target_id,
      decision: r.decision as ReviewDisposition['decision'],
      actor: r.actor,
      reason: r.reason,
      originalStatus: r.original_status,
      note: r.note ?? undefined,
      createdAt: r.created_at,
    }));
  }
}

const STATUS_COUNTER: Record<TestStatus, keyof ProgressCounters | undefined> = {
  passed: 'testsPassed',
  failed: 'testsFailed',
  blocked: 'testsBlocked',
  error: 'testsErrored',
  skipped: 'testsSkipped',
  manual_review_required: 'testsManual',
  pending: 'testsPending',
  running: 'testsRunning',
  not_applicable: undefined,
};

interface ProgressRow {
  run_id: string;
  stage: RunStage;
  activity: string | null;
  current_unit_id: string | null;
  current_test_id: string | null;
  inventory_revision: number;
  counters_json: string;
  last_seq: number;
  started_at: string | null;
  heartbeat_at: string | null;
  updated_at: string;
}
function toProgress(r: ProgressRow): RunProgress {
  return {
    runId: r.run_id,
    stage: r.stage,
    activity: r.activity ?? undefined,
    currentUnitId: r.current_unit_id ?? undefined,
    currentTestId: r.current_test_id ?? undefined,
    inventoryRevision: r.inventory_revision,
    counters: { ...EMPTY_COUNTERS, ...(JSON.parse(r.counters_json) as Partial<ProgressCounters>) },
    lastSeq: r.last_seq,
    startedAt: r.started_at ?? undefined,
    heartbeatAt: r.heartbeat_at ?? undefined,
    updatedAt: r.updated_at,
  };
}

interface UnitRow {
  id: string;
  run_id: string;
  kind: string;
  title: string;
  title_is_fallback: number;
  source_id: string | null;
  parent_id: string | null;
  source: string;
  confidence: string;
  revision: number;
  discovered_at: string;
  visited_at: string | null;
  visited_state_ids_json: string;
  not_reached_reason: string | null;
  sort_order: number;
}
function toUnit(r: UnitRow): ContentUnit {
  return {
    id: r.id,
    runId: r.run_id,
    kind: r.kind as ContentUnit['kind'],
    title: r.title,
    titleIsFallback: r.title_is_fallback === 1,
    sourceId: r.source_id ?? undefined,
    parentId: r.parent_id ?? undefined,
    source: r.source as ContentUnit['source'],
    confidence: r.confidence as ContentUnit['confidence'],
    revision: r.revision,
    discoveredAt: r.discovered_at,
    visitedAt: r.visited_at ?? undefined,
    visitedStateIds: JSON.parse(r.visited_state_ids_json) as string[],
    notReachedReason: r.not_reached_reason ?? undefined,
    order: r.sort_order,
  };
}
interface InteractionRow {
  id: string;
  run_id: string;
  unit_id: string;
  type: string;
  label: string;
  locator: string | null;
  confidence: string;
  capabilities_json: string;
  detected_by: string;
}
interface DispositionRow {
  id: string;
  run_id: string;
  target_kind: string;
  target_id: string;
  decision: string;
  actor: string;
  reason: string;
  original_status: string;
  note: string | null;
  created_at: string;
}
