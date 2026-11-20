import { useState } from 'react';
import type { RunStatus, Severity } from '@cqa/shared';
import { api, type RunReport } from '../../api';
import type { CoverageSummary } from '../../api-qa';
import { isOpenWork } from '../IssueStatus';
import { ScreenshotViewer } from '../ScreenshotViewer';
import { RunActions, SEVERITY_WORD, SinceLastVersion, TopIssue, TrackingCard, evidenceLabel, isLearnerBlocker } from './SimpleParts';
import { plainIssue, plainReason, plainScreenName, withoutRuleCodes } from '../detail-level';

const ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'informational'];

type Issue = RunReport['issues'][number];

/** A problem a person can act on. The report already groups scanner notes (what it could not look at) as "not checked". */
export function isActionable(i: Issue): boolean {
  return i.action === 'fix' || i.action === 'check';
}

/** The file a "Large image / video / audio" problem is about, so the browser check and the file check can be matched. */
/** Checks that look at the same thing from two sides: the browser while playing, and the course files. */
const TOPIC: Record<string, string> = { 'MED-005': 'size', 'PKG-008': 'size', 'MED-003': 'captions', 'PKG-010': 'captions' };

/**
 * Open problems a person can act on, fixes first. When the browser check and the file check report the same problem
 * about the same file (matched by its exact path, never by name alone), they are shown once: open work wins, the
 * higher priority is kept, and the browser's screenshot and lesson are kept. Anything that cannot be matched surely is
 * shown as it is.
 */
export function actionable(r: RunReport): Issue[] {
  const open = r.issues.filter((i) => isOpenWork(i.status) && isActionable(i));
  const groups = new Map<string, Issue[]>();
  const out: Issue[] = [];
  for (const i of open) {
    const topic = TOPIC[i.technical.ruleId];
    if (!topic || !i.assetPath) {
      out.push(i);
      continue;
    }
    const key = `${topic}|${i.assetPath}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  for (const list of groups.values()) out.push(list.length === 1 ? list[0]! : mergeSame(list));
  return out.sort((a, b) => (a.action === b.action ? 0 : a.action === 'fix' ? -1 : 1) || ORDER.indexOf(a.priority) - ORDER.indexOf(b.priority));
}

function mergeSame(list: Issue[]): Issue {
  const fromFiles = list.find((i) => i.source === 'static');
  const fromBrowser = list.find((i) => i.source === 'runtime');
  const base = fromFiles ?? list[0]!;
  const priority = list.map((i) => i.priority).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0]!;
  return {
    ...base,
    action: list.some((i) => i.action === 'fix') ? 'fix' : 'check',
    priority,
    screens: [...new Set(list.flatMap((i) => i.screens))],
    lesson: fromBrowser?.lesson ?? base.lesson,
    screenshotId: fromBrowser?.screenshotId ?? base.screenshotId,
    screenshotKind: fromBrowser?.screenshotId ? fromBrowser.screenshotKind : base.screenshotKind,
  };
}

/**
 * What the scan reached, from the same coverage record the Technical view and the coverage export use. `recorded`
 * false means an older scan kept no such record, so coverage is unknown rather than complete.
 */
export interface CoverageFacts {
  recorded: boolean;
  noun: { singular: string; plural: string };
  reached: number;
  /** Undefined when the course's own total is not known. */
  total?: number;
  notReached: Array<{ title: string; reason: string }>;
  interactionsUntested: number;
  manualOutstanding: number;
  /** Why the course's own list may be incomplete, when it may be. */
  listNote?: string;
  /** The record exists but could not be loaded (the connection to the app dropped). */
  unavailable?: boolean;
}

/** `reachedFallback` is the number of units the report lists as visited, used when the course total is unknown (no ratio). */
export function coverageFacts(c: CoverageSummary | undefined, noun: { singular: string; plural: string } | undefined, reachedFallback = 0): CoverageFacts {
  const n = noun ?? { singular: 'screen', plural: 'screens' };
  if (!c) return { recorded: false, noun: n, reached: 0, notReached: [], interactionsUntested: 0, manualOutstanding: 0 };
  return {
    recorded: true,
    noun: n,
    reached: c.visit.available ? c.visit.numerator : reachedFallback,
    total: c.visit.available && c.discovery.completeness !== 'unknown' ? c.visit.denominator : undefined,
    notReached: c.gaps.unitsNotReached.map((u) => ({ title: u.title, reason: u.reason })),
    interactionsUntested: c.interactions.exercised.available ? c.interactions.exercised.denominator - c.interactions.exercised.numerator : 0,
    manualOutstanding: c.manual.outstanding,
    ...(c.discovery.completeness === 'partial' ? { listNote: c.discovery.reason } : {}),
  };
}

/** Gaps that rule out "Looks good" even when nothing was found. */
export interface VerdictGaps {
  explored?: boolean;
  coverage?: CoverageFacts;
  checksNotRun?: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What is still missing, in plain words, for the verdict line. */
export function missingParts(c: CoverageFacts | undefined, checksNotRun = 0): string[] {
  const out: string[] = [];
  if (c && !c.recorded) out.push(c.unavailable ? 'what the scan reached could not be loaded' : 'this older scan did not record what it reached');
  if (c?.recorded) {
    if (c.notReached.length) out.push(`${plural(c.notReached.length, c.noun.singular, c.noun.plural)} not reached`);
    if (c.total === undefined) out.push(`the course's total number of ${c.noun.plural} is unknown`);
    if (c.interactionsUntested) out.push(`${plural(c.interactionsUntested, 'interaction', 'interactions')} not tried`);
    if (c.manualOutstanding) out.push(`${plural(c.manualOutstanding, 'manual check', 'manual checks')} to do`);
  }
  if (checksNotRun) out.push(`${plural(checksNotRun, 'check', 'checks')} could not run`);
  return out;
}

export function verdictOf(status: RunStatus, fix: number, check: number, notChecked: number, gaps: VerdictGaps = {}): { tone: 'bad' | 'review' | 'good' | 'none'; text: string; detail: string } {
  if (status === 'failed') return { tone: 'none', text: 'The scan could not be completed', detail: 'Nothing in the course is marked as passed.' };
  if (status === 'cancelled') return { tone: 'none', text: 'The scan was cancelled', detail: 'Anything it did not get to is counted as not checked.' };
  if (fix > 0) return { tone: 'bad', text: 'Needs fixes', detail: `${fix} problem${fix === 1 ? '' : 's'} to fix${check ? ` and ${check} thing${check === 1 ? '' : 's'} to check by hand` : ''}.` };
  if (status === 'partial') return { tone: 'review', text: 'Needs your review', detail: 'No problems to fix were found, but the scan did not finish everything, so part of the course was not checked.' };
  if (gaps.explored === false) return { tone: 'review', text: 'Needs your review', detail: 'Only the opening page was checked; the scan did not go through the course.' };
  const missing = missingParts(gaps.coverage, gaps.checksNotRun);
  if (missing.length) return { tone: 'review', text: 'Needs your review', detail: `No problems to fix were found, but ${missing.join(', ')}.` };
  if (check > 0 || notChecked > 0) return { tone: 'review', text: 'Needs your review', detail: 'No problems to fix were found, but some things need a person to look at them.' };
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
export function SimpleSummary({ coverageUnavailable, runId, projectId, packageId, baselineRunId, status, statusDetail, explored, recorded, coverage, unitNoun, report: r, onShowTechnical }: { runId: string; projectId: string; packageId?: string; baselineRunId?: string; status: RunStatus; statusDetail?: string; explored: boolean; recorded: boolean; coverage?: CoverageSummary; unitNoun?: { singular: string; plural: string }; report: RunReport; onShowTechnical: () => void; coverageUnavailable?: boolean }) {
  const list = actionable(r);
  const fix = list.filter((i) => i.action === 'fix').length;
  const check = list.length - fix;
  const notCheckedItems = r.issues.filter((i) => isOpenWork(i.status) && !isActionable(i));
  const notChecked = notCheckedItems.length;
  const checksNotRun = r.checkTotals.notTested + r.checkTotals.errors + (r.checkTotals.unsupported ?? 0) + (r.checkTotals.inconclusive ?? 0);
  const cov = { ...coverageFacts(recorded ? coverage : undefined, unitNoun ?? r.unitNoun, (r.lessons ?? []).filter((l) => l.visited).length), ...(coverageUnavailable ? { unavailable: true } : {}) };
  const v = verdictOf(status, fix, check, notChecked, { explored, coverage: cov, checksNotRun });
  const [show, setShow] = useState<'all' | 'fix' | 'check'>('all');
  const shown = list.filter((i) => show === 'all' || i.action === show);
  // Learner blockers come first, then the rest by type.
  const blockers = shown.filter(isLearnerBlocker);
  const rest = shown.filter((i) => !isLearnerBlocker(i));
  const groups = [
    ...(blockers.length ? [{ name: 'Learner blockers', items: blockers }] : []),
    ...[...new Set(rest.map(groupOf))].map((g) => ({ name: g, items: rest.filter((i) => groupOf(i) === g) })).sort((a, b) => b.items.filter((i) => i.action === 'fix').length - a.items.filter((i) => i.action === 'fix').length || b.items.length - a.items.length),
  ];
  const blockerCount = list.filter(isLearnerBlocker).length;
  const missing = missingParts(cov, checksNotRun);
  const headline = v.tone === 'bad' && blockerCount ? `${v.text} · ${blockerCount} learner blocker${blockerCount === 1 ? '' : 's'}` : v.tone === 'review' && missing.length ? `${v.text} · ${missing[0]}` : v.text;
  const canRetest = status === 'completed' || status === 'partial';
  const lessons = r.lessons ?? [];
  const Noun = cov.noun.plural.charAt(0).toUpperCase() + cov.noun.plural.slice(1);
  const firstMissed = cov.notReached[0];
  const tracking = r.scorm ? `SCORM ${r.scorm.version}` : r.package?.scormVersionDeclared ? `SCORM ${r.package.scormVersionDeclared}` : r.package ? 'None (web package)' : 'Not tested';
  const unitWord = cov.noun.singular.charAt(0).toUpperCase() + cov.noun.singular.slice(1);
  const where = (i: Issue) => (i.lesson ? `${unitWord} ${i.lesson.n} of ${i.lesson.of}: ${i.lesson.title}` : i.source === 'static' ? 'Course files' : i.screens.length ? plainScreenName(r.screens.find((s) => s.label === i.screens[0])?.title ?? '') : '');

  return (
    <div className="simple-results">
      <section className={`simple-verdict verdict-${v.tone}`} aria-labelledby="verdict-h">
        <span className="verdict-tag">{v.tone === 'bad' ? 'Not ready' : v.tone === 'review' ? 'Review needed' : v.tone === 'good' ? 'No problems found' : 'No result'}</span>
        <div>
          <h2 id="verdict-h">{headline}</h2>
          <p>{v.detail}</p>
          {v.tone === 'bad' && missing.length > 0 && <p className="help">Also not covered yet: {missing.join(', ')}.</p>}
          {status !== 'completed' && statusDetail && <p className="help">Why: {plainReason(statusDetail)}</p>}
        </div>
      </section>

      <RunActions runId={runId} projectId={projectId} packageId={packageId} canRetest={canRetest} />

      {list[0] && <TopIssue issue={list[0]} where={where(list[0])} />}

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
          <div>
            <dt>{Noun} reached</dt>
            <dd>{!cov.recorded ? 'Not recorded' : cov.total === undefined ? `${cov.reached} · course total unknown` : `${cov.reached} of ${cov.total}`}</dd>
          </div>
          {cov.noun.singular !== 'screen' && (
            <div>
              <dt>Screens and views reached</dt>
              <dd>{r.coverage.screensScanned}</dd>
            </div>
          )}
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

      {baselineRunId && <SinceLastVersion runId={runId} baselineRunId={baselineRunId} />}

      <TrackingCard report={r} />

      <section className="card" aria-labelledby="played-h">
        <h2 id="played-h">Played like a learner</h2>
        <p>
          {explored
            ? 'The scan opened the course in a browser and went through it the way a learner would, trying the buttons, tabs and other controls on each screen.'
            : 'Only the opening page was checked. Going through the course was switched off for this scan.'}
        </p>
        {explored && (
          <p className={`played-result ${!cov.recorded || firstMissed || cov.total === undefined ? 'played-short' : 'played-done'}`}>
            {!cov.recorded ? (
              <>{cov.unavailable ? 'What the scan reached could not be loaded. Reload the page to try again.' : `This older scan did not record which ${cov.noun.plural} it reached, so how far it got is unknown.`}</>
            ) : firstMissed ? (
              <>
                <strong>Not everything was reached.</strong> It reached {cov.reached}
                {cov.total !== undefined ? ` of ${cov.total}` : ''} {cov.noun.plural}. The first one it did not reach is “{firstMissed.title}”: {firstMissed.reason}
              </>
            ) : cov.total === undefined ? (
              <>
                It reached {plural(cov.reached, cov.noun.singular, cov.noun.plural)}. The course does not list its own {cov.noun.plural}, so whether that is all of them is unknown.
              </>
            ) : (
              <>
                <strong>Every {cov.noun.singular} was reached.</strong> All {cov.total} {cov.noun.plural} the course lists were opened.
              </>
            )}
          </p>
        )}
        {explored && cov.listNote && <p className="help">The course's own list may be incomplete: {cov.listNote}</p>}
        {explored && cov.recorded && cov.interactionsUntested > 0 && (
          <p className="help">
            On the screens it reached, {plural(cov.interactionsUntested, 'interaction was', 'interactions were')} not tried (for example controls it did not recognise). They are listed under the technical details.
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
                      <span className={`badge ${i.action === 'fix' ? 'badge-fix' : 'badge-check'}`}>{i.action === 'fix' ? 'Fix' : 'Check by hand'}</span>
                      <span className="badge badge-quiet">{SEVERITY_WORD[i.priority]}</span>
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
                      {i.screenshotId ? <ScreenshotViewer src={api.artifactUrl(i.screenshotId)} alt={`Screenshot: ${plainIssue(i.issue)}`} caption={evidenceLabel(i)} title={plainIssue(i.issue)} /> : <p className="muted">{evidenceLabel(i)}</p>}
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
