/**
 * In-page collection of visible text styles for brand checks. Serialized into
 * the page by Playwright, so it must be self-contained.
 */
export interface BrandGroup {
  font: string;
  color: string;
  sizePx: number;
  count: number;
  samples: Array<{ selector: string; text: string; bounds: { x: number; y: number; width: number; height: number } }>;
}

export function collectBrandStyles(): { groups: BrandGroup[]; elements: number } {
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
  const groups = new Map<string, BrandGroup>();
  let elements = 0;
  const all = document.body ? document.body.querySelectorAll('*') : [];
  for (const el of all) {
    const tag = el.tagName.toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG') continue;
    let own = '';
    for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent ?? '';
    own = own.trim().replace(/\s+/g, ' ');
    if (!own) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (s.display === 'none' || s.visibility === 'hidden' || r.width <= 0 || r.height <= 0 || Number(s.opacity) === 0) continue;
    elements++;
    const font = (s.fontFamily.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
    const sizePx = Math.round(parseFloat(s.fontSize) * 10) / 10;
    const key = `${font}|${s.color}|${sizePx}`;
    let g = groups.get(key);
    if (!g) {
      if (groups.size >= 200) continue;
      g = { font, color: s.color, sizePx, count: 0, samples: [] };
      groups.set(key, g);
    }
    g.count++;
    if (g.samples.length < 4) g.samples.push({ selector: cssPath(el), text: own.slice(0, 60), bounds: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } });
  }
  return { groups: [...groups.values()], elements };
}
