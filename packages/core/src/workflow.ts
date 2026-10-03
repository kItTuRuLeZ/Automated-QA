import type { Finding, ReviewerStatus } from '@cqa/shared';
import { REVIEWER_STATUSES_REQUIRING_REASON } from '@cqa/shared';
import type { Store } from './db/store.js';

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
function stateKeys(store: Store, runId: string): Map<string, string> {
  const actions = new Map(store.listActions(runId).map((a) => [a.id as string, a.targetDescription]));
  const out = new Map<string, string>();
  for (const s of store.listStates(runId)) out.set(s.id, `${s.pathFromRoot.map((id) => actions.get(id as string) ?? '?').join(' > ')}@${s.viewportName}`);
  return out;
}

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
 * again, and its rule ran and passed on an equivalent screen (same route and
 * screen size). Absence alone proves nothing: if the screen was not reached or
 * the rule did not run, the issue is Not retested. If nobody claimed a fix but
 * the rule passed, it is Not reproduced. A rule that fails to run is never
 * treated as passing.
 */
export function applyRetestOutcome(store: Store, runId: string): RetestSummary {
  const summary: RetestSummary = { verified: 0, notReproduced: 0, notRetested: 0, reopened: 0 };
  const run = store.getRun(runId);
  if (!run?.retestOfRunId) return summary;
  const projectId = run.projectId as string;
  const prior = store.listFindings(run.retestOfRunId).filter((f) => f.type !== 'ai_recommendation');
  const finished = run.status === 'completed' || run.status === 'partial';
  const now = new Set(store.listFindings(runId).map((f) => f.fingerprint));
  const results = finished ? store.listCheckResults(runId) : [];
  const priorKeys = stateKeys(store, run.retestOfRunId);
  const nowKeys = stateKeys(store, runId);
  const nowByKey = new Map<string, string[]>();
  for (const [id, key] of nowKeys) nowByKey.set(key, [...(nowByKey.get(key) ?? []), id]);

  const passedAt = (ruleId: string, stateIds: string[]) => results.some((r) => r.ruleId === ruleId && r.outcome === 'passed' && r.stateId && stateIds.includes(r.stateId as string));
  const tested = (f: Finding): boolean => {
    if (!finished) return false;
    const stateIds = [...new Set([f.location.stateId, ...f.occurrences.map((o) => o.location.stateId)].filter((x): x is NonNullable<typeof x> => Boolean(x)))];
    if (!stateIds.length) return results.some((r) => r.ruleId === f.ruleId && r.outcome === 'passed');
    return stateIds.every((id) => {
      const key = priorKeys.get(id as string);
      const same = key ? nowByKey.get(key) : undefined;
      return Boolean(same?.length && passedAt(f.ruleId, same));
    });
  };

  const set = (f: Finding, status: ReviewerStatus, reason: string) => {
    const cur = store.getWorkflow(projectId, f.fingerprint);
    store.setWorkflow(projectId, f.fingerprint, { status, assignee: cur?.assignee, reason }, { actor: 'retest', runId });
  };

  for (const f of prior) {
    const cur = store.getWorkflow(projectId, f.fingerprint)?.status ?? 'open';
    if (cur === 'accepted_risk' || cur === 'false_positive') continue; // a person's decision stands
    const claimed = cur === 'fixed' || cur === 'retest';
    if (now.has(f.fingerprint)) {
      if (cur !== 'open' && cur !== 'assigned') {
        set(f, 'open', 'Found again in the retest.');
        summary.reopened++;
      }
    } else if (tested(f)) {
      if (claimed) {
        set(f, 'verified', 'Not found in the retest, and the check passed on the same screen at the same screen size.');
        summary.verified++;
      } else if (cur === 'open' || cur === 'assigned') {
        set(f, 'not_reproduced', 'Not found in the retest. Nobody marked it fixed, so it may be intermittent or changed by other edits.');
        summary.notReproduced++;
      }
    } else if (claimed) {
      set(f, 'not_retested', finished ? 'Not found, but the same screen was not reached again or the check did not run, so this is not confirmed.' : 'The retest did not finish, so this was not confirmed.');
      summary.notRetested++;
    }
  }
  return summary;
}
