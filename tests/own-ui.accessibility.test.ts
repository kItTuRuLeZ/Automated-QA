import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CheckResultId, EvidenceId, FindingId, ProjectId } from '@cqa/shared';
import { buildScanConfig, newId, nowIso } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
import { type Harness, createHarness } from './support/harness.js';

vi.setConfig({ testTimeout: 400_000, hookTimeout: 400_000 });

const WEB_DIST = path.resolve(import.meta.dirname, '../apps/web/dist');

let h: Harness;
let app: ReturnType<typeof buildApp>;
let origin: string;
let projectId: ProjectId;
let runId: string;

beforeAll(async () => {
  if (!existsSync(path.join(WEB_DIST, 'index.html'))) execSync('npm run build -w @cqa/web', { cwd: path.resolve(import.meta.dirname, '..'), stdio: 'ignore' });

  // The app's own origin is exempted in test code only, so the scanner can reach loopback.
  const hosts: string[] = [];
  const origins: string[] = [];
  const bootstrap = createHarness();
  app = buildApp({ store: bootstrap.store, artifacts: bootstrap.artifacts, policy: bootstrap.policy, allowedHosts: hosts, allowedOrigins: origins, webDist: WEB_DIST });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  hosts.push(`127.0.0.1:${port}`);
  origins.push(`http://127.0.0.1:${port}`);
  origin = `http://127.0.0.1:${port}`;
  await bootstrap.close();

  h = createHarness({ exemptAddresses: [{ ip: '127.0.0.1', port }] });
  await app.close();
  app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: hosts, allowedOrigins: origins, webDist: WEB_DIST });
  await app.listen({ host: '127.0.0.1', port });

  // Seed a project and a finished run with a finding so every page renders with data.
  const p = h.store.createProject({ name: 'Own UI audit project', courseUrl: 'https://course.example.com/' });
  projectId = p.id;
  const run = h.store.createRun(buildScanConfig({ projectId, url: new URL('https://course.example.com/') }), 'https://course.example.com/');
  runId = run.id;
  const ev = { id: newId<EvidenceId>(), runId: run.id, kind: 'dom_snippet' as const, caption: 'Example evidence', data: { note: 'demo' }, capturedAt: nowIso(), redacted: true };
  h.store.insertEvidence(ev);
  h.store.insertCheckResult({ id: newId<CheckResultId>(), runId: run.id, ruleId: 'RUN-001', outcome: 'passed', durationMs: 10, evidenceIds: [], executedAt: nowIso() });
  h.store.upsertFinding({
    id: newId<FindingId>(),
    runId: run.id,
    ruleId: 'RUN-005',
    category: 'runtime',
    type: 'standards_warning',
    severity: 'low',
    confidence: 'high',
    title: 'Page has no title',
    location: { url: 'https://course.example.com/' as never },
    occurrences: [],
    observed: 'The document title is empty.',
    expected: 'Each page has a title.',
    evidenceIds: [ev.id],
    reproductionSteps: ['Open the page.'],
    remediation: 'Add a title.',
    standards: [],
    reviewer: { status: 'open', updatedAt: nowIso() },
    fingerprint: 'own-ui-demo',
    createdAt: nowIso(),
  });
  h.store.finishRun(run.id, { status: 'completed' });
  h.startWorker();
});

afterAll(async () => {
  await app?.close();
  await h?.close();
});

describe("the application's own interface", () => {
  it('has no automated WCAG violations, reflows at 320 px, shows focus, and has no keyboard trap on the pages it renders', async () => {
    const targets = [
      `${origin}/`,
      `${origin}/#/projects/${projectId}`,
      `${origin}/#/projects/${projectId}/new-scan`,
      `${origin}/#/runs/${runId}`,
      `${origin}/#/runs/${runId}/issues`,
      `${origin}/#/runs/${runId}/coverage`,
      `${origin}/#/runs/${runId}/technical`,
      `${origin}/#/help`,
    ];
    const problems: string[] = [];
    for (const url of targets) {
      const queued = h.queueScan(url, { accessibility: true, explore: false });
      const run = await h.waitForTerminal(queued.id, 300_000);
      expect(run.status, `${url}: ${run.statusDetail}`).toBe('completed');
      const checks = h.store.listCheckResults(run.id);
      expect(checks.some((c) => c.ruleId === 'A11Y-ENG' && c.outcome === 'passed'), `${url}: axe-core did not run`).toBe(true);
      for (const rule of ['A11Y-008', 'KBD-001']) {
        const outcomes = checks.filter((c) => c.ruleId === rule).map((c) => c.outcome);
        if (outcomes.some((o) => o !== 'passed')) problems.push(`${url} → ${rule}: ${outcomes.join(',')}`);
      }
      for (const f of h.store.listFindings(run.id)) {
        const serious = (f.ruleId.startsWith('A11Y-AXE-') && f.type === 'standards_warning') || f.ruleId === 'KBD-002' || f.ruleId === 'KBD-001';
        if (serious) problems.push(`${url} → ${f.ruleId} (${f.severity}): ${f.title} | ${f.occurrences[0]?.location.selector ?? ''}`);
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
