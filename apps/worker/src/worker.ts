import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { type WorkerDeps, runScan } from './runner.js';

export interface WorkerLoop {
  stop(): Promise<void>;
  /** Resolves when the loop is idle (no active run). Used by tests. */
  idle(): Promise<void>;
}

/**
 * Single-concurrency job loop. On start it marks runs left `running` by a
 * previous worker process as `partial`/`failed` (`worker_lost`) and removes
 * orphaned temp directories; it does not re-run them.
 */
export function startWorker(deps: Omit<WorkerDeps, 'workerId'> & { pollMs?: number; recoverAllOnStart?: boolean }): WorkerLoop {
  const workerId = randomUUID();
  const full: WorkerDeps = { ...deps, workerId };
  const recovered = deps.store.recoverOrphanedRuns({ all: deps.recoverAllOnStart ?? true });
  if (recovered.length) deps.log.warn({ runs: recovered }, 'marked orphaned runs after restart');
  for (const entry of safeReaddir(deps.tmpRoot)) rmSync(path.join(deps.tmpRoot, entry), { recursive: true, force: true });

  let stopped = false;
  let active: Promise<unknown> | undefined;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (stopped) return;
    try {
      const run = deps.store.claimNextJob(workerId, deps.leaseMs ?? 30_000);
      if (run) {
        deps.log.info({ runId: run.id }, 'scan started');
        active = runScan(full, run);
        const status = await active;
        deps.log.info({ runId: run.id, status }, 'scan finished');
        active = undefined;
        setImmediate(tick);
        return;
      }
    } catch (err) {
      deps.log.error({ err }, 'worker tick failed');
      active = undefined;
    }
    if (!stopped) timer = setTimeout(tick, deps.pollMs ?? 1_000);
  };
  timer = setTimeout(tick, 0);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await active;
    },
    async idle() {
      while (active) await active;
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
