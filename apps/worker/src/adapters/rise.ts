import type { Frame, Page } from 'playwright';

/**
 * Scrolls a Rise lesson from top to bottom the way a learner would and returns the ids of the blocks
 * (`[data-block-id]`) that appeared on screen. Seen is not tested: this only proves a block was shown.
 * The scroll position is put back afterwards so the rest of the scan sees the lesson as it was.
 */
/**
 * Rise fades blocks in a moment after they scroll into view, and a fully transparent control is not one a learner can use.
 * Waits, for at most 3 seconds, until the number of visible controls has stopped changing.
 */
export async function controlsSettled(root: Page | Frame, maxMs = 3_000): Promise<void> {
  await root
    .evaluate(async (max) => {
      const count = () => [...document.querySelectorAll('button,[role="tab"],[role="button"],a[href]')].filter((e) => (e as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true })).length;
      const end = Date.now() + max;
      let last = count();
      let steady = 0;
      while (Date.now() < end && steady < 4) {
        await new Promise((r) => setTimeout(r, 200));
        const now = count();
        steady = now === last ? steady + 1 : 0;
        last = now;
      }
    }, maxMs)
    .catch(() => undefined);
}

export async function blocksScrolledIntoView(root: Page | Frame, maxSteps = 80): Promise<string[]> {
  return root.evaluate(async (max) => {
    // Two animation frames let the player render what scrolled in; no fixed wait.
    const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const seen = new Set<string>();
    // Rise lessons scroll inside their own container, not the window: use the nearest ancestor of a block that can actually scroll.
    const canScroll = (el: Element) => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY);
    let scroller: Element = document.scrollingElement ?? document.documentElement;
    for (let el = document.querySelector('[data-block-id]')?.parentElement; el; el = el.parentElement) {
      if (canScroll(el)) {
        scroller = el;
        break;
      }
    }
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
