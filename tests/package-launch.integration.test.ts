import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScanRun } from '@cqa/shared';
import { buildRunReport } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
import { createPackageServer } from '../apps/server/src/package-server.js';
import { type Harness, createHarness } from './support/harness.js';
import { makeZip, manifest12, page } from './support/packages.js';

// Synthetic packages built in this file. They imitate the shapes of real exports; they are not real Rise or Storyline courses.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const HOST = '127.0.0.1:4317';
const hdr = { host: HOST, 'x-qa-request': '1' };

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
  const packagesDir = mkdtempSync(path.join(tmpdir(), 'cqa-launch-'));
  pkgServer = createPackageServer({ root: packagesDir, port: pkgPort });
  await new Promise<void>((r) => pkgServer.listen(pkgPort, '127.0.0.1', r));
  app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`], packages: { dir: packagesDir, port: pkgPort } });
  projectId = h.store.createProject({ name: 'Launch' }).id;
  h.startWorker();
});
afterAll(async () => {
  await app?.close();
  await new Promise((r) => pkgServer?.close(r));
  await h?.close();
});

async function scanPackage(files: Record<string, string>, settings: object = { explore: false, accessibility: false, layout: false }): Promise<ScanRun> {
  const up = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/packages?filename=course.zip`, headers: { ...hdr, 'content-type': 'application/zip' }, payload: makeZip(files) });
  expect(up.statusCode).toBe(201);
  const res = await app.inject({ method: 'POST', url: `/api/packages/${up.json().id}/scans`, headers: { ...hdr, 'content-type': 'application/json' }, payload: { acknowledgeLocalExecution: true, ...settings } });
  expect(res.statusCode).toBe(201);
  return h.waitForTerminal((res.json() as { runs: ScanRun[] }).runs[0]!.id, 120_000);
}
const outcome = (run: ScanRun, ruleId: string) => h.store.listCheckResults(run.id).find((c) => c.ruleId === ruleId);

describe('launching packages', () => {
  it('opens a launch file in nested folders whose names have spaces and non-English letters', async () => {
    const launch = 'content/Lesson One/Café ü.html';
    const run = await scanPackage({
      'imsmanifest.xml': manifest12({ launch }),
      [launch]: page('Café lesson', '<img src="Bilder/Ölberg 1.png" alt="A hill">'),
      'content/Lesson One/Bilder/Ölberg 1.png': '\x89PNG\r\n\x1a\n',
    });
    expect(outcome(run, 'RUN-001')?.outcome).toBe('passed');
    expect(h.store.listStates(run.id)[0]?.title).toBe('Café lesson');
    // The image next to it, with a space and an umlaut in its name, was served (no failed request for it).
    expect(h.store.listFindings(run.id).filter((f) => f.ruleId === 'RUN-004')).toEqual([]);
  });

  it('looks inside a wrapper page that loads the course in a frame, and checks the course, not the wrapper', async () => {
    const run = await scanPackage({
      'imsmanifest.xml': manifest12({ launch: 'index_lms.html' }),
      'index_lms.html': '<!doctype html><html lang="en"><head><title>Course wrapper</title></head><body style="margin:0"><iframe src="scormcontent/index.html" title="Course" style="border:0;width:100vw;height:100vh"></iframe></body></html>',
      'scormcontent/index.html': page('Inner lesson', '<p>Lorem ipsum dolor sit amet. TBD: final wording.</p>'),
    });
    expect(outcome(run, 'RUN-001')?.outcome).toBe('passed');
    // The placeholder text only exists inside the frame, so finding it proves the frame was checked.
    expect(h.store.listFindings(run.id).some((f) => f.ruleId === 'TXT-001')).toBe(true);
  });

  it('a launch page that loads but shows nothing is reported, never passed', async () => {
    const run = await scanPackage({
      'imsmanifest.xml': manifest12({ launch: 'index.html' }),
      'index.html': '<!doctype html><html lang="en"><head><title>Course</title><script>/* the player failed to start */</script></head><body><div id="app"></div></body></html>',
    });
    const first = outcome(run, 'RUN-001');
    expect(first?.outcome).toBe('failed');
    expect(first?.reasonDetail).toMatch(/blank|nothing/i);
    expect(h.store.listFindings(run.id).some((f) => f.ruleId === 'RUN-001')).toBe(true);
  });

  it('recognises a Rise-style course while it runs, and records which blocks were scrolled into view', async () => {
    // Synthetic: the shape of a Rise export (runtime-data, lib/rise, data-block-id, a lesson that scrolls inside its own container, as real Rise does), not a real Rise course.
    const course = { lessons: [{ id: 'les1', type: 'blocks', title: 'Welcome', items: [{ id: 'blkTop', type: 'text' }, { id: 'blkLow', type: 'text' }, { id: 'blkHidden', type: 'text' }] }] };
    const runtimeData = `__jsonp("runtime-data.js","${Buffer.from(JSON.stringify({ course })).toString('base64')}");`;
    const block = (id: string, text: string, style = '') => `<div class="block-wrapper" data-block-id="${id}" style="min-height:900px;${style}"><p>${text}</p></div>`;
    const run = await scanPackage({
      'imsmanifest.xml': manifest12({ launch: 'scormcontent/index.html' }),
      'scormcontent/index.html': page('Welcome', `<style>html,body{height:100%;margin:0;overflow:hidden}</style><div data-lesson-id="les1" style="height:100vh;overflow-y:auto">${block('blkTop', 'First block')}${block('blkLow', 'Second block, far down the page')}${block('blkHidden', 'Never shown', 'display:none')}</div>`, '<script src="lib/rise/app.js"></script>'),
      'scormcontent/lib/rise/app.js': 'window.__riseLike = true;',
      'scormcontent/runtime-data.js': runtimeData,
    });
    expect(run.coverage?.platform).toBe('rise');
    const blocks = h.store.db.prepare("SELECT source_id, visited_at FROM inventory_units WHERE run_id = ? AND kind = 'block' ORDER BY sort_order").all(run.id) as Array<{ source_id: string; visited_at: string | null }>;
    expect(blocks.map((b) => [b.source_id, Boolean(b.visited_at)])).toEqual([
      ['blkTop', true],
      ['blkLow', true],
      ['blkHidden', false],
    ]);
  });

  it('walks a Rise-style lesson through its Continue buttons, leaves in-page controls to their recipes, and raises no false alarms', async () => {
    // Synthetic: real Rise markup for the Continue button, tabs, flashcard and quiz retry, but not a real Rise course.
    const course = { lessons: [{ id: 'les2', type: 'blocks', title: 'Walk', items: [{ id: 'blkA', type: 'text' }, { id: 'blkFlash', type: 'interactive' }, { id: 'blkB', type: 'text' }] }] };
    const runtimeData = `__jsonp("runtime-data.js","${Buffer.from(JSON.stringify({ course })).toString('base64')}");`;
    const body = `<div data-lesson-id="les2">
      <div data-block-id="blkA"><p>First part</p><button class="continue-btn" data-continue-btn type="button" id="more">Module 1: Next part</button></div>
      <div data-block-id="blkFlash" hidden>
        <ul><li class="flashcard"><div class="flashcard-side flashcard-side--front"><button class="flashcard-side-flip__btn" id="c1-front-flip-btn" type="button" aria-label="Click to flip Term"></button><p>Term</p></div>
        <div class="flashcard-side flashcard-side--back" inert hidden><button class="flashcard-side-flip__btn" id="c1-back-flip-btn" type="button" aria-label="Click to flip back"></button><p>Meaning</p></div></li></ul>
        <div class="quiz-card"><button type="button" id="again">TAKE AGAIN</button></div>
      </div>
      <div data-block-id="blkB" hidden><p>Second part</p><div id="late" style="opacity:0"><div role="tablist"><button role="tab" aria-selected="true" aria-controls="p1" id="t1">One</button><button role="tab" aria-selected="false" aria-controls="p2" id="t2" aria-label="Two">Two</button></div><div role="tabpanel" id="p1"><p>Panel one</p></div><div role="tabpanel" id="p2" hidden><p>Panel two</p></div></div></div>
    </div>
    <button type="button" data-testid="nav-toggle" aria-expanded="false" aria-controls="nav-list">Menu</button><ul id="nav-list" hidden><li>Item</li></ul>
    <script>
      document.querySelector('[data-testid="nav-toggle"]').addEventListener('click', (e) => { e.currentTarget.setAttribute('aria-expanded', 'true'); document.getElementById('nav-list').hidden = false; });
      for (const t of document.querySelectorAll('[role="tab"]')) t.addEventListener('click', () => { for (const x of document.querySelectorAll('[role="tab"]')) { x.setAttribute('aria-selected', String(x === t)); document.getElementById(x.getAttribute('aria-controls')).hidden = x !== t; } });
      // Rise gives tabs a new random id each time a lesson loads.
      for (const t of document.querySelectorAll('[role="tab"]')) t.id = 'tab-' + Math.random().toString(36).slice(2);
      // Rise fades blocks in a moment after they scroll into view.
      new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) setTimeout(() => { document.getElementById('late').style.opacity = '1'; }, 500); }).observe(document.getElementById('late'));
      document.getElementById('more').addEventListener('click', (e) => { e.target.hidden = true; document.querySelector('[data-block-id="blkFlash"]').hidden = false; document.querySelector('[data-block-id="blkB"]').hidden = false; });
      const c = document.querySelector('.flashcard'), [f, b] = c.querySelectorAll('.flashcard-side');
      const flip = (on) => { c.classList.toggle('flashcard--flipped', on); f.inert = on; f.hidden = on; b.inert = !on; b.hidden = !on; };
      f.querySelector('button').addEventListener('click', () => flip(true));
      b.querySelector('button').addEventListener('click', () => flip(false));
    </script>`;
    const run = await scanPackage(
      {
        'imsmanifest.xml': manifest12({ launch: 'scormcontent/index.html' }),
        'scormcontent/index.html': page('Walk', body, '<script src="lib/rise/app.js"></script>'),
        'scormcontent/lib/rise/app.js': 'window.__riseLike = true;',
        'scormcontent/runtime-data.js': runtimeData,
      },
      { explore: true, functional: true, qaProfile: 'functional', accessibility: false, layout: false },
    );
    expect(run.coverage?.platform).toBe('rise');
    // Everything behind the Continue button was reached.
    const seen = (h.store.db.prepare("SELECT source_id FROM inventory_units WHERE run_id = ? AND kind = 'block' AND visited_at IS NOT NULL").all(run.id) as Array<{ source_id: string }>).map((b) => b.source_id).sort();
    expect(seen).toEqual(['blkA', 'blkB', 'blkFlash']);
    // The walk followed Continue only; the card and the retry button were not clicked while walking.
    const walked = (h.store.db.prepare('SELECT data_json FROM traversal_actions WHERE run_id = ?').all(run.id) as Array<{ data_json: string }>).map((a) => JSON.parse(a.data_json) as { outcome: string; targetDescription: string }).filter((a) => a.outcome !== 'skipped');
    expect(walked.map((a) => a.targetDescription)).toEqual(['Next control "Module 1: Next part"']);
    // The recipe tested the card, after replaying Continue to reach it.
    const flips = (h.store.db.prepare("SELECT status FROM test_executions WHERE run_id = ? AND definition_id = 'FLP-01'").all(run.id) as Array<{ status: string }>).map((e) => e.status);
    expect(flips).toContain('passed');
    // A control that fades in after scrolling is still found, and tested.
    const tabs = (h.store.db.prepare("SELECT status FROM test_executions WHERE run_id = ? AND definition_id = 'TAB-01'").all(run.id) as Array<{ status: string }>).map((e) => e.status);
    expect(tabs).toContain('passed');
    // A control with a test id keeps a locator that survives the page rebuilding around it.
    const toggle = h.store.db.prepare("SELECT locator FROM interaction_instances WHERE run_id = ? AND label LIKE '%Menu%'").get(run.id) as { locator: string };
    expect(toggle.locator).toBe('[data-testid="nav-toggle"]');
    // The retry button is not a disclosure, so it cannot be "an expandable section that did not work".
    expect(h.store.listFindings(run.id).filter((f) => f.ruleId === 'NAV-001')).toEqual([]);
  });

  it('answers Rise knowledge checks with the answers stored in the course, so a Continue that waits for correct answers unlocks', async () => {
    // Synthetic: real Rise knowledge-check markup (quiz-card-option, quiz-submit-button, one Submit per question) with a
    // Continue button that stays hidden until every question is answered correctly, as "Requires a correct answer" does.
    const kc = (id: string, q: string, options: string[], input = 'radio') =>
      `<div data-block-family="knowledgeCheck" data-block-id="${id}"><div data-testid="quiz-card"><p>${q}</p><div role="radiogroup">${options.map((o) => `<div data-testid="quiz-card-option"><label><input type="${input}" name="${id}"><div data-testid="quiz-mc-option-text"><p>${o}</p></div></label></div>`).join('')}</div><button data-testid="quiz-submit-button" type="button">SUBMIT</button><div class="fb"></div></div></div>`;
    const html = (t: string) => `<div><p><span>${t}</span></p></div>`;
    const course = {
      lessons: [
        {
          id: 'kcl',
          type: 'blocks',
          title: 'Knowledge check',
          items: [
            { id: 'kc1', type: 'knowledgeCheck', settings: { requireCorrectAnswer: true }, items: [{ type: 'MULTIPLE_CHOICE', answers: [{ title: html('Internal Audit'), correct: false }, { title: html('The Business &amp; Leaders'), correct: true }] }] },
            { id: 'kc2', type: 'knowledgeCheck', settings: { requireCorrectAnswer: true }, items: [{ type: 'MULTIPLE_RESPONSE', answers: [{ title: html('Alpha'), correct: true }, { title: html('Beta'), correct: false }, { title: html('Gamma'), correct: true }] }] },
            { id: 'kc3', type: 'knowledgeCheck', items: [{ type: 'MATCHING', answers: [] }] },
            { id: 'cont', type: 'divider', family: 'continue' },
            { id: 'after', type: 'text' },
          ],
        },
      ],
    };
    const runtimeData = `__jsonp("runtime-data.js","${Buffer.from(JSON.stringify({ course })).toString('base64')}");`;
    const body = `<div data-lesson-id="kcl">
      ${kc('kc1', 'Who owns controls?', ['Internal Audit', 'The Business &amp; Leaders'])}
      ${kc('kc2', 'Pick two', ['Alpha', 'Beta', 'Gamma'], 'checkbox')}
      <div data-block-family="knowledgeCheck" data-block-id="kc3"><p>Match the pairs</p></div>
      <div data-block-id="cont"><button data-continue-btn data-testid="continue-btn" type="button" id="go" hidden>CONTINUE</button></div>
      <div data-block-id="after" hidden><p>After the knowledge check</p></div>
    </div>
    <script>
      const want = { kc1: ['The Business & Leaders'], kc2: ['Alpha', 'Gamma'] }, done = {};
      for (const [id, right] of Object.entries(want)) {
        const b = document.querySelector('[data-block-id="' + id + '"]');
        b.querySelector('[data-testid="quiz-submit-button"]').addEventListener('click', (e) => {
          const picked = [...b.querySelectorAll('input:checked')].map((i) => i.closest('label').textContent.trim());
          done[id] = picked.length === right.length && right.every((r) => picked.includes(r));
          b.querySelector('.fb').textContent = done[id] ? 'Correct' : 'Incorrect';
          if (done[id]) e.currentTarget.hidden = true;
          document.getElementById('go').hidden = !(done.kc1 && done.kc2);
        });
      }
      document.getElementById('go').addEventListener('click', (e) => { e.target.hidden = true; document.querySelector('[data-block-id="after"]').hidden = false; });
    </script>`;
    const files = {
      'imsmanifest.xml': manifest12({ launch: 'scormcontent/index.html' }),
      'scormcontent/index.html': page('Knowledge check', body, '<script src="lib/rise/app.js"></script>'),
      'scormcontent/lib/rise/app.js': 'window.__riseLike = true;',
      'scormcontent/runtime-data.js': runtimeData,
    };
    const settings = { explore: true, functional: true, qaProfile: 'functional', accessibility: false, layout: false };
    const reached = (run: ScanRun) => (h.store.db.prepare("SELECT source_id FROM inventory_units WHERE run_id = ? AND kind = 'block' AND visited_at IS NOT NULL").all(run.id) as Array<{ source_id: string }>).map((b) => b.source_id);

    const run = await scanPackage(files, { ...settings, autoAnswer: true });
    expect(run.coverage?.platform).toBe('rise');
    expect(reached(run)).toContain('after');
    // The answering is disclosed with the run (and so in the report), and a question type it cannot answer is reported.
    // The report lists the course's lessons in order, with whether each was reached.
    expect(buildRunReport(h.store, run.id).lessons).toEqual([{ n: 1, title: 'Knowledge check', visited: true }]);
    // The Simple view, the Technical coverage panel and the coverage export count the same units.
    const inv = (await app.inject({ method: 'GET', url: `/api/runs/${run.id}/inventory`, headers: hdr })).json() as { coverage: { visit: { numerator: number; denominator: number } }; unitNoun: { plural: string } };
    expect(inv.unitNoun.plural).toBe('lessons');
    expect([inv.coverage.visit.numerator, inv.coverage.visit.denominator]).toEqual([1, 1]);
    const csv = (await app.inject({ method: 'GET', url: `/api/runs/${run.id}/qa-export.csv?table=Course%20Coverage`, headers: hdr })).body;
    expect(csv).toMatch(/Knowledge check/);
    expect(run.coverage?.walkAids).toEqual([expect.stringMatching(/^Answered 2 Rise knowledge check\(s\) with the answers stored in the course.*not judged/)]);
    const notes = JSON.stringify([h.store.listCheckResults(run.id), h.store.listFindings(run.id)]);
    expect(notes).toMatch(/A matching knowledge check on .* was not answered automatically/);
    // Answering only helped the walk: no quiz verdict comes from it.
    expect(h.store.listFindings(run.id).filter((f) => /knowledge|quiz|answer/i.test(f.title))).toEqual([]);

    // Without automatic answers the walk stops at the knowledge check, as before.
    const off = await scanPackage(files, { ...settings, autoAnswer: false });
    expect(reached(off)).not.toContain('after');
    expect(off.coverage?.walkAids).toBeUndefined();
  });

  it('reaching an end screen does not mean everything was covered: an unexplored branch stays a gap', async () => {
    // Next leads straight to the end; a second path is behind a button the scanner has no rule for, so it never opens.
    const run = await scanPackage(
      {
        'imsmanifest.xml': manifest12({ launch: 'index.html' }),
        'index.html': page('Start', '<p>Choose a path.</p><a href="end.html">Next</a> <button onclick="location.href=\x27advanced.html\x27">Take the advanced path</button>'),
        'end.html': page('Congratulations', '<p>You have finished the course.</p>'),
        'advanced.html': page('Advanced path', '<p>Only reachable through the second path.</p>'),
      },
      { explore: true, accessibility: false, layout: false },
    );
    const titles = h.store.listStates(run.id).map((st) => st.title);
    expect(titles).toContain('Congratulations');
    expect(titles).not.toContain('Advanced path');
    const cov = (await app.inject({ method: 'GET', url: `/api/runs/${run.id}/coverage`, headers: { host: HOST } })).json().coverage;
    expect(cov.discovery.completeness).not.toBe('complete');
    // The control that leads to the unexplored branch is listed as not exercised, never silently dropped.
    expect(h.store.listFindings(run.id).some((f) => f.ruleId === 'COV-001' && /Take the advanced path/.test(f.observed))).toBe(true);
    expect(cov.statement).not.toMatch(/all (content|screens) (were )?tested/i);
  });

  it('a page that only shows a drawn canvas is not treated as blank', async () => {
    const run = await scanPackage({
      'imsmanifest.xml': manifest12({ launch: 'index.html' }),
      'index.html': '<!doctype html><html lang="en"><head><title>Canvas course</title></head><body><canvas id="c" width="320" height="200"></canvas><script>document.getElementById("c").getContext("2d").fillRect(10,10,100,100)</script></body></html>',
    });
    expect(outcome(run, 'RUN-001')?.outcome).toBe('passed');
  });
});

describe('course versions: a revised ZIP and retests (brief of 20 Nov, phase 2)', () => {
  const noTitle = '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><main><h1>Course</h1></main></body></html>';
  const upload = async (files: Record<string, string>, query = '') => {
    const up = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/packages?filename=course.zip${query}`, headers: { ...hdr, 'content-type': 'application/zip' }, payload: makeZip(files) });
    expect(up.statusCode).toBe(201);
    return up.json() as { id: string; courseKey: string; version: number; name: string };
  };
  const start = (pkgId: string, payload: object) => app.inject({ method: 'POST', url: `/api/packages/${pkgId}/scans`, headers: { ...hdr, 'content-type': 'application/json' }, payload: { acknowledgeLocalExecution: true, explore: false, accessibility: false, layout: false, ...payload } });
  const finish = async (res: Awaited<ReturnType<typeof start>>) => {
    expect(res.statusCode).toBe(201);
    return h.waitForTerminal((res.json() as { runs: ScanRun[] }).runs[0]!.id, 120_000);
  };
  const compare = async (before: ScanRun, after: ScanRun) => (await app.inject({ method: 'GET', url: `/api/runs/${after.id}/compare?with=${before.id}`, headers: hdr })).json() as { comparable: { sameCourse: boolean; differences: string[] }; findings: Array<{ status: string; ruleId: string; reason: string }> };
  const of = (c: Awaited<ReturnType<typeof compare>>, ruleId: string) => c.findings.find((f) => f.ruleId === ruleId);

  it('compares a broken v1 and its explicitly uploaded v2 as one course, and verifies only what v2 checked', async () => {
    const files = (index: string) => ({ 'imsmanifest.xml': manifest12({ launch: 'index.html' }), 'index.html': index });
    const v1 = await upload(files(noTitle));
    const run1 = await finish(await start(v1.id, {}));
    expect(h.store.listFindings(run1.id).some((f) => f.ruleId === 'RUN-005')).toBe(true);

    const v2 = await upload(files(page('Course')), `&revisionOf=${v1.id}`);
    expect(v2).toMatchObject({ courseKey: v1.courseKey, version: 2 });
    // Scanned as a revision: the lesson and settings are carried forward, and the scan is linked to the baseline.
    const run2 = await finish(await start(v2.id, { baselineRunId: run1.id, acknowledgeLocalExecution: true }));
    expect(run2.retestOfRunId).toBe(run1.id);
    expect(run2.config.engines.traversal).toBe(run1.config.engines.traversal);
    const c = await compare(run1, run2);
    expect(c.comparable.sameCourse).toBe(true);
    expect(of(c, 'RUN-005')?.status).toBe('resolved');

    // The earlier report keeps its own title, version, findings and evidence.
    const old = buildRunReport(h.store, run1.id);
    expect(old.package?.name).toBe(v1.name);
    expect(old.issues.some((i) => i.technical.ruleId === 'RUN-005')).toBe(true);
    expect(h.store.getPackage(v1.id)?.version).toBe(1);

    // An unrelated upload with the same title is never the same course, so nothing is verified against it.
    const other = await upload(files(page('Course')));
    const run3 = await finish(await start(other.id, {}));
    const unrelated = await compare(run1, run3);
    expect(unrelated.comparable.sameCourse).toBe(false);
    expect(of(unrelated, 'RUN-005')?.status).toBe('incomparable');
    // A baseline from another course is refused.
    expect((await start(other.id, { baselineRunId: run1.id })).statusCode).toBe(422);
  });

  it('records the package file checks again on a retest, links it to the earlier scan, and keeps the earlier scan unchanged', async () => {
    const pkg = await upload({ 'imsmanifest.xml': manifest12({ launch: 'index.html' }), 'index.html': page('Course'), 'Bad Name.png': 'x' });
    const first = await finish(await start(pkg.id, {}));
    const before = h.store.listCheckResults(first.id).length;
    const res = await app.inject({ method: 'POST', url: `/api/runs/${first.id}/retest`, headers: { ...hdr, 'content-type': 'application/json' }, payload: {} });
    expect(res.statusCode).toBe(201);
    const retest = await h.waitForTerminal((res.json() as ScanRun).id, 120_000);
    expect(retest.retestOfRunId).toBe(first.id);
    const statics = h.store.listCheckResults(retest.id).filter((r) => r.ruleId.startsWith('PKG-'));
    expect(statics.map((r) => r.ruleId)).toEqual(expect.arrayContaining(['PKG-001', 'PKG-011']));
    expect(h.store.listFindings(retest.id).some((f) => f.ruleId === 'PKG-011')).toBe(true);
    expect(h.store.listCheckResults(first.id)).toHaveLength(before);
  });

  it('never verifies a fix when the revised ZIP opens a different launch point', async () => {
    const v1 = await upload({ 'imsmanifest.xml': manifest12({ launch: 'index.html' }), 'index.html': noTitle });
    const run1 = await finish(await start(v1.id, {}));
    const v2 = await upload({ 'imsmanifest.xml': manifest12({ launch: 'start.html' }), 'start.html': page('Course') }, `&revisionOf=${v1.id}`);
    // The lesson scanned before is not in v2: the scan is not started silently on another one.
    const asked = await start(v2.id, { baselineRunId: run1.id });
    expect(asked.statusCode).toBe(409);
    expect(asked.json()).toMatchObject({ launchChanged: true });
    // Chosen explicitly, it runs, but the change of launch point keeps anything from being verified.
    const choice = (asked.json() as { choices: Array<{ key: string }> }).choices[0]!.key;
    const run2 = await finish(await start(v2.id, { baselineRunId: run1.id, launch: [choice] }));
    const c = await compare(run1, run2);
    expect(c.comparable.sameCourse).toBe(false);
    expect(c.comparable.differences.join(' ')).toMatch(/launch point/);
    expect(of(c, 'RUN-005')?.status).toBe('incomparable');
  });
});
