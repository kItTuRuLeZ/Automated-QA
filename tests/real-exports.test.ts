import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ScanRun } from '@cqa/shared';
import { buildApp } from '../apps/server/src/app.js';
import { createPackageServer } from '../apps/server/src/package-server.js';
import { type Harness, createHarness } from './support/harness.js';

vi.setConfig({ testTimeout: 600_000, hookTimeout: 240_000 });
const DIR = process.env.CQA_REAL_EXPORTS ?? '';
const HOST = '127.0.0.1:4317';
const hdr = { host: HOST, 'x-qa-request': '1' };
let h: Harness; let app: ReturnType<typeof buildApp>; let pkgServer: http.Server; let projectId = '';

describe.skipIf(!DIR || !existsSync(DIR))('real exports (debug)', () => {
  beforeAll(async () => {
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const pkgPort = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    h = createHarness({ resolver: async () => ['93.184.215.14'], exemptAddresses: [{ ip: '127.0.0.1', port: pkgPort }] });
    const dir = mkdtempSync(path.join(tmpdir(), 'cqa-real-'));
    pkgServer = createPackageServer({ root: dir, port: pkgPort });
    await new Promise<void>((r) => pkgServer.listen(pkgPort, '127.0.0.1', r));
    app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`], packages: { dir, port: pkgPort } });
    projectId = h.store.createProject({ name: 'Real' }).id;
    h.startWorker();
  });
  afterAll(async () => { await app?.close(); await new Promise((r) => pkgServer?.close(r)); await h?.close(); });

  for (const zip of (process.env.CQA_REAL_ZIPS ?? '').split(',').filter(Boolean)) {
    it(zip, async () => {
      const up = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/packages?filename=${encodeURIComponent(zip)}`, headers: { ...hdr, 'content-type': 'application/zip' }, payload: readFileSync(path.join(DIR, zip)) });
      expect(up.statusCode, up.body).toBe(201);
      const scanInput = JSON.parse(process.env.CQA_REAL_SCAN ?? '{}');
      const res = await app.inject({ method: 'POST', url: `/api/packages/${(up.json() as { id: string }).id}/scans`, headers: { ...hdr, 'content-type': 'application/json' }, payload: { acknowledgeLocalExecution: true, explore: false, accessibility: false, layout: false, scorm: { observeSeconds: 10 }, ...scanInput } });
      expect(res.statusCode, res.body).toBe(201);
      const run = await h.waitForTerminal((res.json() as { runs: ScanRun[] }).runs[0]!.id, 580_000);
      const out = {
        run: { status: run.status, coverage: (run as any).coverage },
        checks: h.store.listCheckResults(run.id).map((c) => `${c.ruleId} ${c.outcome} ${(c as any).detail ?? ''}`.slice(0, 300)),
        findings: h.store.listFindings(run.id).map((f) => `${f.ruleId} ${f.severity} ${f.title}`),
        scorm: h.store.listEvidenceByKind(run.id, 'scorm_api_call').map((e) => e.data),
      };
      writeFileSync(path.join(process.env.CQA_REAL_OUT ?? tmpdir(), `${zip}.json`), JSON.stringify(out, null, 1));
    });
  }
});
