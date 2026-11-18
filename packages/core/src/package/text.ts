import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Static spelling and wording checks on the course's own text (PKG-012, PKG-013). Text comes from Rise's course data
 * (every lesson, reached or not) or from a plain HTML package's pages. Storyline keeps slide text inside its player
 * data, which is not read here. Every result needs review: a dictionary does not know product names or trade terms.
 */
export type TextRuleId = 'PKG-012' | 'PKG-013';
export interface TextIssue {
  ruleId: TextRuleId;
  outcome: 'passed' | 'needs_review' | 'not_tested' | 'not_applicable';
  reason?: 'not_implemented';
  title?: string;
  detail: string;
  paths?: string[];
}
export interface TextItem {
  /** Where the text is: a lesson title or a file path. */
  where: string;
  text: string;
}

const MAX_SPELLING = 60;
/** Suggestions are slow to work out (they run during the upload), so only the first few words get them. */
const MAX_SUGGESTED = 15;
const TEXT_KEYS = new Set(['title', 'heading', 'paragraph', 'description', 'feedback', 'caption', 'text', 'content', 'label', 'question', 'front', 'back', 'subtitle', 'body', 'note']);

interface Speller {
  correct(word: string): boolean;
  suggest(word: string): string[];
}
let speller: Speller | undefined;
function getSpeller(): Speller {
  if (!speller) {
    const require = createRequire(import.meta.url);
    const nspell = require('nspell') as (d: { aff: Buffer; dic: Buffer }) => Speller;
    // The English (US) Hunspell dictionary, read from disk once. No network.
    const dir = path.dirname(require.resolve('dictionary-en'));
    speller = nspell({ aff: readFileSync(path.join(dir, 'index.aff')), dic: readFileSync(path.join(dir, 'index.dic')) });
  }
  return speller;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/?(p|div|li|ul|ol|h[1-6]|td|th|tr|table|section|article|header|footer|blockquote)\b[^>]*>/gi, '\n')
    // Inline tags join their text as the browser shows it: "<s>l</s>understanding" reads as one word.
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&#(\d+);/g, (all, n: string) => (Number(n) <= 0x10ffff ? String.fromCodePoint(Number(n)) : all))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** The learner-facing text in decoded Rise course data, labelled by lesson. */
export function riseText(course: unknown): TextItem[] {
  const out: TextItem[] = [];
  const add = (where: string, raw: unknown) => {
    if (typeof raw !== 'string' || !/[A-Za-z]{2}/.test(raw)) return;
    const text = htmlToText(raw);
    if (text) out.push({ where, text });
  };
  const walk = (o: unknown, where: string, depth: number) => {
    if (depth > 30 || !o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      for (const v of o) walk(v, where, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === 'string') {
        if (TEXT_KEYS.has(k)) add(where, v);
      } else walk(v, where, depth + 1);
    }
  };
  const c = (course ?? {}) as { title?: unknown; description?: unknown; lessons?: unknown[] };
  add('Course cover', c.title);
  add('Course cover', c.description);
  for (const [i, lesson] of (Array.isArray(c.lessons) ? c.lessons : []).entries()) {
    const l = lesson as { title?: unknown; items?: unknown; type?: unknown };
    const where = `Lesson ${i + 1}: ${typeof l.title === 'string' ? htmlToText(l.title) : '(untitled)'}`;
    add(where, l.title);
    walk(l.items, where, 0);
  }
  return out;
}

/** Visible text of a plain HTML page. */
export function pageText(rel: string, html: string): TextItem[] {
  const body = /<body[\s\S]*?>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const text = htmlToText(body);
  return text ? [{ where: rel, text }] : [];
}

/** The spoken text of a WebVTT or SRT caption file (cue numbers, timings and settings removed). */
export function captionText(rel: string, body: string): TextItem[] {
  const lines = body.split(/\r?\n/).filter((l) => l.trim() && !/^WEBVTT|^NOTE\b|^\d+$|-->/.test(l.trim()));
  const text = htmlToText(lines.join(' '));
  return text ? [{ where: `captions ${path.posix.basename(rel)}`, text }] : [];
}

const snippet =(text: string, at: number, len: number) => {
  const from = Math.max(0, at - 40);
  return `${from > 0 ? '…' : ''}${text.slice(from, at + len + 40).replace(/\s+/g, ' ')}${at + len + 40 < text.length ? '…' : ''}`;
};

/** Words the spelling check skips: anything with a capital (names, acronyms), digits, or fewer than three letters. */
const skipWord = (w: string) => w.length < 3 || /[A-Z0-9]/.test(w);

export function checkText(items: readonly TextItem[], source: string): TextIssue[] {
  const issues: TextIssue[] = [];
  const spell = getSpeller();

  // PKG-012: spelling.
  const unknown = new Map<string, { count: number; where: string; context: string }>();
  for (const it of items) {
    for (const m of it.text.matchAll(/[A-Za-z][A-Za-z'’]*[A-Za-z]/g)) {
      const word = m[0].replace(/['’]s$/i, '').replace(/’/g, "'");
      if (skipWord(word)) continue;
      if (spell.correct(word)) continue;
      const cur = unknown.get(word);
      if (cur) cur.count++;
      else unknown.set(word, { count: 1, where: it.where, context: snippet(it.text, m.index!, m[0].length) });
    }
  }
  const words = [...unknown.entries()].sort((a, b) => a[1].count - b[1].count || a[0].localeCompare(b[0]));
  for (const [i, [word, u]] of words.slice(0, MAX_SPELLING).entries()) {
    const suggestions = i < MAX_SUGGESTED && word.length <= 15 ? spell.suggest(word).slice(0, 3) : [];
    issues.push({
      ruleId: 'PKG-012',
      outcome: 'needs_review',
      title: `Possible misspelling: "${word}" (${u.where})`,
      detail: `"${word}" is not in the English dictionary${suggestions.length ? `. Did you mean ${suggestions.map((s) => `"${s}"`).join(', ')}?` : ', and no close word was found; it may be a trade term.'} Found ${u.count} time(s), first in ${u.where}: "${u.context}". If it is right, mark it "Not a real issue".`,
    });
  }
  if (words.length > MAX_SPELLING) issues.push({ ruleId: 'PKG-012', outcome: 'needs_review', title: `${words.length - MAX_SPELLING} more words not in the dictionary`, detail: `Only the ${MAX_SPELLING} rarest are listed.` });
  if (!words.length) issues.push({ ruleId: 'PKG-012', outcome: 'passed', detail: `Every lower-case word in ${items.length} text item(s) from ${source} is in the English (US) dictionary. Words with capitals (names, acronyms) are not checked.` });

  // PKG-013: missing space after a full stop, a term written two ways, mixed quote styles.
  const wording: TextIssue[] = [];
  for (const it of items) {
    for (const m of it.text.matchAll(/([a-z]{2,})([.!?])([A-Z][a-z]+)/g)) {
      const before = it.text.slice(Math.max(0, m.index! - 30), m.index!);
      if (/[@/]|www\.|https?:\S*$/i.test(before) || /^(com|org|net|gov|edu|html?|js|pdf)/i.test(m[3]!)) continue;
      wording.push({ ruleId: 'PKG-013', outcome: 'needs_review', title: `Missing space after "${m[2]}" (${it.where})`, detail: `"${m[1]}${m[2]}${m[3]}" in ${it.where}: "${snippet(it.text, m.index!, m[0].length)}".` });
    }
  }
  const forms = new Map<string, Map<string, { n: number; shown: string }>>();
  for (const it of items) {
    for (const m of it.text.matchAll(/[A-Za-z]+(?:-[A-Za-z]+)*/g)) {
      const w = m[0];
      if (w.length < 4) continue;
      const key = w.toLowerCase().replace(/-/g, '');
      // A capital only at the start (sentence start), or all capitals (a button label), is the same form as the lower-case word.
      const form = w === w.toUpperCase() ? w.toLowerCase() : w.charAt(0).toLowerCase() + w.slice(1);
      const f = forms.get(key) ?? new Map<string, { n: number; shown: string }>();
      const cur = f.get(form) ?? { n: 0, shown: w };
      cur.n++;
      f.set(form, cur);
      forms.set(key, f);
    }
  }
  for (const f of forms.values()) {
    if (f.size < 2) continue;
    const list = [...f.values()].sort((a, b) => b.n - a.n);
    const shown = list.map((x) => `"${x.shown}" (${x.n}×)`).join(' vs ');
    wording.push({ ruleId: 'PKG-013', outcome: 'needs_review', title: `Same term written ${list.length} ways: ${shown}`, detail: `The term appears as ${shown}. Pick one spelling and use it throughout.` });
  }
  const curly = items.filter((i) => /[‘’“”]/.test(i.text));
  const straight = items.filter((i) => /[A-Za-z]'[A-Za-z]|"[A-Za-z]/.test(i.text));
  if (curly.length && straight.length) {
    wording.push({ ruleId: 'PKG-013', outcome: 'needs_review', title: 'Straight and curly quotes are mixed', detail: `${curly.length} text item(s) use curly quotes or apostrophes and ${straight.length} use straight ones, for example ${straight[0]!.where}: "${straight[0]!.text.slice(0, 80)}". Pick one style.` });
  }
  if (wording.length) issues.push(...wording.slice(0, 60));
  else issues.push({ ruleId: 'PKG-013', outcome: 'passed', detail: `No missing spaces after full stops, no term written two ways, and one quote style, in ${items.length} text item(s) from ${source}.` });
  return issues;
}

export function checkPackageText(root: string, files: ReadonlyArray<{ rel: string; bytes: number }>, tool?: { tool: string; product: string; courseData?: unknown }): TextIssue[] {
  if (tool?.tool === 'storyline') {
    const note = 'Storyline keeps slide text inside its player data, which this check does not read. Check spelling in Storyline itself.';
    return [{ ruleId: 'PKG-012', outcome: 'not_tested', reason: 'not_implemented', detail: note }, { ruleId: 'PKG-013', outcome: 'not_tested', reason: 'not_implemented', detail: note }];
  }
  let items: TextItem[] = [];
  let source = '';
  if (tool?.courseData !== undefined) {
    items = riseText(tool.courseData);
    source = `${tool.product}'s course data`;
  } else {
    for (const f of files.filter((x) => /\.html?$/i.test(x.rel) && x.bytes < 2 * 1024 * 1024).slice(0, 200)) {
      try {
        items.push(...pageText(f.rel, readFileSync(path.join(root, f.rel), 'utf8')));
      } catch {
        /* unreadable page: skipped */
      }
    }
    source = 'the HTML pages';
  }
  // Caption files are text the learner reads too.
  for (const f of files.filter((x) => /\.(vtt|srt)$/i.test(x.rel) && x.bytes < 2 * 1024 * 1024).slice(0, 50)) {
    try {
      items.push(...captionText(f.rel, readFileSync(path.join(root, f.rel), 'utf8')));
    } catch {
      /* unreadable caption file: skipped */
    }
  }
  if (!items.length) {
    const note = `No course text was found in ${source || 'the package'}, so there was nothing to spell-check.`;
    return [{ ruleId: 'PKG-012', outcome: 'not_applicable', detail: note }, { ruleId: 'PKG-013', outcome: 'not_applicable', detail: note }];
  }
  return checkText(items, source);
}
