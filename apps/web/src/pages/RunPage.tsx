import { useEffect, useState } from 'react';
import type { RunStatus } from '@cqa/shared';
import { api, type RunDetail, type RunReport } from '../api';
import { Accessibility } from '../components/Accessibility';
import { ExportMenu, type ExportItem } from '../components/ExportMenu';
import { CoverageTab } from '../components/run/CoverageTab';
import { IssuesTab } from '../components/run/IssuesTab';
import { SummaryTab } from '../components/run/SummaryTab';
import { TechnicalTab } from '../components/run/TechnicalTab';
import { isOpenWork } from '../components/IssueStatus';
import { Alert, Breadcrumb, ErrorBox, Loading, PageHeader, TabNav, courseTitle, formatDate, hostPath, useLoader } from '../components/ui';

const active = (s: RunStatus) => s === 'queued' || s === 'running';
const TABS = ['summary', 'issues', 'coverage', 'manual', 'technical'] as const;
type Tab = (typeof TABS)[number];

function Elapsed({ since }: { since?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  if (!since) return null;
  const s = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  return <>{`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`}</>;
}

export function RunPage({ id, tab, query }: { id: string; tab?: string; query: URLSearchParams }) {
  const run = useLoader(() => api.getRun(id), [id], (r) => active(r.status));
  const report = useLoader(() => api.runReport(id), [id, run.data?.status]);
  const project = useLoader(() => (run.data ? api.getProject(run.data.projectId) : Promise.resolve(undefined)), [run.data?.projectId]);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [cancelError, setCancelError] = useState<unknown>();
  const current: Tab = (TABS as readonly string[]).includes(tab ?? '') ? (tab as Tab) : 'summary';

  if (run.error && !run.data) return <ErrorBox error={run.error} onRetry={run.reload} />;
  if (!run.data) return <Loading />;
  const r = run.data;
  const isActive = active(r.status);
  const finished = !isActive;
  const rep = report.data;
  const pkg = r.config.target.kind === 'package';
  const title = courseTitle(r.states, r.config.target.url, pkg ? r.config.target.packageName : undefined);
  const openCount = rep ? rep.issues.filter((i) => isOpenWork(i.status)).length : undefined;

  const cancel = async () => {
    setCancelRequested(true);
    setCancelError(undefined);
    try {
      await api.cancelRun(id);
      run.reload();
    } catch (e) {
      setCancelRequested(false);
      setCancelError(e);
    }
  };

  const exports: ExportItem[] = [
    { key: 'xlsx', label: 'Excel issue tracker', scope: 'This scan only: issues with owner and status columns, plus Not checked, Manual checks and Screens sheets.', href: `/api/runs/${id}/export.xlsx` },
    { key: 'pdf', label: 'PDF report', scope: 'This scan only. Made offline with the scanning browser.', href: `/api/runs/${id}/export.pdf`, recovery: 'The PDF needs the scanning browser. Check Help → System status, or download the HTML report instead.' },
    { key: 'html', label: 'HTML report', scope: 'This scan only: one file you can open or attach, screenshots included.', href: `/api/runs/${id}/export.html` },
  ];
  const technical: ExportItem[] = [{ key: 'json', label: 'JSON (report data)', scope: 'This scan only, for other tools.', href: `/api/runs/${id}/export.json` }];

  const base = `/runs/${id}`;
  return (
    <section aria-labelledby="run-heading">
      <Breadcrumb
        items={[
          { label: 'Projects', to: '/' },
          { label: project.data?.name ?? 'Project', to: `/projects/${r.projectId}` },
          { label: title },
        ]}
      />
      <PageHeader
        title={title}
        titleId="run-heading"
        subtitle={
          <>
            {pkg ? 'Uploaded course' : <span title={r.config.target.url}>{hostPath(r.config.target.url)}</span>} · scan started {formatDate(r.startedAt ?? r.queuedAt)}
            {r.retestOfRunId && (
              <>
                {' '}
                · <a href={`#/runs/${r.retestOfRunId}`}>retest of an earlier scan</a>
              </>
            )}
          </>
        }
        actions={
          <>
            {isActive && (
              <button type="button" className="btn btn-danger" onClick={cancel} disabled={cancelRequested}>
                {cancelRequested ? 'Cancelling…' : 'Cancel scan'}
              </button>
            )}
            {finished && r.status !== 'cancelled' && <ExportMenu items={exports} technical={technical} />}
          </>
        }
      />
      {cancelError !== undefined && <ErrorBox error={cancelError} />}
      {run.error !== undefined && run.data && (
        <Alert tone="warn" live title="Lost contact with the app.">
          This page could not refresh. The scan is not affected by this and keeps running; the page will keep trying.
        </Alert>
      )}

      <StatusBlock run={r} report={rep} cancelRequested={cancelRequested} />

      {finished && (r.status === 'completed' || r.status === 'partial' || r.summary.findingCount > 0 || r.states.length > 0) ? (
        <>
          <TabNav
            label="Result sections"
            tabs={[
              { to: base, label: 'Summary', current: current === 'summary' },
              { to: `${base}/issues`, label: 'Issues', current: current === 'issues', count: openCount },
              { to: `${base}/coverage`, label: 'Coverage', current: current === 'coverage' },
              { to: `${base}/manual`, label: 'Manual review', current: current === 'manual' },
              { to: `${base}/technical`, label: 'Technical details', current: current === 'technical' },
            ]}
          />
          {report.error && !rep ? (
            <ErrorBox error={report.error} onRetry={report.reload} />
          ) : !rep ? (
            <Loading />
          ) : (
            <TabBody tab={current} run={r} report={rep} query={query} isActive={isActive} onChanged={report.reload} />
          )}
        </>
      ) : null}
    </section>
  );
}

function TabBody({ tab, run, report, query, isActive, onChanged }: { tab: Tab; run: RunDetail; report: RunReport; query: URLSearchParams; isActive: boolean; onChanged: () => void }) {
  const canRetest = run.status === 'completed' || run.status === 'partial';
  if (tab === 'issues') return <IssuesTab key={query.toString()} runId={run.id} report={report} query={query} canRetest={canRetest} isRetest={Boolean(run.retestOfRunId)} onChanged={onChanged} />;
  if (tab === 'coverage') return <CoverageTab run={run} report={report} isActive={isActive} />;
  if (tab === 'manual') return <ManualReview run={run} />;
  if (tab === 'technical') return <TechnicalTab run={run} />;
  return <SummaryTab runId={run.id} report={report} isRetest={Boolean(run.retestOfRunId)} />;
}

function ManualReview({ run }: { run: RunDetail }) {
  const findings = useLoader(() => api.listFindings(run.id), [run.id, run.status]);
  const checks = useLoader(() => api.listChecks(run.id), [run.id, run.status]);
  return (
    <div>
      <Alert tone="note" title="Reference list, not a record.">
        These are things only a person can check. Nothing here is saved, so it is not a sign-off. The downloaded Excel tracker has a Manual checks sheet with status, owner and notes columns to fill in.
      </Alert>
      <Accessibility run={run} checks={checks.data} findings={findings.data} />
    </div>
  );
}

/** Honest status for every state, with the reason, the coverage limit, and what to do next. */
function StatusBlock({ run, report, cancelRequested }: { run: RunDetail; report?: RunReport; cancelRequested: boolean }) {
  const s = run.status;
  const explored = run.config.engines.traversal;
  const hasResults = run.summary.findingCount > 0 || run.states.length > 0;
  const budgets = report?.coverage.budgetsReached ?? run.coverage?.budgetsReached ?? [];
  const rescan = run.config.target.kind === 'package' ? `/projects/${run.projectId}/files` : `/projects/${run.projectId}/new-scan?url=${encodeURIComponent(run.config.target.url ?? '')}`;

  let headline: string;
  if (s === 'queued') headline = 'Waiting to start';
  else if (s === 'running') headline = cancelRequested ? 'Cancelling the scan…' : 'Scanning the course';
  else if (s === 'completed') headline = 'Scan finished — review the results';
  else if (s === 'partial') headline = 'Scan finished with partial results';
  else if (s === 'failed') headline = 'The scan could not be completed';
  else headline = 'Scan cancelled';

  return (
    <div className={`card status-card status-${s}`} role="status" aria-live="polite">
      <div className="inline">
        {active(s) && <span className="spinner" aria-hidden="true" />}
        <strong>{headline}</strong>
      </div>
      {s === 'queued' && <p>Waiting for the worker. One scan runs at a time, so this one starts after any scan ahead of it. You can leave this page; the scan continues.</p>}
      {s === 'running' && (
        <p>
          Elapsed <Elapsed since={run.startedAt ?? run.queuedAt} /> · {run.states.length} screen{run.states.length === 1 ? '' : 's'} captured so far. The scanner does not know how long the course is, so there is no progress percentage or time estimate. You can leave this page; the scan continues.
        </p>
      )}
      {(s === 'completed' || s === 'partial') && (
        <p>
          {explored
            ? `${report ? report.coverage.screensScanned : run.states.length} screen${(report ? report.coverage.screensScanned : run.states.length) === 1 ? '' : 's'} or view${(report ? report.coverage.screensScanned : run.states.length) === 1 ? '' : 's'} checked${budgets.length ? ', and the scan stopped at a limit, so other screens were not looked at' : ''}. `
            : 'Only the opening page was checked; course exploration was off. '}
          A finished scan is not a QA pass: see <a href={`#/runs/${run.id}/coverage`}>Coverage</a> for what was not reached.
        </p>
      )}
      {s !== 'completed' && run.statusDetail && (
        <p>
          <strong>Reason:</strong> {run.statusDetail}
        </p>
      )}
      {s === 'partial' && !run.statusDetail && <p>Some content was outside the scan scope, over a limit, or could not be checked. The Coverage tab lists what.</p>}
      {s === 'failed' && (
        <p>
          Nothing in the course is marked as passed. {hasResults ? 'Some results were saved before it stopped; they are shown below.' : 'No results were saved.'}{' '}
          <a className="btn btn-small" href={`#${rescan}`}>
            {run.config.target.kind === 'package' ? 'Go to course files' : 'Start a new scan of this course'}
          </a>
        </p>
      )}
      {s === 'cancelled' && (
        <p>
          Checks that did not run are marked not tested, never passed. Evidence collected before cancelling is kept{hasResults ? ' and shown below' : ''}.{' '}
          <a className="btn btn-small" href={`#${rescan}`}>
            {run.config.target.kind === 'package' ? 'Go to course files' : 'Start a new scan of this course'}
          </a>
        </p>
      )}
    </div>
  );
}
