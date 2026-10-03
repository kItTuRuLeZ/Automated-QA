import { createHash } from 'node:crypto';
import type { BrowserInfo, Viewport } from '@cqa/shared';

/**
 * Identity of a baseline screenshot. Two screenshots are compared only when
 * every part matches: the course, the way the screen was reached, the
 * viewport and device settings, the browser engine and major version, and
 * the scan configuration version. A different browser version, viewport, or
 * path is a different key, so incompatible screenshots are never compared.
 */
export function baselineKey(input: { courseUrl: string; pathKey: string; viewport: Viewport; browser: Pick<BrowserInfo, 'engine' | 'version'>; configVersion: number }): string {
  const v = input.viewport;
  const major = input.browser.version.split('.')[0] ?? input.browser.version;
  return createHash('sha256')
    .update(
      JSON.stringify({
        course: input.courseUrl,
        path: input.pathKey,
        viewport: [v.name, v.width, v.height, v.deviceScaleFactor, v.isMobile, v.hasTouch],
        browser: [input.browser.engine, major],
        config: input.configVersion,
      }),
    )
    .digest('hex');
}

import type { Store } from './db/store.js';

/**
 * Makes a finished scan the visual baseline for its course: every layout
 * screenshot (screen × viewport) it captured becomes the reference for later
 * scans with identical settings. Replaces the course's previous baseline.
 */
export function recordBaselineFromRun(store: Store, runId: string): { recorded: number; courseUrl: string } | undefined {
  const run = store.getRun(runId);
  if (!run) return undefined;
  const courseUrl = run.config.target.url ?? '';
  const entries: Array<{ key: string; artifactId: string; label: string }> = [];
  for (const e of store.listEvidenceByKind(runId, 'screenshot')) {
    const key = e.data?.layoutCapture ? (e.data.baselineKey as string | undefined) : undefined;
    if (key && e.artifactId) entries.push({ key, artifactId: e.artifactId, label: e.caption });
  }
  const recorded = entries.length ? store.setBaselines(run.projectId, courseUrl, runId, entries) : 0;
  return { recorded, courseUrl };
}
