import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Recognizes the authoring tool that exported a package from files it always
 * writes, and reads the settings it leaves in plain data files. Nothing is run.
 *
 * Built from real exports: Rise 360 (SCORM 2004 4th edition, 2026-10) and
 * Storyline 360 3.126 (SCORM 2004 4th edition). Other versions are recognized
 * by the same files but their settings may be read incompletely.
 */
export interface AuthoringToolInfo {
  tool: 'rise' | 'storyline';
  product: string;
  /** Version the export states, when it states one. Rise exports carry none. */
  version?: string;
  /** Folders and pages holding the tool's own player and SCORM driver code, not course content. */
  runtimePaths: string[];
  /** The tool vendor's own domains (help, telemetry, media services); referenced by every export. */
  vendorHosts: string[];
  /** Page that holds the course itself, when the launch page wraps it in a frame. */
  contentPage?: string;
  /** Plain-language facts read from the export. */
  facts: Array<{ label: string; value: string }>;
  /** Tracking the tool was set to report, as far as the export says. */
  tracking?: {
    /** Rise: "completed-incomplete", "passed-incomplete", "passed-failed", "completed-failed". */
    reporting?: string;
    /** Rise: complete after viewing this percentage of lessons, or with a quiz result. */
    completeWith?: 'percentage' | 'quiz';
    completionPercentage?: number;
  };
  /** Scenarios this tool's adapter can drive without a person writing a journey. */
  scenarios: string[];
  /** Steps run when the person supplies no journey. Selectors use Playwright syntax; "iframe >> internal:control=enter-frame" enters a frame. */
  defaultJourney?: { name: string; steps: Array<{ action: 'click' | 'wait'; target?: string; ms?: number }> };
  adapterVersion: string;
  /** Decoded course text the inspector searches for outside links; dropped before the inspection is stored. */
  contentText?: { text: string; from: string };
  /** What the export itself says the course contains: Rise lessons and blocks, Storyline scenes, slides and layers. */
  outline?: OutlineEntry[];
}

export interface OutlineEntry {
  kind: 'lesson' | 'block' | 'scene' | 'slide' | 'layer';
  /** The tool's own identifier (Rise lesson id; Storyline scene or slide id). */
  id: string;
  title: string;
  /** True when the export gives no title, so a readable fallback was used. */
  titleIsFallback: boolean;
  parentId?: string;
  /** Rise block type, or Storyline slide number, for the reviewer. */
  detail?: string;
}

const stripTags = (s: string): string => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

export const AUTHORING_ADAPTER_VERSION = '1.0 (2026-10)';

const safeRead = (file: string, max = 8 * 1024 * 1024): string | undefined => {
  try {
    if (!existsSync(file) || statSync(file).size > max) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
};
const attrOf = (tag: string | undefined, name: string): string | undefined => (tag ? new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] : undefined);

const RISE_REPORTING: Record<string, string> = {
  'completed-incomplete': 'Complete / Incomplete',
  'passed-incomplete': 'Passed / Incomplete',
  'passed-failed': 'Passed / Failed',
  'completed-failed': 'Complete / Failed',
};

function rise(root: string, has: (rel: string) => boolean): AuthoringToolInfo | undefined {
  if (!has('scormcontent/index.html') || !(has('scormcontent/lib/rise') || has('scormcontent/runtime-data.js'))) return undefined;
  const info: AuthoringToolInfo = {
    tool: 'rise',
    product: 'Rise 360',
    runtimePaths: ['scormcontent/lib/', 'scormdriver/', 'scormcontent/index.html'],
    vendorHosts: ['articulate.com', 'articulateusercontent.com', 'riseusercontent.com', 'rise.com', 'articulate-us.s3.amazonaws.com'],
    contentPage: 'scormcontent/index.html',
    facts: [],
    scenarios: ['Smoke test: Start the course from the cover page (inside the course frame)', 'Smoke test: Leave part-way and reopen (checks bookmark is read back)'],
    defaultJourney: {
      name: 'Smoke test: Rise start course and leave',
      steps: [
        { action: 'click', target: 'iframe[name="scormdriver_content"] >> internal:control=enter-frame >> a.overview__button-enrolled' },
        { action: 'wait', ms: 2500 },
      ],
    },
    adapterVersion: AUTHORING_ADAPTER_VERSION,
  };
  // runtime-data.js is `__jsonp("runtime-data.js", "<base64 JSON>")`: course structure and export settings.
  const raw = safeRead(path.join(root, 'scormcontent', 'runtime-data.js'), 64 * 1024 * 1024);
  const m = raw ? /__jsonp\(\s*"runtime-data\.js"\s*,\s*"([A-Za-z0-9+/=]+)"/.exec(raw) : null;
  if (m) {
    try {
      const data = JSON.parse(Buffer.from(m[1]!, 'base64').toString('utf8')) as {
        course?: { lessons?: Array<{ type?: string; items?: Array<{ type?: string; family?: string }> }>; exportSettings?: { completeWith?: string; completionPercentage?: number; reporting?: string; targetName?: string; quizId?: string | null }; lmsOptions?: { enableExitCourse?: boolean }; navigationMode?: string };
      };
      const course = data.course ?? {};
      info.outline = riseOutline(course.lessons as RiseLesson[] | undefined);
      info.contentText = { text: JSON.stringify(course.lessons ?? []), from: 'scormcontent/runtime-data.js (lesson content)' };
      const lessons = (course.lessons ?? []).filter((l) => l.type !== 'section');
      const blocks = lessons.reduce((n, l) => n + (l.items?.length ?? 0), 0);
      const checks = lessons.reduce((n, l) => n + (l.items ?? []).filter((i) => i.type === 'knowledgeCheck').length, 0);
      const quizzes = lessons.filter((l) => l.type === 'quiz').length;
      info.facts.push({ label: 'Lessons', value: `${lessons.length}${quizzes ? ` (${quizzes} quiz)` : ''}, ${blocks} blocks, ${checks} knowledge check(s)` });
      const es = course.exportSettings ?? {};
      if (es.targetName) info.facts.push({ label: 'Exported as', value: es.targetName });
      const completeWith = es.completeWith === 'quiz' || (es.completeWith !== 'reporting' && es.quizId) ? 'quiz' : es.completeWith ? 'percentage' : undefined;
      info.tracking = { reporting: es.reporting, completeWith, completionPercentage: typeof es.completionPercentage === 'number' ? es.completionPercentage : undefined };
      if (es.reporting) info.facts.push({ label: 'LMS reporting', value: RISE_REPORTING[es.reporting] ?? es.reporting });
      if (completeWith === 'percentage' && info.tracking.completionPercentage !== undefined) info.facts.push({ label: 'Completes when', value: `${info.tracking.completionPercentage}% of lessons are viewed` });
      else if (completeWith === 'quiz') info.facts.push({ label: 'Completes when', value: 'the quiz is passed' });
      if (course.lmsOptions?.enableExitCourse !== undefined) info.facts.push({ label: 'Exit course button', value: course.lmsOptions.enableExitCourse ? 'shown' : 'hidden' });
      if (course.navigationMode) info.facts.push({ label: 'Navigation', value: course.navigationMode === 'restricted' ? 'restricted (lessons unlock in order)' : course.navigationMode });
    } catch {
      info.facts.push({ label: 'Course data', value: 'present but could not be read' });
    }
  }
  return info;
}

interface RiseLesson {
  id?: string;
  type?: string;
  title?: string;
  items?: Array<{ id?: string; type?: string; family?: string; variant?: string; title?: string }>;
}

/** Lessons and the blocks inside them, exactly as the export lists them. Titles that are missing become readable fallbacks. */
function riseOutline(lessons: RiseLesson[] | undefined): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  (lessons ?? []).forEach((l, li) => {
    if (!l.id || l.type === 'section') return;
    out.push({ kind: 'lesson', id: l.id, title: l.title?.trim() || `Lesson ${li + 1}`, titleIsFallback: !l.title?.trim(), detail: l.type });
    (l.items ?? []).forEach((b, bi) => {
      if (!b.id) return;
      const label = [b.family, b.variant].filter((x) => x && x !== b.family).join(' ') || b.family || b.type || 'block';
      out.push({ kind: 'block', id: b.id, title: b.title?.trim() || `Block ${bi + 1}: ${label}`, titleIsFallback: !b.title?.trim(), parentId: l.id, detail: b.type });
    });
  });
  return out;
}

interface StorylineSlide {
  id?: string;
  title?: string;
  lmsId?: string;
  slideNumberInScene?: number;
  slideLayers?: Array<{ id?: string; title?: string; isBaseLayer?: boolean }>;
}
interface StorylineScene {
  id?: string;
  lmsId?: string;
  isMessageScene?: boolean;
  sceneNumber?: number;
  slides?: StorylineSlide[];
}

/** Scenes, slides and layers from html5/data/js/data.js (a JSON string passed to globalProvideData). Player prompt scenes are skipped. */
function storylineOutline(root: string): OutlineEntry[] | undefined {
  const raw = safeRead(path.join(root, 'html5', 'data', 'js', 'data.js'), 16 * 1024 * 1024)?.replace(/^﻿/, '');
  const m = raw ? /globalProvideData\(\s*'data'\s*,\s*'([\s\S]*)'\s*\)\s*;?\s*$/.exec(raw) : null;
  if (!m) return undefined;
  let data: { scenes?: StorylineScene[] };
  try {
    // The payload is a JS single-quoted string literal holding JSON. Read it back the way JavaScript would, then parse the JSON.
    const literal = m[1]!.replace(/\\(.)/g, (_all, c: string) => (c === "'" ? "'" : c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c === '\\' ? '\\' : c === '"' ? '\\"' : `\\${c}`));
    data = JSON.parse(literal) as { scenes?: StorylineScene[] };
  } catch {
    return undefined;
  }
  const out: OutlineEntry[] = [];
  (data.scenes ?? []).forEach((sc, si) => {
    if (sc.isMessageScene || !sc.id) return;
    out.push({ kind: 'scene', id: sc.id, title: `Scene ${sc.sceneNumber ?? si + 1}`, titleIsFallback: true });
    (sc.slides ?? []).forEach((sl, i) => {
      if (!sl.id) return;
      const title = stripTags(sl.title ?? '');
      out.push({ kind: 'slide', id: sl.id, title: title || `Slide ${sl.slideNumberInScene ?? i + 1}`, titleIsFallback: !title, parentId: sc.id, detail: sl.lmsId });
      (sl.slideLayers ?? []).filter((ly) => ly.isBaseLayer === false).forEach((ly, k) => {
        const lt = stripTags(ly.title ?? '');
        out.push({ kind: 'layer', id: ly.id ?? `${sl.id}-layer-${k + 1}`, title: lt || `Layer ${k + 1}`, titleIsFallback: !lt, parentId: sl.id });
      });
    });
  });
  return out;
}

function storyline(root: string, has: (rel: string) => boolean): AuthoringToolInfo | undefined {
  if (!has('story_content') || !(has('html5/lib/scripts/bootstrapper.min.js') || has('story.html'))) return undefined;
  const info: AuthoringToolInfo = {
    tool: 'storyline',
    product: 'Storyline',
    // html5/data/ and story_content/ are this course's own data and scripts, so they are not runtime.
    runtimePaths: ['html5/lib/', 'lms/', 'analytics-frame.html', 'index_lms.html', 'story.html'],
    vendorHosts: ['articulate.com', 'articulateusercontent.com'],
    facts: [],
    scenarios: ['Smoke test: Go forward with the player Next button (three slides)', 'Smoke test: Leave part-way and reopen (checks bookmark is read back)'],
    defaultJourney: {
      name: 'Smoke test: Storyline move forward three slides and leave',
      steps: [
        { action: 'click', target: '#next' },
        { action: 'wait', ms: 1500 },
        { action: 'click', target: '#next' },
        { action: 'wait', ms: 1500 },
        { action: 'click', target: '#next' },
        { action: 'wait', ms: 1500 },
      ],
    },
    adapterVersion: AUTHORING_ADAPTER_VERSION,
  };
  const meta = safeRead(path.join(root, 'meta.xml'), 1024 * 1024);
  const app = meta ? /<application\b[^>]*>/.exec(meta)?.[0] : undefined;
  const project = meta ? /<project\b[^>]*>/.exec(meta)?.[0] : undefined;
  const slidemeta = meta ? /<slidemeta\b[^>]*>/.exec(meta)?.[0] : undefined;
  const version = attrOf(app, 'version');
  if (version) {
    info.version = version;
    // Storyline 360 builds are 3.x; Storyline 3 is 3.<small>; Storyline 2 is 2.x.
    const [maj, min] = version.split('.').map(Number);
    info.product = maj === 3 && (min ?? 0) >= 20 ? 'Storyline 360' : maj === 3 ? 'Storyline 3' : maj === 2 ? 'Storyline 2' : 'Storyline';
  }
  info.outline = storylineOutline(root);
  const slides = attrOf(slidemeta, 'viewslides');
  if (slides) info.facts.push({ label: 'Slides', value: slides });
  const published = attrOf(project, 'datepublished');
  if (published) info.facts.push({ label: 'Published', value: published.replace('T', ' ') });
  const duration = attrOf(project, 'duration');
  if (duration) info.facts.push({ label: 'Stated duration', value: duration });
  return info;
}

export function detectAuthoringTool(root: string, files: Array<{ rel: string }>): AuthoringToolInfo | undefined {
  const set = new Set<string>();
  for (const f of files) {
    set.add(f.rel);
    const parts = f.rel.split('/');
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  const has = (rel: string) => set.has(rel);
  return rise(root, has) ?? storyline(root, has);
}
