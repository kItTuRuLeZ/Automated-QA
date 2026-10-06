import type { Severity } from '@cqa/shared';
import type { RunReport } from '../../api';
import { isOpenWork } from '../IssueStatus';
import { Alert, SEVERITY_LABEL, SeverityBadge, TableScroll } from '../ui';

const REASON_PLAIN: Record<string, string> = {
  unsafe_action: 'Skipped because the control looked unsafe to click',
  ambiguous_action: 'Skipped because its behavior was not recognized',
  out_of_scope: 'Outside the scan scope',
  budget_states: 'Scan limit reached (screens or views)',
  budget_depth: 'Scan limit reached (steps from the start)',
  budget_pages: 'Scan limit reached (pages)',
  budget_runtime: 'Scan limit reached (time)',
  state_unreachable: 'The screen could not be reached again',
  not_applicable: 'Not applicable',
  cancelled: 'The scan was cancelled',
};

/** The part of a scan a course developer reads first: counts with their units, the next actions, and the caveats. */
export function SummaryTab({ runId, report: r, isRetest }: { runId: string; report: RunReport; isRetest: boolean }) {
  const open = r.issues.filter((i) => isOpenWork(i.status));
  const topFix = r.issues.filter((i) => i.action === 'fix' && isOpenWork(i.status)).slice(0, 5);
  const didNotRun = r.checkTotals.notTested + r.checkTotals.errors;
  const bySev = (['critical', 'high', 'medium', 'low', 'informational'] as Severity[]).filter((s) => r.counts.bySeverity[s] > 0);

  return (
    <div>
      <section className="card" aria-labelledby="counts-h">
        <h2 id="counts-h">In this scan</h2>
        <div className="big-counts">
          <a className="big-count big-fix" href={`#/runs/${runId}/issues?action=fix`}>
            <span className="big-number">{r.counts.fix}</span>
            <span className="big-label">Issues to fix</span>
            <span className="help">Confirmed problems that need a change</span>
          </a>
          <a className="big-count big-check" href={`#/runs/${runId}/issues?action=check`}>
            <span className="big-number">{r.counts.check}</span>
            <span className="big-label">Needs your review</span>
            <span className="help">The scanner could not decide; a person should look</span>
          </a>
          <a className="big-count big-not" href={`#/runs/${runId}/issues?action=not_checked`}>
            <span className="big-number">{r.counts.notChecked}</span>
            <span className="big-label">Coverage gaps</span>
            <span className="help">Areas the scanner could not look at. These are not passes</span>
          </a>
        </div>
        {bySev.length > 0 && r.counts.fix > 0 && (
          <p className="help">
            Issues to fix by priority: {(['critical', 'high', 'medium', 'low', 'informational'] as Severity[]).filter((s) => r.counts.bySeverity[s] > 0).map((s) => `${r.counts.bySeverity[s]} ${SEVERITY_LABEL[s].toLowerCase()}`).join(', ')}
          </p>
        )}
        <ul className="plain units">
          <li>
            <strong>Findings in this scan:</strong> {r.issues.length} · <strong>Open work remaining:</strong> {open.length} (Verified, Accepted risk and False positive are finished; Marked fixed waits for a retest)
          </li>
          <li>
            <strong>Checks that did not run:</strong> {didNotRun} of {r.checkTotals.executions} check executions.
            {r.untested.length > 0 && ` Reasons: ${r.untested.map((u) => `${(REASON_PLAIN[u.reason] ?? u.reason.replace(/_/g, ' ')).toLowerCase()} (${u.count})`).join('; ')}.`} These are counted separately from the coverage gaps above and are never counted as passed.
            {didNotRun > 0 && (
              <>
                {' '}
                <a href={`#/runs/${runId}/technical`}>See the check executions</a>
              </>
            )}
          </li>
        </ul>
      </section>

      {topFix.length > 0 && (
        <section className="card" aria-labelledby="next-h">
          <h2 id="next-h">What to do next</h2>
          <ol className="top-issues">
            {topFix.map((i) => (
              <li key={i.id}>
                <SeverityBadge severity={i.priority} /> <a href={`#/findings/${i.findingId}`}>{i.issue}</a> <span className="muted mono">{i.id}</span>
                <span className="block muted">{i.change}</span>
              </li>
            ))}
          </ol>
          <p>
            <a className="btn" href={`#/runs/${runId}/issues?action=fix`}>
              See all {r.counts.fix} issues to fix
            </a>{' '}
            <span className="help">After the fixes are made, retest from the Issues tab.</span>
          </p>
        </section>
      )}
      {r.issues.length === 0 && (
        <Alert tone="note" title="No issues were recorded.">
          That does not mean the course passed QA. See the Coverage tab for what was and was not reached, and the Manual review tab for what only a person can check.
        </Alert>
      )}
      {isRetest && (
        <Alert tone="note">
          This is a retest. Issue statuses were updated from it. Verified means the issue was marked fixed, was not found, and its check passed on the same screen at the same screen size.
        </Alert>
      )}

      {r.package && (
        <section className="card">
          <h2>Course package</h2>
          <p>
            <strong>{r.package.name}</strong>
            {r.package.launchTitle ? ` · lesson scanned: ${r.package.launchTitle}` : ''}
            {r.package.launchPoints > 1 ? ` (one of ${r.package.launchPoints} lessons; the package checks say which others were not scanned)` : ''}
            {r.package.inventory ? ` · ${r.package.inventory.files} files` : ''}
          </p>
          <p>
            Outside websites referenced: {r.package.externalDependencies.length ? r.package.externalDependencies.map((d) => d.host).join(', ') : 'none found in the course’s own files'}.
          </p>
          <p className="help">Items marked “Static package check” were read from the package files; no code was run for them. Everything else was observed in the browser.</p>
        </section>
      )}
      {r.scorm && (
        <section className="card">
          <h2>
            SCORM {r.scorm.version} test harness: {r.scorm.source}
          </h2>
          <p>{r.scorm.limitations[0]}</p>
          <TableScroll label="Test harness sessions">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Session</th>
                  <th scope="col">Steps carried out</th>
                  <th scope="col">API calls</th>
                  <th scope="col">Recorded at the end</th>
                </tr>
              </thead>
              <tbody>
                {r.scorm.sessions.map((x) => (
                  <tr key={x.name}>
                    <th scope="row">{x.name}</th>
                    <td>
                      {x.stepsRun} of {x.stepsTotal}
                      {x.stepFailure ? ` (${x.stepFailure})` : ''}
                    </td>
                    <td>{x.callCount}</td>
                    <td>{x.finalStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          <ul className="help">
            {r.scorm.limitations.slice(1).map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <details>
            <summary>Only your LMS can show these ({r.scorm.lmsChecklist.length})</summary>
            <ol>
              {r.scorm.lmsChecklist.map((i) => (
                <li key={i.id}>
                  <strong>{i.title}</strong>. {i.howToCheck}
                </li>
              ))}
            </ol>
          </details>
        </section>
      )}
    </div>
  );
}
