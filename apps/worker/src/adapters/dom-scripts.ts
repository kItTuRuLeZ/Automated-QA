/**
 * Functions evaluated inside the course page with `page.evaluate`. Each must
 * be self-contained (no imports or outer references) because Playwright
 * serializes the function source into the page.
 */

export interface StateSnapshot {
  url: string;
  lessonId: string | null;
  dialogs: string[];
  selectedTabs: string[];
  expanded: string[];
  textHash: string;
}

export type ControlCategory = 'tab' | 'accordion' | 'details' | 'dialog_open' | 'dialog_close' | 'next' | 'back' | 'link' | 'unsafe' | 'ambiguous' | 'out_of_scope_link';

export interface RawControl {
  category: ControlCategory;
  name: string;
  role: string;
  locator: string;
  /** Element controlled by this control (tab panel, accordion region, dialog), when declared. */
  controlsLocator?: string;
  /** For dialog close controls: the dialog element. */
  dialogLocator?: string;
  href?: string;
  detail?: string;
}

export interface SurfaceSnapshot {
  canvases: Array<{ locator: string; width: number; height: number }>;
}

/** Observable state used to build the state signature. */
export function snapshotState(): StateSnapshot {
  const visible = (el: Element) => (el as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? (el as HTMLElement).offsetParent !== null;
  const nameOf = (el: Element): string => {
    const label = el.getAttribute('aria-label');
    if (label) return label.trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
        .trim();
      if (t) return t;
    }
    return ((el as HTMLElement).innerText ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
  };
  const dialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]')].filter(visible).map(nameOf).sort();
  const selectedTabs = [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].filter(visible).map(nameOf).sort();
  const expanded = [
    ...[...document.querySelectorAll('[aria-expanded="true"]')].filter(visible).map(nameOf),
    ...[...document.querySelectorAll('details[open] > summary')].filter(visible).map(nameOf),
  ].sort();
  const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 50_000);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const u = new URL(location.href);
  u.search = '';
  const lessonMatch = location.hash.match(/#\/?(?:lessons?|pages?|screens?|slides?)\/([^/?&#]+)/i);
  const lessonAttr = document.querySelector('[data-lesson-id]')?.getAttribute('data-lesson-id') ?? null;
  return { url: u.toString(), lessonId: lessonMatch?.[1] ?? lessonAttr, dialogs, selectedTabs, expanded, textHash: h.toString(16) };
}

/** Finds candidate controls in the current state and classifies them. Nothing is clicked here. */
export function discoverControls(args: { allowedOrigins: string[]; allowedPathPrefixes: string[]; deniedPatterns: string[]; maxAmbiguous: number }): RawControl[] {
  const visible = (el: Element) => (el as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? (el as HTMLElement).offsetParent !== null;
  const disabled = (el: Element) => (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
  const nameOf = (el: Element): string => {
    const label = el.getAttribute('aria-label');
    if (label) return label.trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
        .trim();
      if (t) return t;
    }
    const text = ((el as HTMLElement).innerText ?? el.textContent ?? '').trim().replace(/\s+/g, ' ');
    if (text) return text.slice(0, 100);
    const img = el.querySelector('img[alt]');
    if (img?.getAttribute('alt')) return img.getAttribute('alt')!.trim();
    return (el.getAttribute('title') ?? (el as HTMLInputElement).value ?? '').trim();
  };
  const cssPath = (el: Element): string => {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      if (cur.id && document.querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const tag = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
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
  const controlled = (el: Element): Element | null => {
    const id = el.getAttribute('aria-controls')?.split(/\s+/)[0];
    return id ? document.getElementById(id) : null;
  };
  const denied = (name: string) => {
    const n = name.toLowerCase();
    return args.deniedPatterns.find((p) => n.includes(p.toLowerCase()));
  };
  const inScope = (u: URL) =>
    args.allowedOrigins.includes(u.origin) && (args.allowedPathPrefixes.length === 0 || args.allowedPathPrefixes.some((p) => u.pathname.startsWith(p)));

  // When a modal dialog is open, only its contents are reachable.
  const openDialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]')].filter(visible);
  const modal = openDialogs.find((d) => d.getAttribute('aria-modal') === 'true' || (d.tagName === 'DIALOG' && (d as HTMLDialogElement).matches(':modal')));
  const root: ParentNode = modal ?? document;

  const out: RawControl[] = [];
  const seen = new Set<Element>();
  const push = (el: Element, c: Omit<RawControl, 'name' | 'role' | 'locator'> & { name?: string }) => {
    if (seen.has(el)) return;
    seen.add(el);
    out.push({ name: c.name ?? nameOf(el), role: el.getAttribute('role') ?? el.tagName.toLowerCase(), locator: cssPath(el), ...c });
  };

  const interactive = [...root.querySelectorAll('button, [role="button"], [role="tab"], a[href], input[type="submit"], input[type="button"], input[type="reset"], input[type="file"], summary')].filter(
    (el) => visible(el) && !disabled(el),
  );

  for (const el of interactive) {
    const name = nameOf(el);
    const type = el.tagName === 'INPUT' ? (el as HTMLInputElement).type.toLowerCase() : undefined;
    const deniedBy = denied(name);
    if (type === 'submit' || type === 'reset' || type === 'file' || deniedBy) {
      push(el, { category: 'unsafe', name, detail: deniedBy ? `Name matches "${deniedBy}"` : `Input type ${type}` });
      continue;
    }
    if (el.closest('form') && el.tagName === 'BUTTON' && ((el as HTMLButtonElement).type === 'submit' || !el.getAttribute('type'))) {
      push(el, { category: 'unsafe', name, detail: 'Button submits a form' });
      continue;
    }
    if (el.getAttribute('role') === 'tab') {
      if (el.getAttribute('aria-selected') !== 'true') {
        const panel = controlled(el);
        push(el, { category: 'tab', name, controlsLocator: panel ? cssPath(panel) : undefined });
      } else seen.add(el); // already selected: nothing to do
      continue;
    }
    if (el.tagName === 'SUMMARY') {
      const details = el.parentElement;
      if (details?.tagName === 'DETAILS' && !(details as HTMLDetailsElement).open) push(el, { category: 'details', name, controlsLocator: cssPath(details) });
      continue;
    }
    const popup = el.getAttribute('aria-haspopup');
    const target = controlled(el);
    const targetIsDialog = target && (target.getAttribute('role') === 'dialog' || target.getAttribute('role') === 'alertdialog' || target.tagName === 'DIALOG');
    if (popup === 'dialog' || targetIsDialog) {
      push(el, { category: 'dialog_open', name, controlsLocator: target ? cssPath(target) : undefined });
      continue;
    }
    if (el.getAttribute('aria-expanded') === 'false' && target) {
      push(el, { category: 'accordion', name, controlsLocator: cssPath(target) });
      continue;
    }
    if (el.getAttribute('aria-expanded') === 'true' && target) {
      seen.add(el); // already expanded: collapsing returns to a known state
      continue;
    }
    const dialog = el.closest('[role="dialog"],[role="alertdialog"],dialog');
    if (dialog && /^(close|dismiss|×|✕|x|ok|okay|done|cancel|got it)\b/i.test(name)) {
      push(el, { category: 'dialog_close', name, dialogLocator: cssPath(dialog) });
      continue;
    }
    if (/^(next|continue|next page|›|→|»)(\s|$)/i.test(name)) {
      push(el, { category: 'next', name });
      continue;
    }
    if (/^(back|previous|prev|‹|←|«)(\s|$)/i.test(name)) {
      push(el, { category: 'back', name });
      continue;
    }
    if (el.tagName === 'A') {
      const raw = el.getAttribute('href') ?? '';
      if (!raw || raw === '#' || el.hasAttribute('download')) continue;
      let u: URL;
      try {
        u = new URL(raw, location.href);
      } catch {
        continue;
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      const samePage = u.origin === location.origin && u.pathname === location.pathname && u.search === location.search;
      // In-page anchors (#section) are not navigation; hash routes (#/lesson/2) are.
      if (samePage && !/^#[!/]/.test(u.hash)) continue;
      if (samePage && u.hash === location.hash) continue;
      push(el, { category: inScope(u) ? 'link' : 'out_of_scope_link', name, href: u.toString() });
      continue;
    }
  }

  let ambiguous = 0;
  for (const el of interactive) {
    if (seen.has(el) || el.tagName === 'A' || el.tagName === 'SUMMARY') continue;
    if (ambiguous++ >= args.maxAmbiguous) break;
    push(el, { category: 'ambiguous' });
  }
  return out;
}

/** Large visible canvases: content the DOM checks cannot inspect. */
export function surfaceScan(): SurfaceSnapshot {
  const canvases = [...document.querySelectorAll('canvas')]
    .map((c) => ({ c, r: c.getBoundingClientRect() }))
    .filter(({ c, r }) => r.width * r.height >= 10_000 && ((c as HTMLElement).checkVisibility?.() ?? true))
    .map(({ c, r }) => ({ locator: c.id ? `#${CSS.escape(c.id)}` : `canvas:nth-of-type(${[...document.querySelectorAll('canvas')].indexOf(c) + 1})`, width: Math.round(r.width), height: Math.round(r.height) }));
  return { canvases };
}
