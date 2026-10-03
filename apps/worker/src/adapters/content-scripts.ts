/**
 * In-page collectors for Phase 2b checks. Like dom-scripts.ts, each function
 * is serialized into the page and must be self-contained.
 */

export interface LinkInfo {
  href: string;
  resolved: string | null;
  kind: 'http' | 'javascript' | 'empty' | 'malformed' | 'mailto' | 'tel' | 'fragment' | 'other';
  /** True when the destination was read from a script link that opens a URL (for example Storyline's DS.windowOpen.open). */
  viaScript?: boolean;
  text: string;
  locator: string;
}

export interface ImageInfo {
  src: string;
  alt: string | null;
  locator: string;
  complete: boolean;
  naturalWidth: number;
  decodeFailed: boolean;
  visible: boolean;
}

export interface MediaInfo {
  tag: 'audio' | 'video';
  src: string;
  locator: string;
  errorCode: number | null;
  networkState: number;
  readyState: number;
  preload: string;
  controls: boolean;
  autoplay: boolean;
  muted: boolean;
  tracks: Array<{ kind: string; label: string; src: string }>;
}

export interface TextMatch {
  ruleId: 'TXT-001' | 'TXT-002';
  match: string;
  context: string;
  locator: string;
  pattern: string;
  preferred?: string;
}

export interface ResourceSize {
  url: string;
  initiatorType: string;
  encodedBodySize: number;
}

export interface PageContent {
  /** A visible play/pause/mute control exists, so media may be driven by a custom player. */
  customMediaControls: boolean;
  links: LinkInfo[];
  images: ImageInfo[];
  media: MediaInfo[];
  text: TextMatch[];
  resources: ResourceSize[];
}

/** Scrolls through the page in steps so lazy-loaded images and media start loading. */
export async function scrollThrough(): Promise<void> {
  const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
  const max = Math.min(document.documentElement.scrollHeight, 40_000);
  for (let y = 0; y < max; y += step) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 120));
  }
  window.scrollTo(0, document.documentElement.scrollHeight);
  await new Promise((r) => setTimeout(r, 300));
  window.scrollTo(0, 0);
}

export async function collectPageContent(args: { placeholderPatterns: string[]; terminology: Array<{ term: string; preferred?: string; pattern?: boolean }>; exclusions: string[] }): Promise<PageContent> {
  const visible = (el: Element) => (el as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? (el as HTMLElement).offsetParent !== null;
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
  const text = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();

  // ---- links ----
  const links: LinkInfo[] = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    const t = text(a) || a.getAttribute('aria-label') || a.querySelector('img[alt]')?.getAttribute('alt') || '';
    let kind: LinkInfo['kind'];
    let resolved: string | null = null;
    const trimmed = href.trim();
    if (!trimmed) kind = 'empty';
    else if (/^javascript:/i.test(trimmed)) {
      // Authoring tools open real URLs from script links (Storyline: DS.windowOpen.open({ url: '...' })); check that destination instead.
      const m = trimmed.match(/url\s*:\s*(['"])(https?:\/\/[^'"]+)\1/i);
      if (m) {
        try {
          resolved = new URL(m[2]!).toString();
        } catch {
          resolved = null;
        }
      }
      if (resolved) {
        links.push({ href: href.slice(0, 2048), resolved, kind: 'http', text: t.slice(0, 120), locator: cssPath(a), viaScript: true });
        continue;
      }
      kind = 'javascript';
    }
    else if (/^mailto:/i.test(trimmed)) kind = 'mailto';
    else if (/^tel:/i.test(trimmed)) kind = 'tel';
    else if (trimmed.startsWith('#')) kind = 'fragment';
    else {
      try {
        const u = new URL(trimmed, location.href);
        resolved = u.toString();
        kind = u.protocol === 'http:' || u.protocol === 'https:' ? 'http' : 'other';
      } catch {
        kind = 'malformed';
      }
    }
    links.push({ href: href.slice(0, 2048), resolved, kind, text: t.slice(0, 120), locator: cssPath(a) });
  }

  // ---- images ----
  const images: ImageInfo[] = [];
  for (const img of document.querySelectorAll('img')) {
    const src = img.currentSrc || img.getAttribute('src') || '';
    if (!src || src.startsWith('data:')) continue;
    let decodeFailed = false;
    if (img.complete && img.naturalWidth === 0) {
      decodeFailed = await img.decode().then(
        () => false,
        () => true,
      );
    }
    images.push({ src, alt: img.getAttribute('alt'), locator: cssPath(img), complete: img.complete, naturalWidth: img.naturalWidth, decodeFailed, visible: visible(img) });
  }

  // ---- audio / video ----
  const media: MediaInfo[] = [];
  for (const m of document.querySelectorAll('audio, video')) {
    const el = m as HTMLMediaElement;
    media.push({
      tag: m.tagName.toLowerCase() as 'audio' | 'video',
      src: el.currentSrc || el.getAttribute('src') || m.querySelector('source')?.getAttribute('src') || '',
      locator: cssPath(m),
      errorCode: el.error?.code ?? null,
      networkState: el.networkState,
      readyState: el.readyState,
      preload: el.preload,
      controls: el.controls,
      autoplay: el.autoplay,
      muted: el.muted,
      tracks: [...m.querySelectorAll('track')].map((t) => ({ kind: t.getAttribute('kind') ?? 'subtitles', label: t.getAttribute('label') ?? '', src: t.getAttribute('src') ?? '' })),
    });
  }

  // ---- text: deepest visible elements whose text matches ----
  const excluded = (s: string) => args.exclusions.some((x) => s.toLowerCase().includes(x.toLowerCase()));
  const compile = (p: string) => (p.startsWith('cs:') ? new RegExp(p.slice(3), 'g') : new RegExp(p, 'gi'));
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules: Array<{ ruleId: 'TXT-001' | 'TXT-002'; re: RegExp; pattern: string; preferred?: string }> = [
    ...args.placeholderPatterns.map((p) => ({ ruleId: 'TXT-001' as const, re: compile(p), pattern: p })),
    ...args.terminology.map((t) => ({ ruleId: 'TXT-002' as const, re: t.pattern ? new RegExp(t.term, 'gi') : new RegExp(`\\b${escapeRe(t.term)}\\b`, 'gi'), pattern: t.term, preferred: t.preferred })),
  ];
  const textMatches: TextMatch[] = [];
  const elements = [...document.body.querySelectorAll('*')].filter((e) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG'].includes(e.tagName)).slice(0, 8000);
  for (const r of rules) {
    const hits = elements.filter((e) => {
      r.re.lastIndex = 0;
      return r.re.test(text(e)) && visible(e);
    });
    const deepest = hits.filter((e) => !hits.some((o) => o !== e && e.contains(o)));
    for (const e of deepest) {
      const t = text(e);
      r.re.lastIndex = 0;
      for (const m of t.matchAll(r.re)) {
        const start = Math.max(0, (m.index ?? 0) - 50);
        const context = t.slice(start, (m.index ?? 0) + m[0].length + 50);
        if (excluded(context)) continue;
        textMatches.push({ ruleId: r.ruleId, match: m[0].slice(0, 120), context, locator: cssPath(e), pattern: r.pattern, preferred: r.preferred });
        if (textMatches.length > 500) break;
      }
    }
  }

  // ---- transfer sizes (only where the browser exposes them) ----
  const resources: ResourceSize[] = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
    .filter((e) => ['img', 'image', 'video', 'audio', 'media'].includes(e.initiatorType) || /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mp3|m4a|wav|ogg)(\?|$)/i.test(e.name))
    .map((e) => ({ url: e.name, initiatorType: e.initiatorType, encodedBodySize: e.encodedBodySize }));

  const customMediaControls = [...document.querySelectorAll('button, [role="button"]')].some((b) => {
    const n = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
    return /^(play|pause|mute|unmute)\b/i.test(n) && visible(b);
  });

  return { customMediaControls, links, images, media, text: textMatches, resources };
}
