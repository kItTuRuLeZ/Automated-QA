import type { ArtifactStore } from './artifacts.js';
import type { Store } from './db/store.js';

export interface RetentionResult {
  days: number;
  deleted: Array<{ id: string; targetUrl: string; finishedAt: string }>;
  kept: { holdsBaseline: number; latestForCourse: number };
}

/**
 * Deletes scans (rows and artifact files) that finished more than `days` ago.
 * Never deletes the newest finished scan of each course, so every course keeps
 * a current report, and never deletes a scan whose screenshots are stored as a
 * visual baseline. Issue status history is kept: it belongs to the course, not
 * to a scan. With `dryRun`, nothing is deleted and the result says what would be.
 */
export function sweepRetention(store: Store, artifacts: ArtifactStore, opts: { days: number; dryRun?: boolean; now?: number }): RetentionResult {
  const cutoff = (opts.now ?? Date.now()) - opts.days * 86_400_000;
  const all = store.listFinishedRunsForRetention();
  const newest = new Map<string, string>();
  for (const r of all) newest.set(`${r.projectId}|${r.targetUrl}`, r.id); // ascending order: the last one wins
  const result: RetentionResult = { days: opts.days, deleted: [], kept: { holdsBaseline: 0, latestForCourse: 0 } };
  for (const r of all) {
    if (Date.parse(r.finishedAt) >= cutoff) continue;
    if (newest.get(`${r.projectId}|${r.targetUrl}`) === r.id) {
      result.kept.latestForCourse++;
      continue;
    }
    if (store.runHoldsBaselines(r.id)) {
      result.kept.holdsBaseline++;
      continue;
    }
    result.deleted.push({ id: r.id, targetUrl: r.targetUrl, finishedAt: r.finishedAt });
    if (!opts.dryRun) {
      store.deleteRun(r.id);
      artifacts.deleteRunArtifacts(r.id);
    }
  }
  return result;
}
