import { api } from '../api';
import { ExportMenu, type ExportItem } from '../components/ExportMenu';
import { PackagesPanel } from '../components/Packages';
import { Alert, Breadcrumb, Empty, ErrorBox, Link, Loading, PageHeader, StatusBadge, TabNav, TableScroll, duration, formatDate, hostPath, useLoader } from '../components/ui';

const FINISHED = ['completed', 'partial', 'failed'];

export function ProjectPage({ id, tab }: { id: string; tab?: string }) {
  const project = useLoader(() => api.getProject(id), [id]);
  const runs = useLoader(() => api.listRuns(id), [id], (rs) => rs.some((r) => r.status === 'queued' || r.status === 'running'));
  const current = tab === 'files' ? 'files' : tab === 'history' ? 'history' : 'overview';

  if (project.error) return <ErrorBox error={project.error} onRetry={project.reload} />;
  if (!project.data) return <Loading />;
  const p = project.data;
  const finishedRuns = (runs.data ?? []).filter((r) => FINISHED.includes(r.status));
  const courses = [...new Set(finishedRuns.map((r) => r.config.target.url ?? ''))].filter(Boolean);

  const exports: ExportItem[] = [
    ...courses.map((course) => ({
      key: `course-${course}`,
      label: `Excel tracker: ${hostPath(course)}`,
      scope: `This course, across all ${finishedRuns.filter((r) => r.config.target.url === course).length} finished scan(s).`,
      href: `/api/projects/${id}/export.xlsx?course=${encodeURIComponent(course)}`,
    })),
    ...(courses.length > 1 ? [{ key: 'all', label: 'Excel tracker: all courses', scope: `Every course in this project in one workbook.`, href: `/api/projects/${id}/export.xlsx` }] : []),
  ];

  return (
    <section aria-labelledby="project-heading">
      <Breadcrumb items={[{ label: 'Projects', to: '/' }, { label: p.name }]} />
      <PageHeader
        title={p.name}
        titleId="project-heading"
        subtitle={p.description}
        actions={
          <>
            {exports.length > 0 && <ExportMenu label="Download tracker" items={exports} />}
            <a className="btn btn-primary" href={`#/projects/${id}/new-scan`}>
              Start new scan
            </a>
          </>
        }
      />
      <TabNav
        label="Project sections"
        tabs={[
          { to: `/projects/${id}`, label: 'Overview', current: current === 'overview' },
          { to: `/projects/${id}/files`, label: 'Course files', current: current === 'files' },
          { to: `/projects/${id}/history`, label: 'Scan history', current: current === 'history', count: runs.data?.length },
        ]}
      />

      {current === 'overview' && <Overview projectId={id} courseUrl={p.courseUrl} runs={runs} />}
      {current === 'files' && <PackagesPanel projectId={id} />}
      {current === 'history' && <History runs={runs} />}
    </section>
  );
}

function Overview({ projectId, courseUrl, runs }: { projectId: string; courseUrl?: string; runs: ReturnType<typeof useLoader<Awaited<ReturnType<typeof api.listRuns>>>> }) {
  const latest = runs.data?.[0];
  const report = useLoader(() => (latest && FINISHED.includes(latest.status) ? api.runReport(latest.id) : Promise.resolve(undefined)), [latest?.id, latest?.status]);
  if (runs.error) return <ErrorBox error={runs.error} onRetry={runs.reload} />;
  if (!runs.data) return <Loading />;

  if (!latest) {
    return (
      <Empty title="No scans yet">
        <p>{courseUrl ? 'This project has a course link ready.' : 'Add a published course link, or upload a course ZIP.'} Start a scan to see what the checks find.</p>
        <a className="btn btn-primary" href={`#/projects/${projectId}/new-scan`}>
          Start first scan
        </a>
      </Empty>
    );
  }
  const r = report.data;
  return (
    <div className="grid-2">
      <div className="card">
        <h2>Latest scan</h2>
        <p className="inline">
          <StatusBadge status={latest.status} /> <span className="muted">{formatDate(latest.queuedAt)}</span>
        </p>
        <p className="muted">{hostPath(latest.config.target.url)}</p>
        {r ? (
          <ul className="plain">
            <li>
              <strong>{r.counts.fix}</strong> issue{r.counts.fix === 1 ? '' : 's'} to fix
            </li>
            <li>
              <strong>{r.counts.check}</strong> need{r.counts.check === 1 ? 's' : ''} your review
            </li>
            <li>
              <strong>{r.counts.notChecked}</strong> coverage gap{r.counts.notChecked === 1 ? '' : 's'} (areas not checked)
            </li>
          </ul>
        ) : latest.status === 'queued' || latest.status === 'running' ? (
          <p className="muted">This scan is still {latest.status === 'queued' ? 'waiting to start' : 'running'}.</p>
        ) : null}
        <a className="btn btn-primary" href={`#/runs/${latest.id}`}>
          View latest results
        </a>
      </div>
      <div className="card">
        <h2>Next steps</h2>
        <ul className="plain">
          <li>
            <a href={`#/projects/${projectId}/new-scan`}>Start a new scan</a>: for a changed course or to retest fixes.
          </li>
          <li>
            <a href={`#/projects/${projectId}/files`}>Course files</a>: upload or review course ZIP packages.
          </li>
          <li>
            <a href={`#/projects/${projectId}/history`}>Scan history</a>: compare earlier scans ({runs.data.length} so far).
          </li>
        </ul>
        {courseUrl && (
          <p className="help">
            Course link on file: <span title={courseUrl}>{hostPath(courseUrl)}</span>
          </p>
        )}
      </div>
    </div>
  );
}

function History({ runs }: { runs: ReturnType<typeof useLoader<Awaited<ReturnType<typeof api.listRuns>>>> }) {
  if (runs.error) return <ErrorBox error={runs.error} onRetry={runs.reload} />;
  if (!runs.data) return <Loading />;
  if (runs.data.length === 0) return <Empty title="No scans yet">Scans you start appear here.</Empty>;
  return (
    <>
      <Alert tone="note">
        “Checks that ran” counts individual check executions (a rule at a screen and screen size). It is not the number of findings, and checks that did not run are never counted as passed.
      </Alert>
      <TableScroll label="Scan history">
        <table className="table">
          <caption className="sr-only">Scan history</caption>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Course</th>
              <th scope="col">Status</th>
              <th scope="col">Findings</th>
              <th scope="col">Checks that ran</th>
              <th scope="col">Duration</th>
            </tr>
          </thead>
          <tbody>
            {runs.data.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/runs/${r.id}`}>{formatDate(r.queuedAt)}</Link>
                </td>
                <td className="truncate" title={r.config.target.url}>
                  {r.config.target.kind === 'package' ? `${r.config.target.packageName ?? 'Uploaded package'}${r.config.target.launchEntry ? ` (${r.config.target.launchEntry})` : ''}` : hostPath(r.config.target.url)}
                </td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td>{r.summary.findingCount}</td>
                <td>
                  {r.summary.executions - r.summary.byOutcome.not_tested} of {r.summary.executions}
                </td>
                <td>{duration(r.startedAt, r.finishedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </>
  );
}
