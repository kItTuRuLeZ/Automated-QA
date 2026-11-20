import { useRef, useState } from 'react';
import type { Severity } from '@cqa/shared';
import { api, type RunComparisonView, type RunReport } from '../../api';
import { ScreenshotViewer } from '../ScreenshotViewer';
import { plainIssue, withoutRuleCodes } from '../detail-level';
import { useLoader } from '../ui';

type Issue = RunReport['issues'][number];
export const SEVERITY_WORD: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', informational: 'Info' };

/** A problem that stops or misleads a learner: an open fix at critical or high priority. */
export const isLearnerBlocker = (i: Issue) => i.action === 'fix' && (i.priority === 'critical' || i.priority === 'high');

/** The screenshot caption, from the evidence actually kept. */
export function evidenceLabel(i: Pick<Issue, 'screenshotId' | 'screenshotKind'>): string {
  if (!i.screenshotId) return 'No screenshot was kept for this problem';
  return i.screenshotKind === 'element' ? 'The problem is outlined in red' : 'The whole screen where it was found (the problem is not outlined)';
}

/** The most important open problem, near the top: what it is, where, what to do, and its evidence. */
export function TopIssue({ issue: i, where }: { issue: Issue; where: string }) {
  return (
    <section className="card top-issue" aria-labelledby="top-issue-h">
      <div>
        <p className="eyebrow">{isLearnerBlocker(i) ? 'Most important: blocks or misleads learners' : 'Most important open problem'}</p>
        <h2 id="top-issue-h">
          <span className={`badge ${i.action === 'fix' ? 'badge-fix' : 'badge-check'}`}>{i.action === 'fix' ? 'Fix' : 'Check by hand'}</span> <span className="badge badge-quiet">{SEVERITY_WORD[i.priority]}</span> {plainIssue(i.issue)}
        </h2>
        {where && <p className="muted">Where: {where}</p>}
        <p>
          <strong>What to do:</strong> {withoutRuleCodes(i.change)}
        </p>
        <p>
          <a href={`#/findings/${i.findingId}`}>See the full finding and its evidence</a>
        </p>
      </div>
      {i.screenshotId ? (
        <ScreenshotViewer src={api.artifactUrl(i.screenshotId)} alt={`Screenshot: ${plainIssue(i.issue)}`} caption={evidenceLabel(i)} title={plainIssue(i.issue)} />
      ) : (
        <p className="muted evidence-none">{evidenceLabel(i)}</p>
      )}
    </section>
  );
}

const SCORM_WORD: Record<string, string> = { passed: 'Works in the test', failed: 'Problem found', needs_review: 'Check by hand', not_tested: 'Not tested', not_applicable: 'Not applicable', error: 'Could not be checked' };

/** What the LMS would be told, as seen in the built-in SCORM test, kept apart from what the package merely declares. */
export function TrackingCard({ report: r }: { report: RunReport }) {
  const declared = r.package?.scormVersionDeclared ? `SCORM ${r.package.scormVersionDeclared}` : r.package ? 'No SCORM version declared' : undefined;
  if (!r.scorm) {
    return (
      <section className="card" aria-labelledby="tracking-h">
        <h2 id="tracking-h">LMS tracking observed</h2>
        <p>
          <strong>Tracking not tested.</strong> This scan did not run the built-in SCORM test{declared ? ` (the package declares ${declared})` : ''}.
        </p>
      </section>
    );
  }
  const outcome = (suffix: string) => {
    const found = r.scorm!.sessions.flatMap((s) => s.outcomes ?? []).filter((o) => o.rule.endsWith(suffix));
    if (!found.length) return 'Not tested';
    const order = ['failed', 'error', 'needs_review', 'not_tested', 'passed', 'not_applicable'];
    const worst = [...found].sort((a, b) => order.indexOf(a.outcome) - order.indexOf(b.outcome))[0]!.outcome;
    return SCORM_WORD[worst] ?? worst;
  };
  const journeys = r.scorm.sessions.filter((s) => s.kind !== 'resume');
  const completion = journeys.map((s) => s.finalStatus).filter(Boolean);
  const resumed = r.scorm.sessions.some((s) => s.kind === 'resume');
  return (
    <section className="card" aria-labelledby="tracking-h">
      <h2 id="tracking-h">LMS tracking observed</h2>
      <p className="help">
        Seen in the built-in SCORM {r.scorm.version} test, not in a real LMS.{declared ? ` The package declares ${declared}.` : ''}
      </p>
      <dl className="tracking-facts">
        <div>
          <dt>Completion recorded</dt>
          <dd>{completion.length ? completion.join(', ') : 'Nothing recorded'}</dd>
        </div>
        <div>
          <dt>Score and status values</dt>
          <dd>{outcome('-005')}</dd>
        </div>
        <div>
          <dt>Resume</dt>
          <dd>{resumed ? outcome('-007') : 'Not tested'}</dd>
        </div>
      </dl>
    </section>
  );
}

const SINCE: Array<{ key: keyof RunComparisonView['counts']; label: string }> = [
  { key: 'resolved', label: 'Verified fixed' },
  { key: 'persistent', label: 'Still open' },
  { key: 'new', label: 'New' },
  { key: 'not_retested', label: 'Not retested' },
  { key: 'incomparable', label: 'Not comparable' },
];

/** What changed since the version this scan retests, using the same judgement as Compare. */
export function SinceLastVersion({ runId, baselineRunId }: { runId: string; baselineRunId: string }) {
  const c = useLoader(() => api.compareRuns(runId, baselineRunId), [runId, baselineRunId]);
  if (!c.data) return null;
  const d = c.data;
  return (
    <section className="card" aria-labelledby="since-h">
      <h2 id="since-h">Since the previous version</h2>
      <dl className="simple-facts-row">
        {SINCE.map((s) => (
          <div key={s.key}>
            <dt>{s.label}</dt>
            <dd>{d.counts[s.key]}</dd>
          </div>
        ))}
      </dl>
      <p className="help">
        {d.comparable.sameCourse && !d.comparable.differences.length
          ? 'A problem counts as verified fixed only when the same check ran again on the same screen and passed. Anything the new scan did not reach is "Not retested".'
          : `Some results cannot be compared: ${d.comparable.differences.join('; ')}.`}{' '}
        <a href={`#/runs/${runId}/compare`}>See each problem</a>
      </p>
    </section>
  );
}

/**
 * The review actions: download the report, compare, retest this version, and (for an uploaded course) scan a revised
 * ZIP as the next version. Every control is a real button or link, so it works by keyboard and wraps at narrow widths.
 */
export function RunActions({ runId, projectId, packageId, canRetest }: { runId: string; projectId: string; packageId?: string; canRetest: boolean }) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [file, setFile] = useState<File>();
  const [trusted, setTrusted] = useState(false);
  const [choices, setChoices] = useState<Array<{ key: string; title: string }>>();
  const [choice, setChoice] = useState('');
  const [uploaded, setUploaded] = useState<string>();
  const input = useRef<HTMLInputElement>(null);

  const retest = async () => {
    setBusy('retest');
    setError(undefined);
    try {
      const next = await api.retestRun(runId);
      window.location.hash = `#/runs/${next.id}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(undefined);
    }
  };
  const scanRevision = async () => {
    if (!file || !packageId || !trusted) return;
    setBusy('revision');
    setError(undefined);
    try {
      const pkgId = uploaded ?? (await api.uploadPackage(projectId, file, packageId)).id;
      setUploaded(pkgId);
      const out = await api.scanPackage(pkgId, { acknowledgeLocalExecution: true, baselineRunId: runId, ...(choice ? { launch: [choice] } : {}) });
      window.location.hash = `#/runs/${out.runs[0]!.id}`;
    } catch (e) {
      const body = (e as { body?: { choices?: Array<{ key: string; title: string }>; launchChanged?: boolean } }).body;
      if (body?.launchChanged && body.choices) setChoices(body.choices);
      setError((e as Error).message);
      setBusy(undefined);
    }
  };

  return (
    <section className="run-actions" aria-label="Review actions">
      <a className="btn" href={`#/runs/${runId}/compare`}>
        Compare with an earlier scan
      </a>
      {canRetest && (
        <button type="button" className="btn" disabled={Boolean(busy)} onClick={retest}>
          {busy === 'retest' ? 'Starting…' : 'Retest this version'}
        </button>
      )}
      {packageId && canRetest && (
        <>
          <button type="button" className="btn" disabled={Boolean(busy)} onClick={() => input.current?.click()}>
            Scan a revised ZIP
          </button>
          <input ref={input} type="file" accept=".zip,application/zip" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => (setFile(e.target.files?.[0]), setUploaded(undefined), setChoices(undefined), setChoice(''))} />
        </>
      )}
      {file && packageId && (
        <div className="revision-panel" role="group" aria-label="Scan a revised ZIP">
          <p>
            <strong>{file.name}</strong> will be uploaded as the next version of this course, scanned with the same settings and lesson, and compared with this scan.
          </p>
          {choices && (
            <div className="field">
              <label htmlFor="revision-launch">The lesson scanned before is not in this version. Choose a lesson (it will not be compared as the same one):</label>
              <select id="revision-launch" value={choice} onChange={(e) => setChoice(e.target.value)}>
                <option value="">Choose…</option>
                {choices.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.title}
                  </option>
                ))}
              </select>
            </div>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={trusted} onChange={(e) => setTrusted(e.target.checked)} /> I trust this package: scanning runs its own code in a browser on this computer, behind the network limits.
          </label>
          <p>
            <button type="button" className="btn btn-primary" disabled={!trusted || Boolean(busy) || (Boolean(choices) && !choice)} onClick={scanRevision}>
              {busy === 'revision' ? 'Uploading and starting…' : 'Upload and scan'}
            </button>{' '}
            <button
              type="button"
              className="btn"
              onClick={() => {
                // Start over: the same ZIP can be picked again.
                setFile(undefined);
                setChoices(undefined);
                setChoice('');
                setUploaded(undefined);
                setTrusted(false);
                if (input.current) input.current.value = '';
              }}
            >
              Cancel
            </button>
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="alert alert-error">
          {error}
        </p>
      )}
    </section>
  );
}
