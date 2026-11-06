import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScanRun } from '@cqa/shared';
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
    // Synthetic: the shape of a Rise export (runtime-data, lib/rise, data-block-id), not a real Rise course.
    const course = { lessons: [{ id: 'les1', type: 'blocks', title: 'Welcome', items: [{ id: 'blkTop', type: 'text' }, { id: 'blkLow', type: 'text' }, { id: 'blkHidden', type: 'text' }] }] };
    const runtimeData = `__jsonp("runtime-data.js","${Buffer.from(JSON.stringify({ course })).toString('base64')}");`;
    const block = (id: string, text: string, style = '') => `<div class="block-wrapper" data-block-id="${id}" style="min-height:900px;${style}"><p>${text}</p></div>`;
    const run = await scanPackage({
      'imsmanifest.xml': manifest12({ launch: 'scormcontent/index.html' }),
      'scormcontent/index.html': page('Welcome', `<div data-lesson-id="les1">${block('blkTop', 'First block')}${block('blkLow', 'Second block, far down the page')}${block('blkHidden', 'Never shown', 'display:none')}</div>`, '<script src="lib/rise/app.js"></script>'),
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
