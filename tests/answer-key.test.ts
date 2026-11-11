import { describe, expect, it } from 'vitest';
import type { AssessmentSpec } from '@cqa/shared';
import { keyToLines, linesToKey } from '../apps/web/src/components/qa/answer-key.js';

describe('the answer key typed into the rules form', () => {
  it('reads one case per line, with several answers separated by ;', () => {
    expect(linesToKey('Right | correct | Red; Blue | Well done. | Score: 100\nWrong | Incorrect | Red | Not quite.')).toEqual([
      { name: 'Right', correct: true, answers: ['Red', 'Blue'], feedback: 'Well done.', score: 'Score: 100' },
      { name: 'Wrong', correct: false, answers: ['Red'], feedback: 'Not quite.' },
    ]);
  });

  it('keeps | and ; inside text when they have a backslash before them', () => {
    const [c] = linesToKey('Choice \\| A | correct | Yes\\; always | Right \\| see page 3');
    expect(c).toEqual({ name: 'Choice | A', correct: true, answers: ['Yes; always'], feedback: 'Right | see page 3' });
  });

  it('writes back what it reads, so opening and saving a rule changes nothing', () => {
    const spec = { submit: 'Submit', selection: 'single', cases: [{ name: 'A|B', correct: false, answers: ['x;y', 'z\\w'], feedback: 'f', score: 's' }] } as AssessmentSpec;
    expect(linesToKey(keyToLines(spec))).toEqual(spec.cases);
  });

  it('refuses a line it cannot read, rather than guessing', () => {
    expect(() => linesToKey('Only a name | maybe | Red | Fine')).toThrow(/correct or incorrect/);
    expect(() => linesToKey('Name | correct | Red')).toThrow(/Problem line/);
  });
});
