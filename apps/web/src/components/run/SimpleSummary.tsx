import { useState } from 'react';
import type { RunStatus, Severity } from '@cqa/shared';
import { api, type RunReport } from '../../api';
import { isOpenWork } from '../IssueStatus';
import { ScreenshotViewer } from '../ScreenshotViewer';
import { plainIssue, plainReason, plainScreenName, withoutRuleCodes } from '../detail-level';

const ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'informational'];

type Issue = RunReport['issues'][number];

/** A problem a person can act on. The report already groups scanner notes (what it could not look at) as "not checked". */
export function isActionable(i: Issue): boolean {
  return i.action === 'fix' || i.action === 'check';
}

/** The file a "Large image / video / audio" problem is about, so the browser check and the file check can be matched. */
const largeFile = (i: Issue) => /^Large (?:image|video|audio file): (.+?) \(/.exec(plainIssue(i.issue))?.[1]?.trim().toLowerCase();

/** Open problems a person can act on, fixes first. A large file found by both the browser and the file check is listed once, from the file check. */
export function actionable(r: RunReport): Issue[] {
  const fromFiles = new Set(r.issues.filter((i) => i.source === 'static').map(largeFile).filter(Boolean));
  return r.issues.filter((i) => isOpenWork(i.status) && isActionable(i) && !(i.source === 'runtime' && fromFiles.has(largeFile(i)))).sort((a, b) => (a.action === b.action ? 0 : a.action === 'fix' ? -1 : 1) || ORDER.indexOf(a.priority) - ORDER.indexOf(b.priority));
}

/** Gaps that rule out "Looks good" even when nothing was found: exploration off, lessons not reached, checks that could not run. */
export interface VerdictGaps {
  explored?: boolean;
  lessonsMissed?: number;
  checksNotRun?: number;
}

export function verdictOf(status: RunStatus, fix: number, check: number, notChecked: number, gaps: VerdictGaps = {}): { tone: 'bad' | 'review' | 'good' | 'none'; text: string; detail: string } {
  if (status === 'failed') return { tone: 'none', text: 'The scan could not be completed', detail: 'Nothing in the course is marked as passed.' };
  if (status === 'cancelled') return { tone: 'none', text: 'The scan was cancelled', detail: 'Anything it did not get to is counted as not checked.' };
  if (fix > 0) return { tone: 'bad', text: 'Needs fixes', detail: `${fix} problem${fix === 1 ? '' : 's'} to fix${check ? ` and ${check} thing${check === 1 ? '' : 's'} to check by hand` : ''}.` };
  if (status === 'partial') return { tone: 'review', text: 'Needs your review', detail: 'No problems to fix were found, but the scan did not finish everything, so part of the course was not checked.' };
  if (gaps.explored === false) return { tone: 'review', text: 'Needs your review', detail: 'Only the opening page was checked; the scan did not go through the course.' };
  if ((gaps.lessonsMissed ?? 0) > 0) return { tone: 'review', text: 'Needs your review', detail: `No problems to fix were found, but the scan did not reach ${gaps.lessonsMissed} lesson${gaps.lessonsMissed === 1 ? '' : 's'}, so ${gaps.lessonsMissed === 1 ? 'it was' : 'they were'} not checked.` };
  if (check > 0 || notChecked > 0 || (gaps.checksNotRun ?? 0) > 0) return { tone: 'review', text: 'Needs your review', detail: 'No problems to fix were found, but some things need a person to look at them.' };
  return { tone: 'good', text: 'Looks good', detail: 'No problems were found in what the scan checked. A person should still do the manual checks.' };
}

const GROUP: Record<string, string> = {
  accessibility: 'Accessibility',
  keyboard: 'Keyboard',
  layout: 'Layout and readability',
  content: 'Text',
  text: 'Text',
  package: 'Course files',
  media: 'Media',
  links: 'Links',
  network: 'Loading',
  runtime: 'Errors',
  navigation: 'Navigation',
  functional: 'Interactions',
  scorm: 'LMS tracking',
  brand: 'Brand',
  performance: 'Speed',
};
const groupOf = (i: Issue) => GROUP[i.category ?? ''] ?? 'Other';
const PLATFORM: Record<string, string> = { rise: 'Articulate Rise', storyline: 'Articulate Storyline' };

/**
 * The whole result on one page, for course developers and reviewers: a verdict, the course at a glance, how the scan
 * went through it, and the problems grouped by type. Each problem opens to show its screenshot and what to do.
 */
export function SimpleSummary({ runId, status, statusDetail, explored, recorded, report: r, onShowTechnical }: { runId: string; status: RunStatus; statusDetail?: string; explored: boolean; recorded: boolean; report: RunReport; onShowTechnical: () => void }) {
  const list = actionable(r);
  const fix = list.filter((i) => i.action === 'fix').length;
  const check = list.length - fix;
  const notCheckedItems = r.issues.filter((i) => isOpenWork(i.status) && !isActionable(i));
  const notChecked = notCheckedItems.length;
  const checksNotRun = r.checkTotals.notTested + r.checkTotals.errors + (r.checkTotals.unsupported ?? 0) + (r.checkTotals.inconclusive ?? 0);
  const lessonsMissed = (r.lessons ?? []).filter((l) => !l.visited).length;
  const v = verdictOf(status, fix, check, notChecked, { explored, lessonsMissed, checksNotRun });
  const [show, setShow] = useState<'all' | 'fix' | 'check'>('all');
  const shown = list.filter((i) => show === 'all' || i.action === show);
  const groups = [...new Set(shown.map(groupOf))].map((g) => ({ name: g, items: shown.filter((i) => groupOf(i) === g) })).sort((a, b) => b.items.filter((i) => i.action === 'fix').length - a.items.filter((i) => i.action === 'fix').length || b.items.length - a.items.length);
  const lessons = r.lessons ?? [];
  const visited = lessons.filter((l) => l.visited).length;
  const firstMissed = lessons.find((l) => !l.visited);
  const tracking = r.scorm ? `SCORM ${r.scorm.version}` : r.package?.scormVersionDeclared ? `SCORM ${r.package.scormVersionDeclared}` : r.package ? 'None (web package)' : 'Not tested';
  const where = (i: Issue) => (i.lesson ? `Lesson ${i.lesson.n} of ${i.lesson.of}: ${i.lesson.title}` : i.source === 'static' ? 'Course files' : i.screens.length ? plainScreenName(r.screens.find((s) => s.label === i.screens[0])?.title ?? '') : '');

  return (
    <div className="simple-results">
      <section className={`simple-verdict verdict-${v.tone}`} aria-labelledby="verdict-h">
        <span className="verdict-tag">{v.tone === 'bad' ? 'Not ready' : v.tone === 'review' ? 'Review needed' : v.tone === 'good' ? 'No problems found' : 'No result'}</span>
        <div>
          <h2 id="verdict-h">{v.text}</h2>
          <p>{v.detail}</p>
          {status !== 'completed' && statusDetail && <p className="help">Why: {plainReason(statusDetail)}</p>}
        </div>
      </section>

      <section className="card simple-facts" aria-label="The course at a glance">
        <dl>
          <div>
            <dt>Made with</dt>
            <dd>{PLATFORM[r.scan.platform ?? ''] ?? (r.package ? 'Web package' : 'Web page')}</dd>
          </div>
          <div>
            <dt>Tracking</dt>
            <dd>{tracking}</dd>
          </div>
          {lessons.length > 0 && (
            <div>
              <dt>Lessons played</dt>
              <dd>
                {visited} of {lessons.length}
              </dd>
            </div>
          )}
          <div>
            <dt>Screens checked</dt>
            <dd>{r.coverage.screensScanned}</dd>
          </div>
          <div>
            <dt>Checks passed</dt>
            <dd>
              {r.checkTotals.passed} of {r.checkTotals.passed + r.checkTotals.failed}
            </dd>
          </div>
          <div>
            <dt>Not checked</dt>
            <dd>{notChecked}</dd>
          </div>
        </dl>
      </section>

      <section className="card" aria-labelledby="played-h">
        <h2 id="played-h">Played like a learner</h2>
        <p>
          {explored
            ? 'The scan opened the course in a browser and went through it the way a learner would, trying the buttons, tabs and other controls on each screen.'
            : 'Only the opening page was checked. Going through the course was switched off for this scan.'}
        </p>
        {explored && lessons.length > 0 && (
          <p className={`played-result ${firstMissed ? 'played-short' : 'played-done'}`}>
            {firstMissed ? (
              <>
                <strong>Stopped early.</strong> It reached {visited} of {lessons.length} lessons; the first one it did not reach is “{firstMissed.title}”.
              </>
            ) : (
              <>
                <strong>Finished.</strong> It reached all {lessons.length} lessons.
              </>
            )}
          </p>
        )}
        {(r.scan.walkAids ?? []).map((a) => (
          <p key={a} className="help">
            {a}
          </p>
        ))}
        {lessons.length > 0 && (
          <details>
            <summary>Lesson by lesson ({lessons.length})</summary>
            <ol className="lesson-list">
              {lessons.map((l) => (
                <li key={l.n}>
                  <span aria-hidden="true">{l.visited ? '✓' : '✕'}</span> {l.title}
                  {!l.visited && <span className="muted"> · not reached</span>}
                </li>
              ))}
            </ol>
          </details>
        )}
      </section>

      <section aria-labelledby="problems-h">
        <div className="simple-problems-head">
          <h2 id="problems-h">Problems</h2>
          <div className="chips" role="group" aria-label="Show">
            {(
              [
                ['all', `All ${list.length}`],
                ['fix', `To fix ${fix}`],
                ['check', `To check ${check}`],
              ] as const
            ).map(([id, label]) => (
              <button key={id} type="button" className={`chip${show === id ? ' on' : ''}`} aria-pressed={show === id} onClick={() => setShow(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {groups.length === 0 && <p className="card muted">{list.length ? 'Nothing of this kind.' : 'No problems were found in what the scan checked.'}</p>}
        {groups.map((g) => (
          <div key={g.name} className="problem-group">
            <h3>
              {g.name} <span className="muted">· {g.items.length}</span>
            </h3>
            <ul className="problem-rows">
              {g.items.map((i) => (
                <li key={i.id}>
                  <details className="problem-row">
                    <summary>
                      <span className={`badge ${i.action === 'fix' ? 'badge-fix' : 'badge-check'}`}>{i.action === 'fix' ? 'Fix' : 'Check'}</span>
                      <span className="problem-title">{plainIssue(i.issue)}</span>
                      {where(i) && <span className="problem-where">{where(i)}</span>}
                    </summary>
                    <div className="problem-body">
                      <div>
                        <p>
                          <strong>What to do:</strong> {withoutRuleCodes(i.change)}
                        </p>
                        <p>
                          <a href={`#/findings/${i.findingId}`}>See the full details</a>
                        </p>
                      </div>
                      {i.screenshotId && <ScreenshotViewer src={api.artifactUrl(i.screenshotId)} alt={`Screenshot: ${plainIssue(i.issue)}`} caption={i.screenshotKind === 'element' ? 'The problem is outlined in red' : 'The screen where it was found'} title={plainIssue(i.issue)} />}
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      {(notChecked > 0 || checksNotRun > 0) && (
        <section className="card" aria-labelledby="notchecked-h">
          <h2 id="notchecked-h">Not checked</h2>
          <p>
            The scan could not look at {notChecked} thing{notChecked === 1 ? '' : 's'}, for example a screen it could not reach or content drawn as a picture.
            {checksNotRun > 0 ? ` ${checksNotRun} individual check${checksNotRun === 1 ? '' : 's'} could not run.` : ''} None of these count as passed.
          </p>
          {notCheckedItems.length > 0 && (
            <details>
              <summary>What was not checked ({notCheckedItems.length})</summary>
              <ul>
                {notCheckedItems.map((i) => (
                  <li key={i.id}>
                    {plainIssue(i.issue)}
                    {where(i) ? <span className="muted"> · {where(i)}</span> : null}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p>
            <button type="button" className="link-button" onClick={onShowTechnical}>
              Show the technical details
            </button>
          </p>
        </section>
      )}

      <p className="simple-more">
        {recorded && (
          <>
            <a href={`#/runs/${runId}/screens`}>Review screen by screen</a> ·{' '}
          </>
        )}
        <a href={`#/runs/${runId}/issues`}>All problems, with filters</a>
      </p>
    </div>
  );
}
