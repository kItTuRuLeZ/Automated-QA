import { api, type RunReport } from '../../api';
import { IssueStatus } from '../IssueStatus';
import { ScreenshotViewer } from '../ScreenshotViewer';
import { SeverityBadge } from '../ui';

export type ReportIssue = RunReport['issues'][number];

/** One issue, answering: what happened, where, what to do. Technical rule details are one click away. */
export function IssueCard({ issue: i, screens, onSaved }: { issue: ReportIssue; screens: RunReport['screens']; onSaved?: () => void }) {
  const title = (label: string) => {
    const s = screens.find((x) => x.label === label);
    return s?.title ? `${s.title} (${label})` : label;
  };
  return (
    <li className="issue-card">
      <div className="issue-top">
        <SeverityBadge severity={i.priority} />
        <h3 className="issue-title">
          <a href={`#/findings/${i.findingId}`}>{i.issue}</a>
        </h3>
        <span className="muted mono issue-id">{i.id}</span>
        {i.source === 'static' && <span className="badge">Static package check</span>}
      </div>
      <div className="issue-body">
        {i.screenshotId && (
          <ScreenshotViewer
            src={api.artifactUrl(i.screenshotId)}
            alt={i.screenshotKind === 'element' ? `Screenshot with the affected element outlined in red: ${i.issue}` : `Screenshot of the screen where this was found: ${i.issue}`}
            caption={i.screenshotKind === 'element' ? 'Affected element outlined (a crop; the full screen is in the viewer)' : 'Whole screen'}
            title={i.issue}
          />
        )}
        <dl className="issue-facts">
          <div>
            <dt>Where</dt>
            <dd>
              {i.screens.length ? `${i.screens.length > 1 ? 'Screens' : 'Screen'}: ${i.screens.map(title).join(', ')}` : 'This scan'}
              {i.viewports.length > 0 && ` · at ${i.viewports.join(', ')} size`}
              {i.elements.length > 0 && (
                <span className="muted block">
                  {i.elements.join('; ')}
                  {i.moreElements ? ` (+${i.moreElements} more)` : ''}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>What to do</dt>
            <dd>{i.change}</dd>
          </div>
        </dl>
      </div>
      <IssueStatus issue={i} onSaved={onSaved} />
      <details>
        <summary>How to see it, and technical details</summary>
        <ol>
          {i.steps.map((s, n) => (
            <li key={n}>{s}</li>
          ))}
        </ol>
        <p className="help">
          Rule {i.technical.ruleId} · {i.technical.observed} · <a href={`#/findings/${i.findingId}`}>Open the full finding</a>
        </p>
      </details>
    </li>
  );
}
