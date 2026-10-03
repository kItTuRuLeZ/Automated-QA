import type { Evidence } from '@cqa/shared';
import { api } from '../api';
import { ErrorBox, Link, Loading, SeverityBadge, TYPE_LABEL, formatDate, useLoader } from '../components/ui';

export function FindingPage({ id }: { id: string }) {
  const { data, error, reload } = useLoader(() => api.getFinding(id), [id]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const { finding: f, evidence } = data;
  const loc = f.location;

  return (
    <section aria-labelledby="finding-heading">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to="/">Projects</Link> <span aria-hidden="true">/</span> <Link to={`/runs/${f.runId}`}>Scan</Link> <span aria-hidden="true">/</span>{' '}
        <span aria-current="page">Finding</span>
      </nav>
      <div className="page-header">
        <div>
          <h1 id="finding-heading">{f.title}</h1>
          <p className="inline">
            <SeverityBadge severity={f.severity} />
            <span className="badge">{TYPE_LABEL[f.type]}</span>
            <span className="muted">
              Rule <code>{f.ruleId}</code> · Confidence {f.confidence} · Status {f.reviewer.status}
            </span>
          </p>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Observed</h2>
          <p className="pre">{f.observed}</p>
          <h2>Expected</h2>
          <p>{f.expected}</p>
          <h2>Remediation</h2>
          <p>{f.remediation}</p>
        </div>
        <div className="card">
          <h2>Location</h2>
          <dl className="kv">
            {loc.url && (
              <div>
                <dt>URL</dt>
                <dd className="mono">{loc.url}</dd>
              </div>
            )}
            {loc.elementDescription && (
              <div>
                <dt>Element</dt>
                <dd className="mono">{loc.elementDescription}</dd>
              </div>
            )}
            <div>
              <dt>Viewport</dt>
              <dd>{loc.viewportName ?? '—'}</dd>
            </div>
            <div>
              <dt>Browser</dt>
              <dd>{loc.browser ?? '—'}</dd>
            </div>
            <div>
              <dt>Lesson / screen</dt>
              <dd className="muted">{loc.lessonTitle ?? loc.lessonId ?? 'Not determinable by the scanner'}</dd>
            </div>
            <div>
              <dt>Fingerprint</dt>
              <dd className="mono truncate" title={f.fingerprint}>
                {f.fingerprint.slice(0, 16)}…
              </dd>
            </div>
            <div>
              <dt>Recorded</dt>
              <dd>{formatDate(f.createdAt)}</dd>
            </div>
          </dl>
          {f.standards.length > 0 && (
            <>
              <h3>Related standards</h3>
              <ul>
                {f.standards.map((s) => (
                  <li key={`${s.standard}-${s.criterion}`}>
                    {s.standard} {s.version} {s.criterion} ({s.relation === 'relevant' ? 'relevant to, not proof of failure' : 'fails'})
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Steps to reproduce</h2>
        <ol>
          {f.reproductionSteps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      </div>

      <div className="card">
        <h2>Evidence ({evidence.length})</h2>
        {evidence.length === 0 ? <p className="muted">No evidence attached.</p> : evidence.map((e) => <EvidenceItem key={e.id} e={e} />)}
      </div>
    </section>
  );
}

function EvidenceItem({ e }: { e: Evidence }) {
  return (
    <div className="evidence">
      <h3>
        {e.caption} <span className="muted">({e.kind.replace(/_/g, ' ')})</span>
      </h3>
      {e.artifactId && e.kind.includes('screenshot') ? (
        <figure className="screenshot">
          <img src={api.artifactUrl(e.artifactId)} alt={`Evidence: ${e.caption}`} loading="lazy" />
        </figure>
      ) : null}
      {e.data && <pre className="code">{JSON.stringify(e.data, null, 2)}</pre>}
      <p className="help">
        Captured {formatDate(e.capturedAt)}
        {e.viewportName ? ` · ${e.viewportName}` : ''}
      </p>
    </div>
  );
}
