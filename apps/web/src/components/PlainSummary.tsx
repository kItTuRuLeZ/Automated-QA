import { useState } from 'react';
import type { Severity } from '@cqa/shared';
import { api } from '../api';
import { ErrorBox, Loading, SEVERITY_LABEL, SeverityBadge, useLoader } from './ui';
import type { ScanRun } from '@cqa/shared';

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
const MANUAL = ['open', 'assigned', 'fixed', 'retest', 'accepted_risk', 'false_positive'];

/** Status, owner, and reason for one issue. Verified, Not reproduced and Not retested are only ever set by a retest. */
function IssueStatus({ issue, onSaved }: { issue: { findingId: string; id: string; status: string; statusReason?: string; assignee?: string }; onSaved: () => void }) {
  const [status, setStatus] = useState(issue.status);
  const [assignee, setAssignee] = useState(issue.assignee ?? '');
  const [reason, setReason] = useState(issue.statusReason ?? '');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const needsReason = status === 'accepted_risk' || status === 'false_positive';
  const systemSet = !MANUAL.includes(issue.status);
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.setWorkflow(issue.findingId, { status, assignee, reason: needsReason ? reason : null });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="issue-status">
      <label>
        Status{' '}
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={`Status of ${issue.id}`}>
          {systemSet && <option value={issue.status}>{STATUS_LABEL[issue.status]} (from retest)</option>}
          {MANUAL.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>{' '}
      <label>
        Owner <input value={assignee} maxLength={80} onChange={(e) => setAssignee(e.target.value)} aria-label={`Owner of ${issue.id}`} />
      </label>
      {needsReason && (
        <label>
          {' '}Reason (required) <input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} aria-label={`Reason for ${issue.id}`} />
        </label>
      )}{' '}
      <button type="button" className="btn btn-small" onClick={save} disabled={busy || (needsReason && !reason.trim())}>
        Save
      </button>
      {error && <span role="alert" className="error-text"> {error}</span>}
    </div>
  );
}

type Group = 'fix' | 'check' | 'not_checked';

const GROUPS: Array<{ id: Group; title: string; help: string }> = [
  { id: 'fix', title: 'Fix', help: 'Confirmed problems that need a change.' },
  { id: 'check', title: 'Check by hand', help: 'The scanner could not decide. A person needs to look.' },
  { id: 'not_checked', title: 'Not checked', help: 'Areas the scanner could not inspect. These are not passes.' },
];

const VISIBLE = 8;

/** The part of a scan a course developer reads: what to change and where. */
export function PlainSummary({ run, isActive }: { run: ScanRun; isActive: boolean }) {
  const { data, error, reload } = useLoader(() => api.runReport(run.id), [run.id, run.status], undefined);
  const [open, setOpen] = useState<Record<Group, boolean>>({ fix: false, check: false, not_checked: false });

  const [retesting, setRetesting] = useState(false);
  const [retestError, setRetestError] = useState<string>();
  const finishedRun = run.status === 'completed' || run.status === 'partial';
  const retest = async () => {
    setRetesting(true);
    setRetestError(undefined);
    try {
      const next = await api.retestRun(run.id);
      window.location.hash = `#/runs/${next.id}`;
    } catch (e) {
      setRetestError((e as Error).message);
    } finally {
      setRetesting(false);
    }
  };

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const r = data;
  const finished = !isActive;

  return (
    <section aria-labelledby="plain-heading" className="card plain">
      <div className="plain-head">
        <div>
          <h2 id="plain-heading">{finished ? 'What to do' : 'Scan in progress'}</h2>
          <p className="muted">
            {r.run.statusPlain}. {r.coverage.screensScanned} screen{r.coverage.screensScanned === 1 ? '' : 's'} scanned
            {r.coverage.budgetsReached.length > 0 && ', and the scan stopped at a limit, so other screens were not looked at'}.
          </p>
        </div>
        {finishedRun && (
          <button type="button" className="btn" disabled={retesting} onClick={retest} title="Scans the same course again with the same settings and compares it with this scan. This scan stays unchanged.">
            {retesting ? 'Starting…' : 'Retest this course'}
          </button>
        )}
        <div className="download-group" role="group" aria-label="Download this report">
          <a className="btn btn-primary" href={`/api/runs/${run.id}/export.xlsx`} download>
            Excel tracker
          </a>
          <a className="btn" href={`/api/runs/${run.id}/export.html`} download>
            HTML report
          </a>
          <a className="btn" href={`/api/runs/${run.id}/export.pdf`} download>
            PDF
          </a>
          <a className="btn" href={`/api/runs/${run.id}/export.json`} download>
            JSON
          </a>
        </div>
      </div>

      {retestError && <p role="alert" className="error-text">{retestError}</p>}
      {run.retestOfRunId && (
        <p className="help">
          This is a retest of <a href={`#/runs/${run.retestOfRunId}`}>an earlier scan</a>. Issue statuses were updated from it: Verified means it was marked fixed, was not found, and its check passed on the same screen at the same screen size. Not retested means that could not be confirmed.
        </p>
      )}
      <div className="big-counts" role="list">
        <Count label="To fix" value={r.counts.fix} tone="fix" />
        <Count label="Check by hand" value={r.counts.check} tone="check" />
        <Count label="Not checked" value={r.counts.notChecked} tone="not" />
      </div>
      {r.counts.fix > 0 && (
        <p className="help">
          Fix by priority:{' '}
          {(['critical', 'high', 'medium', 'low', 'informational'] as Severity[])
            .filter((s) => r.counts.bySeverity[s] > 0)
            .map((s) => `${r.counts.bySeverity[s]} ${SEVERITY_LABEL[s].toLowerCase()}`)
            .join(', ')}
        </p>
      )}

      {GROUPS.map((g) => {
        const items = r.issues.filter((i) => i.action === g.id);
        if (items.length === 0) return null;
        const shown = open[g.id] ? items : items.slice(0, VISIBLE);
        return (
          <div key={g.id} className="issue-group">
            <h3>
              {g.title} ({items.length})
            </h3>
            <p className="help">{g.help}</p>
            <ul className="issues">
              {shown.map((i) => (
                <li key={i.id}>
                  <div className="issue-top">
                    <SeverityBadge severity={i.priority} />
                    <strong>{i.issue}</strong>
                    <span className="muted mono">{i.id}</span>
                    {i.viewports.length > 0 && <span className="muted">at {i.viewports.join(', ')}</span>}
                  </div>
                  {i.screenshotId && (
                    <figure className="issue-shot">
                      <img
                        src={api.artifactUrl(i.screenshotId)}
                        alt={i.screenshotKind === 'element' ? `Screenshot with the affected element outlined in red: ${i.issue}` : `Screenshot of screen ${i.screens[0] ?? ''} where this was found`}
                        loading="lazy"
                      />
                      <figcaption>{i.screenshotKind === 'element' ? 'Affected element outlined' : 'Whole screen'}</figcaption>
                    </figure>
                  )}
                  <p className="issue-change">
                    <span className="label">What to change:</span> {i.change}
                  </p>
                  <p className="issue-where">
                    <span className="label">Where:</span> {i.screens.length ? `screen${i.screens.length > 1 ? 's' : ''} ${i.screens.join(', ')}` : 'this scan'}
                    {i.elements.length > 0 && ` · ${i.elements.join('; ')}${i.moreElements ? ` (+${i.moreElements} more)` : ''}`}
                  </p>
                  <IssueStatus key={`${i.id}-${i.status}`} issue={i} onSaved={reload} />
                  <details>
                    <summary>How to see it</summary>
                    <ol>
                      {i.steps.map((s, n) => (
                        <li key={n}>{s}</li>
                      ))}
                    </ol>
                    <p className="help">
                      Technical details: {i.technical.ruleId} · {i.technical.observed} · <a href={`#/findings/${i.findingId}`}>Open full finding</a>
                    </p>
                  </details>
                </li>
              ))}
            </ul>
            {items.length > VISIBLE && (
              <button type="button" className="btn btn-small" onClick={() => setOpen((o) => ({ ...o, [g.id]: !o[g.id] }))} aria-expanded={open[g.id]}>
                {open[g.id] ? 'Show fewer' : `Show all ${items.length}`}
              </button>
            )}
          </div>
        );
      })}

      {finished && r.issues.length === 0 && (
        <p>
          <strong>No issues were recorded.</strong> That does not mean the course passed QA: see Coverage below for what was and was not reached, and the manual review checklist.
        </p>
      )}
    </section>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone: 'fix' | 'check' | 'not' }) {
  return (
    <div className={`big-count big-${tone}`} role="listitem">
      <div className="big-number">{value}</div>
      <div className="big-label">{label}</div>
    </div>
  );
}
