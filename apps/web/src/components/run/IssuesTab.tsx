import { useMemo, useState } from 'react';
import type { Severity } from '@cqa/shared';
import { api, type RunReport } from '../../api';
import { STATUS_LABEL, isOpenWork } from '../IssueStatus';
import { Alert, Empty, Pagination, SEVERITY_LABEL } from '../ui';
import { IssueCard } from './IssueCard';
import { useDetailLevel } from '../detail-level';
import { isActionable } from './SimpleSummary';

const PAGE = 25;
const SEV_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'informational'];
const ACTIONS = [
  { id: 'all', label: 'All types' },
  { id: 'fix', label: 'Issues to fix' },
  { id: 'check', label: 'Needs your review' },
  { id: 'not_checked', label: 'Coverage gaps' },
] as const;

export function IssuesTab({
  runId,
  report,
  query,
  canRetest,
  isRetest,
  onChanged,
}: {
  runId: string;
  report: RunReport;
  query: URLSearchParams;
  canRetest: boolean;
  isRetest: boolean;
  onChanged: () => void;
}) {
  const [action, setAction] = useState(query.get('action') ?? 'all');
  const [priority, setPriority] = useState(query.get('priority') ?? 'all');
  const [status, setStatus] = useState(query.get('status') ?? 'all');
  const [search, setSearch] = useState(query.get('q') ?? '');
  const [showAll, setShowAll] = useState(query.get('all') === '1');
  const [page, setPage] = useState(0);
  const [retesting, setRetesting] = useState(false);
  const [retestError, setRetestError] = useState<string>();

  const [level] = useDetailLevel();
  const simple = level === 'simple';
  // The simple view lists problems a person can act on; what the scanner could not look at is counted on the Summary.
  const all = simple ? report.issues.filter(isActionable) : report.issues;
  // A link or bookmark to the coverage gaps list shows everything in the simple view, where that type is not offered.
  const shownAction = simple && action === 'not_checked' ? 'all' : action;
  const openWork = all.filter((i) => isOpenWork(i.status));
  const pool = showAll ? all : openWork;
  const q = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      pool.filter(
        (i) =>
          (shownAction === 'all' || i.action === shownAction) &&
          (priority === 'all' || i.priority === priority) &&
          (status === 'all' || i.status === status) &&
          (!q || `${i.issue} ${i.change} ${i.id} ${i.technical.ruleId} ${i.assignee ?? ''}`.toLowerCase().includes(q)),
      ),
    [pool, shownAction, priority, status, q],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const safePage = Math.min(page, pages - 1);
  const shown = filtered.slice(safePage * PAGE, safePage * PAGE + PAGE);
  const statuses = [...new Set(all.map((i) => i.status))];
  const onFilter = (set: (v: string) => void) => (v: string) => {
    set(v);
    setPage(0);
  };

  const retest = async () => {
    if (retesting) return;
    setRetesting(true);
    setRetestError(undefined);
    try {
      const next = await api.retestRun(runId);
      window.location.hash = `#/runs/${next.id}`;
    } catch (e) {
      setRetestError((e as Error).message);
      setRetesting(false);
    }
  };

  return (
    <div>
      <div className="card toolbar">
        <div>
          {simple ? (
            <p>
              <strong>{openWork.length}</strong> problem{openWork.length === 1 ? '' : 's'} still open. When one is fixed, retest the course to confirm it.
            </p>
          ) : (
            <p>
              <strong>{all.length}</strong> finding{all.length === 1 ? '' : 's'} in this scan · <strong>{openWork.length}</strong> still open work
            </p>
          )}
          <p className="help" hidden={simple}>Open work is everything not yet Verified, Accepted risk or False positive. Marked fixed stays open until a retest confirms it. Nothing is removed from this scan’s history.</p>
        </div>
        {canRetest && (
          <div className="retest-box">
            <button type="button" className="btn" disabled={retesting} onClick={retest}>
              {retesting ? 'Starting retest…' : 'Retest this course'}
            </button>
            <p className="help">Scans the same course again with the same settings after fixes are made, and updates statuses by comparing. This scan stays unchanged.</p>
          </div>
        )}
      </div>
      {retestError && (
        <p role="alert" className="alert alert-error">
          Could not start the retest: {retestError}
        </p>
      )}
      {isRetest && (
        <Alert tone="note">
          This is a retest. Verified means the issue was marked fixed, was not found again, and its check passed on the same screen at the same screen size. Not retested means that could not be confirmed.
        </Alert>
      )}

      <div className="filters" role="search" aria-label="Filter issues">
        <div className="field">
          <label htmlFor="f-q">Search</label>
          <input id="f-q" type="search" value={search} onChange={(e) => onFilter(setSearch)(e.target.value)} placeholder={simple ? "Words" : "Words, issue ID or owner"} />
        </div>
        <div className="field">
          <label htmlFor="f-action">Type</label>
          <select id="f-action" value={shownAction} onChange={(e) => onFilter(setAction)(e.target.value)}>
            {ACTIONS.filter((a) => !simple || a.id !== 'not_checked').map((a) => (
              <option key={a.id} value={a.id}>
                {simple ? ({ all: 'All', fix: 'Problems to fix', check: 'Things to check by hand' } as Record<string, string>)[a.id] ?? a.label : a.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-priority">Priority</label>
          <select id="f-priority" value={priority} onChange={(e) => onFilter(setPriority)(e.target.value)}>
            <option value="all">All priorities</option>
            {SEV_ORDER.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-status">Status</label>
          <select id="f-status" value={status} onChange={(e) => onFilter(setStatus)(e.target.value)}>
            <option value="all">Any status</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s] ?? s}
              </option>
            ))}
          </select>
        </div>
        <label className="checkbox filter-check">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => {
              setShowAll(e.target.checked);
              setPage(0);
            }}
          />{' '}
          Include finished work (Verified, Accepted risk, False positive)
        </label>
      </div>

      <p className="muted" role="status">
        Showing {filtered.length} of {pool.length} {showAll ? 'findings' : 'open findings'}
        {filtered.length > PAGE ? `, ${PAGE} per page` : ''}.
      </p>

      {all.length === 0 ? (
        <Empty title="No findings were recorded">
          <p>That does not mean the course passed QA. Check the Coverage tab for what was and was not reached, and the Manual review tab.</p>
        </Empty>
      ) : filtered.length === 0 ? (
        <Empty title="No findings match these filters">
          <p>Clear a filter, or include finished work to see everything recorded in this scan.</p>
        </Empty>
      ) : (
        <ul className="issue-list">
          {shown.map((i) => (
            <IssueCard key={i.id} issue={i} screens={report.screens} onSaved={onChanged} />
          ))}
        </ul>
      )}
      <Pagination page={safePage} pageSize={PAGE} total={filtered.length} onPage={setPage} label="Issues" />
    </div>
  );
}
