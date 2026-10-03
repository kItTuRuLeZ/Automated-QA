import { useState } from 'react';
import type { ActionOutcome, CourseState, ScanRun, TraversalAction } from '@cqa/shared';
import { api } from '../api';
import { Empty, Loading, useLoader } from './ui';

const OUTCOME_TEXT: Record<ActionOutcome, string> = {
  succeeded: 'Worked as expected',
  no_observable_change: 'No visible change',
  failed: 'Did not work',
  skipped: 'Skipped',
  not_attempted: 'Not attempted',
};

const REASON_TEXT: Record<string, string> = {
  unsafe_action: 'Unsafe to click',
  ambiguous_action: 'Behavior not recognized',
  out_of_scope: 'Outside scan scope',
  budget_states: 'State budget reached',
  budget_depth: 'Depth budget reached',
  budget_pages: 'Page budget reached',
  budget_runtime: 'Runtime budget reached',
  state_unreachable: 'Could not restore state',
  engine_error: 'Could not perform',
};

type Filter = 'all' | 'attempted' | 'problems' | 'skipped';

export function Coverage({ run, states, screenshots }: { run: ScanRun; states: CourseState[]; screenshots: Array<{ artifactId: string; stateId?: string }> }) {
  const explored = run.config.engines.traversal;
  const actions = useLoader(() => api.listActions(run.id), [run.id, run.status]);
  const [filter, setFilter] = useState<Filter>('problems');
  const cov = run.coverage;
  const shotFor = (stateId: string) => screenshots.find((s) => s.stateId === stateId)?.artifactId;
  const stateLabel = (id?: string) => {
    const i = states.findIndex((s) => s.id === id);
    return i >= 0 ? `S${i + 1}` : '—';
  };

  const list = (actions.data ?? []).filter((a) => {
    if (filter === 'attempted') return a.outcome !== 'skipped' && a.outcome !== 'not_attempted';
    if (filter === 'problems') return a.outcome === 'failed' || a.outcome === 'no_observable_change';
    if (filter === 'skipped') return a.outcome === 'skipped' || a.outcome === 'not_attempted';
    return true;
  });

  return (
    <section aria-labelledby="coverage-heading" className="card">
      <h2 id="coverage-heading">Coverage</h2>
      {!explored ? (
        <p className="muted">Exploration was turned off for this scan. Only the initial page was checked.</p>
      ) : (
        <>
          <p className="muted">What the scanner reached and what it did not. Anything not reached is unverified, not passed.</p>
          <dl className="kv">
            <div>
              <dt>States reached</dt>
              <dd>
                {cov?.statesReached ?? states.length} (budget {run.config.budgets.maxStates}, max depth {run.config.budgets.maxDepth})
              </dd>
            </div>
            <div>
              <dt>Actions attempted</dt>
              <dd>{cov?.actionsAttempted ?? '—'}</dd>
            </div>
            <div>
              <dt>Actions skipped</dt>
              <dd>{cov?.actionsSkipped ?? '—'}</dd>
            </div>
            <div>
              <dt>Failed transitions</dt>
              <dd>{cov?.failedTransitions ?? '—'}</dd>
            </div>
            <div>
              <dt>Frames not inspected</dt>
              <dd>{cov?.inaccessibleFrames ?? '—'}</dd>
            </div>
            <div>
              <dt>Canvas surfaces</dt>
              <dd>{cov?.unsupportedSurfaces ?? '—'}</dd>
            </div>
            <div>
              <dt>Budgets reached</dt>
              <dd>{cov?.budgetsReached.length ? cov.budgetsReached.map((b) => REASON_TEXT[b] ?? b).join(', ') : 'None'}</dd>
            </div>
          </dl>
        </>
      )}

      <h3>States ({states.length})</h3>
      {states.length === 0 ? (
        <p className="muted">No states were captured.</p>
      ) : (
        <table className="table">
          <caption className="sr-only">Reached states</caption>
          <thead>
            <tr>
              <th scope="col">State</th>
              <th scope="col">Depth</th>
              <th scope="col">Lesson</th>
              <th scope="col">Open dialogs / selected tabs</th>
              <th scope="col">URL</th>
              <th scope="col">Screenshot</th>
            </tr>
          </thead>
          <tbody>
            {states.map((s, i) => {
              const shot = shotFor(s.id);
              return (
                <tr key={s.id}>
                  <td>S{i + 1}</td>
                  <td>{s.depth}</td>
                  <td>{s.lessonId ?? <span className="muted">—</span>}</td>
                  <td>{[...s.openDialogs.map((d) => `Dialog: ${d}`), ...s.selectedTabs.map((t) => `Tab: ${t}`)].join('; ') || <span className="muted">—</span>}</td>
                  <td className="mono truncate">{s.url}</td>
                  <td>
                    {shot ? (
                      <a href={api.artifactUrl(shot)} target="_blank" rel="noreferrer">
                        View<span className="sr-only"> screenshot of state S{i + 1}</span>
                      </a>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {explored && (
        <>
          <h3>Actions</h3>
          <div className="segmented" role="group" aria-label="Filter actions">
            {(['problems', 'attempted', 'skipped', 'all'] as Filter[]).map((f) => (
              <button key={f} type="button" className={`btn btn-small${filter === f ? ' btn-primary' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {{ problems: 'Problems', attempted: 'Attempted', skipped: 'Skipped', all: 'All' }[f]}
              </button>
            ))}
          </div>
          {actions.error ? (
            <p className="alert alert-error">Could not load actions.</p>
          ) : !actions.data ? (
            <Loading />
          ) : list.length === 0 ? (
            <Empty title="No actions in this view" />
          ) : (
            <ActionsTable actions={list} stateLabel={stateLabel} />
          )}
        </>
      )}
    </section>
  );
}

function ActionsTable({ actions, stateLabel }: { actions: TraversalAction[]; stateLabel: (id?: string) => string }) {
  return (
    <table className="table">
      <caption className="sr-only">Traversal actions</caption>
      <thead>
        <tr>
          <th scope="col">From</th>
          <th scope="col">Action</th>
          <th scope="col">Result</th>
          <th scope="col">To</th>
          <th scope="col">Reason / expected</th>
        </tr>
      </thead>
      <tbody>
        {actions.map((a) => (
          <tr key={a.id}>
            <td>{stateLabel(a.fromStateId)}</td>
            <td>
              <span className="muted">{a.kind.replace('_', ' ')}</span> {a.targetDescription}
            </td>
            <td>
              <span className={`badge act-${a.outcome}`}>{OUTCOME_TEXT[a.outcome]}</span>
            </td>
            <td>{a.toStateId ? stateLabel(a.toStateId) : '—'}</td>
            <td>{a.reason ? `${REASON_TEXT[a.reason] ?? a.reason}${a.reasonDetail ? `: ${a.reasonDetail}` : ''}` : (a.expectedPostcondition ?? '—')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
