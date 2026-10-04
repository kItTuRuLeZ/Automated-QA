import type { ScormExpectation, ScormSettings } from '@cqa/shared';
import type { HarnessCall, ScormVersion } from '../adapters/scorm-harness.js';
import { type NewCheck, check } from './helpers.js';

/**
 * Turns what a course did against the test harness into rule results. Pure:
 * no browser, no clock. Everything here is a statement about the harness
 * session, never about a real LMS.
 */
export interface SessionResult {
  name: string;
  kind: 'journey' | 'resume';
  version: ScormVersion;
  calls: HarnessCall[];
  lookups: Array<{ name: string; t: number }>;
  /** Values the course had set when it left (not redacted; kept on the Node side only). */
  cmi: Record<string, string>;
  /** What the harness would have stored. */
  committed: Record<string, string>;
  /** Highest call number seen before the page was navigated away. */
  callsBeforeLeave: number;
  stepsTotal: number;
  stepsRun: number;
  stepFailure?: string;
  expect?: ScormExpectation;
  /** Resume sessions: what the harness handed back. */
  restoredFrom?: Record<string, string>;
}

export type Outcome = 'passed' | 'failed' | 'needs_review' | 'not_applicable' | 'not_tested';

export interface Issue {
  title: string;
  observed: string;
  expected: string;
  remediation: string;
  /** Stable key so the same problem found in several sessions is one finding. */
  targetKey: string;
}

export interface RuleResult {
  /** Three-digit suffix: 001..008. */
  rule: string;
  outcome: Outcome;
  detail: string;
  issues: Issue[];
}

const NAMES = {
  '1.2': { init: 'LMSInitialize', fin: 'LMSFinish', get: 'LMSGetValue', set: 'LMSSetValue', commit: 'LMSCommit', api: 'API', other: 'API_1484_11', loc: 'cmi.core.lesson_location', exit: 'cmi.core.exit', score: 'cmi.core.score.raw' },
  '2004': { init: 'Initialize', fin: 'Terminate', get: 'GetValue', set: 'SetValue', commit: 'Commit', api: 'API_1484_11', other: 'API', loc: 'cmi.location', exit: 'cmi.exit', score: 'cmi.score.raw' },
} as const;

const PERSIST = {
  '1.2': ['cmi.core.lesson_location', 'cmi.core.lesson_status', 'cmi.core.score.raw', 'cmi.core.score.min', 'cmi.core.score.max', 'cmi.suspend_data'],
  '2004': ['cmi.location', 'cmi.completion_status', 'cmi.success_status', 'cmi.progress_measure', 'cmi.score.scaled', 'cmi.score.raw', 'cmi.score.min', 'cmi.score.max', 'cmi.suspend_data'],
} as const;

const succeeded = (c: HarnessCall) => c.ret === 'true' && c.error === 0;
const label = (v: ScormVersion) => (v === '1.2' ? 'SCORM 1.2' : 'SCORM 2004');

export function analyzeSession(s: SessionResult): RuleResult[] {
  const n = NAMES[s.version];
  const v = label(s.version);
  const isData = (c: HarnessCall) => c.fn === n.get || c.fn === n.set || c.fn === n.commit;
  const inits = s.calls.filter((c) => c.fn === n.init);
  const okInit = inits.find(succeeded);
  const finishes = s.calls.filter((c) => c.fn === n.fin);
  const okFinish = finishes.find(succeeded);
  const out: RuleResult[] = [];

  // ---- 001 API found and initialized ----
  {
    const lookedForOther = s.lookups.find((l) => l.name === n.other);
    if (okInit) out.push({ rule: '001', outcome: 'passed', detail: `The course found the ${n.api} object and called ${n.init}.`, issues: [] });
    else if (s.calls.length === 0 && lookedForOther) {
      out.push({
        rule: '001',
        outcome: 'failed',
        detail: `The course looked for ${n.other} but this package is ${v}.`,
        issues: [{ title: `Course looks for the wrong SCORM API (${n.other}) in a ${v} package`, observed: `The course searched for ${n.other}, which belongs to ${s.version === '1.2' ? 'SCORM 2004' : 'SCORM 1.2'}, and never called ${n.init} on ${n.api}. The manifest declares ${v}.`, expected: `A ${v} course looks for ${n.api} and calls ${n.init}("").`, remediation: `Publish the course for ${v} (or change the manifest) so the course and the manifest agree.`, targetKey: 'wrong-api' }],
      });
    } else if (s.calls.length === 0) {
      out.push({
        rule: '001',
        outcome: 'needs_review',
        detail: `The course never contacted the ${n.api} object. It may not track anything, it may not have finished loading, or it may be looking for the API in a way the harness does not support.`,
        issues: [{ title: `Course never called ${n.init}`, observed: `During the session the course made no ${v} API calls and did not look for the other version's API.`, expected: `A tracked ${v} course calls ${n.init}("") when it starts.`, remediation: 'If the course should report progress, check how it was published (tracking enabled, correct SCORM version) and that it finds the LMS API.', targetKey: 'no-init' }],
      });
    } else out.push({ rule: '001', outcome: 'failed', detail: `${n.init} was called but never succeeded.`, issues: [{ title: `${n.init} never succeeded`, observed: `The course called ${n.init} ${inits.length} time(s); the harness returned error ${inits[0]?.error ?? '?'}.`, expected: `${n.init}("") succeeds once at the start.`, remediation: `Call ${n.init} with an empty string, once, before any other call.`, targetKey: 'init-failed' }] });
  }

  const contacted = s.calls.length > 0;

  // ---- 002 lifecycle order ----
  {
    const issues: Issue[] = [];
    const before = s.calls.filter((c) => isData(c) && c.state === 'not_initialized');
    if (before.length) issues.push({ title: `Course calls ${before[0]!.fn} before ${n.init}`, observed: `${before.length} call(s) were made before ${n.init} succeeded, starting with ${before[0]!.fn}(${before[0]!.args[0] ?? ''}) (error ${before[0]!.error}).`, expected: `${n.init} is the first call.`, remediation: `Wait for ${n.init} to succeed before reading or writing data.`, targetKey: 'call-before-init' });
    const after = s.calls.filter((c) => (isData(c) || c.fn === n.fin) && c.state === 'terminated');
    if (after.length) issues.push({ title: `Course calls ${after[0]!.fn} after ${n.fin}`, observed: `${after.length} call(s) were made after the session ended, starting with ${after[0]!.fn} (error ${after[0]!.error}). Anything set then is not saved.`, expected: `No data calls after ${n.fin}.`, remediation: `Call ${n.fin} last, and only once.`, targetKey: 'call-after-finish' });
    const dupInit = inits.filter((c) => !succeeded(c) && c.state !== 'not_initialized');
    if (dupInit.length) issues.push({ title: `Course calls ${n.init} more than once`, observed: `${n.init} was called again after it had succeeded (error ${dupInit[0]!.error}).`, expected: `${n.init} is called once.`, remediation: 'Make sure only one part of the course initializes the session.', targetKey: 'double-init' });
    const dupFin = finishes.filter((c) => !succeeded(c));
    if (dupFin.length) issues.push({ title: `Course calls ${n.fin} when the session is not running`, observed: `${dupFin.length} ${n.fin} call(s) failed (error ${dupFin[0]!.error}), for example because it had already ended.`, expected: `${n.fin} is called once, while the session is running.`, remediation: `Guard ${n.fin} so it runs once.`, targetKey: 'bad-finish' });
    out.push(!contacted ? { rule: '002', outcome: 'not_applicable', detail: 'The course made no API calls.', issues: [] } : issues.length ? { rule: '002', outcome: 'failed', detail: issues.map((i) => i.title).join('; '), issues } : { rule: '002', outcome: 'passed', detail: `Calls followed the order ${n.init}, data calls, ${n.fin}.`, issues: [] });
  }

  // ---- 003 finish before leaving ----
  {
    const beforeLeave = finishes.find((c) => succeeded(c) && c.seq <= s.callsBeforeLeave);
    if (!okInit) out.push({ rule: '003', outcome: 'not_applicable', detail: `The session was never initialized, so there was nothing to ${n.fin}.`, issues: [] });
    else if (beforeLeave) out.push({ rule: '003', outcome: 'passed', detail: `${n.fin} was called before the page was left.`, issues: [] });
    else if (okFinish) out.push({ rule: '003', outcome: 'needs_review', detail: `${n.fin} was only called while the page was closing.`, issues: [{ title: `Course only calls ${n.fin} while the page is closing`, observed: `${n.fin} ran during page unload, not before. Some LMSes end the session before unload code runs, so progress can be lost.`, expected: `${n.fin} is called by the course's own exit step, before the window closes.`, remediation: 'Call the finish function from the course Exit/Close step, not only from an unload handler.', targetKey: 'finish-on-unload' }] });
    else out.push({ rule: '003', outcome: 'failed', detail: `${n.fin} was never called.`, issues: [{ title: `Course never calls ${n.fin}`, observed: `The session was initialized but ${n.fin} was not called, even when the page was left. An LMS would treat this as an abnormal exit and may discard data not already committed.`, expected: `${n.fin}("") is called when the learner leaves.`, remediation: `Call ${n.fin} when the learner exits, after setting final values.`, targetKey: 'no-finish' }] });
  }

  // ---- 004 values are saved ----
  {
    const persistNames: readonly string[] = PERSIST[s.version];
    const writes = s.calls.filter((c) => c.fn === n.set && succeeded(c) && persistNames.includes(c.args[0] ?? ''));
    const lastPersistSeq = Math.max(0, ...s.calls.filter((c) => (c.fn === n.commit || c.fn === n.fin) && succeeded(c)).map((c) => c.seq));
    const unsaved = writes.filter((c) => c.seq > lastPersistSeq);
    if (!writes.length) out.push({ rule: '004', outcome: 'not_applicable', detail: 'The course set no values that an LMS stores between sessions.', issues: [] });
    else if (!unsaved.length) out.push({ rule: '004', outcome: 'passed', detail: 'Every stored value was set before a commit or finish.', issues: [] });
    else {
      const names = [...new Set(unsaved.map((c) => c.args[0]))];
      out.push({ rule: '004', outcome: 'failed', detail: `${names.join(', ')} set after the last commit and never finished.`, issues: [{ title: 'Course sets values it never commits or finishes', observed: `${names.join(', ')} ${names.length > 1 ? 'were' : 'was'} set after the last ${n.commit}/${n.fin}${lastPersistSeq === 0 ? ' (there was none)' : ''}, so an LMS would not have kept ${names.length > 1 ? 'them' : 'it'}.`, expected: `Values are saved with ${n.commit} or by ${n.fin}.`, remediation: `Call ${n.commit} after important changes, and ${n.fin} on exit.`, targetKey: 'unsaved-values' }] });
    }
  }

  // ---- 005 errors from the course's own calls ----
  {
    const bad = s.calls.filter((c) => isData(c) && c.state === 'running' && c.error !== 0 && !(s.version === '2004' && c.fn === n.get && c.error === 403));
    const notImplemented = bad.filter((c) => s.version === '2004' && c.error === 402);
    const real = bad.filter((c) => !notImplemented.includes(c));
    const groups = new Map<string, { call: HarnessCall; count: number }>();
    for (const c of real) {
      const key = `${c.fn}|${c.args[0]}|${c.error}`;
      const g = groups.get(key);
      if (g) g.count++;
      else groups.set(key, { call: c, count: 1 });
    }
    const issues: Issue[] = [...groups.values()].slice(0, 20).map(({ call, count }) => ({
      title: `${call.fn}("${(call.args[0] ?? '').slice(0, 60)}") fails with error ${call.error}`,
      observed: `${call.fn} on "${call.args[0]}" returned error ${call.error}${call.args[1] !== undefined ? ` for the value ${JSON.stringify(call.args[1])}` : ''}${count > 1 ? ` (${count} times)` : ''}.`,
      expected: 'Calls use elements and values the SCORM data model allows.',
      remediation: errorHelp(s.version, call.error),
      targetKey: `${call.fn}|${call.args[0]}|${call.error}`,
    }));
    if (notImplemented.length) {
      const els = [...new Set(notImplemented.map((c) => c.args[0]))];
      issues.push({ title: 'Course uses elements the test harness does not implement', observed: `The course used ${els.slice(0, 6).join(', ')}. These are standard elements, but this harness does not implement them, so their behaviour was not tested. This is a limit of the harness, not a course error.`, expected: 'Elements the harness does not cover are tested in the real LMS.', remediation: 'Test these elements in your LMS.', targetKey: `unimplemented|${els.join(',')}` });
    }
    out.push(!contacted ? { rule: '005', outcome: 'not_applicable', detail: 'The course made no API calls.', issues: [] } : real.length ? { rule: '005', outcome: 'failed', detail: `${real.length} API call(s) returned errors.`, issues } : notImplemented.length ? { rule: '005', outcome: 'needs_review', detail: 'Only calls to elements the harness does not implement failed.', issues } : { rule: '005', outcome: 'passed', detail: 'No API call returned an error.', issues: [] });
  }

  // ---- 006 status reporting ----
  if (s.kind === 'journey') {
    const c = s.committed;
    if (!contacted) out.push({ rule: '006', outcome: 'not_applicable', detail: 'The course made no API calls.', issues: [] });
    else if (s.version === '1.2') {
      const st = c['cmi.core.lesson_status'];
      if (!st || st === 'not attempted') out.push({ rule: '006', outcome: 'needs_review', detail: 'No lesson status was saved.', issues: [{ title: 'Course never saves a lesson status', observed: 'cmi.core.lesson_status was still "not attempted" after the session, so the LMS has no completion or result for this attempt.', expected: 'The course sets cmi.core.lesson_status (completed, incomplete, passed, failed, or browsed) and saves it.', remediation: 'Check the course reports completion and that the value is committed or finished.', targetKey: 'no-status' }] });
      else out.push({ rule: '006', outcome: 'passed', detail: `Saved lesson status: ${st}.`, issues: [] });
    } else {
      const comp = c['cmi.completion_status'] ?? 'unknown';
      const succ = c['cmi.success_status'] ?? 'unknown';
      if (comp === 'unknown' || comp === 'not attempted') {
        out.push({ rule: '006', outcome: 'needs_review', detail: succ !== 'unknown' ? 'A success status was saved but no completion status.' : 'Neither completion nor success was saved.', issues: [{ title: succ !== 'unknown' ? 'Course reports passed/failed but not completion' : 'Course never saves a completion status', observed: `cmi.completion_status was "${comp}" and cmi.success_status was "${succ}" after the session. In SCORM 2004 these are separate: one does not set the other.`, expected: 'The course sets cmi.completion_status, and cmi.success_status where it has a pass mark, and saves them.', remediation: 'Report completion explicitly, and success separately if the course is scored.', targetKey: 'no-completion' }] });
      } else out.push({ rule: '006', outcome: 'passed', detail: `Saved completion: ${comp}; success: ${succ}.`, issues: [] });
    }
  }

  return out;
}

function errorHelp(version: ScormVersion, code: number): string {
  if (version === '1.2') {
    if (code === 403) return 'Do not set elements the LMS owns (they are read-only); read them instead.';
    if (code === 404) return 'Do not read write-only elements (such as session_time or exit).';
    if (code === 405) return 'Use a value in the format or word list SCORM 1.2 defines for this element (for example HHHH:MM:SS for time, and passed/completed/failed/incomplete/browsed/not attempted for status).';
    if (code === 401) return 'This element does not exist in SCORM 1.2. A SCORM 2004 element used in a 1.2 course is the usual cause.';
    if (code === 201) return 'Check the element name and the argument.';
    return 'Check the element name, the value, and the call order.';
  }
  if (code === 404) return 'Do not set elements the LMS owns (they are read-only); read them instead.';
  if (code === 405) return 'Do not read write-only elements (such as session_time or exit).';
  if (code === 406) return 'Use the type or word list SCORM 2004 defines (for example ISO 8601 durations like PT5M10S, completed/incomplete for completion, passed/failed for success).';
  if (code === 407) return 'Keep the value inside the range SCORM 2004 defines (for example scaled scores from -1 to 1, progress from 0 to 1).';
  if (code === 401) return 'This element does not exist in SCORM 2004. A SCORM 1.2 element used in a 2004 course is the usual cause.';
  return 'Check the element name, the value, and the call order.';
}

/** Rule 007: bookmark and resume, from the first journey session and (if run) the reopened session. */
export function analyzeResume(version: ScormVersion, first: SessionResult | undefined, reopened: SessionResult | undefined, settings: Pick<ScormSettings, 'checkResume'>): RuleResult {
  const n = NAMES[version];
  const none = (detail: string, outcome: Outcome = 'not_applicable'): RuleResult => ({ rule: '007', outcome, detail, issues: [] });
  if (!first || first.calls.length === 0) return none('The course made no API calls, so there is no bookmark to test.');
  const setCall = (el: string) => first.calls.find((c) => c.fn === n.set && succeeded(c) && c.args[0] === el);
  const hasLoc = Boolean(first.cmi[n.loc]);
  const hasSuspend = Boolean(first.cmi['cmi.suspend_data']);
  if (!setCall(n.loc) && !setCall('cmi.suspend_data')) return none('The course stored no bookmark (location or suspend data) in this session. To test resume, use a journey that goes part-way through the course.');
  if (!hasLoc && !hasSuspend) return none('The bookmark values the course set were empty.');
  const exit = first.cmi[n.exit] ?? '';
  if (exit !== 'suspend') {
    return {
      rule: '007',
      outcome: 'needs_review',
      detail: `The course saved a bookmark but set ${n.exit} to "${exit || '(not set)'}", not "suspend".`,
      issues: [{ title: 'Course saves a bookmark but does not ask to be resumed', observed: `The course set ${hasLoc ? n.loc : ''}${hasLoc && hasSuspend ? ' and ' : ''}${hasSuspend ? 'cmi.suspend_data' : ''} but ${n.exit} was ${exit ? `"${exit}"` : 'never set'}. An LMS starts a new attempt unless the exit value is "suspend", so the bookmark is lost.`, expected: `${n.exit} is set to "suspend" when the learner leaves mid-course.`, remediation: 'Set the exit value to suspend when the learner leaves before finishing, and to normal (or leave unset) when they finish.', targetKey: 'bookmark-without-suspend' }],
    };
  }
  if (!settings.checkResume) return none('Resume was not tested for this scan.', 'not_tested');
  if (!reopened) return none('The reopen step did not run.', 'not_tested');
  const reads = reopened.calls.filter((c) => c.fn === n.get && (c.args[0] === n.loc || c.args[0] === 'cmi.suspend_data'));
  const entryRead = reopened.calls.some((c) => c.fn === n.get && c.args[0] === (version === '1.2' ? 'cmi.core.entry' : 'cmi.entry'));
  if (reads.length) return { rule: '007', outcome: 'passed', detail: `On reopening with the saved bookmark the course read ${[...new Set(reads.map((r) => r.args[0]))].join(' and ')}${entryRead ? ' and checked the entry mode' : ''}. Whether it returned to the right screen needs a person to check.`, issues: [] };
  return {
    rule: '007',
    outcome: 'needs_review',
    detail: 'On reopening, the course did not read the saved bookmark.',
    issues: [{ title: 'Course does not read its bookmark when reopened', observed: `The course was reopened with entry set to resume and its saved ${hasLoc ? n.loc : 'suspend data'} available, but it did not call ${n.get} for the bookmark${entryRead ? ' (it did check the entry mode)' : ' or check the entry mode'}.`, expected: 'A resumable course reads the saved location or suspend data when entry is resume.', remediation: 'Check the course restores learner position from the saved data.', targetKey: 'bookmark-not-read' }],
  };
}

/** Rule 008: recorded tracking against the person's expected settings, per journey. */
export function analyzeExpectation(s: SessionResult): RuleResult | undefined {
  const e = s.expect;
  if (!e) return undefined;
  const n = NAMES[s.version];
  if (s.stepFailure) return { rule: '008', outcome: 'not_tested', detail: `The journey "${s.name}" could not be carried out (${s.stepFailure}), so the recorded tracking was not compared with what was expected.`, issues: [] };
  if (s.calls.length === 0) return { rule: '008', outcome: 'failed', detail: 'The course recorded nothing.', issues: [{ title: `"${s.name}": nothing was recorded`, observed: 'The course made no SCORM API calls during this journey.', expected: 'The course records the expected tracking.', remediation: 'Check tracking is enabled and the course finds the API.', targetKey: `${s.name}|nothing` }] };
  const c = s.committed;
  const problems: string[] = [];
  const got = (k: string) => c[k] ?? '';
  if (s.version === '1.2' && e.status !== undefined && got('cmi.core.lesson_status') !== e.status) problems.push(`lesson status was "${got('cmi.core.lesson_status')}", expected "${e.status}"`);
  if (s.version === '2004') {
    if (e.completion !== undefined && (got('cmi.completion_status') || 'unknown') !== e.completion) problems.push(`completion status was "${got('cmi.completion_status') || 'unknown'}", expected "${e.completion}"`);
    if (e.success !== undefined && (got('cmi.success_status') || 'unknown') !== e.success) problems.push(`success status was "${got('cmi.success_status') || 'unknown'}", expected "${e.success}"`);
  }
  const raw = got(n.score);
  if (e.mustReportScore && raw === '') problems.push('no score was recorded');
  if (raw !== '') {
    if (e.scoreMin !== undefined && Number(raw) < e.scoreMin) problems.push(`score ${raw} is below the expected minimum ${e.scoreMin}`);
    if (e.scoreMax !== undefined && Number(raw) > e.scoreMax) problems.push(`score ${raw} is above the expected maximum ${e.scoreMax}`);
  } else if ((e.scoreMin !== undefined || e.scoreMax !== undefined) && !e.mustReportScore) problems.push('no score was recorded, so the expected score range could not be met');
  return problems.length
    ? { rule: '008', outcome: 'failed', detail: problems.join('; '), issues: [{ title: `"${s.name}": recorded tracking differs from what was expected`, observed: `After the journey "${s.name}", ${problems.join('; ')}.`, expected: 'The recorded values match the expected tracking settings you supplied.', remediation: 'Check the course logic for this path, or correct the expectation if it was wrong.', targetKey: `${s.name}|${problems.join('|')}` }] }
    : { rule: '008', outcome: 'passed', detail: `The journey "${s.name}" ended with the expected tracking.`, issues: [] };
}

/** One check result per rule per session, with the worst outcome across sessions kept for the finding list. */
export function toChecks(prefix: string, results: Array<{ session: string; result: RuleResult }>, base: { viewportName?: string }): NewCheck[] {
  return results.map(({ session, result }) =>
    check(`${prefix}-${result.rule}`, result.outcome === 'failed' ? 'failed' : result.outcome === 'needs_review' ? 'needs_review' : result.outcome, 0, [], {
      ...base,
      reason: result.outcome === 'not_tested' ? 'state_unreachable' : undefined,
      reasonDetail: result.outcome === 'passed' ? undefined : `${session}: ${result.detail}`.slice(0, 400),
    }),
  );
}
