import { describe, expect, it } from 'vitest';
import { wholePhrase } from '../apps/worker/src/engines/helpers.js';
import { analyzeExpectation } from '../apps/worker/src/engines/scorm-analysis.js';

describe('matching what the learner sees', () => {
  it('a word never matches inside a longer word, so "Complete" is not found in "incomplete"', () => {
    expect(wholePhrase('Complete', 'iu').test('Course incomplete')).toBe(false);
    expect(wholePhrase('Complete', 'iu').test('Course complete!')).toBe(true);
    expect(wholePhrase('Correct').test('Incorrect')).toBe(false);
    expect(wholePhrase('Score: 10').test('Score: 100')).toBe(false);
  });

  it('rule messages ignore case, as they always did; answer feedback keeps it', () => {
    expect(wholePhrase('well done', 'iu').test('Well done, section complete')).toBe(true);
    expect(wholePhrase('Correct').test('Please select the correct answer')).toBe(false);
  });

  it('a SCORM journey expecting "Complete" on screen fails when the screen says "Course incomplete"', () => {
    const r = analyzeExpectation({ name: 'Finish', kind: 'journey', version: '1.2', calls: [{ seq: 1, fn: 'LMSInitialize', args: [''], result: 'true', error: '0', t: 0 }] as never, lookups: [], cmi: {}, committed: { 'cmi.core.lesson_status': 'completed' }, callsBeforeLeave: 1, stepsTotal: 1, stepsRun: 1, screenText: 'Course incomplete', expect: { status: 'completed', screenShows: 'Complete' } });
    expect(r?.outcome).toBe('failed');
    expect(r?.detail).toMatch(/screen did not show "Complete"/);
  });
});
