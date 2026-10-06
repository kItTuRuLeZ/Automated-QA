import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { type QaStore, type Store, csvCell, effectiveAutomation, isPrimaryUnit, screenStatus, summarizeCoverage } from '@cqa/core';
import { safeCell } from './xlsx.js';

/**
 * One normalized set of tables for a run's functional results. The workbook, the CSV files and the JSON all come from
 * these rows, so a number can never differ between formats or from the screen that shows it.
 */
export type Cell = string | number | boolean | null;
export interface Table {
  name: string;
  /** What each row is, in words. */
  description: string;
  columns: string[];
  rows: Cell[][];
}

export interface QaTables {
  schemaVersion: 1;
  generatedAt: string;
  tables: Table[];
}

const yes = (b: boolean) => (b ? 'Yes' : 'No');
const STATUS_WORDS: Record<string, string> = {
  not_tested: 'Not tested',
  in_progress: 'In progress',
  issues_found: 'Issues found',
  needs_manual_review: 'Needs manual review',
  passed_automated: 'Passed automated checks',
};
const BADGE_WORDS: Record<string, string> = {
  partially_checked: 'Partially checked',
  runtime_not_visited: 'Not visited by a browser',
  manual_checks_pending: 'Manual checks pending',
  static_only: 'Static checks only; functional behavior not tested',
  blocked_checks: 'Blocked checks',
  runner_errors: 'Runner errors',
  reviewer_decision: 'Reviewer decision recorded',
};

export function buildQaTables(store: Store, qa: QaStore, runId: string): QaTables | undefined {
  const run = store.getRun(runId);
  if (!run) return undefined;
  const progress = qa.getProgress(runId);
  const units = qa.listUnits(runId);
  const defs = new Map(qa.listDefinitions().map((d) => [d.id, d]));
  const execs = qa.currentExecutions(runId);
  const allExecs = qa.listExecutions(runId);
  const interactions = qa.listInteractions(runId);
  const dispositions = qa.listDispositions(runId);
  const findings = store.listFindings(runId);
  const unitTitle = new Map(units.map((u) => [u.id, u.title]));
  const noun = units.some((u) => u.kind === 'slide') ? { singular: 'slide', plural: 'slides' } : units.some((u) => u.kind === 'lesson') ? { singular: 'lesson', plural: 'lessons' } : { singular: 'screen', plural: 'screens' };
  const coverage = summarizeCoverage({ units, executions: execs, interactions, definitions: defs, unitNoun: noun });
  const stateToUnit = new Map<string, string>();
  for (const u of units) for (const s of u.visitedStateIds) stateToUnit.set(s, u.id);
  const statusOf = (u: (typeof units)[number]) => screenStatus(u, execs, dispositions);
  const pkg = run.config.target.kind === 'package' && run.config.target.packageId ? store.getPackage(run.config.target.packageId) : undefined;
  const libraryDigest = createHash('sha1').update([...defs.values()].map((d) => `${d.id}@${d.version}`).sort().join('|')).digest('hex').slice(0, 10);
  const ratioText = (r: ReturnType<typeof summarizeCoverage>['visit']) => (r.available ? `${r.numerator} of ${r.denominator} (${r.percent}%)` : `Not available: ${r.reason}`);

  const statusCounts = new Map<string, number>();
  const primary = units.filter((u) => isPrimaryUnit(u, units));
  for (const u of primary) statusCounts.set(statusOf(u).status, (statusCounts.get(statusOf(u).status) ?? 0) + 1);

  const summary: Table = {
    name: 'Summary',
    description: 'One row per fact. Each coverage number is shown with its denominator, never as an unexplained score.',
    columns: ['Item', 'Value'],
    rows: [
      ['Course / package', pkg?.name ?? run.config.target.packageName ?? run.config.target.url ?? ''],
      ['Package SHA-256', pkg?.sha256 ?? ''],
      ['Scan date', run.finishedAt ?? run.queuedAt],
      ['Scan result', run.status],
      ['Stage', progress?.stage ?? 'Not recorded (older scan)'],
      ['Profile', run.config.qaProfile ?? 'Not recorded'],
      ['Counting unit', `${noun.plural} (lessons and blocks for Rise, scenes and slides for Storyline, screens otherwise)`],
      ['Statement', coverage.statement],
      ['Inventory discovery', `${coverage.discovery.completeness}: ${coverage.discovery.reason}`],
      [`${noun.plural} visited`, ratioText(coverage.visit)],
      ['Automated checks executed', ratioText(coverage.execution)],
      ['Automated pass rate', ratioText(coverage.passRate)],
      ['Interactions exercised', `${coverage.interactions.exercised.available ? `${coverage.interactions.exercised.numerator} of ${coverage.interactions.exercised.denominator}` : 'Not available'} (${coverage.interactions.total} detected)`],
      ['Checks passed', coverage.counts.passed],
      ['Checks failed', coverage.counts.failed],
      ['Checks blocked', coverage.counts.blocked],
      ['Runner errors (not course defects)', coverage.counts.error],
      ['Checks skipped', coverage.counts.skipped],
      ['Manual checks outstanding', coverage.manual.outstanding],
      ...[...statusCounts].map(([k, v]) => [`${noun.plural} — ${STATUS_WORDS[k] ?? k}`, v] as Array<Cell>),
      ['Listed but not tracked one by one', `${coverage.listedNotTracked} (blocks, layers, scenes and package items)`],
      ['Test library version', libraryDigest],
      ['LMS behavior', run.config.engines.scorm ? 'Tested in the built-in SCORM test harness, not in a real LMS.' : 'Not tested. This scan did not use the SCORM test harness.'],
    ],
  };

  const coverageTable: Table = {
    name: 'Course Coverage',
    description: `One row per ${noun.singular} or listed unit, including passed ones, ones with issues, partly checked ones and ones never tested.`,
    columns: ['Unit', 'Kind', 'Parent', 'Counted for visits', 'Source', 'Confidence', 'Visited by a browser', 'Visit time', 'Not reached because', 'Automated status', 'Notes', 'Passed', 'Failed', 'Blocked', 'Error', 'Skipped', 'Manual review', 'Reviewer decision'],
    rows: units.map((u) => {
      const r = screenStatus(u, execs, dispositions);
      const counted = isPrimaryUnit(u, units);
      return [u.title, u.kind, u.parentId ? unitTitle.get(u.parentId) ?? '' : '', yes(counted), u.source, u.confidence, yes(Boolean(u.visitedAt)), u.visitedAt ?? '', u.visitedAt ? '' : u.notReachedReason ?? (counted ? 'No browser visit was recorded.' : 'Listed only; not tracked one by one.'), counted || execs.some((e) => e.unitId === u.id) ? STATUS_WORDS[r.status] : 'Not tracked', [...r.badges.map((b) => BADGE_WORDS[b] ?? b), ...r.reasons].join(' | '), r.counts.passed, r.counts.failed, r.counts.blocked, r.counts.error, r.counts.skipped, r.counts.manual, r.reviewerDecision ? `${r.reviewerDecision.decision} by ${r.reviewerDecision.actor}: ${r.reviewerDecision.reason}` : ''] as Cell[];
    }),
  };

  const findingsTable: Table = {
    name: 'Findings',
    description: 'Deduplicated findings. One row per finding; the occurrences column says how many places it was seen.',
    columns: ['ID', 'Rule', 'Severity', 'Type', 'Title', 'Unit', 'Status', 'Owner', 'Occurrences', 'Expected', 'Observed', 'Remediation'],
    rows: findings.map((f) => {
      const wf = store.getWorkflow(run.projectId, f.fingerprint);
      const stateId = f.occurrences[0]?.location.stateId ?? f.location.stateId;
      return [f.id, f.ruleId, f.severity, f.type, f.title, stateId ? unitTitle.get(stateToUnit.get(stateId as string) ?? '') ?? '' : '', f.reviewer.status, wf?.assignee ?? '', f.occurrences.length, f.expected, f.observed, f.remediation] as Cell[];
    }),
  };

  const testRows = (list: typeof allExecs) =>
    list.map((e) => {
      const d = defs.get(e.definitionId);
      return [e.definitionId, e.externalId ?? '', d?.title ?? '', d ? effectiveAutomation(d) : '', e.unitId ? unitTitle.get(e.unitId) ?? '' : 'Course-wide', e.instanceId ? interactions.find((i) => i.id === e.instanceId)?.label ?? e.instanceId : '', e.attempt, e.status, e.scope, e.reason ?? '', e.expected ?? '', e.expectedSource ?? '', e.actual ?? '', e.startedAt ?? '', e.finishedAt ?? '', e.evidenceIds.join(' '), `v${e.definitionVersion}`] as Cell[];
    });
  const testColumns = ['Case', 'Team ID', 'Title', 'Automation', 'Unit', 'Interaction', 'Attempt', 'Status', 'Scope', 'Reason', 'Expected', 'Expectation source', 'Actual', 'Started', 'Finished', 'Evidence', 'Case version'];
  const testResults: Table = {
    name: 'Test Results',
    description: 'Every attempt of every case. Earlier attempts are kept; the latest attempt on each interaction is the current result.',
    columns: testColumns,
    rows: testRows(allExecs),
  };

  const manual: Table = {
    name: 'Manual Review',
    description: 'Cases and results that need a person, with any decision already recorded. A decision never replaces the automated result.',
    columns: [...testColumns, 'Decision', 'Decided by', 'Decision reason', 'Decided at'],
    rows: execs
      .filter((e) => e.status === 'manual_review_required' || dispositions.some((d) => d.targetKind === 'execution' && d.targetId === e.id))
      .map((e) => {
        const d = [...dispositions].reverse().find((x) => x.targetKind === 'execution' && x.targetId === e.id);
        return [...testRows([e])[0]!, d?.decision ?? '', d?.actor ?? '', d?.reason ?? '', d?.createdAt ?? ''];
      }),
  };

  const logic: Table = {
    name: 'Interaction Logic',
    description: 'Behavior-rule and interaction results with the ordered action trace that supports each one.',
    columns: ['Case', 'Rule or interaction', 'Unit', 'Status', 'Reason', 'Actual', 'Ordered trace'],
    rows: allExecs
      .filter((e) => e.trace.some((t) => t.step === 'action') || e.definitionId.startsWith('LOG-'))
      .map((e) => [e.definitionId, e.instanceId?.startsWith('rule:') ? (qa.getRule(e.instanceId.slice(5))?.title ?? e.instanceId) : interactions.find((i) => i.id === e.instanceId)?.label ?? '', e.unitId ? unitTitle.get(e.unitId) ?? '' : '', e.status, e.reason ?? '', e.actual ?? '', e.trace.map((t, n) => `${n + 1}. [${t.step}] ${t.detail}`).join('\n')] as Cell[]),
  };

  const details: Table = {
    name: 'Run Details',
    description: 'How the scan was configured and what produced the results.',
    columns: ['Item', 'Value'],
    rows: [
      ['Run ID', run.id],
      ['Target', run.config.target.url ?? ''],
      ['Queued', run.queuedAt],
      ['Started', run.startedAt ?? ''],
      ['Finished', run.finishedAt ?? ''],
      ['Browser', run.browser ? `${run.browser.engine} ${run.browser.version}` : ''],
      ['Tools', run.toolVersions.map((t) => `${t.name} ${t.version}`).join(', ')],
      ['Engines enabled', Object.entries(run.config.engines).filter(([, v]) => v).map(([k]) => k).join(', ')],
      ['Screen sizes', run.config.viewports.map((v) => `${v.name} ${v.width}x${v.height}`).join(', ')],
      ['Limits', `${run.config.budgets.maxStates} screens or views, depth ${run.config.budgets.maxDepth}, ${run.config.budgets.maxRuntimeMs / 1000} s total, ${run.config.budgets.navigationTimeoutMs / 1000} s per page`],
      ['Content hash', [...new Set(execs.map((e) => e.contentHash).filter(Boolean))].join(', ')],
      ['Configuration hash', [...new Set(execs.map((e) => e.configHash).filter(Boolean))].join(', ')],
      ['Engine version', [...new Set(execs.map((e) => e.engineVersion).filter(Boolean))].join(', ')],
      ['Test library version', libraryDigest],
      ['Inventory revision', progress?.inventoryRevision ?? 0],
      ['Last event', progress?.lastSeq ?? 0],
    ],
  };

  return { schemaVersion: 1, generatedAt: new Date().toISOString(), tables: [summary, coverageTable, findingsTable, testResults, manual, logic, details] };
}

export async function qaWorkbook(t: QaTables): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Course QA';
  for (const table of t.tables) {
    const ws = wb.addWorksheet(table.name.slice(0, 31));
    ws.columns = table.columns.map((c, i) => ({ header: c, key: `c${i}`, width: Math.min(60, Math.max(14, c.length + 4)) }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const row of table.rows) ws.addRow(row.map((v) => (typeof v === 'number' || typeof v === 'boolean' ? v : safeCell(v ?? ''))));
    ws.eachRow((r) => (r.alignment = { vertical: 'top', wrapText: true }));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function tableCsv(table: Table): string {
  return [table.columns.map(csvCell).join(','), ...table.rows.map((r) => r.map((v) => csvCell(String(v ?? ''))).join(','))].join('\r\n') + '\r\n';
}
