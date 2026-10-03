import type { Page } from 'playwright';
import type { EvidenceId, ProviderContext, StateId } from '@cqa/shared';
import { nowIso } from '@cqa/core';
import type { NewFinding } from './helpers.js';

const MAX_PER_STATE = 10;
const MAX_PER_RUN = 80;
const MARGIN = 140;
const MIN_W = 420;
const MIN_H = 260;

/**
 * Captures a cropped screenshot with the affected element outlined, so a
 * developer can see where a problem is without reading a selector.
 * Selectors that cannot be resolved in the main frame (elements inside
 * iframes, selectors that match nothing) are skipped; the finding then falls
 * back to the screenshot of the whole screen.
 */
export class Annotator {
  private used = 0;

  async annotateFindings(ctx: ProviderContext, stateId: StateId, findings: NewFinding[]): Promise<void> {
    const page = ctx.page as Page;
    let perState = 0;
    for (const f of findings) {
      if (perState >= MAX_PER_STATE || this.used >= MAX_PER_RUN || ctx.signal.aborted) return;
      const occ = f.occurrences.find((o) => o.location.stateId === stateId && o.location.selector) ?? (f.location.stateId === stateId && f.location.selector ? { location: f.location, evidenceIds: [] as EvidenceId[] } : undefined);
      const selector = occ?.location.selector;
      if (!selector || f.evidenceIds.length > 12) continue;
      if (f.type === 'manual_review' && f.category === 'coverage') continue; // nothing specific to point at
      const id = await this.capture(page, ctx, stateId, selector, f.title);
      if (!id) continue;
      perState++;
      this.used++;
      f.evidenceIds = [id, ...f.evidenceIds];
      for (const o of f.occurrences) if (o.location.stateId === stateId && o.location.selector === selector) o.evidenceIds = [id, ...o.evidenceIds];
    }
  }

  private async capture(page: Page, ctx: ProviderContext, stateId: StateId, selector: string, caption: string): Promise<EvidenceId | undefined> {
    const viewport = page.viewportSize();
    if (!viewport) return undefined;
    let scrollY = 0;
    try {
      const loc = page.locator(selector).first();
      if ((await loc.count()) === 0) return undefined;
      scrollY = await page.evaluate(() => window.scrollY);
      await loc.scrollIntoViewIfNeeded({ timeout: 1_500 });
      const box = await loc.boundingBox();
      if (!box || box.width < 1 || box.height < 1) return undefined;

      await page.evaluate(
        ({ x, y, w, h }) => {
          const d = document.createElement('div');
          d.id = '__cqa_highlight';
          d.style.cssText = `position:fixed;left:${x - 3}px;top:${y - 3}px;width:${w + 6}px;height:${h + 6}px;border:3px solid #e11d48;border-radius:4px;background:rgba(225,29,72,0.10);z-index:2147483647;pointer-events:none;box-sizing:border-box`;
          document.body.appendChild(d);
        },
        { x: box.x, y: box.y, w: box.width, h: box.height },
      );
      // Crop around the element, wide enough to read, clamped to the viewport.
      const w = Math.min(viewport.width, Math.max(MIN_W, box.width + MARGIN * 2));
      const h = Math.min(viewport.height, Math.max(MIN_H, box.height + MARGIN * 2));
      const x = Math.max(0, Math.min(viewport.width - w, box.x + box.width / 2 - w / 2));
      const y = Math.max(0, Math.min(viewport.height - h, box.y + box.height / 2 - h / 2));
      const bytes = await page.screenshot({ type: 'png', clip: { x, y, width: w, height: h }, timeout: 5_000 });
      const artifactId = await ctx.evidence.writeArtifact({ kind: 'annotated_screenshot', mime: 'image/png', bytes });
      const ev = await ctx.evidence.addEvidence({
        kind: 'annotated_screenshot',
        artifactId,
        caption: `Affected element outlined: ${caption.slice(0, 100)}`,
        data: { selector, bounds: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } },
        stateId,
        viewportName: ctx.viewport.name,
        capturedAt: nowIso(),
        redacted: false,
      });
      return ev.id;
    } catch {
      return undefined; // best effort: the screen-level screenshot still exists
    } finally {
      await page.evaluate(() => document.getElementById('__cqa_highlight')?.remove()).catch(() => undefined);
      await page.evaluate((y) => window.scrollTo(0, y), scrollY).catch(() => undefined);
    }
  }
}
