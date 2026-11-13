import type { Finding, ReviewerStatus } from '@cqa/shared';
import { REVIEWER_STATUSES_REQUIRING_REASON } from '@cqa/shared';
import type { Store } from './db/store.js';
import { compareRuns } from './compare.js';

/** Statuses a person may set. The rest are only ever the result of a retest. */
export const MANUAL_STATUSES = ['open', 'assigned', 'fixed', 'retest', 'accepted_risk', 'false_positive'] as const satisfies readonly ReviewerStatus[];

export type WorkflowInput = { status?: string; assignee?: string | null; reason?: string | null };

/** Validates a manual change and returns the row to store, or an error message. */
export function validateWorkflowChange(current: { status: ReviewerStatus; assignee?: string; reason?: string } | undefined, input: WorkflowInput): { ok: true; value: { status: ReviewerStatus; assignee?: string; reason?: string } } | { ok: false; error: string } {
  const status = (input.status ?? current?.status ?? 'open') as ReviewerStatus;
  if (!(MANUAL_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: `"${status}" is set by a retest, not by hand. Choose one of: ${MANUAL_STATUSES.join(', ')}.` };
  }
  const assignee = input.assignee === undefined ? current?.assignee : (input.assignee ?? '').trim().slice(0, 80) || undefined;
  let reason = input.reason === undefined ? current?.reason : (input.reason ?? '').trim().slice(0, 1000) || undefined;
  if ((REVIEWER_STATUSES_REQUIRING_REASON as readonly string[]).includes(status) && !reason) {
    return { ok: false, error: 'A reason is required for accepted risk and false positive.' };
  }
  if (!(REVIEWER_STATUSES_REQUIRING_REASON as readonly string[]).includes(status) && input.status !== undefined && input.reason === undefined) reason = undefined;
  return { ok: true, value: { status, assignee, reason } };
}

/** How a screen was reached, plus the screen size. Two runs reached "the same screen" when these match. */
export function stateKeys(store: Store, runId: string): Map<string, string> {
  const actions = new Map(store.listActions(runId).map((a) => [a.id as string, a.targetDescription]));
  const out = new Map<string, string>();
  for (const s of store.listStates(runId)) out.set(s.id, `${s.pathFromRoot.map((id) => actions.get(id as string) ?? '?').join(' > ')}@${s.viewportName}`);
  return out;
}

export const ONE_RULE_MANY_TARGETS = /^(FUN-|NAV-|KBD-00[34]$|LNK-001$)/;

export interface RetestSummary {
  verified: number;
  notReproduced: number;
  notRetested: number;
  reopened: number;
}

/**
 * Applies the outcome of a retest run to the issues of the run it was based on.
 *
 * Verified needs all of: a person marked it fixed or retest, it was not found
 * again, and the same check ran and passed on an equivalent screen (same route
 * and screen size) in a comparable browser. For rules that run once per control
 * or case, "the same check" means the same `checkKey`: a pass on another control
 * proves nothing about this one. Absence alone proves nothing: if the screen was
 * not reached or the check did not run, the issue is Not retested. If nobody
 * claimed a fix but the check passed, it is Not reproduced. A check that fails
 * to run is never treated as passing.
 */
export function applyRetestOutcome(store: Store, runId: string): RetestSummary {
  const summary: RetestSummary = { verified: 0, notReproduced: 0, notRetested: 0, reopened: 0 };
  const run = store.getRun(runId);
  if (!run?.retestOfRunId) return summary;
  const projectId = run.projectId as string;
  // One judgement for retests and the Compare tab: what is resolved there is verified here, and nothing else is.
  const comparison = compareRuns(store, run.retestOfRunId, runId);
  if (!comparison) return summary;
  const verdict = new Map(comparison.findings.map((f) => [f.fingerprint, f]));
  const set = (fp: string, status: ReviewerStatus, reason: string) => {
    const cur = store.getWorkflow(projectId, fp);
    store.setWorkflow(projectId, fp, { status, assignee: cur?.assignee, reason }, { actor: 'retest', runId });
  };
  for (const f of store.listFindings(run.retestOfRunId).filter((x) => x.type !== 'ai_recommendation')) {
    const v = verdict.get(f.fingerprint);
    if (!v) continue;
    const cur = store.getWorkflow(projectId, f.fingerprint)?.status ?? 'open';
    if (cur === 'accepted_risk' || cur === 'false_positive') continue; // a person's decision stands
    const claimed = cur === 'fixed' || cur === 'retest';
    if (v.status === 'persistent') {
      if (cur !== 'open' && cur !== 'assigned') {
        set(f.fingerprint, 'open', 'Found again in the retest.');
        summary.reopened++;
      }
    } else if (v.status === 'resolved') {
      if (claimed) {
        set(f.fingerprint, 'verified', 'Not found in the retest, and the same check passed on the same screen at the same screen size.');
        summary.verified++;
      } else if (cur === 'open' || cur === 'assigned') {
        set(f.fingerprint, 'not_reproduced', 'Not found in the retest. Nobody marked it fixed, so it may be intermittent or changed by other edits.');
        summary.notReproduced++;
      }
    } else if (claimed) {
      set(f.fingerprint, 'not_retested', v.status === 'incomparable' ? `Not comparable: ${v.reason}` : v.reason);
      summary.notRetested++;
    }
  }
  return summary;
}
