import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nowIso } from '@cqa/core';

/** Raised when another worker already owns this data folder. */
export class WorkerAlreadyRunningError extends Error {}

/** Beside the temp folder, not inside it: startup clears everything in the temp folder. */
export const workerLockPath = (tmpRoot: string): string => `${path.resolve(tmpRoot)}.worker.lock`;

/** How often a running worker marks its lock as still in use. */
const REFRESH_MS = 10_000;
/**
 * A lock not refreshed for this long is abandoned even if its process number now belongs to something else. Long on purpose:
 * taking over from a worker that is only paused is the harm this lock exists to stop, while waiting costs a few minutes at most.
 */
export const STALE_AFTER_MS = 5 * 60_000;

/** Locks taken by this process, so a process number that matches ours is only trusted when we really hold the lock. */
const heldHere = new Set<string>();

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function ownerOf(file: string): number | undefined {
  try {
    const pid = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }).pid;
    return typeof pid === 'number' ? pid : undefined;
  } catch {
    return undefined;
  }
}

function isHeld(file: string, pid: number | undefined): boolean {
  if (pid === undefined) return false;
  if (pid === process.pid) return heldHere.has(file);
  let refreshedAt: number;
  try {
    refreshedAt = statSync(file).mtimeMs;
  } catch {
    return false;
  }
  return Date.now() - refreshedAt < STALE_AFTER_MS && processIsAlive(pid);
}

/** Creates the lock with its contents in one step, so nobody can ever read a half-written lock. */
function tryCreate(file: string): boolean {
  const draft = `${file}.${process.pid}.${Date.now()}.tmp`;
  const contents = JSON.stringify({ pid: process.pid, startedAt: nowIso() });
  writeFileSync(draft, contents);
  try {
    linkSync(draft, file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    // Some drives have no hard links. Creating the file exclusively still lets only one copy win.
    try {
      writeFileSync(file, contents, { flag: 'wx' });
      return true;
    } catch (fallback) {
      if ((fallback as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw fallback;
    }
  } finally {
    rmSync(draft, { force: true });
  }
}

/** Moves an abandoned lock aside. If what was moved turns out to be a newer lock, it goes straight back. */
function clearAbandoned(file: string, seenPid: number | undefined): boolean {
  const aside = `${file}.${process.pid}.${Date.now()}.old`;
  try {
    renameSync(file, aside);
  } catch {
    return false;
  }
  if (ownerOf(aside) !== seenPid) {
    renameSync(aside, file);
    return false;
  }
  rmSync(aside, { force: true });
  return true;
}

/**
 * Takes sole ownership of a data folder before a worker recovers jobs or clears temp files, both of which assume no
 * other worker is using them. A lock left behind by a process that has died is replaced. Returns the function that releases it.
 */
export function acquireWorkerLock(tmpRoot: string): () => void {
  const file = workerLockPath(tmpRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  const refused = (pid: number | undefined) => new WorkerAlreadyRunningError(`Another copy of the tool is already running${pid === undefined ? '' : ` (process ${pid})`}. This copy was not started, so scans in progress are not affected. Close the other copy first.`);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreate(file)) {
      heldHere.add(file);
      const refresh = setInterval(() => {
        try {
          const now = new Date();
          utimesSync(file, now, now);
        } catch {
          // The next start judges the lock by its age, so a missed refresh cannot cause harm here.
        }
      }, REFRESH_MS);
      refresh.unref();
      return () => {
        clearInterval(refresh);
        heldHere.delete(file);
        // Only our own: if this lock was taken over while we were stopped, it now belongs to someone else.
        if (ownerOf(file) === process.pid) rmSync(file, { force: true });
      };
    }
    const pid = ownerOf(file);
    if (isHeld(file, pid)) throw refused(pid);
    clearAbandoned(file, pid);
  }
  throw refused(undefined);
}
