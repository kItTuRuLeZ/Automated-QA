import { describe, expect, it } from 'vitest';
import { type Harness, type HarnessConfig, scormHarness } from '../apps/worker/src/adapters/scorm-harness.js';

const base = (version: '1.2' | '2004', over: Partial<HarnessConfig> = {}): HarnessConfig => ({ version, learner: { id: 'test-learner', name: 'Test Learner' }, restore: {}, entry: 'ab-initio', priorTotalSeconds: 0, ...over });
const make12 = (over: Partial<HarnessConfig> = {}) => {
  const win: Record<string, unknown> = {};
  const h = scormHarness(base('1.2', over), win);
  const a = h.api as Record<string, (...x: string[]) => string>;
  return { h, win, init: () => a.LMSInitialize!(''), get: (n: string) => a.LMSGetValue!(n), set: (n: string, v: string) => a.LMSSetValue!(n, v), commit: () => a.LMSCommit!(''), fin: () => a.LMSFinish!(''), err: () => Number(a.LMSGetLastError!()), errStr: (c: number) => a.LMSGetErrorString!(String(c)) };
};
const make04 = (over: Partial<HarnessConfig> = {}) => {
  const win: Record<string, unknown> = {};
  const h = scormHarness(base('2004', over), win);
  const a = h.api as Record<string, (...x: string[]) => string>;
  return { h, win, init: () => a.Initialize!(''), get: (n: string) => a.GetValue!(n), set: (n: string, v: string) => a.SetValue!(n, v), commit: () => a.Commit!(''), fin: () => a.Terminate!(''), err: () => Number(a.GetLastError!()), errStr: (c: number) => a.GetErrorString!(String(c)) };
};
const names = (h: Harness) => Object.keys(h.api);

describe('the two harnesses are separate APIs with their own method and element names', () => {
  it('SCORM 1.2 exposes API with LMS-prefixed methods; 2004 exposes API_1484_11 with plain names', () => {
    const a = make12();
    expect(names(a.h)).toEqual(['LMSInitialize', 'LMSFinish', 'LMSGetValue', 'LMSSetValue', 'LMSCommit', 'LMSGetLastError', 'LMSGetErrorString', 'LMSGetDiagnostic']);
    expect(a.win.API).toBeDefined();
    expect((a.win as { API_1484_11?: unknown }).API_1484_11).toBeUndefined();
    const b = make04();
    expect(names(b.h)).toEqual(['Initialize', 'Terminate', 'GetValue', 'SetValue', 'Commit', 'GetLastError', 'GetErrorString', 'GetDiagnostic']);
    expect(b.win.API_1484_11).toBeDefined();
    expect((b.win as { API?: unknown }).API).toBeUndefined();
  });

  it('records a lookup for the other version\'s API object without providing it', () => {
    const a = make12();
    void (a.win as { API_1484_11?: unknown }).API_1484_11;
    expect(a.h.snapshot().lookups.map((l) => l.name)).toEqual(['API_1484_11']);
    const b = make04();
    void (b.win as { API?: unknown }).API;
    expect(b.h.snapshot().lookups.map((l) => l.name)).toEqual(['API']);
  });

  it('SCORM 1.2 elements do not exist in 2004 and vice versa', () => {
    const a = make12();
    a.init();
    expect(a.get('cmi.completion_status')).toBe('');
    expect(a.err()).toBe(401);
    const b = make04();
    b.init();
    expect(b.get('cmi.core.lesson_status')).toBe('');
    expect(b.err()).toBe(401);
  });
});

describe('SCORM 1.2 lifecycle, data model, and error codes', () => {
  it('enforces the lifecycle with 1.2 error codes', () => {
    const s = make12();
    expect(s.get('cmi.core.lesson_status')).toBe('');
    expect(s.err()).toBe(301);
    expect(s.set('cmi.core.lesson_status', 'completed')).toBe('false');
    expect(s.err()).toBe(301);
    expect(s.commit()).toBe('false');
    expect(s.fin()).toBe('false');
    expect(s.err()).toBe(301);
    expect(s.init()).toBe('true');
    expect(s.init()).toBe('false');
    expect(s.err()).toBe(101);
    expect(s.fin()).toBe('true');
    expect(s.get('cmi.core.lesson_status')).toBe('');
    expect(s.err()).toBe(301);
    expect(s.init()).toBe('false'); // cannot restart after finishing
    expect(s.errStr(301)).toBe('Not initialized');
  });

  it('applies access and type rules', () => {
    const s = make12();
    s.init();
    expect(s.get('cmi.core.lesson_status')).toBe('not attempted');
    expect(s.get('cmi.core.entry')).toBe('ab-initio');
    expect(s.set('cmi.core.student_id', 'x')).toBe('false');
    expect(s.err()).toBe(403); // read only
    expect(s.get('cmi.core.session_time')).toBe('');
    expect(s.err()).toBe(404); // write only
    expect(s.set('cmi.core.lesson_status', 'done')).toBe('false');
    expect(s.err()).toBe(405); // not in the vocabulary
    expect(s.set('cmi.core.score.raw', '150')).toBe('false');
    expect(s.err()).toBe(405);
    expect(s.set('cmi.core.score.raw', '85')).toBe('true');
    expect(s.err()).toBe(0);
    expect(s.set('cmi.core.session_time', 'PT5M10S')).toBe('false'); // an ISO duration is the 2004 format
    expect(s.set('cmi.core.session_time', '0000:05:10.00')).toBe('true');
    expect(s.set('cmi.core.lesson_status', 'completed')).toBe('true');
    expect(s.set('cmi.core._children', 'x')).toBe('false');
    expect(s.err()).toBe(402); // keyword
    expect(s.get('cmi.core._children')).toContain('lesson_status');
    expect(s.get('cmi.nonsense')).toBe('');
    expect(s.err()).toBe(401);
    // A 2004 value is refused by the 1.2 vocabulary: completion and success are not separate in 1.2.
    expect(s.set('cmi.core.lesson_status', 'unknown')).toBe('false');
  });

  it('keeps interactions in order and counts them', () => {
    const s = make12();
    s.init();
    expect(s.get('cmi.interactions._count')).toBe('0');
    expect(s.set('cmi.interactions.1.id', 'q2')).toBe('false'); // skipping index 0
    expect(s.err()).toBe(201);
    expect(s.set('cmi.interactions.0.id', 'q1')).toBe('true');
    expect(s.set('cmi.interactions.0.type', 'choice')).toBe('true');
    expect(s.set('cmi.interactions.0.result', 'wrong')).toBe('true');
    expect(s.set('cmi.interactions.0.result', 'incorrect')).toBe('false'); // 2004 word, not valid in 1.2
    expect(s.get('cmi.interactions._count')).toBe('1');
    expect(s.get('cmi.interactions.0.id')).toBe('');
    expect(s.err()).toBe(404); // write only in 1.2
  });

  it('only commits what survives: status, score, location, suspend data', () => {
    const s = make12();
    s.init();
    s.set('cmi.core.lesson_location', 'page-4');
    s.set('cmi.suspend_data', 'abc');
    s.set('cmi.core.lesson_status', 'incomplete');
    expect(s.h.snapshot().committed['cmi.core.lesson_location']).toBe('');
    s.commit();
    expect(s.h.snapshot().committed).toMatchObject({ 'cmi.core.lesson_location': 'page-4', 'cmi.suspend_data': 'abc', 'cmi.core.lesson_status': 'incomplete' });
    s.set('cmi.core.lesson_location', 'page-5'); // set after the commit, never saved
    expect(s.h.snapshot().committed['cmi.core.lesson_location']).toBe('page-4');
    s.fin();
    expect(s.h.snapshot().committed['cmi.core.lesson_location']).toBe('page-5'); // finishing saves
  });

  it('resumes from committed state and accumulates total time', () => {
    const first = make12();
    first.init();
    first.set('cmi.core.lesson_location', 'p7');
    first.set('cmi.core.exit', 'suspend');
    first.set('cmi.core.session_time', '0000:01:30.00');
    first.fin();
    const snap = first.h.snapshot();
    const second = make12({ entry: 'resume', restore: snap.committed, priorTotalSeconds: 90 });
    second.init();
    expect(second.get('cmi.core.entry')).toBe('resume');
    expect(second.get('cmi.core.lesson_location')).toBe('p7');
    expect(second.get('cmi.core.total_time')).toBe('0000:01:30.00');
  });
});

describe('SCORM 2004 lifecycle, data model, and error codes', () => {
  it('uses the 2004 error codes for each lifecycle mistake', () => {
    const s = make04();
    s.get('cmi.completion_status');
    expect(s.err()).toBe(122);
    s.set('cmi.completion_status', 'completed');
    expect(s.err()).toBe(132);
    s.commit();
    expect(s.err()).toBe(142);
    s.fin();
    expect(s.err()).toBe(112);
    expect(s.init()).toBe('true');
    expect(s.init()).toBe('false');
    expect(s.err()).toBe(103);
    expect(s.fin()).toBe('true');
    s.get('cmi.completion_status');
    expect(s.err()).toBe(123);
    s.set('cmi.completion_status', 'completed');
    expect(s.err()).toBe(133);
    s.commit();
    expect(s.err()).toBe(143);
    s.fin();
    expect(s.err()).toBe(113);
    expect(s.init()).toBe('false');
    expect(s.err()).toBe(104);
    expect(s.errStr(113)).toBe('Termination After Termination');
  });

  it('keeps completion and success separate, with their own vocabularies and ranges', () => {
    const s = make04();
    s.init();
    expect(s.get('cmi.completion_status')).toBe('unknown');
    expect(s.get('cmi.success_status')).toBe('unknown');
    expect(s.set('cmi.completion_status', 'passed')).toBe('false');
    expect(s.err()).toBe(406); // "passed" is a success status, not a completion status
    expect(s.set('cmi.success_status', 'completed')).toBe('false');
    expect(s.err()).toBe(406);
    expect(s.set('cmi.success_status', 'passed')).toBe('true');
    expect(s.get('cmi.completion_status')).toBe('unknown'); // setting success did not set completion
    expect(s.set('cmi.score.scaled', '1.5')).toBe('false');
    expect(s.err()).toBe(407);
    expect(s.set('cmi.score.scaled', 'abc')).toBe('false');
    expect(s.err()).toBe(406);
    expect(s.set('cmi.score.scaled', '0.85')).toBe('true');
    expect(s.set('cmi.progress_measure', '2')).toBe('false');
    expect(s.err()).toBe(407);
    expect(s.set('cmi.session_time', '0000:05:10.00')).toBe('false'); // 1.2 format is not an ISO duration
    expect(s.err()).toBe(406);
    expect(s.set('cmi.session_time', 'PT5M10S')).toBe('true');
    expect(s.set('cmi.exit', 'time-out')).toBe('false'); // 2004 spells it timeout
    expect(s.set('cmi.exit', 'suspend')).toBe('true');
  });

  it('distinguishes read-only, write-only, never-set, and unimplemented elements', () => {
    const s = make04();
    s.init();
    expect(s.set('cmi.learner_id', 'x')).toBe('false');
    expect(s.err()).toBe(404);
    expect(s.get('cmi.session_time')).toBe('');
    expect(s.err()).toBe(405);
    expect(s.get('cmi.score.raw')).toBe('');
    expect(s.err()).toBe(403); // defined but no value yet
    expect(s.get('cmi.learner_preference.audio_level')).toBe('');
    expect(s.err()).toBe(402); // standard element this harness does not implement
    expect(s.get('cmi.made_up')).toBe('');
    expect(s.err()).toBe(401);
    expect(s.set('cmi.score._children', 'x')).toBe('false');
  });

  it('resumes only what was committed, with entry=resume, and keeps interactions readable', () => {
    const first = make04();
    first.init();
    first.set('cmi.location', 'slide-9');
    first.set('cmi.suspend_data', 'state');
    first.set('cmi.exit', 'suspend');
    first.set('cmi.interactions.0.id', 'q1');
    expect(first.get('cmi.interactions.0.id')).toBe('q1');
    expect(first.get('cmi.interactions._count')).toBe('1');
    first.fin();
    const second = make04({ entry: 'resume', restore: first.h.snapshot().committed });
    second.init();
    expect(second.get('cmi.entry')).toBe('resume');
    expect(second.get('cmi.location')).toBe('slide-9');
    expect(second.get('cmi.suspend_data')).toBe('state');
  });

  it('redacts learner-related and bulky values in the call log', () => {
    const s = make04();
    s.init();
    s.set('cmi.suspend_data', 'private-bookmark-state');
    s.set('cmi.interactions.0.learner_response', 'my answer');
    const log = JSON.stringify(s.h.snapshot().calls);
    expect(log).not.toMatch(/private-bookmark-state|my answer/);
    expect(log).toMatch(/\[22 characters\]/);
    expect(JSON.stringify(s.h.snapshot().calls.find((c) => c.args[0] === 'cmi.suspend_data'))).toBeDefined();
  });
});
