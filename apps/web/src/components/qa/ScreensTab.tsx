import { type FormEvent, useEffect, useMemo, useState } from 'react';
import type { ScreenStatus } from '@cqa/shared';
import { api } from '../../api';
import { type ExecutionRow, type ScreenRow, type UnitDetail, qaApi } from '../../api-qa';
import { ScreenshotViewer } from '../ScreenshotViewer';
import { Alert, Empty, ErrorBox, Loading, SeverityBadge, TableScroll, useLoader } from '../ui';
import { BadgeList, ScreenStatusBadge, TestStatusBadge } from './StatusBadges';

type Filter = 'attention' | 'issues' | 'manual' | 'passed' | 'untested' | 'all';
const FILTERS: Array<{ id: Filter; label: string; match: (s: ScreenStatus) => boolean }> = [
  { id: 'attention', label: 'Needs attention', match: (s) => s !== 'passed_automated' },
  { id: 'issues', label: 'Issues found', match: (s) => s === 'issues_found' },
  { id: 'manual', label: 'Needs manual review', match: (s) => s === 'needs_manual_review' },
  { id: 'passed', label: 'Passed automated checks', match: (s) => s === 'passed_automated' },
  { id: 'untested', label: 'Not tested', match: (s) => s === 'not_tested' },
  { id: 'all', label: 'All screens', match: () => true },
];
const ORDER: Record<string, number> = { failed: 0, error: 1, blocked: 2, manual_review_required: 3, skipped: 4, pending: 5, running: 5, passed: 6, not_applicable: 7 };
const COURSE_WIDE = '__course_wide__';

/**
 * Review view: course outline, the selected screen's results, and the evidence and expected/actual behavior for one
 * result. Defaults to what needs attention, with passed screens one click away.
 */
export function ScreensTab({ runId, runStatus }: { runId: string; runStatus: string }) {
  const inv = useLoader(() => qaApi.inventory(runId), [runId, runStatus]);
  const [filter, setFilter] = useState<Filter>('attention');
  const [selected, setSelected] = useState<string>();
  const [execId, setExecId] = useState<string>();
  const courseWide = useLoader(() => qaApi.courseWide(runId), [runId, runStatus]);

  const rows = useMemo<ScreenRow[]>(() => (inv.data && inv.data.recorded ? inv.data.units.filter((u) => u.primary && u.result) : []), [inv.data]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, rows.filter((r) => f.match(r.result!.status)).length])) as Record<Filter, number>, [rows]);
  const shown = rows.filter((r) => FILTERS.find((f) => f.id === filter)!.match(r.result!.status));

  useEffect(() => {
    if (!selected || (selected !== COURSE_WIDE && !shown.some((r) => r.unit.id === selected))) setSelected(shown[0]?.unit.id);
  }, [shown, selected]);

  if (inv.error) return <ErrorBox error={inv.error} onRetry={inv.reload} />;
  if (!inv.data) return <Loading />;
  if (!inv.data.recorded) return <Alert tone="note" title="Coverage was not recorded in this older scan.">Step-by-step results are only kept for scans made after this feature was added. The other tabs still show what this scan found.</Alert>;
  const noun = inv.data.unitNoun;
  const hidden = inv.data.units.filter((u) => !u.primary).length;
  const passedRows = rows.filter((r) => r.result!.status === 'passed_automated');

  return (
    <div className="review">
      <aside className="review-outline" aria-label="Course outline">
        <fieldset className="chips">
          <legend>Show</legend>
          {FILTERS.map((f) => (
            <label key={f.id} className={`chip${filter === f.id ? ' on' : ''}`}>
              <input type="radio" name="screen-filter" checked={filter === f.id} onChange={() => setFilter(f.id)} /> {f.label} <span className="chip-count">{counts[f.id]}</span>
            </label>
          ))}
        </fieldset>
        {shown.length === 0 ? (
          <Empty title={rows.length === 0 ? `No ${noun.plural} were recorded` : `No ${noun.plural} match this filter`}>
            <p>{rows.length === 0 ? 'The scan did not reach any screen, so there is nothing to review here. See the status above.' : `Choose “All screens” to see all ${rows.length}.`}</p>
          </Empty>
        ) : (
          <ul className="outline" role="list">
            {shown.map((r) => {
              const c = r.result!.counts;
              const attention = c.failed + c.blocked + c.error + c.manual;
              return (
                <li key={r.unit.id} className={r.unit.parentId ? 'child' : ''}>
                  <button type="button" className={`outline-item${selected === r.unit.id ? ' selected' : ''}`} aria-current={selected === r.unit.id ? 'true' : undefined} onClick={() => (setSelected(r.unit.id), setExecId(undefined))}>
                    <span className="outline-title">{r.unit.title}</span>
                    <span className="outline-meta">
                      <ScreenStatusBadge status={r.result!.status} />
                      {attention > 0 && <span className="attention" title="Checks that failed, were blocked, errored or need a person">{attention} to look at</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="help">
          {hidden > 0 ? `${hidden} more items (blocks, layers, scenes) are listed in the course but not tracked one by one. ` : ''}
          Counting unit: {noun.plural}.
        </p>
        <button type="button" className={`outline-item${selected === COURSE_WIDE ? ' selected' : ''}`} onClick={() => (setSelected(COURSE_WIDE), setExecId(undefined))} aria-current={selected === COURSE_WIDE ? 'true' : undefined}>
          <span className="outline-title">Course-wide checks{courseWide.data ? ` (${courseWide.data.length})` : ''}</span>
          <span className="outline-meta muted">Links, package files, tracking, and the manual review queue</span>
        </button>
        {passedRows.length > 0 && (
          <button type="button" className="btn btn-small" onClick={() => { setFilter('all'); setSelected(passedRows[Math.floor(Math.random() * passedRows.length)]!.unit.id); setExecId(undefined); }}>
            Spot-check a passed screen
          </button>
        )}
      </aside>

      <section className="review-main" aria-label="Selected screen">
        {selected === COURSE_WIDE ? (
          <CourseWide runId={runId} rows={courseWide.data} error={courseWide.error} execId={execId} onSelect={setExecId} />
        ) : selected ? (
          <UnitView key={selected} runId={runId} unitId={selected} execId={execId} onSelect={setExecId} onChanged={() => (inv.reload(), courseWide.reload())} noun={noun} />
        ) : (
          <Empty title="Nothing selected" />
        )}
      </section>
    </div>
  );
}

function UnitView({ runId, unitId, execId, onSelect, onChanged, noun }: { runId: string; unitId: string; execId?: string; onSelect: (id?: string) => void; onChanged: () => void; noun: { singular: string } }) {
  const detail = useLoader(() => qaApi.unit(runId, unitId), [runId, unitId]);
  if (detail.error) return <ErrorBox error={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return <Loading />;
  const d = detail.data;
  const reload = () => (detail.reload(), onChanged());
  const executed = d.executions.filter((e) => e.status === 'passed' || e.status === 'failed').length;
  const sorted = [...d.executions].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
  const selected = d.executions.find((e) => e.id === execId) ?? sorted[0];

  return (
    <>
      <header className="unit-head">
        <h2>{d.unit.title}</h2>
        <p className="muted">
          {d.unit.kind} · from {d.unit.source.replace(/_/g, ' ')} ({d.unit.confidence} confidence) · {d.unit.visitedAt ? `opened by a browser ${new Date(d.unit.visitedAt).toLocaleTimeString()}` : 'never opened by a browser'}
          {d.unit.titleIsFallback ? ' · no title in the course, so a readable name is shown' : ''}
        </p>
        <p className="inline">
          <ScreenStatusBadge status={d.result.status} /> <BadgeList badges={d.result.badges} />
        </p>
        <ul className="plain reasons">
          {d.result.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {d.result.scope === 'static' && <Alert tone="warn" title="Static checks only.">Functional behavior was not tested on this {noun.singular}.</Alert>}
      </header>

      <section aria-labelledby="f-h" className="block-gap">
        <h3 id="f-h">Findings on this {noun.singular} ({d.findings.length})</h3>
        {d.findings.length === 0 ? (
          <p className="muted">
            {executed > 0 ? `No findings were recorded here by the ${executed} check${executed === 1 ? '' : 's'} that ran. That says nothing about the checks that did not run (below).` : 'No findings were recorded. No check ran on this screen, so this is not the same as a clean result.'}
          </p>
        ) : (
          <ul className="plain">
            {d.findings.map((f) => (
              <li key={f.id}>
                <SeverityBadge severity={f.severity as never} /> <a href={`#/findings/${f.id}`}>{f.title}</a> <span className="muted">· {f.status}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="c-h" className="block-gap">
        <h3 id="c-h">Test results on this {noun.singular} ({d.executions.length})</h3>
        {d.executions.length === 0 ? (
          <Empty title="No checks ran here">
            <p>Nothing was tested on this {noun.singular}. A browser {d.unit.visitedAt ? 'opened it' : 'never opened it'}, but no applicable check produced a result.</p>
          </Empty>
        ) : (
          <>
            <ResultsTable rows={sorted} selectedId={selected?.id} onSelect={onSelect} />
            {d.attempts > d.executions.length && <p className="help">{d.attempts - d.executions.length} earlier attempt{d.attempts - d.executions.length === 1 ? ' is' : 's are'} kept in the exports.</p>}
          </>
        )}
      </section>

      <section aria-labelledby="d-h" className="block-gap">
        <h3 id="d-h">Decision about this {noun.singular}</h3>
        <DecisionForm runId={runId} targetKind="unit" targetId={d.unit.id} existing={d.decisions} onSaved={reload} />
      </section>

      <section className="review-detail" aria-label="Evidence and expected behavior">
        {selected ? <ExecutionDetail runId={runId} e={selected} onChanged={reload} /> : <p className="muted">Select a result to see what was expected, what happened, and the evidence.</p>}
      </section>
    </>
  );
}

function ResultsTable({ rows, selectedId, onSelect }: { rows: ExecutionRow[]; selectedId?: string; onSelect: (id: string) => void }) {
  return (
    <TableScroll label="Test results for this screen">
      <table className="table results">
        <caption className="sr-only">Test results for this screen, failures first</caption>
        <thead>
          <tr>
            <th scope="col">Check</th>
            <th scope="col">Result</th>
            <th scope="col">What was found</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} className={e.id === selectedId ? 'selected-row' : ''}>
              <th scope="row">
                <button type="button" className="link-button" onClick={() => onSelect(e.id)} aria-current={e.id === selectedId ? 'true' : undefined}>
                  {e.definitionId}: {e.definition?.title ?? e.definitionId}
                </button>
                <span className="help block">
                  {e.definition?.automation === 'manual' ? 'Manual case' : e.scope === 'static' ? 'Static check' : 'Automated'} · attempt {e.attempt}
                </span>
              </th>
              <td>
                <TestStatusBadge status={e.status} />
                {e.decisions && e.decisions.length > 0 && <span className="badge badge-quiet">Reviewer: {e.decisions[e.decisions.length - 1]!.decision.replace(/_/g, ' ')}</span>}
              </td>
              <td>{e.reason ?? e.actual ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

function CourseWide({ runId, rows, error, execId, onSelect }: { runId: string; rows?: ExecutionRow[]; error: unknown; execId?: string; onSelect: (id?: string) => void }) {
  if (error) return <ErrorBox error={error} />;
  if (!rows) return <Loading />;
  const sorted = [...rows].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9));
  const selected = rows.find((r) => r.id === execId) ?? sorted[0];
  return (
    <>
      <header className="unit-head">
        <h2>Course-wide checks</h2>
        <p className="muted">Checks that apply to the whole course instead of one screen: link destinations, package file checks, tracking, and the cases that need a person. They are not part of any screen’s status.</p>
      </header>
      {rows.length === 0 ? <Empty title="No course-wide checks were recorded" /> : <ResultsTable rows={sorted} selectedId={selected?.id} onSelect={onSelect} />}
      <section className="review-detail" aria-label="Evidence and expected behavior">
        {selected ? <ExecutionDetail runId={runId} e={selected} onChanged={() => undefined} /> : null}
      </section>
    </>
  );
}

function ExecutionDetail({ runId, e, onChanged }: { runId: string; e: ExecutionRow; onChanged: () => void }) {
  const evidence = useLoader(() => (e.evidenceIds.length ? qaApi.evidence(runId, e.evidenceIds) : Promise.resolve([])), [runId, e.id, e.evidenceIds.join(',')]);
  const source = { approved_case: 'a reviewer-approved case', specification: 'a specification', extracted_metadata: 'extracted metadata', starter_baseline: 'the starter baseline (not a client requirement)', observed_hypothesis: 'observed behavior that has not been confirmed' }[e.expectedSource ?? 'starter_baseline'];
  return (
    <div className="exec-detail">
      <h3>
        {e.definitionId}: {e.definition?.title} <TestStatusBadge status={e.status} />
      </h3>
      <dl className="kv">
        <div>
          <dt>Expected</dt>
          <dd>
            {e.expected ?? 'Not recorded.'} <span className="muted">Source: {source}.</span>
          </dd>
        </div>
        <div>
          <dt>What happened</dt>
          <dd>{e.actual ?? 'Nothing was recorded.'}</dd>
        </div>
        {e.reason && (
          <div>
            <dt>Why not a pass</dt>
            <dd>{e.reason}</dd>
          </div>
        )}
        <div>
          <dt>Scope</dt>
          <dd>{e.scope === 'static' ? 'Static: read from files only. Functional behavior was not tested.' : 'Functional: run in a browser.'}</dd>
        </div>
      </dl>
      {e.trace.length > 0 && (
        <>
          <h4>What the scanner did, in order</h4>
          <ol className="trace">
            {e.trace.map((t, i) => (
              <li key={i}>
                <span className="trace-kind">{t.step.replace(/_/g, ' ')}</span> {t.detail}
              </li>
            ))}
          </ol>
        </>
      )}
      <h4>Evidence</h4>
      {evidence.data && evidence.data.length > 0 ? (
        evidence.data.filter((x) => x.artifactId).map((x) => <ScreenshotViewer key={x.id} src={api.artifactUrl(x.artifactId!)} alt={`Evidence: ${x.caption}`} caption={x.caption} title={x.caption} />)
      ) : e.evidenceIds.length ? (
        <p className="muted">{evidence.error ? 'Evidence could not be loaded.' : 'Loading evidence…'}</p>
      ) : (
        <p className="muted">No screenshot was kept for this result. The ordered trace above is the record of what was done and observed.</p>
      )}
      <h4>Decision about this result</h4>
      <DecisionForm runId={runId} targetKind="execution" targetId={e.id} existing={e.decisions ?? []} onSaved={onChanged} />
    </div>
  );
}

const DECISIONS = [
  ['accepted', 'Accept this result'],
  ['false_positive', 'Mark as a false positive'],
  ['retest_requested', 'Request a retest'],
  ['manual_pass', 'Record a manual pass'],
  ['manual_fail', 'Record a manual failure'],
] as const;

function DecisionForm({ runId, targetKind, targetId, existing, onSaved }: { runId: string; targetKind: 'execution' | 'unit'; targetId: string; existing: Array<{ id: string; decision: string; actor: string; reason: string; createdAt: string; originalStatus: string }>; onSaved: () => void }) {
  const [decision, setDecision] = useState<string>('manual_pass');
  const [reason, setReason] = useState('');
  const [actor, setActor] = useState(() => {
    try {
      return localStorage.getItem('cqa-actor') ?? '';
    } catch {
      return '';
    }
  });
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string>();
  const id = `dec-${targetKind}-${targetId}`;

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (state === 'saving') return;
    setState('saving');
    setError(undefined);
    try {
      await qaApi.decide(runId, { targetKind, targetId, decision, reason, actor: actor || undefined });
      try {
        localStorage.setItem('cqa-actor', actor);
      } catch {
        /* storage may be unavailable */
      }
      setReason('');
      setState('saved');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  };

  return (
    <div className="decision">
      {existing.length > 0 && (
        <ul className="plain decisions">
          {existing.map((d) => (
            <li key={d.id}>
              <strong>{DECISIONS.find((x) => x[0] === d.decision)?.[1] ?? d.decision}</strong> by {d.actor} on {new Date(d.createdAt).toLocaleString()}: “{d.reason}” <span className="muted">(automated result at the time: {d.originalStatus.replace(/_/g, ' ')})</span>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={submit} className="form decision-form">
        <p className="help">A decision is saved beside the automated result. It never changes the automated result.</p>
        <div className="field-inline">
          <label htmlFor={`${id}-d`}>Decision</label>
          <select id={`${id}-d`} value={decision} onChange={(e) => setDecision(e.target.value)}>
            {DECISIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="field-inline">
          <label htmlFor={`${id}-a`}>Your name</label>
          <input id={`${id}-a`} value={actor} maxLength={60} onChange={(e) => setActor(e.target.value)} placeholder="Reviewer" />
        </div>
        <div className="field-inline grow">
          <label htmlFor={`${id}-r`}>Reason (required)</label>
          <input id={`${id}-r`} value={reason} maxLength={1000} onChange={(e) => (setReason(e.target.value), setState('idle'))} />
        </div>
        <button type="submit" className="btn btn-small" disabled={state === 'saving' || reason.trim().length < 3}>
          Save decision
        </button>
        <span className="save-feedback" role="status" aria-live="polite">
          {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : ''}
        </span>
        {state === 'error' && (
          <span role="alert" className="error-text">
            Not saved: {error}
          </span>
        )}
      </form>
    </div>
  );
}

export type { UnitDetail };
