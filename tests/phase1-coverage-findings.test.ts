import { describe, expect, it } from 'vitest';
import { assetPathOf, isCountingUnit, unitNounFor } from '@cqa/core';
import { actionable, coverageFacts, missingParts, verdictOf } from '../apps/web/src/components/run/SimpleSummary';

// Brief of 20 Nov 2026, phase 1: coverage and findings that can be relied on.

type Unit = { id: string; kind: 'sco' | 'lesson' | 'block' | 'scene' | 'slide' | 'screen'; parentId?: string };
const primary = (units: Unit[]) => units.filter((u) => isCountingUnit(u as never, units as never)).map((u) => u.id);

describe('the unit a course is counted in', () => {
  it('counts Rise lessons, not the wrapper pages seen only at run time', () => {
    const units: Unit[] = [{ id: 'pkg', kind: 'sco' }, { id: 'l1', kind: 'lesson', parentId: 'pkg' }, { id: 'l2', kind: 'lesson', parentId: 'pkg' }, { id: 'b1', kind: 'block', parentId: 'l1' }, { id: 'wrap', kind: 'screen', parentId: 'pkg' }];
    expect(primary(units)).toEqual(['l1', 'l2']);
    expect(unitNounFor(units as never)).toEqual({ singular: 'lesson', plural: 'lessons' });
  });

  it('counts Storyline slides, with scenes as groups only', () => {
    const units: Unit[] = [{ id: 'sc1', kind: 'scene' }, { id: 's1', kind: 'slide', parentId: 'sc1' }, { id: 's2', kind: 'slide', parentId: 'sc1' }, { id: 'p', kind: 'screen' }];
    expect(primary(units)).toEqual(['s1', 's2']);
    expect(unitNounFor(units as never).plural).toBe('slides');
  });

  it('counts screens, and package items with nothing inside, for other content', () => {
    const units: Unit[] = [{ id: 'a', kind: 'sco' }, { id: 'b', kind: 'screen' }];
    expect(primary(units)).toEqual(['a', 'b']);
  });
});

describe('a verdict grounded in the coverage record', () => {
  const noun = { singular: 'slide', plural: 'slides' };
  const ratio = (n: number, d: number) => ({ available: true as const, numerator: n, denominator: d, percent: Math.round((n / d) * 100) });
  const summary = (over: Record<string, unknown> = {}) =>
    ({
      discovery: { completeness: 'complete', reason: '', byConfidence: { high: 1, medium: 0, low: 0 }, bySource: {}, revision: 1 },
      visit: ratio(10, 12),
      execution: ratio(5, 5),
      passRate: ratio(5, 5),
      interactions: { total: 0, exercised: { available: false, reason: '' } },
      manual: { outstanding: 0, manualOnlyCases: 0 },
      listedNotTracked: 0,
      gaps: { blocked: 0, errored: 0, skipped: 0, pending: 0, unitsNotVisited: 2, unitsNotReached: [{ id: 'x', title: 'Slide 11', reason: 'Next stayed locked.' }, { id: 'y', title: 'Slide 12', reason: 'r' }] },
      counts: {},
      statement: '',
      ...over,
    }) as never;

  it('an incomplete scan with no defects asks for review and says what is missing', () => {
    const c = coverageFacts(summary(), noun);
    const v = verdictOf('completed', 0, 0, 0, { explored: true, coverage: c });
    expect(v.text).toBe('Needs your review');
    expect(v.detail).toMatch(/2 slides not reached/);
    expect(c.notReached[0]).toEqual({ title: 'Slide 11', reason: 'Next stayed locked.' });
  });

  it('an unknown course total is shown as unknown, never as complete', () => {
    const c = coverageFacts(summary({ discovery: { completeness: 'unknown', reason: '', byConfidence: { high: 0, medium: 0, low: 0 }, bySource: {}, revision: 1 }, visit: { available: false, reason: 'unknown' }, gaps: { blocked: 0, errored: 0, skipped: 0, pending: 0, unitsNotVisited: 0, unitsNotReached: [] } }), { singular: 'screen', plural: 'screens' }, 12);
    expect(c.total).toBeUndefined();
    expect(c.reached).toBe(12);
    expect(missingParts(c)).toContain("the course's total number of screens is unknown");
  });

  it('a scan with no coverage record says so instead of looking complete', () => {
    const c = coverageFacts(undefined, undefined);
    expect(c.recorded).toBe(false);
    expect(verdictOf('completed', 0, 0, 0, { explored: true, coverage: c }).detail).toMatch(/did not record what it reached/);
  });

  it('untried interactions and outstanding manual checks keep it from "Looks good"', () => {
    const c = coverageFacts(summary({ visit: ratio(12, 12), gaps: { blocked: 0, errored: 0, skipped: 0, pending: 0, unitsNotVisited: 0, unitsNotReached: [] }, interactions: { total: 4, exercised: ratio(1, 4) }, manual: { outstanding: 3, manualOnlyCases: 3 } }), noun);
    expect(missingParts(c)).toEqual(['3 interactions not tried', '3 manual checks to do']);
    expect(verdictOf('completed', 0, 0, 0, { coverage: c }).tone).toBe('review');
  });

  it('a failed or cancelled scan is never positive', () => {
    const c = coverageFacts(summary({ visit: ratio(12, 12) }), noun);
    expect(verdictOf('failed', 0, 0, 0, { coverage: c }).tone).toBe('none');
    expect(verdictOf('cancelled', 0, 0, 0, { coverage: c }).tone).toBe('none');
  });
});

describe('browser and file findings about the same media file', () => {
  const issue = (id: string, source: 'static' | 'runtime', ruleId: string, over: Record<string, unknown> = {}) => ({ id, findingId: id, url: '', category: source === 'static' ? 'package' : 'media', source, action: 'check' as const, priority: 'low' as const, issue: `Large image: ${id}`, change: '', screens: [], viewports: [], elements: [], moreElements: 0, steps: [], status: 'open', technical: { ruleId, observed: '' }, ...over });
  const report = (issues: unknown[]) => ({ issues }) as never;

  it('reads the exact file from both kinds of finding, and refuses to guess', () => {
    expect(assetPathOf('scormcontent/assets/Hero.jpeg')).toBe('scormcontent/assets/hero.jpeg');
    expect(assetPathOf('http://127.0.0.1:4318/p/0a1b/scormcontent/assets/Eric%20Itambo.png?[query-removed]')).toBe('scormcontent/assets/eric itambo.png');
    expect(assetPathOf('video http://127.0.0.1:4318/p/0a1b/a/clip.mp4')).toBe('a/clip.mp4');
    expect(assetPathOf('a.jpg, b.jpg')).toBeUndefined();
    expect(assetPathOf(undefined)).toBeUndefined();
  });

  it('keeps an open browser finding visible when the matching file finding was dismissed', () => {
    const list = actionable(report([issue('file', 'static', 'PKG-008', { assetPath: 'a/hero.jpg', status: 'false_positive' }), issue('browser', 'runtime', 'MED-005', { assetPath: 'a/hero.jpg' })]));
    expect(list.map((i) => i.id)).toEqual(['browser']);
  });

  it('keeps two different files with the same name apart', () => {
    const list = actionable(report([issue('one', 'static', 'PKG-008', { assetPath: 'lesson1/hero.jpg' }), issue('two', 'runtime', 'MED-005', { assetPath: 'lesson2/hero.jpg' })]));
    expect(list.map((i) => i.id).sort()).toEqual(['one', 'two']);
  });

  it('shows both when the file is not known exactly', () => {
    const list = actionable(report([issue('one', 'static', 'PKG-008'), issue('two', 'runtime', 'MED-005', { assetPath: 'a/hero.jpg' })]));
    expect(list).toHaveLength(2);
  });

  it('merges a sure match into one entry with open work, the higher priority and the browser screenshot', () => {
    const list = actionable(report([issue('file', 'static', 'PKG-008', { assetPath: 'a/hero.jpg', priority: 'low' }), issue('browser', 'runtime', 'MED-005', { assetPath: 'a/hero.jpg', priority: 'medium', action: 'fix', screenshotId: 'shot1', screenshotKind: 'screen', lesson: { n: 2, of: 5, title: 'Two' } })]));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'file', priority: 'medium', action: 'fix', screenshotId: 'shot1', lesson: { n: 2 } });
  });

  it('does not merge different problems about the same file', () => {
    const list = actionable(report([issue('size', 'static', 'PKG-008', { assetPath: 'a/clip.mp4' }), issue('captions', 'runtime', 'MED-003', { assetPath: 'a/clip.mp4' })]));
    expect(list).toHaveLength(2);
  });
});

describe('fingerprints across a course\'s ZIP versions', () => {
  it('match for two uploads of the same course and differ for unrelated courses', async () => {
    const { fingerprint, setUploadCourses } = await import('@cqa/core');
    const v1 = '11111111-1111-4111-8111-111111111111';
    const v2 = '22222222-2222-4222-8222-222222222222';
    const other = '33333333-3333-4333-8333-333333333333';
    setUploadCourses(new Map([[v1, 'course-a'], [v2, 'course-a'], [other, 'course-b']]));
    const at = (id: string) => fingerprint({ ruleId: 'RUN-005' as never, url: `http://127.0.0.1:4318/p/${id}/index.html`, targetKey: `http://127.0.0.1:4318/p/${id}/img.png` });
    expect(at(v1)).toBe(at(v2));
    expect(at(v1)).not.toBe(at(other));
    setUploadCourses(new Map());
    // Without a course for an upload, its own id keeps it apart.
    expect(at(v1)).not.toBe(at(v2));
  });
});
