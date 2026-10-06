import { type FormEvent, useState } from 'react';
import { ApiError, api } from '../api';
import { CopyButton, Empty, ErrorBox, Link, Loading, PageHeader, StatusBadge, formatDate, hostPath, useLoader } from '../components/ui';

export function ProjectsPage() {
  const { data, error, reload } = useLoader(() => api.listProjects(), []);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState('');

  const q = search.trim().toLowerCase();
  const shown = (data ?? []).filter((p) => !q || `${p.name} ${p.description ?? ''} ${p.courseUrl ?? ''}`.toLowerCase().includes(q));

  return (
    <section aria-labelledby="projects-heading">
      <PageHeader
        title="Projects"
        titleId="projects-heading"
        subtitle="Check published courses, review issues and track fixes."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setShowForm((s) => !s)} aria-expanded={showForm}>
            New project
          </button>
        }
      />
      {showForm && (
        <NewProjectForm
          onCreated={(id, hasUrl) => {
            window.location.hash = hasUrl ? `/projects/${id}/new-scan` : `/projects/${id}`;
          }}
          onCancel={() => setShowForm(false)}
        />
      )}
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : !data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty title="No projects yet">
          <p>A project holds the scans, issues and reports for one course. Create one, then start a scan.</p>
          <button type="button" className="btn btn-primary" onClick={() => setShowForm(true)}>
            Create your first project
          </button>
        </Empty>
      ) : (
        <>
          {data.length > 4 && (
            <div className="field search">
              <label htmlFor="project-search">Search projects</label>
              <input id="project-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, description or address" />
            </div>
          )}
          <p className="muted" role="status">
            {shown.length === data.length ? `${data.length} project${data.length === 1 ? '' : 's'}` : `${shown.length} of ${data.length} projects match`}
          </p>
          {shown.length === 0 ? (
            <Empty title="No projects match your search" />
          ) : (
            <ul className="project-list">
              {shown.map((p) => (
                <li key={p.id} className="card project-card">
                  <div className="project-main">
                    <h2 className="project-name">
                      <Link to={`/projects/${p.id}`}>{p.name}</Link>
                      {p.isDemo && <span className="badge">Demo data</span>}
                    </h2>
                    {p.description && <p className="muted">{p.description}</p>}
                    {p.courseUrl && (
                      <p className="project-url">
                        <span className="label">Course:</span> <span title={p.courseUrl}>{hostPath(p.courseUrl)}</span> <CopyButton text={p.courseUrl} label="Copy full address" />
                      </p>
                    )}
                  </div>
                  <div className="project-side">
                    {p.lastRun ? (
                      <>
                        <p className="inline">
                          <span className="label">Latest scan:</span> <StatusBadge status={p.lastRun.status} />
                        </p>
                        <p className="muted">
                          {formatDate(p.lastRun.queuedAt)} · {p.runCount} scan{p.runCount === 1 ? '' : 's'} in total
                        </p>
                        <a className="btn" href={`#/runs/${p.lastRun.id}`}>
                          View latest results<span className="sr-only"> for {p.name}</span>
                        </a>
                      </>
                    ) : (
                      <>
                        <p className="muted">No scans yet</p>
                        <a className="btn btn-primary" href={`#/projects/${p.id}/new-scan`}>
                          Start first scan<span className="sr-only"> for {p.name}</span>
                        </a>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function NewProjectForm({ onCreated, onCancel }: { onCreated: (id: string, hasUrl: boolean) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [courseUrl, setCourseUrl] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const p = await api.createProject({ name, courseUrl: courseUrl || undefined, description: description || undefined });
      onCreated(p.id, Boolean(courseUrl));
    } catch (err) {
      setError(err instanceof ApiError ? (err.issues?.map((i) => i.message).join(' ') || err.message) : String(err));
      setBusy(false);
    }
  };

  return (
    <form className="card form narrow" onSubmit={submit} aria-labelledby="new-project-heading">
      <h2 id="new-project-heading">New project</h2>
      <div className="field">
        <label htmlFor="p-name">Project name</label>
        <input id="p-name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="field">
        <label htmlFor="p-url">Published course link (optional)</label>
        <input id="p-url" type="url" inputMode="url" placeholder="https://" value={courseUrl} onChange={(e) => setCourseUrl(e.target.value)} aria-describedby="p-url-help" />
        <p id="p-url-help" className="help">
          If you add it now, it is filled in for your first scan. You can also upload a course ZIP later.
        </p>
      </div>
      <div className="field">
        <label htmlFor="p-desc">Description (optional)</label>
        <textarea id="p-desc" rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create project'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
