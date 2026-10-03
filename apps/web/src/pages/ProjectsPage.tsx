import { type FormEvent, useState } from 'react';
import { ApiError, api } from '../api';
import { Empty, ErrorBox, Link, Loading, StatusBadge, formatDate, useLoader } from '../components/ui';

export function ProjectsPage() {
  const { data, error, reload } = useLoader(() => api.listProjects(), []);
  const [showForm, setShowForm] = useState(false);

  return (
    <section aria-labelledby="projects-heading">
      <div className="page-header">
        <h1 id="projects-heading">Projects</h1>
        <button type="button" className="btn btn-primary" onClick={() => setShowForm((s) => !s)} aria-expanded={showForm}>
          New project
        </button>
      </div>
      {showForm && (
        <NewProjectForm
          onCreated={(id) => {
            window.location.hash = `/projects/${id}`;
          }}
          onCancel={() => setShowForm(false)}
        />
      )}
      {error ? <ErrorBox error={error} onRetry={reload} /> : !data ? <Loading /> : data.length === 0 ? (
        <Empty title="No projects yet">
          <p>Create a project for a published course, then run a scan.</p>
        </Empty>
      ) : (
        <table className="table">
          <caption className="sr-only">Projects</caption>
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Course URL</th>
              <th scope="col">Scans</th>
              <th scope="col">Latest scan</th>
            </tr>
          </thead>
          <tbody>
            {data.map((p) => (
              <tr key={p.id}>
                <td>
                  <Link to={`/projects/${p.id}`}>{p.name}</Link>
                  {p.isDemo && <span className="badge">Demo data</span>}
                </td>
                <td className="mono truncate">{p.courseUrl ?? '—'}</td>
                <td>{p.runCount}</td>
                <td>
                  {p.lastRun ? (
                    <span className="inline">
                      <StatusBadge status={p.lastRun.status} /> <span className="muted">{formatDate(p.lastRun.queuedAt)}</span>
                    </span>
                  ) : (
                    <span className="muted">Never scanned</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function NewProjectForm({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [courseUrl, setCourseUrl] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const p = await api.createProject({ name, courseUrl: courseUrl || undefined, description: description || undefined });
      onCreated(p.id);
    } catch (err) {
      setError(err instanceof ApiError ? (err.issues?.map((i) => i.message).join(' ') || err.message) : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={submit} aria-labelledby="new-project-heading">
      <h2 id="new-project-heading">New project</h2>
      <div className="field">
        <label htmlFor="p-name">Project name</label>
        <input id="p-name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="p-url">Published course URL (optional)</label>
        <input id="p-url" type="url" inputMode="url" placeholder="https://" value={courseUrl} onChange={(e) => setCourseUrl(e.target.value)} />
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
