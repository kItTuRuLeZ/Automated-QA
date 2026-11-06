import type { Frame, Page } from 'playwright';

/** Checks whether a frame is an allowed content frame for the host page. Supports same-origin, Articulate Review 360 embeds, and organizational CDNs. */
export function isAllowedContentFrameOrigin(frameUrl: string, mainUrl: string): boolean {
  try {
    const fUrl = new URL(frameUrl);
    const mUrl = new URL(mainUrl);
    // 1. Same origin is always allowed
    if (fUrl.origin === mUrl.origin) return true;

    // 2. Articulate Review 360 and Rise ecosystem: 360.articulate.com embedding articulateusercontent.com, articulate.com, or cloudfront.net
    const isArticulateHost = mUrl.hostname.endsWith('articulate.com') || mUrl.hostname === '360.articulate.com';
    const isArticulateContent =
      fUrl.hostname.endsWith('articulate.com') ||
      fUrl.hostname.endsWith('articulateusercontent.com') ||
      fUrl.hostname.endsWith('cloudfront.net');
    if (isArticulateHost && isArticulateContent) return true;

    // 3. Same organizational second-level domain (e.g. content.company.com inside lms.company.com)
    const mParts = mUrl.hostname.split('.');
    const fParts = fUrl.hostname.split('.');
    if (mParts.length >= 2 && fParts.length >= 2) {
      const mDomain = mParts.slice(-2).join('.');
      const fDomain = fParts.slice(-2).join('.');
      if (mDomain && fDomain && mDomain === fDomain) return true;
    }

    return false;
  } catch {
    return false;
  }
}

/** How much a document offers a learner: visible text plus controls. */
async function richness(f: Frame): Promise<number> {
  return f
    .evaluate(() => {
      const b = document.body;
      if (!b) return 0;
      const isReviewIframe =
        window.location.href.includes('articulateusercontent') ||
        window.location.href.includes('/content/') ||
        window.location.href.includes('/review/');
      const controls = document.querySelectorAll(
        'button,a[href],[role="button"],[role="tab"],details,[aria-expanded],input,select',
      ).length;
      return (b.innerText || '').trim().length + controls * 20 + (isReviewIframe ? 1000 : 0);
    })
    .catch(() => 0);
}

/**
 * Many published courses (Rise, Review 360, and other SCORM wrappers) show the lesson in an iframe inside a wrapper page.
 * Controls, text and URL hashes then live in the frame. This returns the frame that holds the content, or the page itself
 * when the page already holds it.
 */
export async function contentRoot(page: Page): Promise<Page | Frame> {
  const main = page.mainFrame();
  const frames = page.frames().filter((f) => f !== main && f.url().startsWith('http') && !/\/(blank|AICCComm)\.html?(\?|$)/i.test(f.url()));
  if (frames.length === 0) return page;
  const mainUrl = main.url();
  const mainScore = await richness(main);
  let best: Frame | undefined;
  let bestScore = Math.max(mainScore * 1.5 + 40, 50);
  for (const f of frames) {
    if (!isAllowedContentFrameOrigin(f.url(), mainUrl)) continue;
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
