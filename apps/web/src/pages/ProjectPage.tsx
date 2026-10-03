import { type FormEvent, useState } from 'react';
import { ApiError, api } from '../api';
import { Empty, ErrorBox, Link, Loading, StatusBadge, duration, formatDate, useLoader } from '../components/ui';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'laptop', width: 1366, height: 768 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
];

export function ProjectPage({ id }: { id: string }) {
  const project = useLoader(() => api.getProject(id), [id]);
  const runs = useLoader(() => api.listRuns(id), [id], (rs) => rs.some((r) => r.status === 'queued' || r.status === 'running'));

  if (project.error) return <ErrorBox error={project.error} onRetry={project.reload} />;
  if (!project.data) return <Loading />;
  const p = project.data;

  return (
    <section aria-labelledby="project-heading">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to="/">Projects</Link> <span aria-hidden="true">/</span> <span aria-current="page">{p.name}</span>
      </nav>
      <div className="page-header">
        <div>
          <h1 id="project-heading">{p.name}</h1>
          {p.description && <p className="muted">{p.description}</p>}
        </div>
      </div>

      <NewScanForm projectId={id} defaultUrl={p.courseUrl ?? ''} onQueued={(runId) => (window.location.hash = `/runs/${runId}`)} />

      <h2>Scan history</h2>
      {runs.error ? <ErrorBox error={runs.error} onRetry={runs.reload} /> : !runs.data ? <Loading /> : runs.data.length === 0 ? (
        <Empty title="No scans yet">
          <p>Configure and start a scan above.</p>
        </Empty>
      ) : (
        <table className="table">
          <caption className="sr-only">Scan history</caption>
          <thead>
            <tr>
              <th scope="col">Started</th>
              <th scope="col">Target</th>
              <th scope="col">Status</th>
              <th scope="col">Findings</th>
              <th scope="col">Checks run</th>
              <th scope="col">Duration</th>
            </tr>
          </thead>
          <tbody>
            {runs.data.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/runs/${r.id}`}>{formatDate(r.queuedAt)}</Link>
                </td>
                <td className="mono truncate">{r.config.target.url}</td>
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
      )}
    </section>
  );
}

function NewScanForm({ projectId, defaultUrl, onQueued }: { projectId: string; defaultUrl: string; onQueued: (runId: string) => void }) {
  const [url, setUrl] = useState(defaultUrl);
  const [origins, setOrigins] = useState('');
  const [prefixes, setPrefixes] = useState('');
  const [timeoutSec, setTimeoutSec] = useState(30);
  const [viewport, setViewport] = useState('desktop');
  const [explore, setExplore] = useState(true);
  const [maxStates, setMaxStates] = useState(25);
  const [maxDepth, setMaxDepth] = useState(4);
  const [terms, setTerms] = useState('');
  const [exclusions, setExclusions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const lines = (s: string) =>
    s
      .split(/[\n,]/)
      .map((x) => x.trim())
      .filter(Boolean);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const run = await api.createScan(projectId, {
        url,
        allowedOrigins: lines(origins),
        allowedPathPrefixes: lines(prefixes),
        navigationTimeoutMs: timeoutSec * 1000,
        viewport: VIEWPORTS.find((v) => v.name === viewport),
        explore,
        maxStates,
        maxDepth,
        terminology: terms
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const [term, preferred] = l.split('=>').map((x) => x.trim());
            return preferred ? { term: term!, preferred } : { term: term! };
          }),
        textExclusions: exclusions
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      });
      onQueued(run.id);
    } catch (err) {
      setError(err instanceof ApiError ? [err.message, ...(err.issues?.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [])].join(' ') : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={submit} aria-labelledby="new-scan-heading">
      <h2 id="new-scan-heading">New scan</h2>
      <p className="muted">
        Captures the initial page (screenshot, title, final URL, JavaScript exceptions, console errors, failed requests, load timing), then optionally explores recognized
        tabs, accordions, dialogs, Next/Back controls, and in-scope links without submitting forms or clicking unsafe controls. Every reached state is checked for broken
        images and media, missing captions, and placeholder text, and every link destination is checked once. Private, loopback, and reserved network addresses are blocked.
      </p>
      <div className="field">
        <label htmlFor="s-url">Course URL</label>
        <input id="s-url" type="url" required inputMode="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} />
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="s-origins">Additional allowed origins</label>
          <textarea id="s-origins" rows={2} placeholder="https://cdn.example.com" value={origins} onChange={(e) => setOrigins(e.target.value)} aria-describedby="s-origins-help" />
          <p id="s-origins-help" className="help">
            The course URL's own origin is always allowed. One per line.
          </p>
        </div>
        <div className="field">
          <label htmlFor="s-prefixes">Allowed path prefixes</label>
          <textarea id="s-prefixes" rows={2} placeholder="/course/" value={prefixes} onChange={(e) => setPrefixes(e.target.value)} aria-describedby="s-prefixes-help" />
          <p id="s-prefixes-help" className="help">
            Leave empty to allow the whole origin.
          </p>
        </div>
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="s-timeout">Navigation timeout (seconds)</label>
          <input id="s-timeout" type="number" min={1} max={120} required value={timeoutSec} onChange={(e) => setTimeoutSec(Number(e.target.value))} />
        </div>
        <div className="field">
          <label htmlFor="s-viewport">Viewport (CSS-pixel simulation)</label>
          <select id="s-viewport" value={viewport} onChange={(e) => setViewport(e.target.value)}>
            {VIEWPORTS.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} — {v.width}×{v.height}
              </option>
            ))}
          </select>
        </div>
      </div>
      <fieldset className="fieldset">
        <legend>Exploration</legend>
        <label className="checkbox">
          <input type="checkbox" checked={explore} onChange={(e) => setExplore(e.target.checked)} /> Explore course interactions (read-only)
        </label>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="s-states">Maximum states</label>
            <input id="s-states" type="number" min={1} max={200} required disabled={!explore} value={maxStates} onChange={(e) => setMaxStates(Number(e.target.value))} />
          </div>
          <div className="field">
            <label htmlFor="s-depth">Maximum depth (actions from the start)</label>
            <input id="s-depth" type="number" min={0} max={10} required disabled={!explore} value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))} />
          </div>
        </div>
      </fieldset>
      <fieldset className="fieldset">
        <legend>Text checks</legend>
        <p className="help">Placeholder text (lorem ipsum, TBD, [Insert …], notes to the GD/developer) is always checked. This is not a grammar review.</p>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="s-terms">Terms to flag</label>
            <textarea id="s-terms" rows={3} placeholder={'e-learning => eLearning'} value={terms} onChange={(e) => setTerms(e.target.value)} aria-describedby="s-terms-help" />
            <p id="s-terms-help" className="help">
              One per line. Use "term =&gt; preferred" to suggest a replacement.
            </p>
          </div>
          <div className="field">
            <label htmlFor="s-excl">Never flag text containing</label>
            <textarea id="s-excl" rows={3} placeholder="XXX Series" value={exclusions} onChange={(e) => setExclusions(e.target.value)} aria-describedby="s-excl-help" />
            <p id="s-excl-help" className="help">
              One per line. For intentional uses of words like TBD.
            </p>
          </div>
        </div>
      </fieldset>
      {error && (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Validating…' : 'Validate and start scan'}
        </button>
      </div>
    </form>
  );
}
