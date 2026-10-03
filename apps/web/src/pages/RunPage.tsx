import { useState } from 'react';
import type { CheckResult, Finding } from '@cqa/shared';
import { api } from '../api';
import { Accessibility } from '../components/Accessibility';
import { PlainSummary } from '../components/PlainSummary';
import { Coverage } from '../components/Coverage';
import {
  Empty,
  ErrorBox,
  Link,
  Loading,
  OUTCOME_LABEL,
  OutcomeBadge,
  RUN_STATUS_HELP,
  SEVERITY_LABEL,
  SeverityBadge,
  StatusBadge,
  TYPE_LABEL,
  duration,
  formatDate,
  useLoader,
  TableScroll,
} from '../components/ui';

const active = (s: string) => s === 'queued' || s === 'running';

export function RunPage({ id }: { id: string }) {
  const run = useLoader(() => api.getRun(id), [id], (r) => active(r.status));
  const isActive = run.data ? active(run.data.status) : false;
  const findings = useLoader(() => api.listFindings(id), [id, run.data?.status]);
  const checks = useLoader(() => api.listChecks(id), [id, run.data?.status]);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<unknown>();

  if (run.error) return <ErrorBox error={run.error} onRetry={run.reload} />;
  if (!run.data) return <Loading />;
  const r = run.data;
  const s = r.summary;
  const screenshot = r.states[0];

  const cancel = async () => {
    setCancelling(true);
    setCancelError(undefined);
    try {
      await api.cancelRun(id);
      run.reload();
    } catch (e) {
      setCancelError(e);
    } finally {
      setCancelling(false);
    }
  };

  return (
    <section aria-labelledby="run-heading">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to="/">Projects</Link> <span aria-hidden="true">/</span> <Link to={`/projects/${r.projectId}`}>Project</Link> <span aria-hidden="true">/</span>{' '}
        <span aria-current="page">Scan</span>
      </nav>
      <div className="page-header">
        <div>
          <h1 id="run-heading">Scan of {r.config.target.url}</h1>
          <p className="muted">Queued {formatDate(r.queuedAt)}</p>
        </div>
        {isActive && (
          <button type="button" className="btn btn-danger" onClick={cancel} disabled={cancelling}>
            {cancelling ? 'Cancelling…' : 'Cancel scan'}
          </button>
        )}
      </div>
      {Boolean(cancelError) && <ErrorBox error={cancelError} />}

      <div className={`card status-card status-${r.status}`} role="status" aria-live="polite">
        <div className="inline">
          <StatusBadge status={r.status} />
          {isActive && <span className="spinner" aria-hidden="true" />}
          <span>{RUN_STATUS_HELP[r.status]}</span>
        </div>
        {r.statusDetail && (
          <p>
            <strong>Reason:</strong> {r.statusDetail} {r.statusReason && <code>{r.statusReason}</code>}
          </p>
        )}
      </div>

      <PlainSummary run={r} isActive={isActive} />

      <Accessibility run={r} checks={checks.data} findings={findings.data} />

      <Coverage run={r} states={r.states} screenshots={r.screenshots} />

      <details className="card">
        <summary>
          <h2 className="inline-heading">Technical details: counts, rules, and the full findings table</h2>
        </summary>
      <div className="stats">
        <Stat label="Findings" value={s.findingCount} />
        <Stat label="Unique rules" value={s.uniqueRules} hint="Distinct rules evaluated" />
        <Stat label="Check executions" value={s.executions} hint="Rule × state × viewport" />
        <Stat label="Not tested" value={s.byOutcome.not_tested + s.byOutcome.error} hint="Not tested or errored; never counted as passed" />
        <Stat label="Duration" value={duration(r.startedAt, r.finishedAt)} />
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Findings by severity</h2>
          <dl className="kv">
            {(Object.keys(SEVERITY_LABEL) as Array<keyof typeof SEVERITY_LABEL>).map((k) => (
              <div key={k}>
                <dt>{SEVERITY_LABEL[k]}</dt>
                <dd>{s.findingsBySeverity[k]}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="card">
          <h2>Check results</h2>
          <dl className="kv">
            {(Object.keys(OUTCOME_LABEL) as Array<keyof typeof OUTCOME_LABEL>).map((k) => (
              <div key={k}>
                <dt>{OUTCOME_LABEL[k]}</dt>
                <dd>{s.byOutcome[k]}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      {screenshot && (
        <div className="card">
          <h2>Initial state</h2>
          <dl className="kv">
            <div>
              <dt>Final URL</dt>
              <dd className="mono">{screenshot.url}</dd>
            </div>
            <div>
              <dt>Title</dt>
              <dd>{screenshot.title || <span className="muted">(none)</span>}</dd>
            </div>
            <div>
              <dt>Viewport</dt>
              <dd>
                {r.config.viewports[0]?.name} {r.config.viewports[0]?.width}×{r.config.viewports[0]?.height} (CSS-pixel simulation)
              </dd>
            </div>
            <div>
              <dt>Browser</dt>
              <dd>{r.browser ? `${r.browser.engine} ${r.browser.version}` : '—'}</dd>
            </div>
          </dl>
          {r.screenshots.filter((shot) => shot.stateId === screenshot.id).slice(0, 1).map((shot) => (
            <figure className="screenshot" key={shot.artifactId}>
              <img src={api.artifactUrl(shot.artifactId)} alt="Screenshot of the initial course page as captured by the scanner" loading="lazy" />
              <figcaption>{shot.caption}</figcaption>
            </figure>
          ))}
        </div>
      )}

      <h2>Findings</h2>
      {findings.error ? <ErrorBox error={findings.error} onRetry={findings.reload} /> : !findings.data ? <Loading /> : findings.data.length === 0 ? (
        <Empty title={isActive ? 'No findings yet' : 'No findings recorded'}>
          <p>{isActive ? 'Findings appear when the scan finishes.' : 'No findings does not mean the course passed QA. Check coverage and the not-tested count above.'}</p>
        </Empty>
      ) : (
        <FindingsTable findings={findings.data} />
      )}

      </details>

      <details className="card">
        <summary>
          <h2 className="inline-heading">All check executions ({checks.data?.length ?? 0})</h2>
        </summary>
        {checks.data && <ChecksTable checks={checks.data} />}
      </details>

      <details className="card">
        <summary>
          <h2 className="inline-heading">Scan configuration and environment</h2>
        </summary>
        <dl className="kv">
          <div>
            <dt>Allowed origins</dt>
            <dd className="mono">{r.config.scope.allowedOrigins.join(', ')}</dd>
          </div>
          <div>
            <dt>Path prefixes</dt>
            <dd className="mono">{r.config.scope.allowedPathPrefixes.join(', ') || 'Whole origin'}</dd>
          </div>
          <div>
            <dt>Navigation timeout</dt>
            <dd>{r.config.budgets.navigationTimeoutMs / 1000} s</dd>
          </div>
          <div>
            <dt>Runtime budget</dt>
            <dd>{r.config.budgets.maxRuntimeMs / 1000} s</dd>
          </div>
          <div>
            <dt>Tools</dt>
            <dd>{r.toolVersions.map((t) => `${t.name} ${t.version}`).join(', ') || '—'}</dd>
          </div>
          <div>
            <dt>Blocked requests</dt>
            <dd>{r.coverage?.blockedRequests ?? '—'}</dd>
          </div>
          <div>
            <dt>AI assistance</dt>
            <dd>Off (not part of core scanning)</dd>
          </div>
        </dl>
      </details>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="stat" title={hint}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="help">{hint}</div>}
    </div>
  );
}

function FindingsTable({ findings }: { findings: Finding[] }) {
  return (
    <TableScroll label="Findings, most severe first">
<table className="table">
      <caption className="sr-only">Findings, most severe first</caption>
      <thead>
        <tr>
          <th scope="col">Severity</th>
          <th scope="col">Finding</th>
          <th scope="col">Type</th>
          <th scope="col">Rule</th>
          <th scope="col">Confidence</th>
          <th scope="col">Occurrences</th>
        </tr>
      </thead>
      <tbody>
        {findings.map((f) => (
          <tr key={f.id}>
            <td>
              <SeverityBadge severity={f.severity} />
            </td>
            <td>
              <Link to={`/findings/${f.id}`}>{f.title}</Link>
            </td>
            <td>{TYPE_LABEL[f.type]}</td>
            <td className="mono">{f.ruleId}</td>
            <td>{f.confidence}</td>
            <td>{f.occurrences.length}</td>
          </tr>
        ))}
      </tbody>
    </table>
</TableScroll>
  );
}

function ChecksTable({ checks }: { checks: CheckResult[] }) {
  return (
    <TableScroll label="Check executions">
<table className="table">
      <caption className="sr-only">Check executions</caption>
      <thead>
        <tr>
          <th scope="col">Rule</th>
          <th scope="col">Result</th>
          <th scope="col">Viewport</th>
          <th scope="col">Reason</th>
          <th scope="col">Duration</th>
        </tr>
      </thead>
      <tbody>
        {checks.map((c) => (
          <tr key={c.id}>
            <td className="mono">{c.ruleId}</td>
            <td>
              <OutcomeBadge outcome={c.outcome} />
            </td>
            <td>{c.viewportName ?? '—'}</td>
            <td>{c.reason ? `${c.reason}${c.reasonDetail ? `: ${c.reasonDetail}` : ''}` : '—'}</td>
            <td>{c.durationMs} ms</td>
          </tr>
        ))}
      </tbody>
    </table>
</TableScroll>
  );
}
