import { useMemo, useState } from 'react';
import type { CheckOutcome, CheckResult, Finding } from '@cqa/shared';
import { api, type RunDetail } from '../../api';
import { ErrorBox, Link, Loading, OUTCOME_LABEL, OutcomeBadge, Pagination, SEVERITY_LABEL, SeverityBadge, TYPE_LABEL, TableScroll, duration, useLoader } from '../ui';

const PAGE = 50;

/** Raw rule IDs, counts by unit, individual check executions (searchable, filtered, paginated), and configuration. */
export function TechnicalTab({ run }: { run: RunDetail }) {
  const s = run.summary;
  const findings = useLoader(() => api.listFindings(run.id), [run.id, run.status]);
  const checks = useLoader(() => api.listChecks(run.id), [run.id, run.status]);
  const initial = run.states[0];

  return (
    <div>
      <section className="card">
        <h2>Counts and the unit each one counts</h2>
        <div className="stats">
          <Stat label="Findings" value={s.findingCount} hint="Merged problems found (one finding can occur in several places)" />
          <Stat label="Unique rules" value={s.uniqueRules} hint="Distinct rules evaluated" />
          <Stat label="Check executions" value={s.executions} hint="A rule run at one screen and one screen size" />
          <Stat label="Did not run" value={s.byOutcome.not_tested + s.byOutcome.error} hint="Check executions not tested or errored; never counted as passed" />
          <Stat label="Duration" value={duration(run.startedAt, run.finishedAt)} />
        </div>
        <div className="grid-2">
          <div>
            <h3>Findings by priority</h3>
            <dl className="kv">
              {(Object.keys(SEVERITY_LABEL) as Array<keyof typeof SEVERITY_LABEL>).map((k) => (
                <div key={k}>
                  <dt>{SEVERITY_LABEL[k]}</dt>
                  <dd>{s.findingsBySeverity[k]}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            <h3>Check executions by result</h3>
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
      </section>

      <section className="card">
        <h2>Check executions</h2>
        {checks.error ? <ErrorBox error={checks.error} onRetry={checks.reload} /> : !checks.data ? <Loading /> : <ChecksTable checks={checks.data} />}
      </section>

      <section className="card">
        <h2>Findings table</h2>
        {findings.error ? <ErrorBox error={findings.error} onRetry={findings.reload} /> : !findings.data ? <Loading /> : findings.data.length === 0 ? <p className="muted">No findings were recorded. That does not mean the course passed QA.</p> : <FindingsTable findings={findings.data} />}
      </section>

      {initial && (
        <section className="card">
          <h2>Opening screen</h2>
          <dl className="kv">
            <div>
              <dt>Final address</dt>
              <dd className="mono">{initial.url}</dd>
            </div>
            <div>
              <dt>Page title</dt>
              <dd>{initial.title || <span className="muted">(none)</span>}</dd>
            </div>
            <div>
              <dt>Screen size</dt>
              <dd>
                {run.config.viewports[0]?.name} {run.config.viewports[0]?.width}×{run.config.viewports[0]?.height} (simulated)
              </dd>
            </div>
            <div>
              <dt>Browser</dt>
              <dd>{run.browser ? `${run.browser.engine} ${run.browser.version}` : '—'}</dd>
            </div>
          </dl>
        </section>
      )}

      <section className="card">
        <h2>Scan configuration and environment</h2>
        <dl className="kv">
          <div>
            <dt>Allowed origins</dt>
            <dd className="mono">{run.config.scope.allowedOrigins.join(', ')}</dd>
          </div>
          <div>
            <dt>Path prefixes</dt>
            <dd className="mono">{run.config.scope.allowedPathPrefixes.join(', ') || 'Whole origin'}</dd>
          </div>
          <div>
            <dt>Page open timeout</dt>
            <dd>{run.config.budgets.navigationTimeoutMs / 1000} s</dd>
          </div>
          <div>
            <dt>Runtime budget</dt>
            <dd>{run.config.budgets.maxRuntimeMs / 1000} s</dd>
          </div>
          <div>
            <dt>Exploration limits</dt>
            <dd>
              {run.config.budgets.maxStates} screens or views, {run.config.budgets.maxDepth} steps
            </dd>
          </div>
          <div>
            <dt>Tools</dt>
            <dd>{run.toolVersions.map((t) => `${t.name} ${t.version}`).join(', ') || '—'}</dd>
          </div>
          <div>
            <dt>Blocked requests</dt>
            <dd>{run.coverage?.blockedRequests ?? '—'}</dd>
          </div>
          <div>
            <dt>AI assistance</dt>
            <dd>Off (not part of core scanning)</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="stat">
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
            <th scope="col">Priority</th>
            <th scope="col">Finding</th>
            <th scope="col">Type</th>
            <th scope="col">Rule</th>
            <th scope="col">Confidence</th>
            <th scope="col">Places</th>
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

/** All executions are kept; search and the result filter narrow the view and pagination limits how many rows are drawn. */
function ChecksTable({ checks }: { checks: CheckResult[] }) {
  const [q, setQ] = useState('');
  const [outcome, setOutcome] = useState<'all' | CheckOutcome>('all');
  const [page, setPage] = useState(0);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of checks) m.set(c.outcome, (m.get(c.outcome) ?? 0) + 1);
    return m;
  }, [checks]);
  const needle = q.trim().toLowerCase();
  const list = useMemo(
    () => checks.filter((c) => (outcome === 'all' || c.outcome === outcome) && (!needle || `${c.ruleId} ${c.reason ?? ''} ${c.reasonDetail ?? ''} ${c.viewportName ?? ''}`.toLowerCase().includes(needle))),
    [checks, outcome, needle],
  );
  const safePage = Math.min(page, Math.max(0, Math.ceil(list.length / PAGE) - 1));
  const rows = list.slice(safePage * PAGE, safePage * PAGE + PAGE);
  return (
    <>
      <div className="filters" role="search" aria-label="Filter check executions">
        <div className="field">
          <label htmlFor="c-q">Search rule or reason</label>
          <input id="c-q" type="search" value={q} onChange={(e) => (setQ(e.target.value), setPage(0))} placeholder="For example KBD-001 or timeout" />
        </div>
        <div className="field">
          <label htmlFor="c-o">Result</label>
          <select id="c-o" value={outcome} onChange={(e) => (setOutcome(e.target.value as 'all' | CheckOutcome), setPage(0))}>
            <option value="all">All results ({checks.length})</option>
            {(Object.keys(OUTCOME_LABEL) as CheckOutcome[]).map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABEL[o]} ({counts.get(o) ?? 0})
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="muted" role="status">
        Showing {list.length} of {checks.length} check executions. Not applicable and not tested are different from failed, and none of them is a defect on its own.
      </p>
      <TableScroll label="Check executions">
        <table className="table">
          <caption className="sr-only">Check executions</caption>
          <thead>
            <tr>
              <th scope="col">Rule</th>
              <th scope="col">Result</th>
              <th scope="col">Screen size</th>
              <th scope="col">Reason</th>
              <th scope="col">Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
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
      <Pagination page={safePage} pageSize={PAGE} total={list.length} onPage={setPage} label="Check executions" />
    </>
  );
}
