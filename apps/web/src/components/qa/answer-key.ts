import type { AssessmentSpec } from '@cqa/shared';

/** One answer-key case per line: name | correct or incorrect | answer; answer | feedback | score (optional). */
const escapeKey = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/;/g, '\\;');
const unescapeKey = (s: string) => s.replace(/\\([\\|;])/g, '$1').trim();
/** Splits on a separator unless it has a backslash before it. */
const splitKey = (s: string, sep: '|' | ';') => {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) current += s[i]! + s[++i]!;
    else if (s[i] === sep) {
      parts.push(current);
      current = '';
    } else current += s[i];
  }
  parts.push(current);
  return parts.map((x) => x.trim());
};
export const keyToLines = (a?: AssessmentSpec) => (a?.cases ?? []).map((c) => [escapeKey(c.name), c.correct ? 'correct' : 'incorrect', c.answers.map(escapeKey).join('; '), escapeKey(c.feedback), c.score === undefined ? undefined : escapeKey(c.score)].filter((x) => x !== undefined).join(' | ')).join('\n');
export const linesToKey = (s: string): AssessmentSpec['cases'] =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name, kind, answers, feedback, score] = splitKey(l, '|');
      if (!name || !answers || !feedback || !/^(correct|incorrect)$/i.test(kind ?? '')) throw new Error(`This answer key line needs: name | correct or incorrect | answers | feedback. Problem line: ${l}`);
      return { name: unescapeKey(name), correct: /^correct$/i.test(kind!), answers: splitKey(answers, ';').map(unescapeKey).filter(Boolean), feedback: unescapeKey(feedback), ...(score ? { score: unescapeKey(score) } : {}) };
    });
