import { useState } from 'react';
import type { Severity } from '@cqa/shared';
import { api } from '../api';
import { ErrorBox, Loading, SEVERITY_LABEL, SeverityBadge, useLoader } from './ui';
import type { ScanRun } from '@cqa/shared';

type Group = 'fix' | 'check' | 'not_checked';

const GROUPS: Array<{ id: Group; title: string; help: string }> = [
  { id: 'fix', title: 'Fix', help: 'Confirmed problems that need a change.' },
  { id: 'check', title: 'Check by hand', help: 'The scanner could not decide. A person needs to look.' },
  { id: 'not_checked', title: 'Not checked', help: 'Areas the scanner could not inspect. These are not passes.' },
];

const VISIBLE = 8;

/** The part of a scan a course developer reads: what to change and where. */
export function PlainSummary({ run, isActive }: { run: ScanRun; isActive: boolean }) {
  const { data, error, reload } = useLoader(() => api.runReport(run.id), [run.id, run.status], undefined);
  const [open, setOpen] = useState<Record<Group, boolean>>({ fix: false, check: false, not_checked: false });

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const r = data;
  const finished = !isActive;

  return (
    <section aria-labelledby="plain-heading" className="card plain">
      <div className="plain-head">
        <div>
          <h2 id="plain-heading">{finished ? 'What to do' : 'Scan in progress'}</h2>
          <p className="muted">
            {r.run.statusPlain}. {r.coverage.screensScanned} screen{r.coverage.screensScanned === 1 ? '' : 's'} scanned
            {r.coverage.budgetsReached.length > 0 && ', and the scan stopped at a limit, so other screens were not looked at'}.
          </p>
        </div>
        <a className="btn btn-primary" href={`/api/runs/${run.id}/export.xlsx`} download>
          Download Excel tracker
        </a>
      </div>

      <div className="big-counts" role="list">
        <Count label="To fix" value={r.counts.fix} tone="fix" />
        <Count label="Check by hand" value={r.counts.check} tone="check" />
        <Count label="Not checked" value={r.counts.notChecked} tone="not" />
      </div>
      {r.counts.fix > 0 && (
        <p className="help">
          Fix by priority:{' '}
          {(['critical', 'high', 'medium', 'low', 'informational'] as Severity[])
            .filter((s) => r.counts.bySeverity[s] > 0)
            .map((s) => `${r.counts.bySeverity[s]} ${SEVERITY_LABEL[s].toLowerCase()}`)
            .join(', ')}
        </p>
      )}

      {GROUPS.map((g) => {
        const items = r.issues.filter((i) => i.action === g.id);
        if (items.length === 0) return null;
        const shown = open[g.id] ? items : items.slice(0, VISIBLE);
        return (
          <div key={g.id} className="issue-group">
            <h3>
              {g.title} ({items.length})
            </h3>
            <p className="help">{g.help}</p>
            <ul className="issues">
              {shown.map((i) => (
                <li key={i.id}>
                  <div className="issue-top">
                    <SeverityBadge severity={i.priority} />
                    <strong>{i.issue}</strong>
                    <span className="muted mono">{i.id}</span>
                    {i.viewports.length > 0 && <span className="muted">at {i.viewports.join(', ')}</span>}
                  </div>
                  {i.screenshotId && (
                    <figure className="issue-shot">
                      <img
                        src={api.artifactUrl(i.screenshotId)}
                        alt={i.screenshotKind === 'element' ? `Screenshot with the affected element outlined in red: ${i.issue}` : `Screenshot of screen ${i.screens[0] ?? ''} where this was found`}
                        loading="lazy"
                      />
                      <figcaption>{i.screenshotKind === 'element' ? 'Affected element outlined' : 'Whole screen'}</figcaption>
                    </figure>
                  )}
                  <p className="issue-change">
                    <span className="label">What to change:</span> {i.change}
                  </p>
                  <p className="issue-where">
                    <span className="label">Where:</span> {i.screens.length ? `screen${i.screens.length > 1 ? 's' : ''} ${i.screens.join(', ')}` : 'this scan'}
                    {i.elements.length > 0 && ` · ${i.elements.join('; ')}${i.moreElements ? ` (+${i.moreElements} more)` : ''}`}
                  </p>
                  <details>
                    <summary>How to see it</summary>
                    <ol>
                      {i.steps.map((s, n) => (
                        <li key={n}>{s}</li>
                      ))}
                    </ol>
                    <p className="help">
                      Technical details: {i.technical.ruleId} · {i.technical.observed} · <a href={`#/findings/${i.findingId}`}>Open full finding</a>
                    </p>
                  </details>
                </li>
              ))}
            </ul>
            {items.length > VISIBLE && (
              <button type="button" className="btn btn-small" onClick={() => setOpen((o) => ({ ...o, [g.id]: !o[g.id] }))} aria-expanded={open[g.id]}>
                {open[g.id] ? 'Show fewer' : `Show all ${items.length}`}
              </button>
            )}
          </div>
        );
      })}

      {finished && r.issues.length === 0 && (
        <p>
          <strong>No issues were recorded.</strong> That does not mean the course passed QA: see Coverage below for what was and was not reached, and the manual review checklist.
        </p>
      )}
    </section>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone: 'fix' | 'check' | 'not' }) {
  return (
    <div className={`big-count big-${tone}`} role="listitem">
      <div className="big-number">{value}</div>
      <div className="big-label">{label}</div>
    </div>
  );
}
