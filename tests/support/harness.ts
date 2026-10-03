import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProjectId, ScanRun } from '@cqa/shared';
import { TERMINAL_RUN_STATUSES } from '@cqa/shared';
import { ArtifactStore, NetworkPolicy, type PolicyOptions, Store, buildScanConfig, createLogger, openDatabase, resolveDataPaths } from '@cqa/core';
import { type WorkerLoop, startWorker } from '@cqa/worker';

export interface Harness {
  dataDir: string;
  store: Store;
  artifacts: ArtifactStore;
  policy: NetworkPolicy;
  tmpRoot: string;
  worker?: WorkerLoop;
  startWorker(): WorkerLoop;
  queueScan(url: string, opts?: { navigationTimeoutMs?: number; maxRuntimeMs?: number; explore?: boolean; maxStates?: number; maxDepth?: number; allowedOrigins?: string[]; terminology?: Array<{ term: string; preferred?: string }>; textExclusions?: string[]; linkCheckTimeoutMs?: number }): ScanRun;
  waitForTerminal(runId: string, timeoutMs?: number): Promise<ScanRun>;
  close(): Promise<void>;
}

/**
 * Creates an isolated data directory and a policy whose only exemptions are
 * the given fixture-server ports. The exemption is constructed here, in test
 * code; production entry points construct `new NetworkPolicy()` with none.
 */
export function createHarness(policyOptions: PolicyOptions = {}): Harness {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'cqa-test-'));
  const paths = resolveDataPaths(dataDir);
  const store = new Store(openDatabase(paths.dbFile));
  const artifacts = new ArtifactStore(paths.artifacts, store);
  const policy = new NetworkPolicy(policyOptions);
  const log = createLogger('test');
  log.level = 'silent';
  let project: ProjectId | undefined;

  const h: Harness = {
    dataDir,
    store,
    artifacts,
    policy,
    tmpRoot: paths.tmp,
    startWorker() {
      h.worker = startWorker({ store, artifacts, policy, tmpRoot: paths.tmp, log, pollMs: 100, heartbeatMs: 200 });
      return h.worker;
    },
    queueScan(url, opts = {}) {
      project ??= store.createProject({ name: 'Fixture project' }).id;
      const config = buildScanConfig({
        projectId: project,
        url: new URL(url),
        navigationTimeoutMs: opts.navigationTimeoutMs ?? 10_000,
        explore: opts.explore,
        maxStates: opts.maxStates,
        maxDepth: opts.maxDepth,
        terminology: opts.terminology,
        textExclusions: opts.textExclusions,
        scope: opts.allowedOrigins ? { allowedOrigins: [new URL(url).origin, ...opts.allowedOrigins] } : undefined,
      });
      if (opts.maxRuntimeMs) config.budgets.maxRuntimeMs = opts.maxRuntimeMs;
      if (opts.linkCheckTimeoutMs) config.budgets.linkCheckTimeoutMs = opts.linkCheckTimeoutMs;
      return store.createRun(config, url);
    },
    async waitForTerminal(runId, timeoutMs = 45_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const run = store.getRun(runId)!;
        if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) return run;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`Run ${runId} did not finish in ${timeoutMs} ms (status ${store.getRun(runId)?.status})`);
    },
    async close() {
      await h.worker?.stop();
      store.db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return h;
}
