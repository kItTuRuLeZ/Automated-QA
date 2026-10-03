import type { Page } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { ArtifactId, BrowserInfo, CourseState, EvidenceId, FindingLocation, FindingOccurrence, LayoutSettings, ProviderContext } from '@cqa/shared';
import { baselineKey, nowIso } from '@cqa/core';
import { type Bounds, type LayoutMeasure, type PerfSample, measureLayout, settleVisuals } from '../adapters/layout-scripts.js';
import { type NewCheck, type NewFinding, check, finding, truncate } from './helpers.js';

export interface BaselineAccess {
  /** Looks up the stored baseline screenshot for this exact key. */
  lookup(key: string): ArtifactId | undefined;
  read(artifactId: string): Buffer | undefined;
}

export interface LayoutResult {
  checks: NewCheck[];
  findings: NewFinding[];
}

const loc = (ctx: ProviderContext, state: CourseState, extra: Partial<FindingLocation> = {}): FindingLocation => ({
  stateId: state.id,
  url: state.url,
  lessonId: state.lessonId,
  viewportName: ctx.viewport.name,
  browser: 'chromium',
  ...extra,
});

const sizeLabel = (ctx: ProviderContext) => `${ctx.viewport.name} (${ctx.viewport.width}×${ctx.viewport.height})`;

/**
 * Responsive layout heuristics, a settled screenshot per screen and viewport,
 * font load errors, page-load evidence, and baseline comparison. Geometry
 * results are heuristics: they are reported as "needs review", not as defects.
 */
export class LayoutChecks {
  readonly id = 'layout';
  readonly version = '1.0.0';

  constructor(
    private readonly deps: {
      courseUrl: string;
      browser: () => BrowserInfo | undefined;
      settings: LayoutSettings;
      baselines?: BaselineAccess;
    },
  ) {}

  async checkState(ctx: ProviderContext, state: CourseState, repro: string[], pathKey: string): Promise<LayoutResult> {
    const page = ctx.page as Page;
    const base = { stateId: state.id, viewportName: ctx.viewport.name };
    const checks: NewCheck[] = [];
    const findings: NewFinding[] = [];
    const t0 = Date.now();
    const size = sizeLabel(ctx);
    const steps = (extra: string) => [...repro, `Set the browser window (or device emulation) to ${ctx.viewport.width}×${ctx.viewport.height} CSS pixels.`, extra];

    // Wait (bounded) for fonts and images, then measure and capture the same settled page.
    const settled = await page.evaluate(settleVisuals).catch(() => ({ fontsSettled: false, imagesPending: 0 }));
    let m: LayoutMeasure;
    try {
      m = await page.evaluate(measureLayout);
    } catch (err) {
      const detail = truncate((err as Error).message, 200);
      for (const id of ['LAY-001', 'LAY-002', 'LAY-003', 'LAY-004', 'LAY-005'] as const) checks.push(check(id, 'error', Date.now() - t0, [], { ...base, reason: 'engine_error', reasonDetail: detail }));
      return { checks, findings };
    }
    const ms = Date.now() - t0;
    const settleNote = [!settled.fontsSettled ? 'Fonts had not finished loading after 3 s.' : '', settled.imagesPending ? `${settled.imagesPending} image(s) were still loading after 2 s.` : ''].filter(Boolean).join(' ');

    const cap = await this.capture(ctx, state, pathKey, settled);
    const shot = cap.ids;

    const geometry = async (caption: string, data: Record<string, unknown>) =>
      (
        await ctx.evidence.addEvidence({
          kind: 'geometry',
          caption: `${caption} at ${size}`,
          data: { viewport: { name: ctx.viewport.name, width: ctx.viewport.width, height: ctx.viewport.height, deviceScaleFactor: ctx.viewport.deviceScaleFactor, isMobile: ctx.viewport.isMobile, hasTouch: ctx.viewport.hasTouch }, browser: this.deps.browser(), ...data },
          stateId: state.id,
          viewportName: ctx.viewport.name,
          capturedAt: nowIso(),
          redacted: false,
        })
      ).id;
    const occ = (items: Array<{ selector: string; bounds: Bounds; label: string }>, ev: EvidenceId): FindingOccurrence[] =>
      items.map((i) => ({ location: loc(ctx, state, { selector: i.selector, bounds: i.bounds, elementDescription: i.label }), checkResultIds: [], evidenceIds: [ev], observed: i.label }));

    // ---- LAY-001 horizontal overflow ----
    if (m.overflow.scrollWidth > m.overflow.clientWidth + 1) {
      const ev = await geometry('Horizontal overflow', { scrollWidth: m.overflow.scrollWidth, clientWidth: m.overflow.clientWidth, offenders: m.overflow.offenders });
      checks.push(check('LAY-001', 'needs_review', ms, [ev, ...shot], base));
      const items = m.overflow.offenders.map((o) => ({ selector: o.selector, bounds: o.bounds, label: `${o.selector}${o.text ? ` "${truncate(o.text, 40)}"` : ''} reaches ${o.bounds.x + o.bounds.width}px` }));
      findings.push(
        finding('LAY-001', loc(ctx, state), {
          title: `Page scrolls sideways at ${size}`,
          observed: `At ${size} the page content is ${m.overflow.scrollWidth} px wide but the screen is ${m.overflow.clientWidth} px, so learners must scroll horizontally.${items.length ? ` Elements reaching past the edge: ${items.map((i) => i.label).join('; ')}.` : ''}`,
          expected: 'Content fits the screen width without horizontal scrolling, except content that legitimately needs it (wide tables, maps, carousels).',
          evidenceIds: [ev, ...shot],
          reproductionSteps: steps('Look for horizontal scrolling.'),
          remediation: 'Use flexible widths and wrapping so the layout fits narrow screens, or put wide content in its own scrolling area.',
          targetKey: `overflow|${ctx.viewport.name}`,
          stateKey: '',
          occurrences: occ(items.length ? items : [{ selector: 'body', bounds: { x: 0, y: 0, width: m.overflow.scrollWidth, height: 0 }, label: 'page' }], ev),
        }),
      );
    } else {
      checks.push(check('LAY-001', 'passed', ms, shot, { ...base, reasonDetail: settleNote || undefined }));
    }

    // ---- LAY-002 clipped text ----
    if (m.clipped.length) {
      const ev = await geometry('Clipped text', { elements: m.clipped });
      checks.push(check('LAY-002', 'needs_review', 0, [ev, ...shot], { ...base, itemsEvaluated: m.clipped.length }));
      const items = m.clipped.map((c) => ({
        selector: c.selector,
        bounds: c.bounds,
        label: `"${truncate(c.text, 50)}" shows ${c.clientWidth}×${c.clientHeight} px of ${c.scrollWidth}×${c.scrollHeight} px`,
      }));
      findings.push(
        finding('LAY-002', loc(ctx, state, { selector: items[0]?.selector }), {
          title: `Text may be cut off at ${size} (${items.length} place${items.length > 1 ? 's' : ''})`,
          observed: `These elements hide part of their text: ${items.slice(0, 4).map((i) => i.label).join('; ')}${items.length > 4 ? '; …' : ''}.`,
          expected: 'All text is fully visible. Intentional truncation (ellipsis) is not reported; confirm this clipping is not intended.',
          evidenceIds: [ev, ...shot],
          reproductionSteps: steps('Look at the outlined text and check whether words are cut off.'),
          remediation: 'Give the container room (remove the fixed height, or allow wrapping), or shorten the text.',
          targetKey: `clipped|${ctx.viewport.name}`,
          stateKey: '',
          occurrences: occ(items, ev),
        }),
      );
    } else {
      checks.push(check('LAY-002', 'passed', 0, [], base));
    }

    // ---- LAY-003 obscured controls ----
    if (m.obscured.items.length) {
      const ev = await geometry('Covered controls', { tested: m.obscured.tested, controls: m.obscured.items });
      checks.push(check('LAY-003', 'needs_review', 0, [ev, ...shot], { ...base, itemsEvaluated: m.obscured.tested }));
      const items = m.obscured.items.map((o) => ({ selector: o.selector, bounds: o.bounds, label: `"${truncate(o.name, 40)}" is covered by "${truncate(o.coveredBy, 40)}"` }));
      findings.push(
        finding('LAY-003', loc(ctx, state, { selector: items[0]?.selector }), {
          title: `A control looks covered by another element at ${size}`,
          observed: `${items.map((i) => i.label).join('; ')}. The element at each control's center is not the control.`,
          expected: 'Controls can be clicked or tapped. Overlays that are meant to cover content (modals, tooltips) are excluded; confirm this covering is not intended.',
          evidenceIds: [ev, ...shot],
          reproductionSteps: steps('Try to click the outlined control.'),
          remediation: 'Move or resize the covering element, or lower its stacking order.',
          targetKey: `obscured|${ctx.viewport.name}`,
          stateKey: '',
          occurrences: occ(items, ev),
        }),
      );
    } else {
      checks.push(check('LAY-003', m.obscured.tested ? 'passed' : 'not_applicable', 0, [], { ...base, itemsEvaluated: m.obscured.tested }));
    }

    // ---- LAY-004 dialogs outside the viewport ----
    if (m.dialogs.length) {
      const ev = await geometry('Dialog outside viewport', { dialogs: m.dialogs });
      checks.push(check('LAY-004', 'needs_review', 0, [ev, ...shot], base));
      for (const d of m.dialogs) {
        findings.push(
          finding('LAY-004', loc(ctx, state, { selector: d.selector, bounds: d.bounds, elementDescription: `dialog "${truncate(d.name, 40)}"` }), {
            title: `Dialog "${truncate(d.name, 40)}" does not fit the screen at ${size}`,
            observed: `The dialog ${d.reason}.`,
            expected: 'An open dialog is fully inside the viewport, or scrolls inside itself when taller than the screen.',
            evidenceIds: [ev, ...shot],
            reproductionSteps: steps('Open the dialog and check that all of it is visible.'),
            remediation: 'Constrain the dialog to the viewport (max-width and max-height with internal scrolling).',
            targetKey: `dialog|${d.selector}|${ctx.viewport.name}`,
            stateKey: '',
          }),
        );
      }
    } else {
      checks.push(check('LAY-004', 'passed', 0, [], base));
    }

    // ---- LAY-005 fonts ----
    if (m.fontErrors.length) {
      const ev = await geometry('Web fonts that failed to load', { families: m.fontErrors });
      checks.push(check('LAY-005', 'failed', 0, [ev], { ...base, itemsEvaluated: m.fonts.loaded + m.fonts.errors }));
      for (const family of m.fontErrors) {
        findings.push(
          finding('LAY-005', loc(ctx, state), {
            title: `Web font "${truncate(family, 40)}" did not load`,
            observed: `The browser tried to load the font "${family}" and failed, so text falls back to a different font.`,
            expected: 'Web fonts load; text keeps its intended typeface and metrics.',
            evidenceIds: [ev],
            reproductionSteps: [...repro, 'Open the developer tools Network panel and filter by font.'],
            remediation: 'Restore the font file or fix its address.',
            targetKey: `font|${family}`,
            stateKey: '',
          }),
        );
      }
    } else {
      checks.push(check('LAY-005', m.fonts.loaded + m.fonts.errors ? 'passed' : 'not_applicable', 0, [], { ...base, itemsEvaluated: m.fonts.loaded }));
    }

    // ---- VIS-001 baseline comparison (only when enabled for the scan) ----
    if (ctx.config.engines.visualBaseline) await this.compare(ctx, state, shot, cap.bytes, checks, findings, repro, pathKey);

    return { checks, findings };
  }

  /** Page-load evidence for the first page at the primary viewport. */
  async perf(ctx: ProviderContext, state: CourseState, s: PerfSample | undefined, repro: string[]): Promise<LayoutResult> {
    const base = { stateId: state.id, viewportName: ctx.viewport.name };
    const t = this.deps.settings.perf;
    if (!s || !s.available) {
      return { checks: [check('PERF-001', 'not_tested', 0, [], { ...base, reason: 'engine_error', reasonDetail: 'The browser did not provide Navigation Timing for this page.' })], findings: [] };
    }
    const browser = this.deps.browser();
    const unavailable = [s.loadMs === null ? 'load time' : '', s.sizeUnavailable ? `${s.sizeUnavailable} resource size(s)` : ''].filter(Boolean);
    const ev = (
      await ctx.evidence.addEvidence({
        kind: 'timing',
        caption: `Page-load evidence: ${s.loadMs} ms, ${(s.transferredBytes / 1_000_000).toFixed(1)} MB, ${s.requests} requests`,
        data: {
          ...s,
          thresholds: t,
          unavailable,
          conditions: [
            'One sample with an empty cache (fresh browser).',
            `Headless ${browser ? `${browser.engine} ${browser.version}` : 'Chromium'} on the machine running the scan.`,
            'Results depend on that machine, its network, server load, and third-party content; compare scans only under similar conditions.',
            'This is not a full performance audit: no Core Web Vitals or throttling.',
          ],
        },
        stateId: state.id,
        viewportName: ctx.viewport.name,
        capturedAt: nowIso(),
        redacted: false,
      })
    ).id;
    const over: string[] = [];
    if (s.loadMs !== null && s.loadMs > t.loadMs) over.push(`load time ${(s.loadMs / 1000).toFixed(1)} s (limit ${(t.loadMs / 1000).toFixed(1)} s)`);
    if (s.transferredBytes > t.totalBytes) over.push(`${s.sizeUnavailable > 0 ? 'at least ' : ''}${(s.transferredBytes / 1_000_000).toFixed(1)} MB transferred (limit ${(t.totalBytes / 1_000_000).toFixed(1)} MB)`);
    if (s.requests > t.requestCount) over.push(`${s.requests} requests (limit ${t.requestCount})`);
    if (over.length === 0) return { checks: [check('PERF-001', 'passed', 0, [ev], { ...base, reasonDetail: unavailable.length ? `Not available: ${unavailable.join(', ')}.` : undefined })], findings: [] };
    return {
      checks: [check('PERF-001', 'needs_review', 0, [ev], base)],
      findings: [
        finding('PERF-001', loc(ctx, state), {
          title: `Page load is over the warning thresholds (${over.length} of 3)`,
          observed: `${over.join('; ')}. Largest assets: ${s.largest.slice(0, 3).map((a) => `${a.url.split('/').pop()} ${(a.bytes / 1000).toFixed(0)} kB`).join(', ') || 'unavailable'}.`,
          expected: `Page load stays within the thresholds. Source: ${t.provenance}`,
          evidenceIds: [ev],
          reproductionSteps: [...repro, 'Open the developer tools Network panel with the cache disabled and reload.'],
          remediation: 'Compress or lazy-load the largest assets and remove unneeded requests. Confirm on a normal connection before acting.',
          targetKey: 'perf',
          stateKey: '',
        }),
      ],
    };
  }

  private async capture(ctx: ProviderContext, state: CourseState, pathKey: string, settled: { fontsSettled: boolean; imagesPending: number }): Promise<{ ids: EvidenceId[]; bytes?: Buffer }> {
    const page = ctx.page as Page;
    try {
      const bytes = await page.screenshot({ type: 'png', timeout: 10_000 });
      const artifactId = await ctx.evidence.writeArtifact({ kind: 'screenshot', mime: 'image/png', bytes });
      const browser = this.deps.browser();
      const key = browser ? baselineKey({ courseUrl: this.deps.courseUrl, pathKey, viewport: ctx.viewport, browser, configVersion: ctx.config.configVersion }) : undefined;
      const ev = await ctx.evidence.addEvidence({
        kind: 'screenshot',
        artifactId,
        caption: `${state.title || state.url} at ${sizeLabel(ctx)}`,
        data: { layoutCapture: true, baselineKey: key, fontsSettled: settled.fontsSettled, imagesPending: settled.imagesPending, viewport: { name: ctx.viewport.name, width: ctx.viewport.width, height: ctx.viewport.height, deviceScaleFactor: ctx.viewport.deviceScaleFactor, isMobile: ctx.viewport.isMobile, hasTouch: ctx.viewport.hasTouch } },
        stateId: state.id,
        viewportName: ctx.viewport.name,
        capturedAt: nowIso(),
        redacted: false,
      });
      return { ids: [ev.id], bytes };
    } catch {
      return { ids: [] };
    }
  }

  private async compare(ctx: ProviderContext, state: CourseState, shot: EvidenceId[], current: Buffer | undefined, checks: NewCheck[], findings: NewFinding[], repro: string[], pathKey: string): Promise<void> {
    const base = { stateId: state.id, viewportName: ctx.viewport.name };
    const browser = this.deps.browser();
    if (!browser || !this.deps.baselines || shot.length === 0) {
      checks.push(check('VIS-001', 'not_tested', 0, [], { ...base, reason: 'engine_error', reasonDetail: 'No screenshot was available to compare.' }));
      return;
    }
    const key = baselineKey({ courseUrl: this.deps.courseUrl, pathKey, viewport: ctx.viewport, browser, configVersion: ctx.config.configVersion });
    const baselineId = this.deps.baselines.lookup(key);
    if (!baselineId) {
      checks.push(check('VIS-001', 'not_tested', 0, [], { ...base, reason: 'no_baseline', reasonDetail: `No baseline was recorded for this screen at ${sizeLabel(ctx)} with this browser version and these settings.` }));
      return;
    }
    const baselineBytes = this.deps.baselines.read(baselineId);
    if (!current || !baselineBytes) {
      checks.push(check('VIS-001', 'not_tested', 0, [], { ...base, reason: 'baseline_incompatible', reasonDetail: 'The baseline or current screenshot could not be read.' }));
      return;
    }
    const a = PNG.sync.read(baselineBytes);
    const b = PNG.sync.read(current);
    if (a.width !== b.width || a.height !== b.height) {
      checks.push(check('VIS-001', 'not_tested', 0, [], { ...base, reason: 'baseline_incompatible', reasonDetail: `Screenshot sizes differ (${a.width}×${a.height} baseline, ${b.width}×${b.height} now), so they were not compared.` }));
      return;
    }
    const diff = new PNG({ width: a.width, height: a.height });
    const differing = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
    const ratio = differing / (a.width * a.height);
    if (ratio <= this.deps.settings.baselineDiffRatio) {
      checks.push(check('VIS-001', 'passed', 0, shot, { ...base, reasonDetail: `${(ratio * 100).toFixed(2)}% of pixels differ (limit ${(this.deps.settings.baselineDiffRatio * 100).toFixed(2)}%).` }));
      return;
    }
    const diffArtifact = await ctx.evidence.writeArtifact({ kind: 'diff_image', mime: 'image/png', bytes: PNG.sync.write(diff) });
    const ev = (
      await ctx.evidence.addEvidence({
        kind: 'diff_image',
        artifactId: diffArtifact,
        caption: `Difference from baseline at ${sizeLabel(ctx)}: ${(ratio * 100).toFixed(2)}% of pixels`,
        data: { differingPixels: differing, ratio, limit: this.deps.settings.baselineDiffRatio, baselineArtifactId: baselineId, currentEvidenceId: shot[0] },
        stateId: state.id,
        viewportName: ctx.viewport.name,
        capturedAt: nowIso(),
        redacted: false,
      })
    ).id;
    checks.push(check('VIS-001', 'needs_review', 0, [ev, ...shot], base));
    findings.push(
      finding('VIS-001', loc(ctx, state), {
        title: `Screen looks different from the baseline at ${sizeLabel(ctx)} (${(ratio * 100).toFixed(1)}% of pixels)`,
        observed: `${differing} of ${a.width * a.height} pixels differ from the baseline screenshot recorded with identical settings. Red areas in the diff image show where.`,
        expected: 'The screen matches the baseline, or the change is intended. Animations, carousels, dates, and ads also cause differences.',
        evidenceIds: [ev, ...shot],
        reproductionSteps: [...repro, `Compare with the baseline screenshot at ${sizeLabel(ctx)}.`],
        remediation: 'Confirm the change is intended. If it is, record a new baseline from this scan.',
        targetKey: `baseline|${ctx.viewport.name}`,
        stateKey: '',
      }),
    );
  }
}
