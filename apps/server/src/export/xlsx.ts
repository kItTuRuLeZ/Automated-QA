import ExcelJS from 'exceljs';
import { ACCESSIBILITY_DISCLAIMER, ACTION_LABEL, type ConsolidatedIssue, MANUAL_REVIEW_CHECKLIST, type ProjectReport } from '@cqa/core';
import type { ReviewerStatus, Severity } from '@cqa/shared';

/**
 * Text that a spreadsheet could treat as a formula is stored with a leading
 * apostrophe so it is shown as text. Course content is untrusted.
 */
export function safeCell(value: unknown, max = 32_000): string {
  const s = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  const clipped = s.length > max ? `${s.slice(0, max - 1)}…` : s;
  return /^[=+\-@\t\r]/.test(clipped) ? `'${clipped}` : clipped;
}

const STATUS_LABEL: Record<ReviewerStatus, string> = {
  open: 'Open',
  assigned: 'Assigned',
  fixed: 'Fixed',
  retest: 'Retest',
  verified: 'Verified',
  accepted_risk: 'Accepted risk',
  false_positive: 'False positive',
  not_reproduced: 'Not reproduced',
  not_retested: 'Not retested',
};
const STATUS_CHOICES = ['Open', 'Assigned', 'Fixed', 'Retest', 'Verified', 'Accepted risk', 'False positive'];
const MANUAL_STATUS_CHOICES = ['Not started', 'In progress', 'Done', 'Not applicable'];

const PRIORITY_LABEL: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', informational: 'Info' };
const PRIORITY_FILL: Record<Severity, string> = { critical: 'FFF4B6B0', high: 'FFF9D5CF', medium: 'FFFFF0C2', low: 'FFDDE8FF', informational: 'FFEDEFF3' };

const REASON_PLAIN: Record<string, string> = {
  budget_states: 'Screen limit reached',
  budget_depth: 'Depth limit reached',
  budget_pages: 'Page limit reached',
  budget_runtime: 'Time limit reached',
  budget_bytes: 'Download limit reached',
  budget_redirects: 'Too many redirects',
  out_of_scope: 'Outside the scanned site',
  blocked_by_policy: 'Blocked for safety',
  unsafe_action: 'Control looked unsafe to click',
  ambiguous_action: 'Control not recognized',
  inaccessible_frame: 'Frame could not be inspected',
  unsupported_surface: 'Canvas or unsupported content',
  state_unreachable: 'Screen could not be reached again',
  engine_error: 'The check hit an error',
  timeout: 'Timed out',
  navigation_failed: 'Page did not load',
  cancelled: 'Scan was cancelled',
  worker_lost: 'Scan was interrupted',
  access_restricted: 'Needs sign-in',
  rate_limited: 'Rate limited',
  not_applicable_to_surface: 'Not available for this content',
  not_implemented: 'Not supported yet',
};

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12233F' } };

function styleHeader(row: ExcelJS.Row): void {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.eachCell((c) => {
    c.fill = HEADER_FILL;
    c.alignment = { vertical: 'middle', wrapText: true };
  });
  row.height = 22;
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

/** Builds the tracking workbook for one scan or a whole project. */
export async function buildWorkbook(report: ProjectReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Course QA Automation';
  wb.created = new Date();
  wb.title = `Course QA: ${report.project.name}`;

  addSummary(wb, report);
  addIssues(wb, report);
  addNotChecked(wb, report);
  addManualChecks(wb);
  addScreens(wb, report);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

function addSummary(wb: ExcelJS.Workbook, report: ProjectReport): void {
  const ws = wb.addWorksheet('Summary', { properties: { tabColor: { argb: 'FF1F4FBF' } } });
  ws.columns = [{ width: 52 }, { width: 22 }, { width: 34 }, { width: 14 }, { width: 12 }, { width: 16 }, { width: 14 }, { width: 12 }];
  ws.getCell('A1').value = safeCell(`Course QA report: ${report.project.name}`);
  ws.getCell('A1').font = { bold: true, size: 16 };
  ws.getCell('A2').value = `Generated ${report.generatedAt.slice(0, 16).replace('T', ' ')} UTC`;
  ws.getCell('A2').font = { color: { argb: 'FF566176' } };

  const header = ws.getRow(4);
  header.values = ['Course address', 'Last scanned', 'Scan result', 'Screens scanned', 'To fix', 'Check by hand', 'Not checked', 'Scans so far'];
  styleHeader(header);
  let r = 5;
  for (const c of report.courses) {
    const row = ws.getRow(r++);
    row.values = [
      safeCell(c.targetUrl),
      dateOnly(c.latest.run.finishedAt ?? c.latest.run.queuedAt),
      safeCell(c.latest.run.statusPlain),
      c.latest.coverage.screensScanned,
      c.latest.counts.fix,
      c.latest.counts.check,
      c.latest.counts.notChecked,
      c.scans,
    ];
    row.alignment = { vertical: 'top', wrapText: true };
  }

  r += 1;
  const lines: Array<[string, boolean]> = [
    ['How to use this workbook', true],
    ['• Issues sheet: one row per problem. Filter the Action column to "Fix" to see what needs changing.', false],
    ['• Update the Status, Owner, and Notes columns as work progresses. IDs (QA-xxxxxx) stay the same when the same problem is found in a later scan.', false],
    ['• "Not found (confirm fixed)" in the Latest scan column means the newest scan did not see the problem. That is not proof it was fixed: check it, then set Status to Verified.', false],
    ['• Check by hand: the scanner could not decide. A person needs to look.', false],
    ['• Not checked sheet: what the scanner could not inspect (frames, canvas, skipped controls, scan limits). These are not passes.', false],
    ['• Manual checks sheet: accessibility reviews that always need a person.', false],
    ['', false],
    ['Important', true],
    [ACCESSIBILITY_DISCLAIMER, false],
    ['A scan only covers the screens it reached. Anything it did not reach is unverified, not passed.', false],
  ];
  for (const [text, bold] of lines) {
    const cell = ws.getCell(`A${r}`);
    cell.value = text;
    cell.font = { bold };
    cell.alignment = { wrapText: true, vertical: 'top' };
    ws.mergeCells(`A${r}:H${r}`);
    if (text.length > 120) ws.getRow(r).height = 32;
    r++;
  }
}

function addIssues(wb: ExcelJS.Workbook, report: ProjectReport): void {
  const ws = wb.addWorksheet('Issues', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }], properties: { tabColor: { argb: 'FFB42318' } } });
  const cols: Array<[string, number]> = [
    ['ID', 11],
    ['Priority', 10],
    ['Action', 14],
    ['Course', 28],
    ['Screens', 10],
    ['Issue', 46],
    ['What to change', 52],
    ['Where', 36],
    ['How to see it', 52],
    ['Status', 15],
    ['Owner', 16],
    ['Notes', 30],
    ['First found', 12],
    ['Last seen', 12],
    ['Latest scan', 20],
    ['Rule', 18],
    ['Standard', 16],
    ['Technical details', 60],
  ];
  ws.columns = cols.map(([header, width]) => ({ header, width }));
  styleHeader(ws.getRow(1));

  report.issues.forEach((i: ConsolidatedIssue, idx) => {
    const row = ws.addRow([
      i.id,
      PRIORITY_LABEL[i.priority],
      ACTION_LABEL[i.action],
      safeCell(i.course),
      safeCell(i.screens.join(', ')),
      safeCell(i.issue),
      safeCell(i.change),
      safeCell([...i.elements, ...(i.moreElements ? [`(+${i.moreElements} more)`] : [])].join('\n')),
      safeCell(i.steps.map((s, n) => `${n + 1}. ${s}`).join('\n')),
      STATUS_LABEL[i.status],
      '',
      '',
      dateOnly(i.firstFound),
      dateOnly(i.lastSeen),
      i.inLatestScan ? 'Found' : 'Not found (confirm fixed)',
      i.technical.ruleId,
      safeCell(i.technical.standards.join(', ')),
      safeCell(`${i.technical.observed}\nConfidence: ${i.technical.confidence}. Type: ${i.technical.type.replace(/_/g, ' ')}.`),
    ]);
    row.alignment = { vertical: 'top', wrapText: true };
    row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PRIORITY_FILL[i.priority] } };
    row.getCell(1).font = { bold: true };
    void idx;
  });

  const last = Math.max(report.issues.length + 1, 2);
  // Dropdown for Status on every data row plus room for rows added by hand.
  for (let r = 2; r <= last + 100; r++) {
    ws.getCell(`J${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${STATUS_CHOICES.join(',')}"`], showErrorMessage: false };
  }
  ws.autoFilter = { from: 'A1', to: `R${last}` };
  ws.addConditionalFormatting({
    ref: `A2:R${last + 100}`,
    rules: [
      { type: 'expression', formulae: ['OR($J2="Verified",$J2="Fixed")'], style: { font: { color: { argb: 'FF1B7A3D' } } }, priority: 1 },
      { type: 'expression', formulae: ['OR($J2="Accepted risk",$J2="False positive")'], style: { font: { color: { argb: 'FF6B7280' } } }, priority: 2 },
    ],
  });
}

function addNotChecked(wb: ExcelJS.Workbook, report: ProjectReport): void {
  const ws = wb.addWorksheet('Not checked', { properties: { tabColor: { argb: 'FF8A5A00' } } });
  ws.columns = [{ width: 28 }, { width: 10 }, { width: 56 }, { width: 56 }];
  ws.getRow(1).values = ['Course', 'Screens', 'What was not checked', 'What to do'];
  styleHeader(ws.getRow(1));
  for (const i of report.issues.filter((x) => x.action === 'not_checked')) {
    const row = ws.addRow([safeCell(i.course), safeCell(i.screens.join(', ')), safeCell(i.issue + (i.elements.length ? `\n${i.elements.join('\n')}` : '')), safeCell(i.change)]);
    row.alignment = { vertical: 'top', wrapText: true };
  }
  let r = ws.rowCount + 2;
  ws.getCell(`A${r}`).value = 'Checks that did not run, by reason (latest scan of each course). These are never counted as passed.';
  ws.getCell(`A${r}`).font = { bold: true };
  r++;
  const h = ws.getRow(r++);
  h.values = ['Course', 'Count', 'Reason'];
  styleHeader(h);
  for (const c of report.courses) {
    if (c.latest.untested.length === 0) {
      ws.addRow([safeCell(c.targetUrl), 0, 'Everything the scan was set to check ran.']);
      continue;
    }
    for (const u of c.latest.untested) ws.addRow([safeCell(c.targetUrl), u.count, REASON_PLAIN[u.reason] ?? u.reason]);
  }
}

function addManualChecks(wb: ExcelJS.Workbook): void {
  const ws = wb.addWorksheet('Manual checks', { properties: { tabColor: { argb: 'FF566176' } } });
  ws.columns = [{ width: 10 }, { width: 34 }, { width: 70 }, { width: 50 }, { width: 14 }, { width: 16 }, { width: 30 }];
  ws.getRow(1).values = ['ID', 'Check', 'How to check', 'Why it needs a person', 'Status', 'Owner', 'Notes'];
  styleHeader(ws.getRow(1));
  MANUAL_REVIEW_CHECKLIST.forEach((m, i) => {
    const row = ws.addRow([m.id, m.title, m.howToCheck, m.whyManual, 'Not started', '', '']);
    row.alignment = { vertical: 'top', wrapText: true };
    ws.getCell(`E${i + 2}`).dataValidation = { type: 'list', allowBlank: false, formulae: [`"${MANUAL_STATUS_CHOICES.join(',')}"`] };
  });
}

function addScreens(wb: ExcelJS.Workbook, report: ProjectReport): void {
  const ws = wb.addWorksheet('Screens', { properties: { tabColor: { argb: 'FF1B7A3D' } } });
  ws.columns = [{ width: 28 }, { width: 8 }, { width: 38 }, { width: 56 }, { width: 50 }, { width: 14 }];
  ws.getRow(1).values = ['Course', 'Screen', 'Title', 'How the scanner got here', 'Address', 'Issues here'];
  styleHeader(ws.getRow(1));
  for (const c of report.courses) {
    for (const s of c.latest.screens) {
      const here = c.latest.issues.filter((i) => i.screens.includes(s.label)).length;
      const row = ws.addRow([safeCell(c.targetUrl), s.label, safeCell(s.title), safeCell(s.reachedBy), safeCell(s.url), here]);
      row.alignment = { vertical: 'top', wrapText: true };
    }
  }
}
