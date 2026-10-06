import type { Evidence } from '@cqa/shared';
import { api } from '../api';
import { IssueStatus, STATUS_LABEL } from '../components/IssueStatus';
import { ScreenshotViewer } from '../components/ScreenshotViewer';
import { Breadcrumb, ErrorBox, Loading, PageHeader, SeverityBadge, TYPE_LABEL, courseTitle, formatDate, hostPath, useLoader } from '../components/ui';

export function FindingPage({ id }: { id: string }) {
  const { data, error, reload } = useLoader(() => api.getFinding(id), [id]);
  const run = useLoader(() => (data ? api.getRun(data.finding.runId) : Promise.resolve(undefined)), [data?.finding.runId]);
  const project = useLoader(() => (run.data ? api.getProject(run.data.projectId) : Promise.resolve(undefined)), [run.data?.projectId]);
  const report = useLoader(() => (data ? api.runReport(data.finding.runId) : Promise.resolve(undefined)), [data?.finding.runId]);
  const history = useLoader(() => api.findingHistory(id), [id, data?.finding.reviewer.updatedAt]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const { finding: f, evidence } = data;
  const loc = f.location;
  const issue = report.data?.issues.find((i) => i.findingId === f.id);
  const course = courseTitle(run.data?.states, run.data?.config.target.url);
  const screenLabel = issue?.screens[0];
  const screenTitle = screenLabel ? report.data?.screens.find((s) => s.label === screenLabel)?.title : undefined;

  return (
    <section aria-labelledby="finding-heading">
      <Breadcrumb
        items={[
          { label: 'Projects', to: '/' },
          { label: project.data?.name ?? 'Project', to: run.data ? `/projects/${run.data.projectId}` : '/' },
          { label: course, to: `/runs/${f.runId}` },
          { label: issue?.id ?? 'Finding' },
        ]}
      />
      <PageHeader
        title={f.title}
        titleId="finding-heading"
        subtitle={
          <span className="inline">
            <SeverityBadge severity={f.severity} />
            <span className="badge">{TYPE_LABEL[f.type]}</span>
            {issue && <span className="mono">{issue.id}</span>}
            <span>Status: {STATUS_LABEL[f.reviewer.status] ?? f.reviewer.status}</span>
          </span>
        }
        actions={
          <a className="btn" href={`#/runs/${f.runId}/issues`}>
            Back to issues
          </a>
        }
      />

      <div className="grid-2">
        <div className="card">
          <h2>What happened</h2>
          <p className="pre">{f.observed}</p>
          <h2>Why it matters</h2>
          <p>{f.expected}</p>
          <h2>What to do</h2>
          <p>{f.remediation}</p>
          {f.type !== 'automated_defect' && <p className="help">The scanner is not certain about this one. {f.type === 'manual_review' ? 'A person needs to look.' : 'Confirm it by hand before changing anything.'} Timeouts and checks that could not finish mean “could not verify”, not “broken”.</p>}
        </div>
        <div className="card">
          <h2>Where</h2>
          <dl className="kv">
            <div>
              <dt>Course</dt>
              <dd>{course}</dd>
            </div>
            <div>
              <dt>Screen</dt>
              <dd>
                {screenTitle ? `${screenTitle}${screenLabel ? ` (${screenLabel})` : ''}` : (loc.lessonTitle ?? loc.lessonId ?? <span className="muted">Not determinable by the scanner</span>)}
              </dd>
            </div>
            {loc.url && (
              <div>
                <dt>Address</dt>
                <dd className="mono" title={loc.url}>
                  {hostPath(loc.url)}
                </dd>
              </div>
            )}
            {loc.elementDescription && (
              <div>
                <dt>Element</dt>
                <dd className="mono">{loc.elementDescription}</dd>
              </div>
            )}
            <div>
              <dt>Screen size</dt>
              <dd>{loc.viewportName ?? '—'}</dd>
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
        <h2>Owner and status</h2>
        {issue ? <IssueStatus issue={issue} onSaved={() => (report.reload(), reload())} /> : report.error ? <p className="muted">Status editing is not available because the scan report could not be loaded.</p> : <Loading />}
        {history.data && history.data.length > 0 && (
          <details>
            <summary>Status history ({history.data.length})</summary>
            <ul className="plain">
              {history.data.map((h, n) => (
                <li key={n}>
                  {formatDate(h.at)} · {h.actor}: {STATUS_LABEL[h.from] ?? h.from} → {STATUS_LABEL[h.to] ?? h.to}
                  {h.assignee ? ` · owner ${h.assignee}` : ''}
                  {h.reason ? ` · ${h.reason}` : ''}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div className="card">
        <h2>Steps to see it</h2>
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

      <details className="card">
        <summary>
          <h2 className="inline-heading">Technical details</h2>
        </summary>
        <dl className="kv">
          <div>
            <dt>Rule</dt>
            <dd className="mono">{f.ruleId}</dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd>{f.confidence}</dd>
          </div>
          <div>
            <dt>Browser</dt>
            <dd>{loc.browser ?? '—'}</dd>
          </div>
          <div>
            <dt>Fingerprint</dt>
            <dd className="mono" title={f.fingerprint}>
              {f.fingerprint}
            </dd>
          </div>
          <div>
            <dt>Full address</dt>
            <dd className="mono">{loc.url ?? '—'}</dd>
          </div>
        </dl>
      </details>
    </section>
  );
}

function EvidenceItem({ e }: { e: Evidence }) {
  return (
    <div className="evidence">
      <h3>
        {e.caption} <span className="muted">({e.kind.replace(/_/g, ' ')})</span>
      </h3>
      {e.artifactId && e.kind.includes('screenshot') ? <ScreenshotViewer src={api.artifactUrl(e.artifactId)} alt={`Evidence: ${e.caption}`} caption={e.caption} title={e.caption} /> : null}
      {e.data && (
        <details>
          <summary>Recorded data</summary>
          <pre className="code">{JSON.stringify(e.data, null, 2)}</pre>
        </details>
      )}
      <p className="help">
        Captured {formatDate(e.capturedAt)}
        {e.viewportName ? ` · ${e.viewportName}` : ''}
      </p>
    </div>
  );
}
