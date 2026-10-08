import type { FastifyInstance, FastifyReply } from 'fastify';
import ExcelJS from 'exceljs';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { BehaviorRule, ReviewDisposition, TestDefinition } from '@cqa/shared';
import { DISPOSITIONS, EXPECTATION_SOURCES, RULE_EVENTS, REVIEW_STATES } from '@cqa/shared';
import {
  CSV_COLUMNS,
  type ArtifactStore,
  type ImportRowResult,
  QaStore,
  type Store,
  TestDefinitionInput,
  commitImport,
  definitionsToCsv,
  effectiveAutomation,
  isOpaqueId,
  isPrimaryUnit,
  newId,
  buildZip,
  nowIso,
  parseCsv,
  previewImport,
  screenStatus,
  seedStarterLibrary,
  stepsText,
  suggestMapping,
  summarizeCoverage,
} from '@cqa/core';
import { buildQaTables, qaWorkbook, tableCsv } from './export/qa-tables.js';
import { safeCell } from './export/xlsx.js';

/**
 * Read and write access to the functional-QA layer: progress and events, the inventory with screen statuses,
 * executions, reviewer decisions, the test-case library with CSV/JSON/XLSX import and export, and behavior rules.
 * Everything returned is read from stored rows; nothing is computed from a timer.
 */
export interface QaRouteOptions {
  store: Store;
  artifacts: ArtifactStore;
  /** A worker that has not reported for this long, while a run is still active, is shown as unresponsive. */
  stallSeconds?: number;
}

const ACTIVE_STAGES = new Set(['validating', 'discovering', 'running', 'finalizing']);
const IMPORT_LIMIT = 4 * 1024 * 1024;

const actorOf = (v: unknown): string => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : 'Reviewer');

const RuleInput = z.object({
  title: z.string().trim().min(1).max(160),
  unitMatch: z.string().trim().max(200).default(''),
  requiredItems: z.array(z.object({ label: z.string().trim().min(1).max(200), locator: z.string().trim().max(300).optional() })).min(1).max(40),
  optionalItems: z.array(z.object({ label: z.string().trim().min(1).max(200), locator: z.string().trim().max(300).optional() })).max(40).default([]),
  prerequisites: z.array(z.string().trim().max(300)).max(20).default([]),
  expectedEvent: z.enum(RULE_EVENTS),
  eventTarget: z.string().trim().max(300).default(''),
  timingWindowMs: z.number().int().min(200).max(30_000).default(2000),
  orderPolicy: z.enum(['any_order', 'sequence']).default('any_order'),
  repeatPolicy: z.enum(['once', 'repeatable']).default('once'),
  resetPolicy: z.enum(['fresh_context', 'reload', 'none']).default('fresh_context'),
  destination: z.string().trim().max(300).optional(),
  expectationSource: z.enum(EXPECTATION_SOURCES).default('approved_case'),
  reviewState: z.enum(REVIEW_STATES).default('draft'),
});

export function registerQaRoutes(app: FastifyInstance, opts: QaRouteOptions): QaStore {
  const { store, artifacts } = opts;
  const qa = new QaStore(store.db);
  seedStarterLibrary(qa);
  const stallMs = (opts.stallSeconds ?? Number(process.env.CQA_STALL_SECONDS ?? 60)) * 1000;
  const notFound = (reply: FastifyReply, what: string) => reply.code(404).send({ error: what });
  const bad = (reply: FastifyReply, error: string, issues?: unknown) => reply.code(400).send({ error, issues });
  const runOf = (id: string) => (isOpaqueId(id) ? store.getRun(id) : undefined);

  // ---- progress ----

  app.get<{ Params: { id: string } }>('/api/runs/:id/progress', async (req, reply) => {
    const run = runOf(req.params.id);
    if (!run) return notFound(reply, 'Scan not found.');
    const progress = qa.getProgress(run.id);
    if (!progress) return { recorded: false, note: 'Progress was not recorded for this scan. It was made before step-by-step progress existed.', run: { status: run.status } };
    const last = progress.heartbeatAt ? Date.parse(progress.heartbeatAt) : undefined;
    const active = ACTIVE_STAGES.has(progress.stage) && (run.status === 'running' || run.status === 'queued');
    const silentMs = active && last ? Date.now() - last : 0;
    return { recorded: true, progress, run: { status: run.status, statusDetail: run.statusDetail }, stalled: active && silentMs > stallMs, silentSeconds: Math.round(silentMs / 1000), stallSeconds: stallMs / 1000, serverTime: nowIso() };
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>('/api/runs/:id/events', async (req, reply) => {
    const run = runOf(req.params.id);
    if (!run) return notFound(reply, 'Scan not found.');
    const after = Math.max(0, Number(req.query.after) || 0);
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 500));
    const events = qa.listEvents(run.id, after, limit);
    return { events, lastSeq: qa.getProgress(run.id)?.lastSeq ?? 0 };
  });

  // ---- inventory, screen statuses, coverage ----

  const coverageFor = (runId: string) => {
    const units = qa.listUnits(runId);
    const defs = new Map(qa.listDefinitions().map((d) => [d.id, d]));
    const coverage = summarizeCoverage({ units, executions: qa.currentExecutions(runId), interactions: qa.listInteractions(runId), definitions: defs, unitNoun: nounFor(units) });
    return { units, defs, coverage };
  };

  app.get<{ Params: { id: string } }>('/api/runs/:id/inventory', async (req, reply) => {
    const run = runOf(req.params.id);
    if (!run) return notFound(reply, 'Scan not found.');
    if (!qa.getProgress(run.id)) return { recorded: false, note: 'Coverage was not recorded in this older scan.' };
    const { units, coverage } = coverageFor(run.id);
    const executions = qa.currentExecutions(run.id);
    const dispositions = qa.listDispositions(run.id);
    const interactions = qa.listInteractions(run.id);
    const screens = units.map((u) => {
      const primary = isPrimaryUnit(u, units);
      const result = screenStatus(u, executions, dispositions, interactions);
      return { unit: u, primary, result: primary || executions.some((e) => e.unitId === u.id) ? result : undefined, interactions: interactions.filter((i) => i.unitId === u.id).length };
    });
    return { recorded: true, revision: qa.inventoryRevision(run.id), units: screens, coverage, unitNoun: nounFor(units) };
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/coverage', async (req, reply) => {
    const run = runOf(req.params.id);
    if (!run) return notFound(reply, 'Scan not found.');
    if (!qa.getProgress(run.id)) return { recorded: false, note: 'Coverage was not recorded in this older scan.' };
    return { recorded: true, coverage: coverageFor(run.id).coverage };
  });

  app.get<{ Params: { id: string }; Querystring: { unit?: string; history?: string } }>('/api/runs/:id/executions', async (req, reply) => {
    const run = runOf(req.params.id);
    if (!run) return notFound(reply, 'Scan not found.');
    const defs = new Map(qa.listDefinitions().map((d) => [d.id, d]));
    const list = req.query.history === '1' ? qa.listExecutions(run.id, req.query.unit) : qa.currentExecutions(run.id, req.query.unit);
    return {
      executions: list.map((e) => ({ ...e, definition: defs.get(e.definitionId) ? { id: e.definitionId, title: defs.get(e.definitionId)!.title, category: defs.get(e.definitionId)!.category, automation: effectiveAutomation(defs.get(e.definitionId)!), reviewState: defs.get(e.definitionId)!.reviewState } : undefined })),
      attemptsIncluded: req.query.history === '1',
    };
  });

  /** Everything a reviewer needs for one screen: its status and reasons, its checks, and the findings seen on it. */
  app.get<{ Params: { id: string; unitId: string } }>('/api/runs/:id/units/:unitId', async (req, reply) => {
    const run = runOf(req.params.id);
    if (!run) return notFound(reply, 'Scan not found.');
    const unit = qa.getUnit(run.id, req.params.unitId);
    if (!unit) return notFound(reply, 'Screen not found.');
    const executions = qa.currentExecutions(run.id);
    const dispositions = qa.listDispositions(run.id);
    const defs = new Map(qa.listDefinitions().map((d) => [d.id, d]));
    const states = new Set(unit.visitedStateIds);
    const findings = store
      .listFindings(run.id)
      .filter((f) => [f.location.stateId, ...f.occurrences.map((o) => o.location.stateId)].some((s) => s && states.has(s as string)))
      .map((f) => ({ id: f.id, ruleId: f.ruleId, severity: f.severity, type: f.type, title: f.title, observed: f.observed, expected: f.expected, remediation: f.remediation, status: f.reviewer.status }));
    const mine = executions.filter((e) => e.unitId === unit.id);
    return {
      unit,
      result: screenStatus(unit, executions, dispositions),
      interactions: qa.listInteractions(run.id, unit.id),
      findings,
      executions: mine.map((e) => ({ ...e, definition: defs.get(e.definitionId) ? { title: defs.get(e.definitionId)!.title, category: defs.get(e.definitionId)!.category, automation: effectiveAutomation(defs.get(e.definitionId)!) } : undefined, decisions: dispositions.filter((d) => d.targetKind === 'execution' && d.targetId === e.id) })),
      decisions: dispositions.filter((d) => d.targetKind === 'unit' && d.targetId === unit.id),
      attempts: qa.listExecutions(run.id, unit.id).length,
    };
  });

  /** Resolves evidence IDs on test results to their files, so a result can show its screenshots. */
  app.get<{ Params: { id: string }; Querystring: { ids?: string } }>('/api/runs/:id/evidence', async (req, reply) => {
    const run = runOf(req.params.id);
    if (!run) return notFound(reply, 'Scan not found.');
    const ids = (req.query.ids ?? '').split(',').map((s) => s.trim()).filter(isOpaqueId).slice(0, 40);
    return store.getEvidence(ids).filter((e) => e.runId === run.id).map((e) => ({ id: e.id, kind: e.kind, caption: e.caption, artifactId: e.artifactId, capturedAt: e.capturedAt }));
  });

  /** Course-wide results (no screen), such as link checks and the manual review queue. */
  app.get<{ Params: { id: string } }>('/api/runs/:id/course-wide', async (req, reply) => {
    const run = runOf(req.params.id);
    if (!run) return notFound(reply, 'Scan not found.');
    const defs = new Map(qa.listDefinitions().map((d) => [d.id, d]));
    const dispositions = qa.listDispositions(run.id);
    return qa
      .currentExecutions(run.id)
      .filter((e) => !e.unitId)
      .map((e) => ({ ...e, definition: defs.get(e.definitionId) ? { title: defs.get(e.definitionId)!.title, category: defs.get(e.definitionId)!.category, automation: effectiveAutomation(defs.get(e.definitionId)!) } : undefined, decisions: dispositions.filter((d) => d.targetKind === 'execution' && d.targetId === e.id) }));
  });

  /** Items the last finished scan of this project found, for the rule editor's picker. */
  app.get<{ Params: { id: string } }>('/api/projects/:id/discovered-items', async (req, reply) => {
    if (!isOpaqueId(req.params.id) || !store.getProject(req.params.id)) return notFound(reply, 'Project not found.');
    const last = store.listRuns(req.params.id).filter((r) => ['completed', 'partial'].includes(r.status) && qa.getProgress(r.id)).pop() ?? store.listRuns(req.params.id).filter((r) => qa.getProgress(r.id)).pop();
    if (!last) return { runId: undefined, units: [], items: [] };
    const units = qa.listUnits(last.id).filter((u) => u.visitedAt);
    const items = qa.listInteractions(last.id).filter((i) => i.type !== 'unknown_control' || i.label).map((i) => ({ id: i.id, unitId: i.unitId, unitTitle: units.find((u) => u.id === i.unitId)?.title ?? '', type: i.type, label: i.label.replace(/^[a-z ]+ "(.*)"$/i, '$1'), locator: i.locator, canBeActivated: i.capabilities.includes('activate') }));
    return { runId: last.id, units: units.map((u) => ({ id: u.id, title: u.title })), items };
  });

  // ---- exports built from one set of tables ----

  const fileName = (run: { queuedAt: string }, ext: string) => `course-qa-results-${run.queuedAt.slice(0, 10)}.${ext}`;
  app.get<{ Params: { id: string } }>('/api/runs/:id/qa-export.xlsx', async (req, reply) => {
    const run = runOf(req.params.id);
    if (!run) return notFound(reply, 'Scan not found.');
    const t = buildQaTables(store, qa, run.id)!;
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename="${fileName(run, 'xlsx')}"`).header('Cache-Control', 'no-store');
    return reply.send(await qaWorkbook(t));
  });
  app.get<{ Params: { id: string }; Querystring: { table?: string } }>('/api/runs/:id/qa-export.csv', async (req, reply) => {
    const run = runOf(req.params.id);
    if (!run) return notFound(reply, 'Scan not found.');
    const t = buildQaTables(store, qa, run.id)!;
    const table = t.tables.find((x) => x.name.toLowerCase() === (req.query.table ?? 'test results').toLowerCase());
    if (!table) return bad(reply, `Unknown table. Choose one of: ${t.tables.map((x) => x.name).join(', ')}.`);
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="course-qa-${table.name.toLowerCase().replace(/ /g, '-')}-${run.queuedAt.slice(0, 10)}.csv"`).header('Cache-Control', 'no-store');
    return reply.send(tableCsv(table));
  });
  app.get<{ Params: { id: string } }>('/api/runs/:id/qa-export.json', async (req, reply) => {
    const run = runOf(req.params.id);
    if (!run) return notFound(reply, 'Scan not found.');
    const t = buildQaTables(store, qa, run.id)!;
    reply.header('Content-Type', 'application/json; charset=utf-8').header('Content-Disposition', `attachment; filename="${fileName(run, 'json')}"`).header('Cache-Control', 'no-store');
    return reply.send(JSON.stringify({ ...t, run: { id: run.id, status: run.status }, executions: qa.listExecutions(run.id), units: qa.listUnits(run.id), interactions: qa.listInteractions(run.id), dispositions: qa.listDispositions(run.id), events: qa.listEvents(run.id, 0, 5000) }, null, 2));
  });

  /**
   * Evidence archive: the screenshots kept for this scan plus a manifest that ties each file to the result, screen and
   * attempt it belongs to, with relative paths and a checksum. A file the retention clean-up already removed is listed as missing.
   */
  app.get<{ Params: { id: string } }>('/api/runs/:id/evidence-archive.zip', async (req, reply) => {
    const run = runOf(req.params.id);
    if (!run) return notFound(reply, 'Scan not found.');
    const files: Record<string, Uint8Array | string> = {};
    const entries: Array<Record<string, unknown>> = [];
    const unitTitle = new Map(qa.listUnits(run.id).map((u) => [u.id, u.title]));
    const seen = new Set<string>();
    for (const e of qa.listExecutions(run.id)) {
      for (const ev of store.getEvidence(e.evidenceIds)) {
        const art = ev.artifactId ? store.getArtifact(ev.artifactId) : undefined;
        let status: 'included' | 'missing' | 'no-file' = 'no-file';
        let path: string | undefined;
        if (art) {
          path = `evidence/${art.id}.${art.mime === 'image/png' ? 'png' : 'bin'}`;
          try {
            if (!seen.has(art.id)) files[path] = new Uint8Array(readFileSync(artifacts.absolutePath(art)));
            seen.add(art.id);
            status = 'included';
          } catch {
            status = 'missing';
          }
        }
        entries.push({ evidenceId: ev.id, caption: ev.caption, kind: ev.kind, file: status === 'included' ? path : undefined, status, sha256: art?.sha256, capturedAt: ev.capturedAt, caseId: e.definitionId, attempt: e.attempt, executionId: e.id, screen: e.unitId ? unitTitle.get(e.unitId) : 'Course-wide' });
      }
    }
    files['manifest.json'] = JSON.stringify({ schemaVersion: 1, runId: run.id, generatedAt: nowIso(), note: 'Paths are relative to this archive. A file marked missing was removed (for example by the retention clean-up); the result that referenced it is unchanged.', files: entries }, null, 2);
    reply.header('Content-Type', 'application/zip').header('Content-Disposition', `attachment; filename="course-qa-evidence-${run.queuedAt.slice(0, 10)}.zip"`).header('Cache-Control', 'no-store');
    return reply.send(Buffer.from(buildZip(files)));
  });

  // ---- reviewer decisions ----

  const DispositionInput = z.object({
    targetKind: z.enum(['execution', 'finding', 'unit']),
    targetId: z.string().trim().min(1).max(100),
    decision: z.enum(DISPOSITIONS),
    actor: z.string().trim().max(60).optional(),
    reason: z.string().trim().min(3, 'Say why, in a few words').max(1000),
    note: z.string().trim().max(2000).optional(),
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/dispositions', async (req, reply) => {
    const run = runOf(req.params.id);
    return run ? qa.listDispositions(run.id) : notFound(reply, 'Scan not found.');
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/dispositions', async (req, reply) => {
    const run = runOf(req.params.id);
    if (!run) return notFound(reply, 'Scan not found.');
    const parsed = DispositionInput.safeParse(req.body);
    if (!parsed.success) return bad(reply, parsed.error.issues[0]?.message ?? 'Invalid decision.', parsed.error.issues);
    const d = parsed.data;
    // The decision is stored beside the automated result, which is recorded here so it can never be lost or rewritten.
    let original = 'unknown';
    if (d.targetKind === 'execution') {
      const e = qa.getExecution(d.targetId);
      if (!e || e.runId !== run.id) return notFound(reply, 'That test result is not part of this scan.');
      original = e.status;
    } else if (d.targetKind === 'finding') {
      const f = store.getFinding(d.targetId);
      if (!f || f.runId !== run.id) return notFound(reply, 'That finding is not part of this scan.');
      original = `finding:${f.reviewer.status}`;
    } else {
      const u = qa.getUnit(run.id, d.targetId);
      if (!u) return notFound(reply, 'That screen is not part of this scan.');
      original = screenStatus(u, qa.currentExecutions(run.id), qa.listDispositions(run.id)).status;
    }
    const saved = qa.addDisposition({ runId: run.id, targetKind: d.targetKind, targetId: d.targetId, decision: d.decision, actor: actorOf(d.actor), reason: d.reason, originalStatus: original, note: d.note } as Omit<ReviewDisposition, 'id' | 'createdAt'>);
    return reply.code(201).send(saved);
  });

  // ---- test library ----

  app.get('/api/test-library', async () => {
    const defs = qa.listDefinitions();
    return { definitions: defs.map((d) => ({ ...d, effectiveAutomation: effectiveAutomation(d) })), total: defs.length };
  });

  app.get('/api/test-library/export.csv', async (_req, reply) => {
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="course-qa-test-library.csv"').header('Cache-Control', 'no-store');
    return reply.send(definitionsToCsv(qa.listDefinitions()));
  });
  /** A starter sheet for team cases: the columns the importer understands, and one example row. */
  app.get('/api/test-library/template.csv', async (_req, reply) => {
    const head = CSV_COLUMNS.map((c) => `"${c}"`).join(',');
    const example = ['TC-0001', 'TC-0001', 'Every panel opens', 'Accordions', 'accordion', 'medium', '2', 'manual', 'draft', 'Rise | Storyline', 'The course is open at the screen', 'The screen has an accordion', 'Open panel 1 | Open panel 2 | Open panel 3', 'Each panel shows its text', 'approved_case', 'Screenshot', 'none', '15000', ''];
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="course-qa-test-case-template.csv"');
    return reply.send(`${head}
${example.map((c) => `"${c}"`).join(',')}
`);
  });
  app.get('/api/test-library/export.json', async (_req, reply) => {
    reply.header('Content-Type', 'application/json; charset=utf-8').header('Content-Disposition', 'attachment; filename="course-qa-test-library.json"').header('Cache-Control', 'no-store');
    return reply.send(JSON.stringify({ schemaVersion: 1, exportedAt: nowIso(), definitions: qa.listDefinitions() }, null, 2));
  });
  app.get('/api/test-library/export.xlsx', async (_req, reply) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Test cases');
    const defs = qa.listDefinitions();
    const csv = parseCsv(definitionsToCsv(defs));
    ws.columns = CSV_COLUMNS.map((c) => ({ header: c, key: c, width: c === 'title' || c === 'steps' || c === 'expected_result' ? 48 : 18 }));
    for (const row of csv.slice(1)) ws.addRow(row.map((v) => safeCell(v)));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', 'attachment; filename="course-qa-test-library.xlsx"').header('Cache-Control', 'no-store');
    return reply.send(Buffer.from(await wb.xlsx.writeBuffer()));
  });

  app.get<{ Params: { id: string } }>('/api/test-library/:id', async (req, reply) => {
    const d = qa.getDefinition(req.params.id);
    return d ? { definition: { ...d, effectiveAutomation: effectiveAutomation(d) }, history: qa.definitionHistory(d.id).map((h) => ({ version: h.version, at: h.at, actor: h.actor, note: h.note, title: h.snapshot.title, reviewState: h.snapshot.reviewState })), steps: stepsText(d) } : notFound(reply, 'Test case not found.');
  });

  const SaveInput = z.object({ definition: TestDefinitionInput, actor: z.string().trim().max(60).optional(), note: z.string().trim().max(500).optional() });
  const saveDefinition = (reply: FastifyReply, body: unknown, forceId?: string, creating = false) => {
    const parsed = SaveInput.safeParse(body);
    if (!parsed.success) return bad(reply, 'That test case has problems.', parsed.error.issues);
    const input = parsed.data.definition;
    if (forceId && input.id !== forceId) return bad(reply, 'The ID of a test case cannot be changed. Create a new case instead.');
    const existing = qa.getDefinition(input.id);
    if (creating && existing) return reply.code(409).send({ error: `A test case with the ID ${input.id} already exists.` });
    if (!creating && !existing) return notFound(reply, 'Test case not found.');
    const at = nowIso();
    const def: TestDefinition = { ...input, version: existing?.version ?? 1, origin: existing?.origin ?? 'user', createdAt: existing?.createdAt ?? at, updatedAt: at } as TestDefinition;
    // A person cannot make the scanner perform something it cannot: the stored class follows the capability.
    def.automation = effectiveAutomation(def);
    const saved = qa.saveDefinition(def, actorOf(parsed.data.actor), parsed.data.note || (creating ? 'Created' : 'Edited'));
    return reply.code(creating ? 201 : 200).send({ ...saved, effectiveAutomation: effectiveAutomation(saved) });
  };
  app.post('/api/test-library', async (req, reply) => saveDefinition(reply, req.body, undefined, true));
  app.put<{ Params: { id: string } }>('/api/test-library/:id', async (req, reply) => saveDefinition(reply, req.body, req.params.id));

  // ---- import: preview, then commit with an explicit duplicate choice ----

  const ImportInput = z.object({
    format: z.enum(['csv', 'json', 'xlsx']),
    /** CSV or JSON text, or base64 for XLSX. */
    content: z.string().min(1).max(IMPORT_LIMIT * 2),
    mapping: z.record(z.string(), z.string()).optional(),
    duplicates: z.enum(['skip', 'replace']).optional(),
    actor: z.string().trim().max(60).optional(),
  });

  async function sheetRows(format: 'csv' | 'xlsx', content: string): Promise<{ headers: string[]; rows: string[][] }> {
    let table: string[][];
    if (format === 'csv') table = parseCsv(content);
    else {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(content, 'base64') as never);
      const ws = wb.worksheets[0];
      if (!ws) throw new Error('The workbook has no sheets.');
      table = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        const vals = (row.values as unknown[]).slice(1).map((v) => (v === null || v === undefined ? '' : typeof v === 'object' ? String((v as { text?: string; result?: unknown }).text ?? (v as { result?: unknown }).result ?? '') : String(v)));
        table.push(vals);
      });
    }
    const [headers = [], ...rows] = table;
    return { headers: headers.map((h) => h.trim()), rows };
  }

  async function buildPreview(body: z.infer<typeof ImportInput>): Promise<{ headers: string[]; mapping: Record<string, string>; results: ImportRowResult[] }> {
    if (body.format === 'json') {
      const raw = JSON.parse(body.content) as unknown;
      const list = Array.isArray(raw) ? raw : (raw as { definitions?: unknown[] }).definitions;
      if (!Array.isArray(list)) throw new Error('The JSON file must be a list of test cases, or an object with a "definitions" list.');
      const at = nowIso();
      const results: ImportRowResult[] = list.slice(0, 2000).map((item, i): ImportRowResult => {
        const parsed = TestDefinitionInput.safeParse({ ...(item as object), reviewState: 'draft' });
        const id = String((item as { id?: unknown })?.id ?? '');
        if (!parsed.success) return { row: i + 1, id, status: 'invalid', problems: parsed.error.issues.map((x) => `${x.path.join('.') || 'case'}: ${x.message}`) };
        const def: TestDefinition = { ...parsed.data, version: 1, origin: 'import', createdAt: at, updatedAt: at } as TestDefinition;
        def.automation = effectiveAutomation(def);
        const dup = qa.getDefinition(def.id) ?? (def.externalId ? qa.getDefinitionByExternalId(def.externalId) : undefined);
        return dup ? { row: i + 1, externalId: def.externalId, id: def.id, status: 'duplicate', problems: [], definition: def, existing: { id: dup.id, version: dup.version, title: dup.title } } : { row: i + 1, externalId: def.externalId, id: def.id, status: 'new', problems: [], definition: def };
      });
      return { headers: [], mapping: {}, results };
    }
    const { headers, rows } = await sheetRows(body.format, body.content);
    if (headers.length === 0) throw new Error('The file has no header row.');
    const mapping = body.mapping && Object.keys(body.mapping).length ? body.mapping : suggestMapping(headers);
    for (const [col, header] of Object.entries(mapping)) if (!(CSV_COLUMNS as readonly string[]).includes(col) || !headers.includes(header)) throw new Error(`The mapping for "${col}" points at a column ("${header}") that is not in the file.`);
    const results = previewImport(headers, rows.slice(0, 2000), mapping, (id) => qa.getDefinition(id), (e) => qa.getDefinitionByExternalId(e));
    return { headers, mapping, results };
  }

  const importSummary = (results: ImportRowResult[]) => ({ rows: results.length, new: results.filter((r) => r.status === 'new').length, duplicates: results.filter((r) => r.status === 'duplicate').length, invalid: results.filter((r) => r.status === 'invalid').length });

  app.post('/api/test-library/import/preview', { bodyLimit: IMPORT_LIMIT * 2 }, async (req, reply) => {
    const parsed = ImportInput.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'The import request is not valid.', parsed.error.issues);
    try {
      const p = await buildPreview(parsed.data);
      return { headers: p.headers, mapping: p.mapping, columns: CSV_COLUMNS, summary: importSummary(p.results), rows: p.results.map((r) => ({ row: r.row, id: r.id, externalId: r.externalId, status: r.status, problems: r.problems, title: r.definition?.title, existing: r.existing })) };
    } catch (e) {
      return bad(reply, `That file could not be read: ${(e as Error).message}`);
    }
  });

  app.post('/api/test-library/import/commit', { bodyLimit: IMPORT_LIMIT * 2 }, async (req, reply) => {
    const parsed = ImportInput.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'The import request is not valid.', parsed.error.issues);
    if (!parsed.data.duplicates) return bad(reply, 'Choose what to do with cases that already exist: skip them or replace them.');
    try {
      const p = await buildPreview(parsed.data);
      const outcome = commitImport(qa, p.results, { duplicates: parsed.data.duplicates, actor: actorOf(parsed.data.actor) });
      return { ...outcome, summary: importSummary(p.results) };
    } catch (e) {
      return bad(reply, `That file could not be imported: ${(e as Error).message}`);
    }
  });

  // ---- behavior rules ----

  app.get<{ Params: { id: string } }>('/api/projects/:id/behavior-rules', async (req, reply) => (isOpaqueId(req.params.id) && store.getProject(req.params.id) ? qa.listRules(req.params.id) : notFound(reply, 'Project not found.')));

  app.post<{ Params: { id: string } }>('/api/projects/:id/behavior-rules', async (req, reply) => {
    if (!isOpaqueId(req.params.id) || !store.getProject(req.params.id)) return notFound(reply, 'Project not found.');
    const parsed = RuleInput.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'That rule has problems.', parsed.error.issues);
    const at = nowIso();
    const saved = qa.saveRule({ ...parsed.data, id: newId<string & { __brand: 'rule' }>(), projectId: req.params.id, createdAt: at, updatedAt: at } as BehaviorRule);
    return reply.code(201).send(saved);
  });

  app.put<{ Params: { id: string } }>('/api/behavior-rules/:id', async (req, reply) => {
    const prev = qa.getRule(req.params.id);
    if (!prev) return notFound(reply, 'Rule not found.');
    const parsed = RuleInput.safeParse(req.body);
    if (!parsed.success) return bad(reply, 'That rule has problems.', parsed.error.issues);
    return qa.saveRule({ ...parsed.data, id: prev.id, projectId: prev.projectId, createdAt: prev.createdAt, updatedAt: nowIso() } as BehaviorRule);
  });

  app.delete<{ Params: { id: string } }>('/api/behavior-rules/:id', async (req, reply) => (qa.deleteRule(req.params.id) ? reply.code(204).send() : notFound(reply, 'Rule not found.')));

  return qa;
}

/** Rise says lesson and block, Storyline says scene and slide. The report must say which unit it counts. */
function nounFor(units: ReadonlyArray<{ kind: string }>): { singular: string; plural: string } {
  if (units.some((u) => u.kind === 'slide')) return { singular: 'slide', plural: 'slides' };
  if (units.some((u) => u.kind === 'lesson')) return { singular: 'lesson', plural: 'lessons' };
  return { singular: 'screen', plural: 'screens' };
}
