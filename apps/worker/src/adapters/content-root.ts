import type { Frame, Page } from 'playwright';

/** Public suffixes made of two labels, so "company.co.uk" is one organisation but "evil.co.uk" and "lms.co.uk" are not. */
const TWO_LABEL_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'nhs.uk', 'ltd.uk', 'plc.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'ac.nz', 'govt.nz', 'co.in', 'net.in', 'org.in', 'ac.in', 'gov.in', 'com.br', 'com.mx', 'com.sg', 'edu.sg', 'gov.sg', 'co.jp', 'ac.jp', 'co.za', 'ac.za', 'gov.za', 'com.cn', 'com.hk', 'com.tw', 'co.kr', 'com.my', 'com.ph', 'com.tr', 'co.id', 'ac.id', 'com.ar', 'com.co', 'com.ng', 'co.ke', 'com.pk', 'com.eg', 'com.sa', 'co.il', 'ac.il']);
/** Hosts where anyone can publish their own site under a shared name: two sites there are never one organisation. */
const SHARED_HOSTS = new Set(['gitlab.io', 'workers.dev', 'onrender.com', 'fly.dev', 'glitch.me', 'surge.sh', 'ngrok.io', 'ngrok-free.app', 'trycloudflare.com', 'azureedge.net', 'azurestaticapps.net', 'cloudapp.net', 'windows.net', 'amazonaws.com', 'googleusercontent.com', 'storage.googleapis.com', 'github.io', 'netlify.app', 'vercel.app', 'pages.dev', 'web.app', 'firebaseapp.com', 'herokuapp.com', 'azurewebsites.net', 'blob.core.windows.net', 's3.amazonaws.com', 'cloudfront.net', 'appspot.com', 'blogspot.com', 'wordpress.com', 'sharepoint.com']);

const GENERIC_SECOND_LEVEL = new Set(['com', 'net', 'org', 'edu', 'gov', 'ac', 'co', 'or', 'ne', 'go', 'mil', 'nic', 'sch', 'gob', 'gouv']);

const isIp = (host: string) => /^\d+(\.\d+){3}$/.test(host) || host.includes(':');
/** True when host is the domain itself or a subdomain of it, never a look-alike such as "evilcloudfront.net". */
const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** The organisation a host belongs to, or undefined when that cannot be told safely (IP addresses, shared hosting). */
function organisation(host: string): string | undefined {
  if (isIp(host)) return undefined;
  const labels = host.split('.');
  if ([...SHARED_HOSTS].some((d) => within(host, d))) return undefined;
  // Country domains often register under a generic second level (com.vn, co.th, edu.in): treat those as one suffix too.
  const second = labels[labels.length - 2] ?? '';
  const countryGeneric = labels[labels.length - 1]!.length === 2 && GENERIC_SECOND_LEVEL.has(second);
  const take = TWO_LABEL_SUFFIXES.has(labels.slice(-2).join('.')) || countryGeneric ? 3 : 2;
  return labels.length > take ? labels.slice(-take).join('.') : labels.length === take ? host : undefined;
}

/**
 * Checks whether a frame is an allowed content frame for the host page: the same origin, Articulate Review 360 embeds,
 * or another host of the same organisation. Domains are compared at label boundaries and with two-label public
 * suffixes in mind. The network policy is a separate layer; this only decides which frame is treated as the course.
 */
export function isAllowedContentFrameOrigin(frameUrl: string, mainUrl: string): boolean {
  try {
    const fUrl = new URL(frameUrl);
    const mUrl = new URL(mainUrl);
    if (fUrl.origin === mUrl.origin) return true;
    const f = fUrl.hostname;
    const m = mUrl.hostname;
    // The same host on another port (an LMS and its content server on one machine) is the same course.
    if (f === m) return true;
    if (within(m, 'articulate.com') && ['articulate.com', 'articulateusercontent.com', 'cloudfront.net'].some((d) => within(f, d))) return true;
    const org = organisation(m);
    return Boolean(org && org === organisation(f));
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
