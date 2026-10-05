import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CheckResult, EvidenceId, Finding, ScanRun } from '@cqa/shared';
import { buildRunReport } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
import { buildHtmlReport } from '../apps/server/src/export/html.js';
import { createPackageServer } from '../apps/server/src/package-server.js';
import { type Harness, createHarness } from './support/harness.js';
import { makeZip, manifest12, manifest2004, page } from './support/packages.js';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

const HOST = '127.0.0.1:4317';
const hdr = { host: HOST, 'x-qa-request': '1' };
const json = { ...hdr, 'content-type': 'application/json' };
let h: Harness;
let app: ReturnType<typeof buildApp>;
let pkgServer: http.Server;
let projectId = '';

beforeAll(async () => {
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
  const pkgPort = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  h = createHarness({ resolver: async () => ['93.184.215.14'], exemptAddresses: [{ ip: '127.0.0.1', port: pkgPort }] });
  const dir = mkdtempSync(path.join(tmpdir(), 'cqa-scorm-'));
  pkgServer = createPackageServer({ root: dir, port: pkgPort });
  await new Promise<void>((r) => pkgServer.listen(pkgPort, '127.0.0.1', r));
  app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`], packages: { dir, port: pkgPort } });
  projectId = h.store.createProject({ name: 'SCORM' }).id;
  h.startWorker();
});
afterAll(async () => {
  await app?.close();
  await new Promise((r) => pkgServer?.close(r));
  await h?.close();
});

const FIND12 = 'function findAPI(w){var n=0;while(!w.API&&w.parent&&w.parent!==w&&n++<10){w=w.parent}return w.API}var api=findAPI(window);';
const BUTTONS = '<button id="next">Next</button><button id="finish">Finish</button><button id="fail">Fail</button>';
const course12 = (body: string) => page('Course 1.2', BUTTONS, `<script>${FIND12}${body}</script>`.replace('<script>', '<script defer>'));
// Scripts run before the buttons exist unless deferred; wiring waits for the document.
const wire = (js: string) => `document.addEventListener('DOMContentLoaded',function(){${js}});`;

const GOOD12 = course12(
  `api.LMSInitialize('');
   var entry=api.LMSGetValue('cmi.core.entry');
   if(entry==='resume'){api.LMSGetValue('cmi.core.lesson_location');api.LMSGetValue('cmi.suspend_data');}
   if(api.LMSGetValue('cmi.core.lesson_status')==='not attempted')api.LMSSetValue('cmi.core.lesson_status','incomplete');
   ${wire(`
   document.getElementById('next').onclick=function(){api.LMSSetValue('cmi.core.lesson_location','page-2');api.LMSSetValue('cmi.suspend_data','p2');api.LMSSetValue('cmi.core.exit','suspend');api.LMSCommit('');api.LMSFinish('')};
   document.getElementById('finish').onclick=function(){api.LMSSetValue('cmi.core.score.raw','90');api.LMSSetValue('cmi.core.lesson_status','passed');api.LMSSetValue('cmi.core.session_time','0000:00:30.00');api.LMSFinish('')};
   document.getElementById('fail').onclick=function(){api.LMSSetValue('cmi.core.score.raw','30');api.LMSSetValue('cmi.core.lesson_status','failed');api.LMSFinish('')};`)}`,
);

async function scorm(files: Record<string, string>, scormInput: object): Promise<{ run: ScanRun; checks: CheckResult[]; findings: Finding[] }> {
  const up = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/packages?filename=c.zip`, headers: { ...hdr, 'content-type': 'application/zip' }, payload: makeZip(files) });
  expect(up.statusCode).toBe(201);
  const pkg = up.json() as { id: string };
  const res = await app.inject({ method: 'POST', url: `/api/packages/${pkg.id}/scans`, headers: json, payload: { acknowledgeLocalExecution: true, explore: false, accessibility: false, layout: false, scorm: { observeSeconds: 1, ...scormInput } } });
  expect(res.statusCode, res.body).toBe(201);
  const run = await h.waitForTerminal((res.json() as { runs: ScanRun[] }).runs[0]!.id, 200_000);
  return { run, checks: h.store.listCheckResults(run.id), findings: h.store.listFindings(run.id) };
}
const outcomes = (checks: CheckResult[], rule: string) => checks.filter((c) => c.ruleId === rule).map((c) => c.outcome);
const titles = (f: Finding[], rule: string) => f.filter((x) => x.ruleId === rule).map((x) => x.title);

describe('SCORM 1.2 harness against a well-behaved course', () => {
  it('passes lifecycle, saving, errors, status, resume, and pass/fail expectations, with the call log as evidence', async () => {
    const { run, checks, findings } = await scorm(
      { 'imsmanifest.xml': manifest12(), 'index.html': GOOD12 },
      {
        journeys: [
          { name: 'Leave part-way', steps: [{ action: 'click', target: '#next' }] },
          { name: 'Pass journey', steps: [{ action: 'click', target: '#finish' }], expect: { status: 'passed', scoreMin: 80 } },
          { name: 'Fail journey', steps: [{ action: 'click', target: '#fail' }], expect: { status: 'failed', scoreMax: 50 } },
        ],
      },
    );
    expect(['completed', 'partial']).toContain(run.status);
    for (const rule of ['001', '002', '003', '004', '005', '006']) {
      const o = outcomes(checks, `SCO12-${rule}`);
      expect(o.length, rule).toBe(3);
      expect(o.every((x) => x === 'passed'), `${rule}: ${o.join(',')}`).toBe(true);
    }
    expect(outcomes(checks, 'SCO12-007')).toEqual(['passed']);
    expect(outcomes(checks, 'SCO12-008')).toEqual(['passed', 'passed']);
    expect(findings.filter((f) => f.ruleId.startsWith('SCO'))).toEqual([]);
    // Only the 1.2 rule set ran.
    expect(checks.some((c) => c.ruleId.startsWith('SCO04'))).toBe(false);

    const evidence = h.store.listEvidenceByKind(run.id, 'scorm_api_call');
    expect(evidence).toHaveLength(4); // three journeys and the reopened session
    const calls = (evidence[0]!.data as { calls: Array<{ fn: string }> }).calls;
    expect(calls.map((c) => c.fn)).toContain('LMSInitialize');
    expect(JSON.stringify(evidence.map((e) => e.data))).not.toMatch(/"p2"|Test Learner|cqa-test-learner/); // learner data and bookmark contents are redacted

    const report = buildRunReport(h.store, run.id);
    expect(report.scorm).toMatchObject({ version: '1.2', source: 'Test harness, not an LMS' });
    expect(report.scorm!.sessions.map((s) => s.name)).toEqual(['Leave part-way', 'Pass journey', 'Fail journey', 'Leave part-way, reopened']);
    expect(report.scorm!.sessions.find((s) => s.name === 'Pass journey')!.finalStatus).toContain('passed');
    expect(report.scorm!.limitations.join(' ')).toMatch(/do not show how any LMS will behave/);
    expect(report.scorm!.lmsChecklist.map((i) => i.id)).toContain('LMS-002');
    const html = buildHtmlReport(report, {});
    expect(html).toContain('test harness results');
    expect(html).toContain('Only your LMS can show');
  });
});

describe('SCORM 1.2 harness against faulty courses', () => {
  it('flags a course that looks for the SCORM 2004 API in a 1.2 package', async () => {
    const wrong = page('Wrong API', '', `<script>var w=window,n=0;while(!w.API_1484_11&&w.parent&&w.parent!==w&&n++<10){w=w.parent}if(w.API_1484_11){w.API_1484_11.Initialize('')}</script>`);
    const { checks, findings } = await scorm({ 'imsmanifest.xml': manifest12(), 'index.html': wrong }, {});
    expect(outcomes(checks, 'SCO12-001')).toEqual(['failed']);
    expect(titles(findings, 'SCO12-001')[0]).toMatch(/wrong SCORM API \(API_1484_11\)/);
    expect(outcomes(checks, 'SCO12-003')).toEqual(['not_applicable']);
  });

  it('flags a bookmark saved without asking to be resumed, and a bookmark never read on reopen', async () => {
    const noSuspend = course12(`api.LMSInitialize('');${wire(`document.getElementById('next').onclick=function(){api.LMSSetValue('cmi.core.lesson_location','p2');api.LMSCommit('');api.LMSFinish('')};`)}`);
    const a = await scorm({ 'imsmanifest.xml': manifest12(), 'index.html': noSuspend }, { journeys: [{ name: 'Go on', steps: [{ action: 'click', target: '#next' }] }] });
    expect(outcomes(a.checks, 'SCO12-007')).toEqual(['needs_review']);
    expect(titles(a.findings, 'SCO12-007')[0]).toMatch(/does not ask to be resumed/);

    const ignores = course12(`api.LMSInitialize('');${wire(`document.getElementById('next').onclick=function(){api.LMSSetValue('cmi.core.lesson_location','p2');api.LMSSetValue('cmi.core.exit','suspend');api.LMSCommit('');api.LMSFinish('')};`)}`);
    const b = await scorm({ 'imsmanifest.xml': manifest12(), 'index.html': ignores }, { journeys: [{ name: 'Go on', steps: [{ action: 'click', target: '#next' }] }] });
    expect(outcomes(b.checks, 'SCO12-007')).toEqual(['needs_review']);
    expect(titles(b.findings, 'SCO12-007')[0]).toMatch(/does not read its bookmark/);
    expect(h.store.listEvidenceByKind(b.run.id, 'scorm_api_call')).toHaveLength(2);
  });

  it('reports an expectation mismatch as a failure, and a journey that cannot be carried out as not tested', async () => {
    const { checks, findings } = await scorm(
      { 'imsmanifest.xml': manifest12(), 'index.html': GOOD12 },
      {
        journeys: [
          { name: 'Fail but expect pass', steps: [{ action: 'click', target: '#fail' }], expect: { status: 'passed', scoreMin: 80 } },
          { name: 'Broken journey', steps: [{ action: 'click', target: '#does-not-exist' }], expect: { status: 'passed' } },
        ],
      },
    );
    expect(outcomes(checks, 'SCO12-008')).toEqual(['failed', 'not_tested']);
    const f = findings.find((x) => x.ruleId === 'SCO12-008')!;
    expect(f.title).toMatch(/Fail but expect pass.*differs/);
    expect(f.observed).toMatch(/lesson status was "failed", expected "passed"/);
    expect(findings.filter((x) => x.ruleId === 'SCO12-008')).toHaveLength(1); // the broken journey produced no finding
    const nt = checks.find((c) => c.ruleId === 'SCO12-008' && c.outcome === 'not_tested')!;
    expect(nt.reasonDetail).toMatch(/could not be carried out/);
  });
});

describe('SCORM 2004 harness: calls made while the page closes', () => {
  it('keeps Commit and Terminate sent from pagehide (the way Storyline exits), so the course is not reported as never finishing', async () => {
    const closing = page(
      'Exits on pagehide',
      '',
      `<script>var api=window.API_1484_11;api.Initialize('');api.SetValue('cmi.completion_status','incomplete');api.SetValue('cmi.exit','suspend');
      window.addEventListener('pagehide',function(){api.SetValue('cmi.session_time','PT5S');api.SetValue('cmi.suspend_data','late');api.Commit('');api.Terminate('')});</script>`,
    );
    const { checks, findings, run } = await scorm({ 'imsmanifest.xml': manifest2004(), 'index.html': closing }, {});
    expect(outcomes(checks, 'SCO04-004')).toEqual(['passed']); // saved and committed
    expect(findings.some((f) => f.ruleId === 'SCO04-004')).toBe(false);
    expect(outcomes(checks, 'SCO04-003')).toEqual(['needs_review']); // terminates only on unload: low-severity note, not "never"
    expect(titles(findings, 'SCO04-003')[0]).toMatch(/only calls Terminate while the page is closing/);
    const calls = (h.store.listEvidenceByKind(run.id, 'scorm_api_call')[0]!.data as { calls: Array<{ fn: string }> }).calls.map((c) => c.fn);
    expect(calls).toEqual(expect.arrayContaining(['Commit', 'Terminate']));
  });
});

describe('SCORM 2004 harness', () => {
  it('uses the 2004 API and error codes, and flags range/format errors, a missing Terminate, unsaved values, and no completion', async () => {
    const bad = page(
      '2004 course',
      '',
      `<script>var api=window.API_1484_11;api.Initialize('');api.SetValue('cmi.success_status','passed');api.SetValue('cmi.score.scaled','1.5');api.SetValue('cmi.session_time','0000:01:00.00');</script>`,
    );
    const { checks, findings } = await scorm({ 'imsmanifest.xml': manifest2004(), 'index.html': bad }, {});
    expect(checks.some((c) => c.ruleId.startsWith('SCO12'))).toBe(false);
    expect(outcomes(checks, 'SCO04-001')).toEqual(['passed']);
    expect(outcomes(checks, 'SCO04-003')).toEqual(['failed']);
    expect(outcomes(checks, 'SCO04-004')).toEqual(['failed']);
    expect(outcomes(checks, 'SCO04-005')).toEqual(['failed']);
    expect(outcomes(checks, 'SCO04-006')).toEqual(['needs_review']);
    const errs = titles(findings, 'SCO04-005').join('\n');
    expect(errs).toMatch(/SetValue\("cmi\.score\.scaled"\) fails with error 407/);
    expect(errs).toMatch(/SetValue\("cmi\.session_time"\) fails with error 406/);
    expect(titles(findings, 'SCO04-003')[0]).toMatch(/never calls Terminate/);
  });

  it('keeps completion and success separate when judging a well-behaved 2004 course', async () => {
    const good = page(
      '2004 good',
      '',
      `<script>var api=window.API_1484_11;api.Initialize('');api.SetValue('cmi.completion_status','completed');api.SetValue('cmi.success_status','passed');api.SetValue('cmi.score.raw','88');api.SetValue('cmi.session_time','PT0H0M30S');api.SetValue('cmi.exit','normal');api.Commit('');api.Terminate('');</script>`,
    );
    const { checks } = await scorm({ 'imsmanifest.xml': manifest2004(), 'index.html': good }, { journeys: [{ name: 'Open', steps: [], expect: { completion: 'completed', success: 'passed', scoreMin: 80 } }] });
    for (const rule of ['001', '002', '003', '004', '005', '006']) expect(outcomes(checks, `SCO04-${rule}`), rule).toEqual(['passed']);
    expect(outcomes(checks, 'SCO04-008')).toEqual(['passed']);
  });
});

describe('what a SCORM scan will not do', () => {
  it('refuses a SCORM test for packages with no known SCORM version, and notes sequencing is not evaluated', async () => {
    const up = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/packages?filename=h.zip`, headers: { ...hdr, 'content-type': 'application/zip' }, payload: makeZip({ 'index.html': page('plain') }) });
    const pkg = up.json() as { id: string };
    const res = await app.inject({ method: 'POST', url: `/api/packages/${pkg.id}/scans`, headers: json, payload: { acknowledgeLocalExecution: true, launch: ['index.html'], scorm: { enabled: true } } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ ruleId: 'PKG-003' });

    const seq = manifest12().replace('</organization>', '<imsss:sequencing xmlns:imsss="http://www.imsglobal.org/xsd/imsss"/></organization>');
    const { findings } = await scorm({ 'imsmanifest.xml': seq, 'index.html': GOOD12 }, {});
    expect(titles(findings, 'SCO12-001')).toContain('Manifest has sequencing rules that this harness does not evaluate');
  });

  void ([] as EvidenceId[]);
});
