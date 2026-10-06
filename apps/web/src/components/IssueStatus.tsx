import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

export const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  assigned: 'Assigned',
  fixed: 'Marked fixed',
  retest: 'Ready to retest',
  verified: 'Verified',
  accepted_risk: 'Accepted risk',
  false_positive: 'False positive',
  not_reproduced: 'Not reproduced',
  not_retested: 'Not retested',
};
/** Statuses a person may set. Verified, Not reproduced and Not retested are only ever set by a retest. */
export const MANUAL = ['open', 'assigned', 'fixed', 'retest', 'accepted_risk', 'false_positive'];
/** Work is "done" only for these. Marked fixed still awaits a retest, so it stays in open work. */
export const DONE = ['verified', 'accepted_risk', 'false_positive'];
export const isOpenWork = (status: string) => !DONE.includes(status);

type Save = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Status, owner and reason for one issue. Shows Unsaved changes / Saving / Saved / the error, and never shows
 * Saved after a failed save. "Marked fixed" is the person's declaration; there is no way to set Verified here.
 */
export function IssueStatus({ issue, onSaved }: { issue: { findingId: string; id: string; status: string; statusReason?: string; assignee?: string }; onSaved?: () => void }) {
  const [saved, setSaved] = useState({ status: issue.status, assignee: issue.assignee ?? '', reason: issue.statusReason ?? '' });
  const [status, setStatus] = useState(issue.status);
  const [assignee, setAssignee] = useState(issue.assignee ?? '');
  const [reason, setReason] = useState(issue.statusReason ?? '');
  const [state, setState] = useState<Save>('idle');
  const [error, setError] = useState<string>();
  const needsReason = status === 'accepted_risk' || status === 'false_positive';
  const systemSet = !MANUAL.includes(issue.status);
  const dirty = status !== saved.status || assignee !== saved.assignee || (needsReason && reason !== saved.reason);
  const idBase = `st-${issue.findingId}`;

  // A retest (or another tab) can change the stored values. Follow them unless this person has unsaved edits.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (dirtyRef.current) return;
    setStatus(issue.status);
    setAssignee(issue.assignee ?? '');
    setReason(issue.statusReason ?? '');
    setSaved({ status: issue.status, assignee: issue.assignee ?? '', reason: issue.statusReason ?? '' });
  }, [issue.status, issue.assignee, issue.statusReason]);

  const save = async () => {
    if (state === 'saving') return;
    setState('saving');
    setError(undefined);
    try {
      await api.setWorkflow(issue.findingId, { status, assignee, reason: needsReason ? reason : null });
      setSaved({ status, assignee, reason: needsReason ? reason : '' });
      setState('saved');
      onSaved?.();
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  };

  const feedback = state === 'saving' ? 'Saving…' : state === 'error' ? undefined : dirty ? 'Unsaved changes' : state === 'saved' ? 'Saved' : '';

  return (
    <div className="issue-status">
      <div className="field-inline">
        <label htmlFor={`${idBase}-status`}>Status</label>
        <select id={`${idBase}-status`} value={status} onChange={(e) => (setStatus(e.target.value), setState('idle'))}>
          {systemSet && <option value={issue.status}>{STATUS_LABEL[issue.status]} (from retest)</option>}
          {MANUAL.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
      <div className="field-inline">
        <label htmlFor={`${idBase}-owner`}>Owner</label>
        <input id={`${idBase}-owner`} value={assignee} maxLength={80} onChange={(e) => (setAssignee(e.target.value), setState('idle'))} placeholder="Who is fixing this?" />
      </div>
      {needsReason && (
        <div className="field-inline">
          <label htmlFor={`${idBase}-reason`}>Reason (required)</label>
          <input id={`${idBase}-reason`} value={reason} maxLength={1000} onChange={(e) => (setReason(e.target.value), setState('idle'))} />
        </div>
      )}
      <button type="button" className="btn btn-small" onClick={save} disabled={state === 'saving' || !dirty || (needsReason && !reason.trim())}>
        Save
      </button>
      <span className="save-feedback" role="status" aria-live="polite">
        {feedback}
      </span>
      {state === 'error' && (
        <span role="alert" className="error-text">
          Not saved: {error}
        </span>
      )}
      <p className="help issue-status-help">“Marked fixed” is your note that the change was made. “Verified” is only set by a retest.</p>
    </div>
  );
}
