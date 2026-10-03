import { useState } from 'react';
import type { ScanRun } from '@cqa/shared';
import { api } from '../api';
import { Loading, TableScroll, useLoader } from './ui';

const mb = (n: number) => `${(n / 1_000_000).toFixed(1)} MB`;

/** Screen sizes tested (with their device settings), page-load evidence with its conditions, and the baseline control. */
export function ScreenSizes({ run, isActive }: { run: ScanRun; isActive: boolean }) {
  const { data, reload } = useLoader(() => api.runReport(run.id), [run.id, run.status], undefined);
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (!run.config.engines.layout) return null;
  if (!data) return <Loading />;
  const sizes = data.viewports ?? [];
  const perf = data.performance;

  const saveBaseline = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      const r = await api.setBaseline(run.id);
      setMessage(`Saved ${r.recorded} screenshot${r.recorded === 1 ? '' : 's'} as the baseline for this course. It replaces any earlier baseline.`);
      reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="sizes-heading" className="card">
      <h2 id="sizes-heading">Screen sizes and page load</h2>
      <p className="muted">
        Screen sizes are simulated in {run.browser ? `${run.browser.engine} ${run.browser.version}` : 'a desktop browser'}. They are not tests on real phones or tablets.
      </p>
      {sizes.length > 0 && (
        <TableScroll label="Screen sizes tested">
          <table className="table">
            <caption className="sr-only">Screen sizes tested</caption>
            <thead>
              <tr>
                <th scope="col">Screen size</th>
                <th scope="col">Device settings</th>
                <th scope="col">Screens checked</th>
                <th scope="col">Not reached at this size</th>
                <th scope="col">Layout issues</th>
              </tr>
            </thead>
            <tbody>
              {sizes.map((v) => (
                <tr key={v.name}>
                  <td>
                    {v.name} {v.width}×{v.height}
                  </td>
                  <td>
                    scale {v.deviceScaleFactor}
                    {v.isMobile ? ', mobile emulation' : ''}
                    {v.hasTouch ? ', touch' : ''}
                  </td>
                  {v.skipped ? (
                    <td colSpan={3}>
                      <strong>Not tested.</strong> {v.skipped}
                    </td>
                  ) : (
                    <>
                      <td>{v.screensChecked}</td>
                      <td>{v.screensNotReached > 0 ? <strong>{v.screensNotReached}</strong> : 0}</td>
                      <td>{v.layoutIssues}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
      {sizes.some((v) => v.screensNotReached > 0) && <p className="help">"Not reached" means the scanner could not repeat the same clicks at that size (for example a control is hidden on small screens). Those screens were not checked there.</p>}

      {perf && (
        <>
          <h3>Page load (first page, one sample)</h3>
          <dl className="kv">
            <div>
              <dt>Load time</dt>
              <dd>{perf.loadMs === null ? 'not available' : `${(perf.loadMs / 1000).toFixed(1)} s`} (warning above {(perf.thresholds.loadMs / 1000).toFixed(1)} s)</dd>
            </div>
            <div>
              <dt>Transferred</dt>
              <dd>
                {perf.unavailable.some((u) => u.includes('resource size')) ? 'at least ' : ''}
                {mb(perf.transferredBytes)} (warning above {mb(perf.thresholds.totalBytes)})
              </dd>
            </div>
            <div>
              <dt>Requests</dt>
              <dd>
                {perf.requests} (warning above {perf.thresholds.requestCount})
              </dd>
            </div>
            <div>
              <dt>Largest files</dt>
              <dd>{perf.largest.map((a) => `${a.url.split('/').pop()} ${Math.round(a.bytes / 1000)} kB`).join(', ') || 'not available'}</dd>
            </div>
            {perf.unavailable.length > 0 && (
              <div>
                <dt>Not available</dt>
                <dd>{perf.unavailable.join(', ')}</dd>
              </div>
            )}
          </dl>
          <details>
            <summary>Conditions and limits of this measurement</summary>
            <ul>
              {perf.conditions.map((c) => (
                <li key={c}>{c}</li>
              ))}
              <li>Thresholds: {perf.thresholds.provenance}</li>
            </ul>
          </details>
        </>
      )}

      <h3>Visual baseline</h3>
      <p className="help">
        A baseline is a saved set of screenshots for this course. Later scans with "compare with baseline" turned on show where a screen looks different. A difference is something to look at, not proof of a
        problem. Only screenshots with the same course, screen, size, browser version, and settings are compared.
      </p>
      <button type="button" className="btn" onClick={saveBaseline} disabled={busy || isActive}>
        {busy ? 'Saving…' : 'Use this scan as the baseline'}
      </button>{' '}
      <span className="muted">{data.baselinesStored > 0 ? `${data.baselinesStored} baseline screenshot${data.baselinesStored === 1 ? '' : 's'} stored for this course.` : 'No baseline stored yet.'}</span>
      {message && (
        <p role="status" className="help">
          {message}
        </p>
      )}
    </section>
  );
}
