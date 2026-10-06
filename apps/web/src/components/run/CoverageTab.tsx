import type { RunDetail, RunReport } from '../../api';
import { Coverage } from '../Coverage';
import { ScreenSizes } from '../ScreenSizes';
import { Alert } from '../ui';

const BUDGET_TEXT: Record<string, string> = {
  budget_states: 'the maximum number of screens or views',
  budget_depth: 'the maximum number of steps from the start',
  budget_pages: 'the maximum number of pages',
  budget_runtime: 'the time limit',
};

/** Coverage limits first, in plain words, then the detailed views. Coverage of the whole course is never given as a percentage. */
export function CoverageTab({ run, report, isActive }: { run: RunDetail; report: RunReport; isActive: boolean }) {
  const explored = run.config.engines.traversal;
  const budgets = report.coverage.budgetsReached;
  return (
    <div>
      <Alert tone={explored && budgets.length === 0 ? 'note' : 'warn'} title="What was and was not checked.">
        {explored ? (
          <>
            {report.coverage.screensScanned} screen{report.coverage.screensScanned === 1 ? '' : 's'} or view{report.coverage.screensScanned === 1 ? '' : 's'} reached
            {budgets.length > 0 ? `, then the scan stopped at ${budgets.map((b) => BUDGET_TEXT[b] ?? b).join(' and ')}, so other screens were not looked at` : ''}. The total size of the course is not known to the scanner, so there is no coverage percentage. Anything not reached is unverified, not passed.
          </>
        ) : (
          <>Only the opening page was checked; course exploration was off for this scan. Everything else in the course is unverified.</>
        )}
      </Alert>
      {report.screens.length > 0 && (
        <section className="card">
          <h2>Screens reached ({report.screens.length})</h2>
          <ul className="plain">
            {report.screens.map((s) => (
              <li key={s.label}>
                <strong>{s.label}</strong> {s.title || <span className="muted">(no title captured)</span>} <span className="muted">· step {s.depth} · {s.reachedBy}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ScreenSizes run={run} isActive={isActive} />
      <Coverage run={run} states={run.states} screenshots={run.screenshots} />
      {report.skippedActions.length > 0 && (
        <details className="card">
          <summary>
            <h2 className="inline-heading">Controls and areas skipped ({report.skippedActions.length})</h2>
          </summary>
          <p className="help">Skipped is not passed. Each one needs a person to check it.</p>
          <ul className="plain">
            {report.skippedActions.map((a, n) => (
              <li key={n}>
                {a.what} <span className="muted">· {a.reason.replace(/_/g, ' ')}{a.detail ? `: ${a.detail}` : ''}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
