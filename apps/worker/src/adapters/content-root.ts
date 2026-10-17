import type { Frame, Page } from 'playwright';

/** How much a document offers a learner: visible text plus controls. */
async function richness(f: Frame): Promise<number> {
  return f
    .evaluate(() => {
      const b = document.body;
      if (!b) return 0;
      const controls = document.querySelectorAll('button,a[href],[role="button"],[role="tab"],details,[aria-expanded]').length;
      return (b.innerText || '').trim().length + controls * 20;
    })
    .catch(() => 0);
}

/**
 * Many published courses (Rise and other SCORM wrappers) show the lesson in an iframe inside a nearly empty wrapper page.
 * Controls, text and URL hashes then live in the frame. This returns the frame that holds the content, or the page itself
 * when the page already holds it. A frame is chosen only when it is same-origin with the page and clearly richer than the
 * page, so a small embed inside a real page never takes over.
 */
export async function contentRoot(page: Page): Promise<Page | Frame> {
  const main = page.mainFrame();
  const frames = page.frames().filter((f) => f !== main && f.url().startsWith('http') && !/\/(blank|AICCComm)\.html?(\?|$)/i.test(f.url()));
  if (frames.length === 0) return page;
  let origin = '';
  try {
    origin = new URL(main.url()).origin;
  } catch {
    return page;
  }
  const mainScore = await richness(main);
  let best: Frame | undefined;
  let bestScore = mainScore * 2 + 40;
  for (const f of frames) {
    try {
      if (new URL(f.url()).origin !== origin) continue;
    } catch {
      continue;
    }
    const s = await richness(f);
    if (s > bestScore) {
      best = f;
      bestScore = s;
    }
  }
  return best ?? page;
}

/**
 * Like contentRoot, but when the page itself shows almost nothing (a wrapper that is still loading its lesson frame),
 * waits up to maxMs for a content frame to appear. Ordinary pages return at once.
 */
export async function waitForContentRoot(page: Page, maxMs = 15_000): Promise<Page | Frame> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const root = await contentRoot(page);
    if (root !== page) return root;
    if ((await richness(page.mainFrame())) >= 40 || Date.now() > deadline) return page;
    await new Promise((r) => setTimeout(r, 300));
  }
}
