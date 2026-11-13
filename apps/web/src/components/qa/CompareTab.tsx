import { useState } from 'react';
import { api, request } from '../../api';
import { Alert, Empty, ErrorBox, Loading, useLoader } from '../ui';

type Status = 'new' | 'persistent' | 'resolved' | 'not_retested' | 'incomparable';
interface Comparison {
  before: { id: string; at: string };
  comparable: { sameCourse: boolean; differences: string[] };
  findings: Array<{ status: Status; fingerprint: string; ruleId: string; title: string; reason: string }>;
  counts: Record<Status, number>;
}

const LABEL: Record<Status, string> = {
  new: 'New',
  persistent: 'Still there',
  resolved: 'Resolved',
  not_retested: 'Not retested',
  incomparable: 'Not comparable',
};
const ORDER: Status[] = ['new', 'persistent', 'resolved', 'not_retested', 'incomparable'];

/** Compares this scan with an earlier scan of the same project. Resolved only when the same check passed again in comparable conditions. */
export function CompareTab({ runId, projectId }: { runId: string; projectId: string }) {
  const runs = useLoader(() => api.listRuns(projectId), [projectId]);
  const [other, setOther] = useState('');
  const result = useLoader(() => (other ? request<Comparison>('GET', `/api/runs/${encodeURIComponent(runId)}/compare?with=${encodeURIComponent(other)}`) : Promise.resolve(undefined)), [runId, other]);

  if (runs.error) return <ErrorBox error={runs.error} onRetry={runs.reload} />;
  if (!runs.data) return <Loading />;
  const self = runs.data.find((r) => r.id === runId);
  // Only scans made before this one: the comparison always reads earlier to later.
  const earlier = runs.data.filter((r) => r.id !== runId && (!self || r.queuedAt < self.queuedAt));
  if (!earlier.length) return <Empty title="No earlier scan to compare with">There is no scan of this project from before this one. Open a later scan to compare it with this one.</Empty>;

  return (
    <section className="card" aria-labelledby="compare-h">
      <h2 id="compare-h">Compare with an earlier scan</h2>
      <p className="muted">A finding counts as resolved only when the same check ran again on the same screen, in comparable conditions, and passed. A screen that was not reached, a check that did not run, or a changed rule never counts as a fix.</p>
      <div className="field">
        <label htmlFor="compare-with">Earlier scan</label>
        <select id="compare-with" value={other} onChange={(e) => setOther(e.target.value)}>
          <option value="">Choose a scan…</option>
          {earlier.map((r) => (
            <option key={r.id} value={r.id}>
              {new Date(r.queuedAt).toLocaleString()} · {r.status}
            </option>
          ))}
        </select>
      </div>
      {other && (result.error ? <ErrorBox error={result.error} onRetry={result.reload} /> : !result.data ? <Loading /> : <Results c={result.data} />)}
    </section>
  );
}

function Results({ c }: { c: Comparison }) {
  return (
    <>
      {!c.comparable.sameCourse && <Alert tone="warn">These scans are of different courses, so nothing can be called resolved.</Alert>}
      {c.comparable.differences.length > 0 && c.comparable.sameCourse && <Alert tone="note">Conditions differ: {c.comparable.differences.join('; ')}. Findings that depend on them are marked not comparable.</Alert>}
      <dl className="counters" aria-label="Comparison totals">
        {ORDER.map((s) => (
          <div key={s}>
            <dt>{LABEL[s]}</dt>
            <dd>{c.counts[s]}</dd>
          </div>
        ))}
      </dl>
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Finding</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {[...c.findings].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status)).map((f) => (
            <tr key={f.fingerprint}>
              <td>{LABEL[f.status]}</td>
              <td>
                {f.title} <span className="muted">({f.ruleId})</span>
              </td>
              <td>{f.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
