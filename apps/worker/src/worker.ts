import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { type WorkerDeps, runScan } from './runner.js';
import { acquireWorkerLock } from './worker-lock.js';

export interface WorkerLoop {
  stop(): Promise<void>;
  /** Resolves when the loop is idle (no active run). Used by tests. */
  idle(): Promise<void>;
}

/** Upper bound for parallel scans: each one is a full Chromium plus an egress proxy. */
export const MAX_CONCURRENCY = 4;

/** Reads CQA_WORKER_CONCURRENCY: a whole number from 1 to MAX_CONCURRENCY. Anything else falls back to 1. */
export function concurrencyFromEnv(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_CONCURRENCY) : 1;
}

/**
 * Job loop that runs up to `concurrency` scans at once (default 1), each in its
 * own browser. On start it marks runs left `running` by a previous worker
 * process as `partial`/`failed` (`worker_lost`) and removes orphaned temp
 * directories; it does not re-run them.
 */
export function startWorker(deps: Omit<WorkerDeps, 'workerId'> & { pollMs?: number; recoverAllOnStart?: boolean; concurrency?: number }): WorkerLoop {
  const workerId = randomUUID();
  const full: WorkerDeps = { ...deps, workerId };
  const limit = Math.min(Math.max(1, Math.floor(deps.concurrency ?? 1)), MAX_CONCURRENCY);
  // Before anything else: the two steps below assume no other worker is using this data folder.
  const releaseLock = acquireWorkerLock(deps.tmpRoot);
  const recovered = deps.store.recoverOrphanedRuns({ all: deps.recoverAllOnStart ?? true });
  if (recovered.length) deps.log.warn({ runs: recovered }, 'marked orphaned runs after restart');
  for (const entry of safeReaddir(deps.tmpRoot)) {
    try {
      rmSync(path.join(deps.tmpRoot, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (err) {
      // A folder Windows still holds is not worth refusing to start over; it is tried again next time.
      deps.log.warn({ err, entry }, 'could not remove an old scan temp folder');
    }
  }

  let stopped = false;
  const active = new Set<Promise<unknown>>();
  let timer: NodeJS.Timeout | undefined;

  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, ms);
  };

  const tick = () => {
    timer = undefined;
    if (stopped) return;
    try {
      while (active.size < limit) {
        const run = deps.store.claimNextJob(workerId, deps.leaseMs ?? 30_000);
        if (!run) break;
        deps.log.info({ runId: run.id }, 'scan started');
        const p: Promise<unknown> = runScan(full, run)
          .then((status) => deps.log.info({ runId: run.id, status }, 'scan finished'))
          .catch((err) => deps.log.error({ err, runId: run.id }, 'scan crashed the worker loop'))
          .finally(() => {
            active.delete(p);
            schedule(0);
          });
        active.add(p);
      }
    } catch (err) {
      deps.log.error({ err }, 'worker tick failed');
    }
    schedule(deps.pollMs ?? 1_000);
  };
  schedule(0);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await Promise.all([...active]);
      releaseLock();
    },
    async idle() {
      while (active.size) await Promise.all([...active]);
    },
  };
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
