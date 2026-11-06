import type { Frame, Page } from 'playwright';

/**
 * Scrolls a Rise lesson from top to bottom the way a learner would and returns the ids of the blocks
 * (`[data-block-id]`) that appeared on screen. Seen is not tested: this only proves a block was shown.
 * The scroll position is put back afterwards so the rest of the scan sees the lesson as it was.
 */
export async function blocksScrolledIntoView(root: Page | Frame, maxSteps = 80): Promise<string[]> {
  return root.evaluate(async (max) => {
    // Two animation frames let the player render what scrolled in; no fixed wait.
    const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const seen = new Set<string>();
    const scroller = document.scrollingElement ?? document.documentElement;
    const look = () => {
      for (const el of document.querySelectorAll('[data-block-id]')) {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && st.visibility !== 'hidden') seen.add(el.getAttribute('data-block-id')!);
      }
    };
    const start = scroller.scrollTop;
    look();
    for (let i = 0; i < max; i++) {
      const before = scroller.scrollTop;
      scroller.scrollBy(0, Math.max(200, Math.floor(innerHeight * 0.8)));
      await nextFrame();
      look();
      if (scroller.scrollTop === before) break;
    }
    scroller.scrollTop = start;
    await nextFrame();
    return [...seen];
  }, maxSteps);
}
