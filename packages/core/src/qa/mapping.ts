import type { CheckResult, EngineSelection, ExecutionTraceStep, TestDefinition, TestExecution, TestStatus } from '@cqa/shared';

/**
 * Cases judged by checks the scan already runs. A mapped case never produces its own result: it reports what those
 * recorded checks found, per screen where the check is per screen and once for the course where it is course-wide.
 */

interface Mapping {
  caseId: string;
  /** Rule IDs, or a prefix match when the entry ends with "*". */
  rules: string[];
  /** The engine flag that must be on for the checks to run. */
  engine: keyof EngineSelection | 'always';
  engineLabel: string;
  /** Static means the checks read files only (package inspection). */
  scope?: 'static' | 'functional';
}

export const MAPPINGS: Mapping[] = [
  { caseId: 'NAV-01', rules: ['RUN-001'], engine: 'capture', engineLabel: 'opening page capture' },
  { caseId: 'ERR-01', rules: ['RUN-002', 'RUN-003'], engine: 'capture', engineLabel: 'runtime error capture' },
  { caseId: 'ERR-02', rules: ['RUN-004', 'MED-001', 'MED-002'], engine: 'capture', engineLabel: 'asset failure capture' },
  { caseId: 'A11Y-01', rules: ['KBD-001', 'KBD-004'], engine: 'keyboard', engineLabel: 'keyboard checks' },
  { caseId: 'A11Y-02', rules: ['KBD-002', 'KBD-003'], engine: 'keyboard', engineLabel: 'keyboard checks' },
  { caseId: 'A11Y-03', rules: ['A11Y-AXE-button-name', 'A11Y-AXE-link-name', 'A11Y-AXE-input-button-name', 'A11Y-AXE-select-name', 'A11Y-AXE-label', 'A11Y-AXE-aria-*', 'A11Y-AXE-role-*'], engine: 'accessibility', engineLabel: 'accessibility checks' },
  { caseId: 'VIS-01', rules: ['LAY-002', 'LAY-003', 'LAY-004'], engine: 'layout', engineLabel: 'layout checks' },
  { caseId: 'VIS-02', rules: ['LAY-001', 'A11Y-008'], engine: 'layout', engineLabel: 'layout checks' },
  { caseId: 'LNK-01', rules: ['LNK-001', 'LNK-002', 'LNK-003', 'LNK-005'], engine: 'links', engineLabel: 'link checks' },
  { caseId: 'MED-02', rules: ['MED-003'], engine: 'media', engineLabel: 'media checks' },
  { caseId: 'MED-03', rules: ['MED-002'], engine: 'media', engineLabel: 'media checks' },
  { caseId: 'LMS-01', rules: ['SCO12-001', 'SCO12-002', 'SCO04-001', 'SCO04-002'], engine: 'scorm', engineLabel: 'SCORM test harness' },
  { caseId: 'LMS-02', rules: ['SCO12-005', 'SCO12-006', 'SCO12-008', 'SCO04-005', 'SCO04-006', 'SCO04-008'], engine: 'scorm', engineLabel: 'SCORM test harness' },
  { caseId: 'LMS-03', rules: ['SCO12-003', 'SCO12-004', 'SCO04-003', 'SCO04-004'], engine: 'scorm', engineLabel: 'SCORM test harness' },
  { caseId: 'LMS-04', rules: ['SCO12-007', 'SCO04-007'], engine: 'scorm', engineLabel: 'SCORM test harness' },
  // Package checks read the uploaded files only. Results are labelled static and never stand in for behavior.
  { caseId: 'STAT-01', rules: ['PKG-001', 'PKG-002', 'PKG-003', 'PKG-004', 'PKG-005'], engine: 'always', engineLabel: 'package file checks', scope: 'static' },
  { caseId: 'STAT-02', rules: ['PKG-006'], engine: 'always', engineLabel: 'package file checks', scope: 'static' },
  { caseId: 'STAT-03', rules: ['PKG-007'], engine: 'always', engineLabel: 'package file checks', scope: 'static' },
];

const matches = (ruleId: string, patterns: string[]): boolean => patterns.some((p) => (p.endsWith('*') ? ruleId.startsWith(p.slice(0, -1)) : ruleId === p));

export interface DeriveInput {
  runId: string;
  checks: readonly CheckResult[];
  /** Which content unit each reached state belongs to. */
  unitOfState: ReadonlyMap<string, string>;
  engines: EngineSelection;
  /** The unit static (package file) results are recorded against: the lesson being scanned. */
  staticUnitId?: string;
  /** Quick check: only the cases that read package files are recorded. Nothing claims interaction behavior was looked at. */
  onlyStatic?: boolean;
  definitions: ReadonlyMap<string, TestDefinition>;
  engineVersion: string;
  contentHash?: string;
  configHash?: string;
  now: () => string;
}

/** The status a group of recorded check outcomes adds up to. A failure wins, then errors, then gaps, then reviews. */
export function statusFromChecks(checks: readonly CheckResult[]): { status: TestStatus; reason?: string; actual: string } {
  const by = (o: CheckResult['outcome']) => checks.filter((c) => c.outcome === o);
  const failed = by('failed');
  const error = by('error');
  const notTested = by('not_tested');
  const review = by('needs_review');
  const passed = by('passed');
  const na = by('not_applicable');
  const ids = (list: readonly CheckResult[]) => [...new Set(list.map((c) => c.ruleId))].join(', ');
  if (failed.length) return { status: 'failed', actual: `${failed.length} check${failed.length === 1 ? '' : 's'} failed (${ids(failed)}).` };
  if (error.length) return { status: 'error', reason: `The engine reported an error (${ids(error)}): ${error[0]!.reasonDetail ?? error[0]!.reason ?? 'no detail'}`, actual: 'No result: the check itself failed to run.' };
  if (notTested.length) return { status: 'blocked', reason: `Not tested (${ids(notTested)}): ${notTested[0]!.reasonDetail ?? notTested[0]!.reason ?? 'no reason recorded'}`, actual: 'No result: the check did not run.' };
  if (review.length) return { status: 'manual_review_required', reason: `The scanner could not decide (${ids(review)}). A person needs to look.`, actual: `${review.length} item${review.length === 1 ? '' : 's'} need review.` };
  if (passed.length) return { status: 'passed', actual: `${passed.length} check${passed.length === 1 ? '' : 's'} passed (${ids(passed)}).` };
  if (na.length) return { status: 'not_applicable', reason: na[0]!.reasonDetail ?? 'The check did not apply to this screen.', actual: 'Not applicable.' };
  return { status: 'blocked', reason: 'No check result was recorded.', actual: 'No result.' };
}

/** Builds one execution per screen (for per-screen checks) or one for the course (for course-wide checks) for each mapped case. */
export function deriveMappedExecutions(input: DeriveInput): Array<Omit<TestExecution, 'id' | 'attempt'>> {
  const out: Array<Omit<TestExecution, 'id' | 'attempt'>> = [];
  for (const m of MAPPINGS) {
    const def = input.definitions.get(m.caseId);
    if (!def) continue;
    if (input.onlyStatic && m.scope !== 'static') continue;
    const base = { runId: input.runId, definitionId: def.id, definitionVersion: def.version, externalId: def.externalId, expected: def.body.expectedResult, expectedSource: def.body.expectationSource, engineVersion: input.engineVersion, contentHash: input.contentHash, configHash: input.configHash, evidenceIds: [] as string[] };
    const scope = m.scope ?? 'functional';
    const enabled = m.engine === 'always' || Boolean(input.engines[m.engine]);
    if (!enabled) {
      out.push({ ...base, status: 'not_applicable', reason: `The ${m.engineLabel} were turned off for this scan.`, scope, trace: [], startedAt: input.now(), finishedAt: input.now() });
      continue;
    }
    const mine = input.checks.filter((c) => matches(c.ruleId, m.rules));
    if (mine.length === 0) {
      // The engine was on but produced nothing relevant. That is a gap, never a pass. Course types that never produce these results are not applicable.
      const notApplicable = m.engine === 'scorm' || scope === 'static';
      out.push({ ...base, status: notApplicable ? 'not_applicable' : 'blocked', reason: m.engine === 'scorm' ? 'This course was not scanned as a SCORM package, so the test harness did not run.' : scope === 'static' ? 'Package file checks only apply to an uploaded course package.' : `No ${m.engineLabel} result was recorded for this case.`, scope, trace: [], startedAt: input.now(), finishedAt: input.now() });
      continue;
    }
    const groups = new Map<string, CheckResult[]>();
    for (const c of mine) {
      const unit = c.stateId ? input.unitOfState.get(c.stateId) : scope === 'static' ? input.staticUnitId : undefined;
      const key = unit ?? '';
      groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    for (const [unitId, list] of groups) {
      const r = statusFromChecks(list);
      const trace: ExecutionTraceStep[] = [{ at: input.now(), step: 'observed', detail: `Used ${list.length} recorded check result${list.length === 1 ? '' : 's'} from the ${m.engineLabel}.`, data: { rules: [...new Set(list.map((c) => c.ruleId))] } }];
      out.push({
        ...base,
        unitId: unitId || undefined,
        status: r.status,
        reason: r.status === 'passed' ? undefined : r.reason ?? (r.status === 'failed' ? 'A recorded check failed.' : undefined),
        actual: r.actual,
        scope,
        trace,
        evidenceIds: [...new Set(list.flatMap((c) => c.evidenceIds as string[]))].slice(0, 20),
        startedAt: input.now(),
        finishedAt: input.now(),
      });
    }
  }
  return out;
}
