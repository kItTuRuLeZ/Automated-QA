import { useEffect, useRef, useState } from 'react';
import type { RunEvent, RunStage } from '@cqa/shared';
import { type InventoryResponse, type ProgressResponse, qaApi } from '../../api-qa';
import { Alert } from '../ui';

const STAGE_LABEL: Record<RunStage, string> = {
  queued: 'Waiting to start',
  validating: 'Checking the address and settings',
  discovering: 'Listing what the course contains',
  running: 'Running checks',
  finalizing: 'Saving results',
  completed: 'Finished',
  completed_with_gaps: 'Finished with gaps',
  failed: 'Could not finish',
  cancelled: 'Cancelled',
};
const ACTIVE = new Set<RunStage>(['queued', 'validating', 'discovering', 'running', 'finalizing']);

export interface LiveRun {
  progress?: Extract<ProgressResponse, { recorded: true }>;
  recorded?: boolean;
  inventory?: Extract<InventoryResponse, { recorded: true }>;
  events: RunEvent[];
  /** True while the last request failed. The scan itself is not affected. */
  connectionLost: boolean;
}

/**
 * Follows a run from stored records only. Every tick asks the server for the progress snapshot and any events after the
 * last one applied; an event at or below the last sequence is ignored, so a repeated or late delivery cannot change a
 * number. After a refresh the same calls rebuild the same view.
 */
export function useLiveRun(runId: string, active: boolean): LiveRun {
  const [state, setState] = useState<LiveRun>({ events: [], connectionLost: false });
  const lastSeq = useRef(0);
  const tick = useRef(0);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    lastSeq.current = 0;
    tick.current = 0;
    setState({ events: [], connectionLost: false });
    const run = async () => {
      try {
        const p = await qaApi.progress(runId);
        if (cancelled) return;
        if (!p.recorded) {
          setState((s) => ({ ...s, recorded: false, connectionLost: false }));
          return;
        }
        let fresh: RunEvent[] = [];
        if (p.progress.lastSeq > lastSeq.current) {
          const ev = await qaApi.events(runId, lastSeq.current);
          fresh = ev.events.filter((e) => e.seq > lastSeq.current);
          if (fresh.length) lastSeq.current = fresh[fresh.length - 1]!.seq;
        }
        // The outline changes slowly; refresh it when something happened, and at least every few ticks.
        const inv = fresh.length || tick.current % 4 === 0 ? await qaApi.inventory(runId) : undefined;
        tick.current++;
        if (cancelled) return;
        setState((s) => ({ progress: p, recorded: true, inventory: inv && inv.recorded ? inv : s.inventory, events: [...s.events, ...fresh].slice(-200), connectionLost: false }));
        if (ACTIVE.has(p.progress.stage) || (activeRef.current && p.run.status !== 'completed' && p.run.status !== 'partial' && p.run.status !== 'failed' && p.run.status !== 'cancelled')) timer = window.setTimeout(run, 1500);
      } catch {
        if (cancelled) return;
        setState((s) => ({ ...s, connectionLost: true }));
        timer = window.setTimeout(run, 4000); // keep asking: the scan carries on without this page
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [runId]);

  return state;
}


function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

function Bar({ label, value, max }: { label: string; value?: number; max?: number }) {
  // No value means the total is not known: an indeterminate bar, never a guessed percentage.
  return (
    <div className="bar-row">
      <label>
        {label}
        {value !== undefined && max !== undefined ? (
          <progress value={value} max={max} aria-label={label} />
        ) : (
          <progress aria-label={`${label} (total not known)`} />
        )}
      </label>
    </div>
  );
}

function describe(e: RunEvent): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case 'stage_changed':
      return `${STAGE_LABEL[p.stage as RunStage] ?? String(p.stage)}${p.activity ? `: ${String(p.activity)}` : ''}`;
    case 'unit_discovered':
      return `Found ${String(p.title)}${p.kind ? ` (${String(p.kind)})` : ''}`;
    case 'unit_entered':
      return `Opened ${String(p.title)}`;
    case 'interaction_discovered':
      return `Found ${String(p.count)} control${p.count === 1 ? '' : 's'} (${(p.types as string[] | undefined)?.join(', ') ?? ''})`;
    case 'test_started':
      return `Started ${String(p.caseId)}: ${String(p.title)}`;
    case 'test_finished':
      return `${String(p.caseId)} finished: ${String(p.status).replace(/_/g, ' ')}`;
    case 'path_blocked':
      return `Blocked: ${String(p.reason ?? '')}`;
    case 'run_finalized':
      return `Run finalized: ${String(p.statement ?? '')}`;
    default:
      return String(p.text ?? e.type);
  }
}

export function ProgressPanel({ live, runStatus, queuedAt, onCancel, cancelRequested }: { live: LiveRun; runStatus: string; queuedAt: string; onCancel: () => void; cancelRequested: boolean }) {
  const p = live.progress;
  const active = p ? ACTIVE.has(p.progress.stage) : runStatus === 'queued' || runStatus === 'running';
  const now = useNow(active);

  if (!p) {
    return (
      <div className="card progress-panel" role="status" aria-live="polite">
        <h2>Starting</h2>
        <p>{live.recorded === false ? 'Step-by-step progress is not available for this scan.' : 'Loading the latest progress…'}</p>
        {live.connectionLost && <Alert tone="warn">This page cannot reach the app right now. The scan is not affected; this page keeps trying.</Alert>}
      </div>
    );
  }
  const { progress, stalled, silentSeconds } = p;
  const c = progress.counters;
  const finished = c.testsPassed + c.testsFailed + c.testsBlocked + c.testsErrored + c.testsSkipped + c.testsManual;
  const planned = finished + c.testsPending + c.testsRunning;
  const outline = live.inventory?.units.filter((u) => u.primary) ?? [];
  const totalKnown = live.inventory?.coverage.discovery.completeness === 'complete' ? outline.length : undefined;
  const updatedAgo = Math.max(0, Math.round((now - Date.parse(progress.updatedAt)) / 1000));
  const startedAt = progress.startedAt ?? queuedAt;
  const noun = live.inventory?.unitNoun ?? { singular: 'screen', plural: 'screens' };
  const current = progress.currentUnitId ? outline.find((u) => u.unit.id === progress.currentUnitId)?.unit.title : undefined;

  return (
    <section className="card progress-panel" aria-labelledby="progress-h">
      <div className="progress-head">
        <div>
          <h2 id="progress-h">{STAGE_LABEL[progress.stage]}</h2>
          <p className="progress-activity" role="status" aria-live="polite">
            {progress.stage === 'queued' ? 'Waiting for the worker. One scan runs at a time, so this one starts after any scan ahead of it.' : (progress.activity ?? '')}
            {current && progress.stage === 'running' ? ` Current screen: ${current}.` : ''}
          </p>
        </div>
        {active && (
          <div className="cancel-box">
            <button type="button" className="btn btn-danger" onClick={onCancel} disabled={cancelRequested}>
              {cancelRequested ? 'Cancelling…' : 'Cancel scan'}
            </button>
            <p className="help">Checks already finished are kept. Anything that did not run stays listed as not run, never as passed.</p>
          </div>
        )}
      </div>

      {live.connectionLost && <Alert tone="warn" live>This page cannot reach the app right now. The scan is not affected; this page keeps trying.</Alert>}
      {stalled && (
        <Alert tone="error" live title="The worker has not reported for a while.">
          It last reported {silentSeconds} seconds ago (this page treats more than {p.stallSeconds} seconds as unresponsive). The scan may be waiting on a slow page, or the worker may have stopped. Results saved so far are kept. If this does not clear, cancel the scan and start a new one.
        </Alert>
      )}

      <div className="progress-grid">
        <div>
          <Bar label={totalKnown !== undefined ? `${noun.plural} visited` : `${noun.plural} found so far`} value={totalKnown !== undefined ? c.unitsVisited : undefined} max={totalKnown} />
          <p className="help">
            {c.unitsVisited} visited · {c.unitsDiscovered} {totalKnown !== undefined ? 'listed in the course' : 'found so far (the course total is not known, so there is no percentage)'}
            {totalKnown !== undefined ? ` · ${Math.max(0, c.unitsDiscovered - c.unitsVisited)} to go` : ''}
          </p>
          <Bar label="Checks finished" value={planned > 0 ? finished : undefined} max={planned > 0 ? planned : undefined} />
          <p className="help">{planned > 0 ? `${finished} of ${planned} planned checks have a result (the plan can grow as more screens are found).` : 'No checks are planned yet.'}</p>
        </div>
        <dl className="counters" aria-label="Check results so far">
          {(
            [
              ['Passed', c.testsPassed],
              ['Failed', c.testsFailed],
              ['Blocked', c.testsBlocked],
              ['Runner errors', c.testsErrored],
              ['Needs manual review', c.testsManual],
              ['Waiting to run', c.testsPending + c.testsRunning],
            ] as const
          ).map(([label, n]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{n}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="muted">
        Elapsed <strong>{clock(now - Date.parse(startedAt))}</strong> · last update {updatedAgo < 3 ? 'just now' : `${updatedAgo} seconds ago`} · there is no time estimate because the scanner does not know how large the course is.
      </p>

      {outline.length > 0 && (
        <details className="outline-live" open={outline.length <= 14}>
          <summary>Course outline ({outline.length} {outline.length === 1 ? noun.singular : noun.plural} found so far)</summary>
          <ul className="plain">
            {outline.map((u) => (
              <li key={u.unit.id} aria-current={u.unit.id === progress.currentUnitId ? 'true' : undefined}>
                <span aria-hidden="true">{u.unit.visitedAt ? '●' : '○'}</span> {u.unit.title}
                <span className="muted"> · {u.unit.visitedAt ? 'visited' : 'not visited yet'}{u.result && u.result.status !== 'not_tested' ? ` · ${u.result.counts.passed} passed, ${u.result.counts.failed} failed` : ''}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <details>
        <summary>Activity ({live.events.length})</summary>
        <ol className="feed" reversed>
          {[...live.events].reverse().slice(0, 40).map((e) => (
            <li key={e.seq}>
              <span className="muted">{new Date(e.at).toLocaleTimeString()}</span> {describe(e)}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
