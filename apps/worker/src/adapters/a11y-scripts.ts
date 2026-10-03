/**
 * In-page functions for Phase 3. Serialized into the page by Playwright, so
 * each must be self-contained. axe-core itself is injected into every frame
 * with an init script (which also works under a restrictive CSP).
 */

export interface AxeNode {
  target: string;
  html: string;
  failureSummary: string;
}

export interface AxeRuleResult {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  tags: string[];
  totalNodes: number;
  nodes: AxeNode[];
}

export interface AxeRun {
  version: string;
  violations: AxeRuleResult[];
  incomplete: AxeRuleResult[];
  passes: Array<{ id: string; tags: string[] }>;
  inapplicable: Array<{ id: string; tags: string[] }>;
}

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

export async function runAxe(args: { tags: string[]; maxNodes: number }): Promise<AxeRun | { error: string }> {
  const axe = (window as unknown as { axe?: any }).axe;
  if (!axe) return { error: 'axe-core is not present in this page' };
  try {
    const slim = (list: any[], keepNodes: boolean) =>
      list.map((r) => ({
        id: r.id as string,
        impact: (r.impact ?? null) as string | null,
        help: r.help as string,
        helpUrl: r.helpUrl as string,
        tags: r.tags as string[],
        totalNodes: r.nodes.length as number,
        nodes: keepNodes
          ? r.nodes.slice(0, args.maxNodes).map((n: any) => ({
              target: (Array.isArray(n.target) ? n.target.map((t: unknown) => (Array.isArray(t) ? t.join(' ') : String(t))).join(' >>> ') : String(n.target)).slice(0, 300),
              html: String(n.html ?? '').slice(0, 300),
              failureSummary: String(n.failureSummary ?? '').slice(0, 400),
            }))
          : [],
      }));
    const res = await axe.run(document, {
      runOnly: { type: 'tag', values: args.tags },
      resultTypes: ['violations', 'incomplete'],
      iframes: true,
    });
    return {
      version: String(axe.version),
      violations: slim(res.violations, true),
      incomplete: slim(res.incomplete, true),
      passes: res.passes.map((r: any) => ({ id: r.id as string, tags: r.tags as string[] })),
      inapplicable: res.inapplicable.map((r: any) => ({ id: r.id as string, tags: r.tags as string[] })),
    };
  } catch (err) {
    return { error: String((err as Error)?.message ?? err).slice(0, 300) };
  }
}

export interface FocusInfo {
  /** Stable per-element id assigned by this scanner (data-cqa-id). */
  key: string;
  isBody: boolean;
  tag: string;
  role: string | null;
  name: string;
  selector: string;
  inModal: boolean;
  /** Style signature used by the focus-visible heuristic. */
  focusedStyle: string;
}

/** Prepares a state for a Tab journey: blur, scroll to top, count tabbable elements. */
export function prepareTabbing(): { total: number } {
  (document.activeElement as HTMLElement | null)?.blur?.();
  window.scrollTo(0, 0);
  const visible = (el: Element) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0 && !el.closest('[inert]');
  };
  const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"], audio[controls], video[controls]';
  const total = [...document.querySelectorAll(sel)].filter((el) => {
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) < 0) return false;
    if ((el as HTMLButtonElement).disabled) return false;
    return visible(el);
  }).length;
  return { total };
}

/** Describes the focused element, tagging it with a data-cqa-id the first time it is seen. */
export function describeActive(): FocusInfo {
  const styleSig = (e: Element): string => {
    const s = getComputedStyle(e);
    return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderTopColor, s.borderTopWidth, s.backgroundColor, s.color, s.textDecorationLine, s.opacity].join('|');
  };
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || el === document.documentElement) {
    return { key: 'body', isBody: true, tag: 'body', role: null, name: '', selector: 'body', inModal: false, focusedStyle: '' };
  }
  let key = el.getAttribute('data-cqa-id');
  if (!key) {
    key = `e${Math.random().toString(36).slice(2, 9)}`;
    el.setAttribute('data-cqa-id', key);
  }
  const label = el.getAttribute('aria-label') || (el.innerText ?? '').trim().replace(/\s+/g, ' ') || el.getAttribute('title') || (el as HTMLInputElement).value || '';
  const cssPath = (e: Element): string => {
    if (e.id && document.querySelectorAll(`#${CSS.escape(e.id)}`).length === 1) return `#${CSS.escape(e.id)}`;
    const parts: string[] = [];
    let cur: Element | null = e;
    while (cur && cur !== document.documentElement) {
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
  return {
    key,
    isBody: false,
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    name: label.slice(0, 80),
    selector: cssPath(el).slice(0, 200),
    inModal: Boolean(el.closest('[aria-modal="true"], dialog:modal')),
    focusedStyle: styleSig(el),
  };
}

/** Style signature of an element identified by data-cqa-id while it is NOT focused. */
export function blurredStyle(key: string): string | null {
  const el = document.querySelector(`[data-cqa-id="${key}"]`);
  if (!el || el === document.activeElement) return null;
  const s = getComputedStyle(el);
  return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderTopColor, s.borderTopWidth, s.backgroundColor, s.color, s.textDecorationLine, s.opacity].join('|');
}

/** Native focusability of a control located by CSS selector. */
export function focusabilityOf(locator: string): { found: boolean; focusable: boolean; tag: string; role: string | null; tabindex: string | null } {
  const el = document.querySelector(locator) as HTMLElement | null;
  if (!el) return { found: false, focusable: false, tag: '', role: null, tabindex: null };
  const native = ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(el.tagName) && !(el as HTMLButtonElement).disabled && !(el.tagName === 'A' && !el.hasAttribute('href'));
  const ti = el.getAttribute('tabindex');
  const focusable = (native && (ti === null || Number(ti) >= 0)) || (ti !== null && Number(ti) >= 0);
  return { found: true, focusable, tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), tabindex: ti };
}

/** Where focus is relative to a container located by CSS selector. */
export function focusWithin(locator: string): { inside: boolean; active: string } {
  const c = document.querySelector(locator);
  const a = document.activeElement as HTMLElement | null;
  const active = a && a !== document.body ? `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ''}` : 'body';
  return { inside: Boolean(c && a && c.contains(a)), active };
}

/** Whether the active element is the one located by the selector. */
export function focusIsOn(locator: string): boolean {
  const el = document.querySelector(locator);
  return Boolean(el && el === document.activeElement);
}

/** Horizontal overflow after the viewport has been narrowed to 320 CSS pixels. */
export function measureOverflow(): { scrollWidth: number; clientWidth: number; offenders: Array<{ selector: string; right: number; text: string }> } {
  const doc = document.documentElement;
  const clientWidth = doc.clientWidth;
  const scrollWidth = Math.max(doc.scrollWidth, document.body?.scrollWidth ?? 0);
  const offenders: Array<{ selector: string; right: number; text: string }> = [];
  if (scrollWidth > clientWidth + 1) {
    const inScroller = (el: Element) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if ((ox === 'auto' || ox === 'scroll' || ox === 'hidden') && p.scrollWidth > p.clientWidth) return true;
      }
      return false;
    };
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || s.visibility === 'hidden' || s.display === 'none' || s.position === 'fixed') continue;
      if (r.right > clientWidth + 1 && !inScroller(el)) {
        offenders.push({
          selector: el.id ? `#${CSS.escape(el.id)}` : el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/)[0]}` : ''),
          right: Math.round(r.right),
          text: ((el as HTMLElement).innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 50),
        });
        if (offenders.length >= 5) break;
      }
    }
  }
  return { scrollWidth, clientWidth, offenders };
}
