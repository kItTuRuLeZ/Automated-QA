import { describe, expect, it } from 'vitest';
import { isScannerNote, plainScreenName, withoutRuleCodes } from '../apps/web/src/components/detail-level';
import { verdictOf } from '../apps/web/src/components/run/SimpleSummary';

describe('simple view wording', () => {
  it('removes the tool\'s rule codes but keeps ordinary hyphenated names', () => {
    expect(withoutRuleCodes('NAV-02: Next and Previous move between adjacent units')).toBe('Next and Previous move between adjacent units');
    expect(withoutRuleCodes('16 checks passed (A11Y-AXE-aria-roles, A11Y-AXE-button-name).')).toBe('16 checks passed.');
    expect(withoutRuleCodes('2 checks passed (LAY-002, LAY-004).')).toBe('2 checks passed.');
    expect(withoutRuleCodes('Add the missing header (X-Frame-Options).')).toBe('Add the missing header (X-Frame-Options).');
    expect(withoutRuleCodes('Dates use (ISO-8601) here.')).toBe('Dates use (ISO-8601) here.');
  });

  it('drops the web address the scanner adds to a screen name', () => {
    expect(plainScreenName('Leadership Expectations (/p/6cb7/scormdriver/indexAPI.html)')).toBe('Leadership Expectations');
    expect(plainScreenName('Intro (http://127.0.0.1:4318/p/x/index.html)')).toBe('Intro');
    expect(plainScreenName('Module 3 (Part 2)')).toBe('Module 3 (Part 2)');
  });

  it('treats the same findings as scanner notes as the reports do', () => {
    expect(isScannerNote({ ruleId: 'COV-002' })).toBe(true);
    expect(isScannerNote({ ruleId: 'NET-002' })).toBe(true);
    expect(isScannerNote({ ruleId: 'X-1', category: 'coverage' })).toBe(true);
    expect(isScannerNote({ ruleId: 'A11Y-AXE-region' })).toBe(false);
  });
});

describe('simple verdict', () => {
  it('never says "Looks good" for a scan that did not finish everything, failed or was cancelled', () => {
    expect(verdictOf('partial', 0, 0, 0).text).toBe('Needs your review');
    expect(verdictOf('failed', 0, 0, 0).tone).toBe('none');
    expect(verdictOf('cancelled', 0, 0, 0).tone).toBe('none');
    expect(verdictOf('completed', 0, 0, 1).text).toBe('Needs your review');
    expect(verdictOf('completed', 2, 0, 0).text).toBe('Needs fixes');
    expect(verdictOf('completed', 0, 0, 0).text).toBe('Looks good');
  });

  it('never says "Looks good" when the course was not gone through, lessons were missed or checks could not run', () => {
    expect(verdictOf('completed', 0, 0, 0, { explored: false }).detail).toMatch(/Only the opening page/);
    expect(verdictOf('completed', 0, 0, 0, { lessonsMissed: 2 }).detail).toMatch(/did not reach 2 lessons/);
    expect(verdictOf('completed', 0, 0, 0, { checksNotRun: 5 }).text).toBe('Needs your review');
    expect(verdictOf('completed', 0, 0, 0, { explored: true, lessonsMissed: 0, checksNotRun: 0 }).text).toBe('Looks good');
  });
});

describe('plain problem titles', () => {
  it('drops the "Check by hand" prefix and shows file names as people write them', async () => {
    const { plainIssue } = await import('../apps/web/src/components/detail-level');
    expect(plainIssue('Check by hand: A video has no captions')).toBe('A video has no captions');
    expect(plainIssue('Video has no caption track: Eric%20Itambo.mp4?[query-removed]')).toBe('Video has no caption track: Eric Itambo.mp4');
  });
});

describe('plain stop reasons and one entry per large file', () => {
  it('rewrites the wording older scans were saved with', async () => {
    const { plainReason } = await import('../apps/web/src/components/detail-level');
    expect(plainReason('1 action(s) or state restorations failed.')).toBe('The scan could not repeat one of its steps, so a screen may have been checked only in part.');
    expect(plainReason('Exploration stopped at a scan budget (budget_states).')).toMatch(/stopped at one of its limits/);
  });

  it('lists a large image found by both the browser and the file check once, from the file check', async () => {
    const { actionable } = await import('../apps/web/src/components/run/SimpleSummary');
    const issue = (id: string, source: 'static' | 'runtime', text: string) => ({ id, findingId: id, url: '', source, action: 'check' as const, priority: 'low' as const, issue: text, change: '', screens: [], viewports: [], elements: [], moreElements: 0, steps: [], status: 'open', technical: { ruleId: source === 'static' ? 'PKG-008' : 'MED-005', observed: '' } });
    const report = { issues: [issue('a', 'runtime', 'Large image: Hero.jpeg (3.9 MB)'), issue('b', 'static', 'Large image: Hero.jpeg (3.8 MB, above the 1.0 MB limit)'), issue('c', 'runtime', 'Large image: Other.png (2.0 MB)')] } as never;
    expect(actionable(report).map((i) => i.id).sort()).toEqual(['b', 'c']);
  });
});
