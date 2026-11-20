import type { RunStatus } from '@cqa/shared';
import { api } from '../api';
import { Breadcrumb, ErrorBox, Loading, PageHeader, TableScroll, useLoader } from '../components/ui';

const STATUS: Record<RunStatus, string> = { queued: 'Waiting to start', running: 'Scanning', completed: 'Finished', partial: 'Finished, some parts not checked', failed: 'Could not be completed', cancelled: 'Cancelled' };
const active = (s: RunStatus) => s === 'queued' || s === 'running';

/** One row: a lesson's scan, refreshed while it runs, with what it has recorded so far and a link to its result. */
function BatchRow({ runId }: { runId: string }) {
  const run = useLoader(() => api.getRun(runId), [runId], (r) => active(r.status));
  const pkg = useLoader(() => (run.data?.config.target.packageId ? api.getPackage(run.data.config.target.packageId) : Promise.resolve(undefined)), [run.data?.config.target.packageId]);
  if (run.error && !run.data) {
    return (
      <tr>
        <td colSpan={4}>This scan could not be loaded.</td>
      </tr>
    );
  }
  if (!run.data) {
    return (
      <tr>
        <td colSpan={4}>Loading…</td>
      </tr>
    );
  }
  const r = run.data;
  const title = pkg.data?.inspection.launchChoices.find((c) => c.key === r.config.target.launchEntry)?.title ?? r.config.target.launchEntry ?? 'Lesson';
  return (
    <tr>
      <th scope="row">{title}</th>
      <td>
        {STATUS[r.status]}
        {active(r.status) && <span className="spinner" aria-hidden="true" />}
      </td>
      <td>
        {r.states.length} screen{r.states.length === 1 ? '' : 's'} reached · {r.summary.findingCount} finding{r.summary.findingCount === 1 ? '' : 's'}
      </td>
      <td>
        <a href={`#/runs/${r.id}`}>{active(r.status) ? 'Follow progress' : 'Open the result'}</a>
      </td>
    </tr>
  );
}

/** Every lesson a ZIP scan queued, with its status and result, and the lessons that were not chosen. */
export function BatchPage({ projectId, query }: { projectId: string; query: URLSearchParams }) {
  const project = useLoader(() => api.getProject(projectId), [projectId]);
  const runs = (query.get('runs') ?? '').split(',').filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  let skipped: string[] = [];
  try {
    const raw = JSON.parse(query.get('skipped') ?? '[]') as unknown;
    if (Array.isArray(raw)) skipped = raw.filter((x): x is string => typeof x === 'string').slice(0, 100);
  } catch {
    skipped = [];
  }
  if (project.error) return <ErrorBox error={project.error} onRetry={project.reload} />;
  if (!project.data) return <Loading />;
  return (
    <section aria-labelledby="batch-h">
      <Breadcrumb items={[{ label: 'Projects', to: '/' }, { label: project.data.name, to: `/projects/${projectId}` }, { label: 'Lessons scanned' }]} />
      <PageHeader title="Lessons scanned" titleId="batch-h" subtitle={`${runs.length} lesson${runs.length === 1 ? '' : 's'}, each in its own scan. They run one at a time.`} />
      <TableScroll label="Scans in this batch">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Lesson</th>
              <th scope="col">Status</th>
              <th scope="col">Recorded so far</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((id) => (
              <BatchRow key={id} runId={id} />
            ))}
          </tbody>
        </table>
      </TableScroll>
      {skipped.length > 0 && (
        <section className="card" aria-labelledby="skipped-h">
          <h2 id="skipped-h">Not scanned ({skipped.length})</h2>
          <p>These lessons were not chosen, so nothing in them was checked.</p>
          <ul>
            {skipped.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
