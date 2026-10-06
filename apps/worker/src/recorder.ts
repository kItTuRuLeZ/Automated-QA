import { createHash } from 'node:crypto';
import type { CourseState, InteractionInstance, InteractionType, RunStage } from '@cqa/shared';
import { type NewUnit, type QaStore, finalStage, summarizeCoverage, unitForState } from '@cqa/core';
import type { CandidateAction } from './adapters/generic-html.js';

/**
 * Writes what the worker is really doing into the durable run record: stage, the current unit, discovered and visited
 * units, detected interactions, and a heartbeat. The interface only ever shows what is stored here, so a refresh, a
 * reconnect or a second browser sees the same run.
 */
export class RunRecorder {
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private launchUnitId: string | undefined;
  private finalized = false;

  constructor(
    private readonly qa: QaStore,
    readonly runId: string,
  ) {}

  begin(): void {
    this.qa.ensureProgress(this.runId, 'queued');
    this.qa.touchHeartbeat(this.runId);
    this.heartbeatTimer = setInterval(() => {
      try {
        this.qa.touchHeartbeat(this.runId);
      } catch {
        /* the database may already be closed during shutdown */
      }
    }, 1_000);
    this.heartbeatTimer.unref?.();
  }

  stop(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  stage(stage: RunStage, activity?: string): void {
    if (this.finalized) return;
    this.qa.setStage(this.runId, stage, activity);
    this.qa.appendEvent(this.runId, 'stage_changed', { stage, activity });
  }

  note(text: string): void {
    this.qa.appendEvent(this.runId, 'note', { text });
  }

  /** Units known before any browser visit (package manifest, authoring export). */
  seedUnits(units: NewUnit[], launchUnitId?: string): void {
    this.launchUnitId = launchUnitId;
    if (units.length === 0) return;
    const { added, revision } = this.qa.addUnits(this.runId, units);
    for (const u of added) this.qa.appendEvent(this.runId, 'unit_discovered', { unitId: u.id, title: u.title, kind: u.kind, source: u.source, revision });
    this.qa.recount(this.runId);
  }

  /** A browser is showing this state. Records the visit against the unit the state belongs to. */
  stateReached(state: CourseState): void {
    const known = this.qa.listUnits(this.runId);
    const hit = unitForState(state, known);
    let unitId = hit.existingId;
    if (!unitId && hit.unit) {
      const unit = { ...hit.unit, parentId: this.launchUnitId };
      const { added, revision } = this.qa.addUnits(this.runId, [unit]);
      unitId = unit.id;
      for (const u of added) this.qa.appendEvent(this.runId, 'unit_discovered', { unitId: u.id, title: u.title, kind: u.kind, source: u.source, revision });
    }
    if (!unitId) return;
    this.qa.markVisited(this.runId, unitId, state.id);
    const unit = this.qa.getUnit(this.runId, unitId);
    this.qa.appendEvent(this.runId, 'unit_entered', { unitId, title: unit?.title, stateId: state.id, depth: state.depth, url: state.url });
    this.qa.setActivity(this.runId, `Checking ${unit?.title ?? 'a screen'}`, { unitId });
    this.qa.recount(this.runId);
  }

  /** The unit the most recent state belongs to, so later checks can be attached to it. */
  unitOf(state: CourseState): string | undefined {
    const hit = unitForState(state, this.qa.listUnits(this.runId));
    return hit.existingId ?? hit.unit?.id;
  }

  /** Records the controls the adapter found on a state as interaction instances. Unrecognized controls are kept, with no capabilities. */
  actionsDiscovered(state: CourseState, candidates: readonly CandidateAction[]): void {
    const unitId = this.unitOf(state);
    if (!unitId) return;
    const items: Array<Omit<InteractionInstance, 'runId'>> = [];
    for (const c of candidates) {
      const m = mapCandidate(c);
      if (!m) continue;
      const id = `i-${createHash('sha1').update(`${unitId}|${m.type}|${c.locator ?? ''}|${c.targetDescription}`).digest('hex').slice(0, 12)}`;
      items.push({ id, unitId, type: m.type, label: c.targetDescription, locator: c.locator, confidence: m.capabilities.length ? 'high' : 'low', capabilities: m.capabilities, detectedBy: c.adapter });
    }
    const added = this.qa.addInteractions(this.runId, items);
    if (added.length) {
      this.qa.appendEvent(this.runId, 'interaction_discovered', { unitId, count: added.length, types: [...new Set(added.map((a) => a.type))] });
      this.qa.recount(this.runId);
    }
  }

  /** Unreached units get a reason where one is known. */
  explainUnreached(reason: (unitTitle: string) => string): void {
    for (const u of this.qa.listUnits(this.runId)) if (!u.visitedAt && (u.kind === 'lesson' || u.kind === 'slide' || u.kind === 'screen')) this.qa.setNotReached(this.runId, u.id, reason(u.title));
  }

  /**
   * Final bookkeeping. Idempotent: a second call does nothing, so a retry cannot double anything. Counters are
   * recomputed from rows, never added to.
   */
  finalize(runStatus: 'completed' | 'partial' | 'failed' | 'cancelled', detail?: string): RunStage {
    if (this.finalized) return this.qa.getProgress(this.runId)?.stage ?? 'failed';
    this.qa.failInterrupted(this.runId, runStatus === 'cancelled' ? 'The run was cancelled before this check finished.' : 'The run stopped before this check finished.');
    this.qa.recount(this.runId);
    const defs = new Map(this.qa.listDefinitions().map((d) => [d.id, d]));
    const coverage = summarizeCoverage({ units: this.qa.listUnits(this.runId), executions: this.qa.currentExecutions(this.runId), interactions: this.qa.listInteractions(this.runId), definitions: defs });
    const stage = finalStage({ runStatus, coverage });
    this.qa.setStage(this.runId, stage, detail);
    this.qa.appendEvent(this.runId, 'run_finalized', { stage, runStatus, statement: coverage.statement });
    this.finalized = true;
    this.stop();
    return stage;
  }
}

/** Which kind of interaction a discovered action is, and what automation can really do with it. */
export function mapCandidate(c: Pick<CandidateAction, 'kind' | 'reason' | 'targetDescription'>): { type: InteractionType; capabilities: string[] } | undefined {
  if (c.reason === 'out_of_scope') return { type: 'link', capabilities: [] };
  if (c.reason === 'unsafe_action' || c.reason === 'ambiguous_action') return { type: 'unknown_control', capabilities: [] };
  switch (c.kind) {
    case 'select_tab':
      return { type: 'tab', capabilities: ['activate', 'observe_selected'] };
    case 'expand':
    case 'collapse':
      return { type: c.targetDescription.startsWith('expandable section') ? 'accordion' : 'details', capabilities: ['activate', 'observe_expanded'] };
    case 'open_dialog':
      return { type: 'dialog', capabilities: ['activate', 'observe_dialog'] };
    case 'close_dialog':
      return undefined; // part of the dialog it closes
    case 'next':
      return { type: 'next', capabilities: ['activate', 'observe_navigation'] };
    case 'back':
      return { type: 'previous', capabilities: ['activate', 'observe_navigation'] };
    case 'navigate':
      return { type: 'link', capabilities: ['activate', 'observe_url'] };
    default:
      return undefined;
  }
}
