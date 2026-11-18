import type { Page } from 'playwright';
import { htmlToText } from '@cqa/core';

/**
 * Rise knowledge checks that lock the lesson's Continue button until they are answered correctly. With "answer quiz
 * questions automatically" on, the walk answers them with the answers stored in the course's own data
 * (runtime-data.js), the way a learner who knew the answers would, so it can reach the lessons after them.
 * This only helps the walk: it never judges whether the course marks answers correctly (that needs a reviewed answer
 * key). The course data is untrusted: it only decides which visible option is clicked, and never runs as code.
 */
export interface RiseQuestion {
  blockId: string;
  type: string;
  /** Plain text of each correct answer. */
  correct: string[];
}

const ANSWERABLE = new Set(['MULTIPLE_CHOICE', 'MULTIPLE_RESPONSE']);

/** Plain text of an answer's HTML title on one line, as the option shows it. */
export function plainText(html: string): string {
  return htmlToText(html).replace(/\s+/g, ' ').trim();
}

/** Knowledge-check questions in decoded Rise course data, by block. */
export function riseQuestions(course: unknown): RiseQuestion[] {
  const out: RiseQuestion[] = [];
  const lessons = (course as { lessons?: unknown[] } | undefined)?.lessons;
  if (!Array.isArray(lessons)) return out;
  for (const lesson of lessons) {
    const items = (lesson as { items?: unknown[] }).items;
    if (!Array.isArray(items)) continue;
    for (const block of items as Array<{ id?: unknown; type?: unknown; items?: unknown[] }>) {
      if (block.type !== 'knowledgeCheck' || typeof block.id !== 'string' || !Array.isArray(block.items)) continue;
      for (const q of block.items as Array<{ type?: unknown; answers?: Array<{ title?: unknown; correct?: unknown }> }>) {
        const answers = Array.isArray(q.answers) ? q.answers : [];
        out.push({ blockId: block.id, type: String(q.type ?? ''), correct: answers.filter((a) => a.correct === true && typeof a.title === 'string').map((a) => plainText(a.title as string)) });
      }
    }
  }
  return out;
}

/** Reads and decodes the course's runtime-data.js from the page's own origin. Undefined when it could not be read. */
export async function loadRiseQuestions(cur: Page): Promise<RiseQuestion[] | undefined> {
  const course = await cur
    .evaluate(async () => {
      const res = await fetch(new URL('runtime-data.js', location.href).href);
      if (!res.ok) return null;
      const m = /__jsonp\(\s*"runtime-data\.js"\s*,\s*"([A-Za-z0-9+/=]+)"/.exec(await res.text());
      if (!m) return null;
      const bytes = Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0));
      const data = JSON.parse(new TextDecoder().decode(bytes)) as { course?: { lessons?: Array<{ items?: Array<{ id?: string; type?: string; items?: unknown[] }> }> } };
      // Only the knowledge-check blocks travel back.
      return { lessons: (data.course?.lessons ?? []).map((l) => ({ items: (l.items ?? []).filter((b) => b.type === 'knowledgeCheck') })) };
    })
    .catch(() => null);
  if (!course) return undefined;
  try {
    return riseQuestions(course);
  } catch {
    return undefined;
  }
}

const css = (s: string) => s.replace(/["\\]/g, '\\$&');

export interface AnswerStep {
  locator: string;
  description: string;
  blockId?: string;
}

/**
 * Answers every knowledge check on the screen that the course data has answers for and that was not answered before
 * in this walk (`done`). Returns the clicks made (replayed like any other walk step) and, per block it could not
 * answer, why.
 */
export async function answerRiseKnowledgeChecks(cur: Page, questions: readonly RiseQuestion[], settle: () => Promise<void>, done: ReadonlySet<string> = new Set()): Promise<{ steps: AnswerStep[]; skipped: Array<{ blockId: string; why: string }> }> {
  const steps: AnswerStep[] = [];
  const skipped: Array<{ blockId: string; why: string }> = [];
  const byBlock = new Map<string, RiseQuestion[]>();
  for (const q of questions) byBlock.set(q.blockId, [...(byBlock.get(q.blockId) ?? []), q]);
  for (const [blockId, qs] of byBlock) {
    if (done.has(blockId)) continue;
    const block = `[data-block-id="${css(blockId)}"]`;
    if ((await cur.locator(`${block} >> visible=true`).count().catch(() => 0)) === 0) continue;
    const q = qs[0]!;
    if (qs.length !== 1 || !ANSWERABLE.has(q.type) || q.correct.length === 0) {
      skipped.push({ blockId, why: qs.length !== 1 ? `a knowledge check with ${qs.length} questions in one block` : !ANSWERABLE.has(q.type) ? `a ${q.type.toLowerCase().replace(/_/g, ' ')} knowledge check` : 'a knowledge check with no correct answer in the course data' });
      continue;
    }
    const submit = `${block} [data-testid="quiz-submit-button"] >> visible=true`;
    if ((await cur.locator(submit).count().catch(() => 0)) !== 1) continue; // already answered, or not this layout
    const picks: AnswerStep[] = [];
    for (const answer of q.correct) {
      const option = `${block} [data-testid="quiz-card-option"] >> text="${css(answer)}" >> visible=true`;
      if ((await cur.locator(option).count().catch(() => 0)) !== 1) {
        picks.length = 0;
        skipped.push({ blockId, why: `a knowledge check whose answer "${answer.slice(0, 60)}" was not found on screen exactly once` });
        break;
      }
      picks.push({ locator: option, description: `Knowledge check: choose "${answer.slice(0, 80)}" (the answer stored in the course)`, blockId });
    }
    if (!picks.length) continue;
    try {
      for (const p of picks) {
        await cur.locator(p.locator).first().click({ timeout: 4_000 });
        steps.push(p);
      }
      await cur.locator(submit).first().click({ timeout: 4_000 });
      steps.push({ locator: submit, description: 'Knowledge check: Submit', blockId });
      await settle();
    } catch {
      skipped.push({ blockId, why: 'a knowledge check that could not be clicked' });
    }
  }
  return { steps, skipped };
}
