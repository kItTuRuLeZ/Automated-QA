/**
 * Functions evaluated inside the course page with `page.evaluate`. Each must
 * be self-contained (no imports or outer references) because Playwright
 * serializes the function source into the page.
 */

export interface StateSnapshot {
  url: string;
  lessonId: string | null;
  /** Title of the current lesson or slide when the player states it (Storyline's selected menu item). */
  lessonTitle?: string;
  dialogs: string[];
  selectedTabs: string[];
  expanded: string[];
  textHash: string;
}

export type ControlCategory = 'tab' | 'accordion' | 'details' | 'dialog_open' | 'dialog_close' | 'next' | 'back' | 'link' | 'unsafe' | 'ambiguous' | 'out_of_scope_link' | 'flip_card' | 'carousel' | 'media';

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
  // Storyline: the player menu marks the current slide with cs-selected and names it by data-ref (_player.<scene>.<slide>).
  const slideItem = document.querySelector('.cs-listitem[data-ref].cs-selected:not(.is-scene)');
  const slideRef = slideItem?.getAttribute('data-ref') ?? null;
  const slideId = slideRef ? slideRef.split('.').pop() ?? null : null;
  const snapshot: { url: string; lessonId: string | null; lessonTitle?: string; dialogs: string[]; selectedTabs: string[]; expanded: string[]; textHash: string } = { url: u.toString(), lessonId: lessonMatch?.[1] ?? lessonAttr ?? slideId, dialogs, selectedTabs, expanded, textHash: h.toString(16) };
  const slideTitle = slideItem?.getAttribute('data-slide-title');
  if (slideTitle) snapshot.lessonTitle = slideTitle.trim();
  return snapshot;
}

/** Finds candidate controls in the current state and classifies them. Nothing is clicked here. */
export function discoverControls(args: { allowedOrigins: string[]; allowedPathPrefixes: string[]; deniedPatterns: string[]; maxAmbiguous: number }): RawControl[] {
  const visible = (el: Element) => {
    if ((el as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? (el as HTMLElement).offsetParent !== null) return true;
    // Storyline draws answers and buttons as graphics and lays real, fully transparent buttons over them for assistive
    // technology. Those are what a learner's click and a screen reader reach, so a transparent one that has a size counts.
    if (el.classList?.contains('acc-shadow-el')) {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && ((el as HTMLElement).checkVisibility?.({ checkVisibilityCSS: true }) ?? true);
    }
    return false;
  };
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
    // A test id survives the page rebuilding around the control; a position in the page may not.
    const testId = el.getAttribute('data-testid');
    if (testId && document.querySelectorAll(`[data-testid="${CSS.escape(testId)}"]`).length === 1) return `[data-testid="${CSS.escape(testId)}"]`;
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
  const push = (el: Element, c: Omit<RawControl, 'name' | 'role' | 'locator'> & { name?: string; locator?: string }) => {
    if (seen.has(el)) return;
    seen.add(el);
    out.push({ name: c.name ?? nameOf(el), role: el.getAttribute('role') ?? el.tagName.toLowerCase(), locator: cssPath(el), ...c });
  };

  const interactive = [...root.querySelectorAll('button, [role="button"], [role="tab"], a[href], input[type="submit"], input[type="button"], input[type="reset"], input[type="file"], summary')].filter(
    // A control inside an inert or aria-hidden part of the page is not something a learner can reach (Rise keeps its "Take again" button there until a quiz ends).
    (el) => visible(el) && !disabled(el) && !el.closest('[inert],[aria-hidden="true"]'),
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
    // Rise flashcards: tested by their own recipe, because a flip changes neither aria-expanded nor a linked panel.
    if (el.matches('.flashcard-side-flip__btn')) {
      push(el, { category: 'flip_card', name });
      continue;
    }
    // Rise's Continue divider reveals the rest of the lesson, whatever its label says.
    if (el.matches('[data-continue-btn]')) {
      push(el, { category: 'next', name });
      continue;
    }
    // A carousel's Next and Previous move inside the screen, so they are not course navigation.
    const carousel = el.closest('[aria-roledescription="carousel"]');
    if (carousel && /\b(next|forward)\b/i.test(name)) {
      push(el, { category: 'carousel', name: carousel.getAttribute('aria-label') ?? name });
      continue;
    }
    if (carousel && /\b(previous|prev|back)\b/i.test(name)) {
      seen.add(el);
      continue;
    }
    if (el.getAttribute('role') === 'tab') {
      if (el.getAttribute('aria-selected') !== 'true') {
        const panel = controlled(el);
        // Rise gives a tab a new random id each time a lesson loads, but its block id and its place among the tabs stay the same.
        const block = el.closest('[data-block-id]');
        const tabs = block ? [...block.querySelectorAll('[role="tab"]')] : [];
        const stable = block ? `[data-block-id="${block.getAttribute('data-block-id')}"] [role="tab"] >> nth=${tabs.indexOf(el)}` : undefined;
        push(el, { category: 'tab', name, controlsLocator: panel ? cssPath(panel) : undefined, ...(stable ? { locator: stable } : {}) });
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
    if (el.getAttribute('aria-expanded') === 'false') {
      push(el, { category: 'accordion', name, controlsLocator: target ? cssPath(target) : undefined });
      continue;
    }
    if (el.getAttribute('aria-expanded') === 'true') {
      seen.add(el); // already expanded: collapsing returns to a known state
      continue;
    }
    // Process block / carousel steppers
    if (el.classList.contains('process-controls__button') || /^(step|slide|carousel|card)\b/i.test(name)) {
      if (/previous|prev|back|left|‹|←/i.test(name)) {
        push(el, { category: 'back', name });
      } else {
        push(el, { category: 'next', name });
      }
      continue;
    }
    const dialog = el.closest('[role="dialog"],[role="alertdialog"],dialog');
    if (dialog && /^(close|dismiss|×|✕|x|ok|okay|done|cancel|got it)\b/i.test(name)) {
      push(el, { category: 'dialog_close', name, dialogLocator: cssPath(dialog) });
      continue;
    }
    // Storyline image buttons are often named after their file ("Next.png", "Next over.png").
    const label = name.replace(/\.(png|jpe?g|gif|svg|webp)$/i, '');
    if (/^(next|continue|next page|start|start course|launch|begin|get started|let's begin|›|→|»)(\s|$)/i.test(label)) {
      push(el, { category: 'next', name });
      continue;
    }
    // "Back to top" scrolls the page; it is not lesson navigation.
    if (/^(back|previous|prev|‹|←|«)(\s|$)/i.test(label) && !/^back to (top|the top)\b/i.test(label)) {
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

  // Audio and video are not in the list above: a custom player's <audio> has no box of its own, and its buttons are checked by the media recipe.
  for (const m of root.querySelectorAll('video, audio')) {
    // A custom player keeps its <video> transparent until it plays, so a video counts when it has a size on the page.
    const box = m.getBoundingClientRect();
    if (m.closest('[inert]') || (m.tagName === 'VIDEO' && (box.width === 0 || box.height === 0))) continue;
    const src = (m as HTMLMediaElement).currentSrc || m.querySelector('source')?.getAttribute('src') || m.getAttribute('src') || '';
    const file = src.startsWith('data:') || src.startsWith('blob:') ? '' : decodeURIComponent(src.split(/[?#]/)[0]?.split('/').pop() ?? '');
    push(m, { category: 'media', name: m.getAttribute('aria-label') || m.getAttribute('title') || file || m.tagName.toLowerCase() });
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
