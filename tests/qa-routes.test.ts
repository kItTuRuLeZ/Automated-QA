import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { ProjectId, TestExecution } from '@cqa/shared';
import { QaStore, buildScanConfig, definitionsToCsv, nowIso } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
import { type Harness, createHarness } from './support/harness.js';

const HOST = '127.0.0.1:4317';
const hdr = { host: HOST, 'x-qa-request': '1' };
const json = { ...hdr, 'content-type': 'application/json' };

let h: Harness;
let app: ReturnType<typeof buildApp>;
let qa: QaStore;
let projectId = '';
let runId = '';
let legacyRunId = '';

const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, headers: json, payload: payload as object });
const put = (url: string, payload: unknown) => app.inject({ method: 'PUT', url, headers: json, payload: payload as object });
const get = (url: string) => app.inject({ method: 'GET', url, headers: { host: HOST } });

beforeAll(() => {
  h = createHarness();
  app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`], webDist: undefined });
  qa = new QaStore(h.store.db);
  projectId = h.store.createProject({ name: 'QA routes' }).id;
  const mk = () => h.store.createRun(buildScanConfig({ projectId: projectId as ProjectId, url: new URL('https://course.example.com/') }), 'https://course.example.com/');
  runId = mk().id;
  legacyRunId = mk().id; // never touched by the recorder: stands in for a scan made before progress existed
  h.store.finishRun(legacyRunId, { status: 'completed' });

  qa.ensureProgress(runId, 'running');
  qa.addUnits(runId, [
    { id: 'u-a', kind: 'slide', title: 'Slide A', titleIsFallback: false, source: 'authoring_export', confidence: 'high', order: 0 },
    { id: 'u-b', kind: 'slide', title: 'Slide B', titleIsFallback: false, source: 'authoring_export', confidence: 'high', order: 1 },
    { id: 'u-c', kind: 'slide', title: 'Slide C', titleIsFallback: false, source: 'authoring_export', confidence: 'high', order: 2 },
  ]);
  qa.markVisited(runId, 'u-a', 's1');
  qa.markVisited(runId, 'u-b', 's2');
  const base = { runId, definitionVersion: 1, trace: [], evidenceIds: [], scope: 'functional' as const };
  qa.insertExecution({ ...base, definitionId: 'TAB-01', unitId: 'u-a', status: 'passed' });
  qa.insertExecution({ ...base, definitionId: 'ACC-01', unitId: 'u-b', status: 'failed', reason: 'The item did not open.' });
  qa.insertExecution({ ...base, definitionId: 'LAY-01', unitId: 'u-b', status: 'blocked', reason: 'Control not found.' });
  qa.recount(runId);
});
afterAll(async () => {
  await app?.close();
  await h?.close();
});

describe('progress and events', () => {
  it('says plainly when a scan has no recorded progress, instead of inventing any', async () => {
    const r = (await get(`/api/runs/${legacyRunId}/progress`)).json();
    expect(r.recorded).toBe(false);
    expect(r.note).toMatch(/made before step-by-step progress existed/);
    expect((await get(`/api/runs/${legacyRunId}/inventory`)).json()).toMatchObject({ recorded: false, note: 'Coverage was not recorded in this older scan.' });
    expect((await get(`/api/runs/${legacyRunId}/coverage`)).json().recorded).toBe(false);
  });

  it('returns the stored snapshot, and marks the worker unresponsive only when its heartbeat is old', async () => {
    qa.touchHeartbeat(runId);
    const fresh = (await get(`/api/runs/${runId}/progress`)).json();
    expect(fresh).toMatchObject({ recorded: true, stalled: false, progress: { stage: 'running', counters: { unitsDiscovered: 3, unitsVisited: 2, testsPassed: 1, testsFailed: 1, testsBlocked: 1 } } });
    h.store.db.prepare('UPDATE run_progress SET heartbeat_at = ? WHERE run_id = ?').run(new Date(Date.now() - 5 * 60_000).toISOString(), runId);
    h.store.db.prepare("UPDATE scan_runs SET status = 'running' WHERE id = ?").run(runId);
    const stale = (await get(`/api/runs/${runId}/progress`)).json();
    expect(stale.stalled).toBe(true);
    expect(stale.silentSeconds).toBeGreaterThanOrEqual(299);
    qa.touchHeartbeat(runId);
  });

  it('serves events after a sequence number so a reconnecting page converges without duplicates', async () => {
    qa.appendEvent(runId, 'note', { text: 'one' });
    qa.appendEvent(runId, 'note', { text: 'two' });
    const all = (await get(`/api/runs/${runId}/events`)).json();
    expect(all.events.map((e: { seq: number }) => e.seq)).toEqual(all.events.map((_: unknown, i: number) => i + 1));
    const tail = (await get(`/api/runs/${runId}/events?after=${all.lastSeq - 1}`)).json();
    expect(tail.events.map((e: { payload: { text: string } }) => e.payload.text)).toEqual(['two']);
    expect((await get(`/api/runs/${runId}/events?after=${all.lastSeq}`)).json().events).toEqual([]);
  });
});

describe('inventory and screen statuses', () => {
  it('reports a status per screen from the stored executions, and coverage with its denominators', async () => {
    const r = (await get(`/api/runs/${runId}/inventory`)).json();
    const status = (id: string) => r.units.find((u: { unit: { id: string } }) => u.unit.id === id).result;
    expect(status('u-a').status).toBe('passed_automated');
    expect(status('u-b').status).toBe('issues_found');
    expect(status('u-b').badges).toContain('blocked_checks');
    expect(status('u-c').status).toBe('not_tested'); // discovered, never visited, no checks: not a pass
    expect(status('u-c').badges).toContain('runtime_not_visited');
    expect(r.coverage.visit).toMatchObject({ available: true, numerator: 2, denominator: 3 });
    expect(r.coverage.statement).toMatch(/2 of 3 discovered slides visited/);
    expect(r.unitNoun).toEqual({ singular: 'slide', plural: 'slides' });
  });

  it('shows current results by default and every attempt on request, never overwriting an earlier attempt', async () => {
    const first = qa.listExecutions(runId, 'u-b').find((e) => e.definitionId === 'ACC-01')!;
    qa.insertExecution({ runId, definitionId: 'ACC-01', definitionVersion: 1, unitId: 'u-b', status: 'passed', trace: [], evidenceIds: [], scope: 'functional' });
    const current = (await get(`/api/runs/${runId}/executions?unit=u-b`)).json().executions as Array<TestExecution & { attempt: number }>;
    expect(current.filter((e) => e.definitionId === 'ACC-01')).toMatchObject([{ attempt: 2, status: 'passed' }]);
    const history = (await get(`/api/runs/${runId}/executions?unit=u-b&history=1`)).json().executions as TestExecution[];
    expect(history.filter((e) => e.definitionId === 'ACC-01').map((e) => [e.attempt, e.status])).toEqual([[1, 'failed'], [2, 'passed']]);
    expect(qa.getExecution(first.id)!.status).toBe('failed');
  });
});

describe('reviewer decisions', () => {
  it('records who decided, why, and the automated result at the time, and leaves the automated status alone', async () => {
    const exec = qa.listExecutions(runId, 'u-b').find((e) => e.definitionId === 'LAY-01')!;
    const missing = await post(`/api/runs/${runId}/dispositions`, { targetKind: 'execution', targetId: exec.id, decision: 'manual_pass', reason: '' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatch(/Say why/);
    const ok = await post(`/api/runs/${runId}/dispositions`, { targetKind: 'execution', targetId: exec.id, decision: 'manual_pass', reason: 'Opened it by hand; works', actor: 'Sam' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ actor: 'Sam', decision: 'manual_pass', originalStatus: 'blocked', reason: 'Opened it by hand; works' });
    expect(qa.getExecution(exec.id)!.status).toBe('blocked'); // the automated result is untouched
    const unit = await post(`/api/runs/${runId}/dispositions`, { targetKind: 'unit', targetId: 'u-b', decision: 'retest_requested', reason: 'Fixed in build 42' });
    expect(unit.json().originalStatus).toBe('needs_manual_review'); // by now the failed check has a passing second attempt, and one check is still blocked
    expect((await get(`/api/runs/${runId}/dispositions`)).json()).toHaveLength(2);
    expect((await post(`/api/runs/${runId}/dispositions`, { targetKind: 'execution', targetId: 'nope', decision: 'accepted', reason: 'because' })).statusCode).toBe(404);
  });
});

describe('test library API', () => {
  it('lists the starter library with the automation class the scanner can really deliver', async () => {
    const r = (await get('/api/test-library')).json();
    expect(r.total).toBeGreaterThanOrEqual(72);
    const log01 = r.definitions.find((d: { id: string }) => d.id === 'LOG-01');
    expect(log01).toMatchObject({ automation: 'automated', effectiveAutomation: 'automated', reviewState: 'starter' });
    expect(r.definitions.find((d: { id: string }) => d.id === 'DND-01').effectiveAutomation).toBe('manual');
  });

  it('edits a case with a new version and history, refuses to change its ID, and refuses a duplicate create', async () => {
    const cur = (await get('/api/test-library/TAB-02')).json();
    const def = { ...cur.definition, title: 'Visited tab indicators (team wording)', reviewState: 'reviewed' };
    delete def.effectiveAutomation;
    const saved = await put('/api/test-library/TAB-02', { definition: def, actor: 'Sam', note: 'Reworded' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().version).toBe(2);
    expect((await get('/api/test-library/TAB-02')).json().history.map((h: { version: number; actor: string }) => [h.version, h.actor])).toEqual([[2, 'Sam'], [1, 'system']]);
    expect((await put('/api/test-library/TAB-02', { definition: { ...def, id: 'TAB-99' } })).statusCode).toBe(400);
    expect((await post('/api/test-library', { definition: def })).statusCode).toBe(409);
    expect((await put('/api/test-library/NOPE-1', { definition: { ...def, id: 'NOPE-1' } })).statusCode).toBe(404);
  });

  it('will not let a person claim automation for a capability the scanner does not have', async () => {
    const cur = (await get('/api/test-library/TAB-02')).json().definition;
    delete cur.effectiveAutomation;
    const r = await post('/api/test-library', { definition: { ...cur, id: 'USER-1', automation: 'automated', body: { ...cur.body, requiredCapability: 'telepathy' } } });
    expect(r.statusCode).toBe(201);
    expect(r.json().automation).toBe('manual');
  });

  it('previews a team CSV with a confirmable mapping and row-level problems, then commits with an explicit duplicate choice', async () => {
    const csv = ['Case No,Case Name,Module,Steps,Expected,Priority,Type', 'TC-1,Panels open,Interactions,Open panel 1 | Open panel 2,Each shows text,1,accordion', 'TC-2,,Interactions,x,y,2,tab', 'TC-3,"=HYPERLINK(""http://evil"")",Interactions,step,exp,2,tab'].join('\r\n');
    const preview = (await post('/api/test-library/import/preview', { format: 'csv', content: csv, mapping: { id: 'Case No', title: 'Case Name', category: 'Module', steps: 'Steps', expected_result: 'Expected', priority: 'Priority', interaction_type: 'Type' } })).json();
    expect(preview.summary).toEqual({ rows: 3, new: 2, duplicates: 0, invalid: 1 });
    expect(preview.rows.find((r: { id: string }) => r.id === 'TC-2').problems.join(' ')).toMatch(/Title is missing/);
    const noChoice = await post('/api/test-library/import/commit', { format: 'csv', content: csv, mapping: preview.mapping });
    expect(noChoice.statusCode).toBe(400);
    const committed = (await post('/api/test-library/import/commit', { format: 'csv', content: csv, mapping: preview.mapping, duplicates: 'skip', actor: 'Sam' })).json();
    expect(committed).toMatchObject({ created: 2, invalid: 1 });
    const stored = (await get('/api/test-library/TC-1')).json().definition;
    expect(stored).toMatchObject({ externalId: 'TC-1', reviewState: 'draft', origin: 'import', title: 'Panels open' });
    // The imported formula is stored as text and neutralized when exported.
    const out = (await get('/api/test-library/export.csv')).body;
    expect(out).toContain(`"'=HYPERLINK(""http://evil"")"`);
    const again = (await post('/api/test-library/import/preview', { format: 'csv', content: csv, mapping: preview.mapping })).json();
    expect(again.summary.duplicates).toBe(2);
    expect((await post('/api/test-library/import/commit', { format: 'csv', content: csv, mapping: preview.mapping, duplicates: 'replace' })).json()).toMatchObject({ replaced: 2 });
    expect((await post('/api/test-library/import/preview', { format: 'csv', content: csv, mapping: { title: 'No such column' } })).statusCode).toBe(400);
  });

  it('imports structured JSON through the constrained schema and rejects anything else', async () => {
    const good = { id: 'J-1', title: 'JSON case', category: 'Imported', interactionType: 'tab', severity: 'low', priority: 3, automation: 'manual', reviewState: 'approved', body: { preconditions: [], applicability: '', actions: [{ kind: 'wait', ms: 100 }], assertions: [{ kind: 'manual_review', question: 'ok?' }], resetPolicy: 'none', timeoutMs: 5000, expectedResult: 'ok', expectationSource: 'approved_case', evidence: [], courseTypes: [], environments: [] } };
    const evil = { ...good, id: 'J-2', body: { ...good.body, actions: [{ kind: 'run_script', code: 'alert(1)' }] } };
    const preview = (await post('/api/test-library/import/preview', { format: 'json', content: JSON.stringify([good, evil]) })).json();
    expect(preview.rows.map((r: { status: string }) => r.status)).toEqual(['new', 'invalid']);
    await post('/api/test-library/import/commit', { format: 'json', content: JSON.stringify([good, evil]), duplicates: 'skip' });
    expect((await get('/api/test-library/J-1')).json().definition.reviewState).toBe('draft'); // imported cases always start as drafts, even if the file says approved
    expect((await get('/api/test-library/J-2')).statusCode).toBe(404);
  });

  it('exports XLSX that can be imported again', async () => {
    const res = await get('/api/test-library/export.xlsx');
    expect(res.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as never);
    expect(wb.worksheets[0]!.rowCount).toBeGreaterThan(70);
    const preview = (await post('/api/test-library/import/preview', { format: 'xlsx', content: res.rawPayload.toString('base64') })).json();
    expect(preview.summary.invalid).toBe(0);
    expect(preview.summary.duplicates).toBeGreaterThan(70);
  });

  it('export and the stored definitions agree', () => {
    const [header, ...rows] = definitionsToCsv(qa.listDefinitions()).trim().split('\r\n');
    expect(header).toContain('"id"');
    expect(rows.length).toBe(qa.listDefinitions().length);
  });
});

describe('behavior rules API', () => {
  const rule = { title: 'Next after all items', requiredItems: [{ label: 'Alpha' }, { label: 'Bravo' }], expectedEvent: 'next_enabled', eventTarget: 'Next' };

  it('validates, stores, edits and deletes rules in plain fields, with defaults for the timing and policies', async () => {
    const bad = await post(`/api/projects/${projectId}/behavior-rules`, { ...rule, requiredItems: [] });
    expect(bad.statusCode).toBe(400);
    expect((await post(`/api/projects/${projectId}/behavior-rules`, { ...rule, expectedEvent: 'run_script' })).statusCode).toBe(400);
    const made = await post(`/api/projects/${projectId}/behavior-rules`, rule);
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ timingWindowMs: 2000, orderPolicy: 'any_order', repeatPolicy: 'once', resetPolicy: 'fresh_context', reviewState: 'draft' });
    const id = made.json().id as string;
    expect((await put(`/api/behavior-rules/${id}`, { ...rule, timingWindowMs: 5000, orderPolicy: 'sequence' })).json()).toMatchObject({ timingWindowMs: 5000, orderPolicy: 'sequence' });
    expect(((await get(`/api/projects/${projectId}/behavior-rules`)).json() as unknown[]).length).toBe(1);
    expect((await app.inject({ method: 'DELETE', url: `/api/behavior-rules/${id}`, headers: hdr })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/behavior-rules/${id}`, headers: hdr })).statusCode).toBe(404);
    expect((await post('/api/projects/nope/behavior-rules', rule)).statusCode).toBe(404);
  });
});

void nowIso;
