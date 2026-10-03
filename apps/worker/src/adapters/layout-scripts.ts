/**
 * In-page measurements for Phase 4. Serialized into the page by Playwright, so
 * each function is self-contained. Every rule here is a heuristic: geometry
 * that intersects or overflows is a signal to review, not proof of a defect.
 */

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutMeasure {
  viewport: { width: number; height: number };
  overflow: { scrollWidth: number; clientWidth: number; offenders: Array<{ selector: string; text: string; bounds: Bounds }> };
  clipped: Array<{ selector: string; text: string; scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number; bounds: Bounds }>;
  obscured: { tested: number; items: Array<{ selector: string; name: string; coveredBy: string; coveredBySelector: string; bounds: Bounds }> };
  dialogs: Array<{ selector: string; name: string; bounds: Bounds; reason: string }>;
  fontErrors: string[];
  fonts: { loaded: number; errors: number };
}

/** Waits (bounded) for web fonts and visible images to settle before measuring or taking a screenshot. */
export async function settleVisuals(): Promise<{ fontsSettled: boolean; imagesPending: number }> {
  let fontsSettled = true;
  try {
    const fonts = (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts;
    if (fonts) {
      fontsSettled = await Promise.race([fonts.ready.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 3000))]);
    }
  } catch {
    fontsSettled = false;
  }
  const deadline = Date.now() + 2000;
  const pending = () => [...document.images].filter((i) => !i.complete && i.getBoundingClientRect().width > 0 && i.loading !== 'lazy');
  while (pending().length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  return { fontsSettled, imagesPending: pending().length };
}

export function measureLayout(): LayoutMeasure {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const rectOf = (el: Element): Bounds => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const visible = (el: Element) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0 && el.getAttribute('aria-hidden') !== 'true';
  };
  const cssPath = (e: Element): string => {
    if (e.id && document.querySelectorAll(`#${CSS.escape(e.id)}`).length === 1) return `#${CSS.escape(e.id)}`;
    const parts: string[] = [];
    let cur: Element | null = e;
    while (cur && cur !== document.documentElement) {
      if (cur.id && document.querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const parent: Element | null = cur.parentElement;
      const tag = cur.tagName.toLowerCase();
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const same = [...parent.children].filter((c) => c.tagName === cur!.tagName);
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
      cur = parent;
    }
    return parts.join(' > ');
  };
  const nameOf = (el: Element) => (el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.getAttribute('title') || (el as HTMLInputElement).value || el.tagName.toLowerCase()).trim().replace(/\s+/g, ' ').slice(0, 60);
  const textOf = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);

  // ---- LAY-001: horizontal overflow of the page ----
  const doc = document.documentElement;
  const scrollWidth = Math.max(doc.scrollWidth, document.body?.scrollWidth ?? 0);
  const offenders: LayoutMeasure['overflow']['offenders'] = [];
  // If the page hides horizontal overflow (overflow-x hidden or clip on the viewport), learners cannot scroll sideways: not a problem.
  const rootOx = getComputedStyle(doc).overflowX;
  const effectiveOx = rootOx === 'visible' ? getComputedStyle(document.body).overflowX : rootOx;
  const userCanScrollSideways = effectiveOx !== 'hidden' && effectiveOx !== 'clip';
  if (scrollWidth > vw + 1 && userCanScrollSideways) {
    const insideScroller = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body && p !== doc; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if ((ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') && p.scrollWidth > p.clientWidth) return true;
      }
      return false;
    };
    for (const el of document.body.querySelectorAll('*')) {
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed') continue;
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && !insideScroller(el)) {
        offenders.push({ selector: cssPath(el), text: textOf(el), bounds: rectOf(el) });
        if (offenders.length >= 6) break;
      }
    }
  }

  // ---- LAY-002: text clipped by its container ----
  const clipped: LayoutMeasure['clipped'] = [];
  const all = [...document.body.querySelectorAll('*')].slice(0, 6000);
  for (const el of all) {
    if (clipped.length >= 8) break;
    if (!(el instanceof HTMLElement) || ['SCRIPT', 'STYLE', 'SELECT', 'INPUT', 'TEXTAREA', 'SVG', 'CANVAS'].includes(el.tagName)) continue;
    const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length >= 3);
    if (!hasOwnText || !visible(el)) continue;
    if (el.clientWidth <= 1 || el.clientHeight <= 1) continue; // visually hidden helper text
    const cs = getComputedStyle(el);
    const hidesX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
    const hidesY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
    const clampsLines = (cs as unknown as Record<string, string>)['webkitLineClamp'] && (cs as unknown as Record<string, string>)['webkitLineClamp'] !== 'none';
    const ellipsis = cs.textOverflow === 'ellipsis';
    const wide = hidesX && el.scrollWidth > el.clientWidth + 2 && !ellipsis;
    const tall = hidesY && el.scrollHeight > el.clientHeight + 2 && !clampsLines && !ellipsis;
    if (wide || tall) {
      clipped.push({ selector: cssPath(el), text: textOf(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, bounds: rectOf(el) });
    }
  }

  // ---- LAY-003: controls covered by another element ----
  const openModal = [...document.querySelectorAll('[aria-modal="true"], dialog:modal')].some((d) => visible(d));
  const controls = [...document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="link"]')].filter(visible);
  const obscured: LayoutMeasure['obscured']['items'] = [];
  let tested = 0;
  for (const el of controls) {
    if (obscured.length >= 8) break;
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue;
    const cs = getComputedStyle(el);
    if (cs.pointerEvents === 'none') continue;
    // Skip links and other visually hidden controls (shown only on focus) are hidden on purpose.
    if (cs.opacity === '0' || (cs.clipPath && cs.clipPath !== 'none') || (cs.clip && cs.clip !== 'auto')) continue;
    if (/^skip (to|navigation|nav|main)/i.test(nameOf(el))) continue;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > vw || cy > vh) continue; // outside the viewport: not tested
    if (openModal && !el.closest('[aria-modal="true"], dialog:modal')) continue; // behind a modal on purpose
    tested++;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) continue;
    if (el.closest('label') && el.closest('label') === hit.closest('label')) continue;
    if (hit.closest('[role="tooltip"]')) continue;
    obscured.push({ selector: cssPath(el), name: nameOf(el), coveredBy: nameOf(hit), coveredBySelector: cssPath(hit), bounds: rectOf(el) });
  }

  // ---- LAY-004: open dialogs partly outside the viewport ----
  const dialogs: LayoutMeasure['dialogs'] = [];
  for (const d of document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')) {
    if (!visible(d)) continue;
    const r = d.getBoundingClientRect();
    const cs = getComputedStyle(d);
    const scrollsInside = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && d.scrollHeight > d.clientHeight;
    const reasons: string[] = [];
    if (r.left < -2) reasons.push(`extends ${Math.round(-r.left)} px past the left edge`);
    if (r.right > vw + 2) reasons.push(`extends ${Math.round(r.right - vw)} px past the right edge`);
    if (r.top < -2) reasons.push(`extends ${Math.round(-r.top)} px above the top edge`);
    if (r.bottom > vh + 2 && !scrollsInside) reasons.push(`extends ${Math.round(r.bottom - vh)} px below the bottom edge`);
    if (reasons.length) dialogs.push({ selector: cssPath(d), name: nameOf(d), bounds: rectOf(d), reason: reasons.join(', ') });
  }

  // ---- LAY-005: web fonts that failed to load ----
  const fontErrors: string[] = [];
  let loaded = 0;
  const faces = (document as unknown as { fonts?: Iterable<{ family: string; status: string }> }).fonts;
  if (faces) {
    for (const f of faces) {
      if (f.status === 'error') fontErrors.push(f.family.replace(/['"]/g, ''));
      else if (f.status === 'loaded') loaded++;
    }
  }

  return {
    viewport: { width: vw, height: vh },
    overflow: { scrollWidth: userCanScrollSideways ? scrollWidth : Math.min(scrollWidth, vw), clientWidth: vw, offenders },
    clipped,
    obscured: { tested, items: obscured },
    dialogs,
    fontErrors: [...new Set(fontErrors)],
    fonts: { loaded, errors: fontErrors.length },
  };
}

/**
 * Recognizes Storyline output, which is a fixed-size stage that scales rather than reflows.
 * Markers: Storyline's loader and player globals, its story_content folder, and its bootstrapper script.
 */
export function detectPlatform(): 'storyline' | 'unknown' {
  const w = window as unknown as Record<string, unknown>;
  const hasGlobals = typeof w['globalProvideData'] === 'function' || (typeof w['DS'] === 'object' && w['DS'] !== null) || typeof w['g_slideData'] !== 'undefined';
  const hasAssets = Boolean(document.querySelector('script[src*="story_content"], script[src*="bootstrapper.min.js"], script[src*="slides.min.js"], link[href*="story_content"], link[href*="output.min.css"]'));
  return hasGlobals || hasAssets ? 'storyline' : 'unknown';
}

export interface PerfSample {
  available: boolean;
  loadMs: number | null;
  domContentLoadedMs: number | null;
  responseEndMs: number | null;
  requests: number;
  transferredBytes: number;
  /** Resources whose size the browser did not expose (cached, or cross-origin without Timing-Allow-Origin). */
  sizeUnavailable: number;
  largest: Array<{ url: string; bytes: number; type: string }>;
}

export function collectPerf(): PerfSample {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  const sized = res.filter((r) => r.transferSize > 0 || r.encodedBodySize > 0);
  const bytes = (r: PerformanceResourceTiming) => (r.transferSize > 0 ? r.transferSize : r.encodedBodySize);
  const docBytes = nav ? (nav.transferSize > 0 ? nav.transferSize : nav.encodedBodySize) : 0;
  return {
    available: Boolean(nav),
    loadMs: nav ? Math.round(nav.loadEventEnd) : null,
    domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    responseEndMs: nav ? Math.round(nav.responseEnd) : null,
    requests: res.length + (nav ? 1 : 0),
    transferredBytes: sized.reduce((a, r) => a + bytes(r), 0) + docBytes,
    sizeUnavailable: res.length - sized.length,
    largest: sized
      .sort((a, b) => bytes(b) - bytes(a))
      .slice(0, 5)
      .map((r) => ({ url: r.name, bytes: bytes(r), type: r.initiatorType })),
  };
}
