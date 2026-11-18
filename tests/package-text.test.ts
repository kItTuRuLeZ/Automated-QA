import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { captionText, checkPackageText, checkText, htmlToText, riseText } from '@cqa/core';

const of = (issues: ReturnType<typeof checkText>, id: string) => issues.filter((i) => i.ruleId === id);

describe('course text extraction', () => {
  it('joins inline tags as the browser shows them, and breaks lines at block tags', () => {
    // A stray struck-through letter left in the text reads as part of the word.
    expect(htmlToText('<p>a leader’s role in <s>l</s>understanding of risk</p>')).toBe('a leader’s role in lunderstanding of risk');
    expect(htmlToText('<p>directives.<br><br>The course</p>')).toBe('directives.\nThe course');
    expect(htmlToText('<p>One</p><p>Two &amp; three</p>')).toBe('One\nTwo & three');
    // A numeric entity past the last Unicode code point is left as written instead of throwing.
    expect(htmlToText('<p>x &#99999999; y &#8217;</p>')).toBe('x &#99999999; y ’');
  });

  it('reads every Rise lesson\'s text, labelled by lesson, and caption cues without timings', () => {
    const items = riseText({ title: 'Course', lessons: [{ title: 'Intro', items: [{ items: [{ paragraph: '<p>Hello there</p>', id: 'x', src: 'a.png' }] }] }] });
    expect(items).toEqual([{ where: 'Course cover', text: 'Course' }, { where: 'Lesson 1: Intro', text: 'Intro' }, { where: 'Lesson 1: Intro', text: 'Hello there' }]);
    expect(captionText('a/cap.vtt', 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nprotecting co-bank safety,\n')).toEqual([{ where: 'captions cap.vtt', text: 'protecting co-bank safety,' }]);
  });
});

describe('PKG-012 spelling', () => {
  it('flags words not in the dictionary with suggestions, and skips names, acronyms and short words', () => {
    const issues = of(checkText([{ where: 'Lesson 4', text: 'Designing remediation planse to address issues. CoBank and ICOR own it. Ok.' }], 'test'), 'PKG-012');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toBe('Possible misspelling: "planse" (Lesson 4)');
    expect(issues[0]!.detail).toMatch(/Did you mean .*"plans"/);
    expect(issues[0]!.outcome).toBe('needs_review');
  });

  it('passes correctly spelled text, including possessives and curly apostrophes', () => {
    const issues = of(checkText([{ where: 'L', text: 'The leader’s team doesn’t own the controls.' }], 'test'), 'PKG-012');
    expect(issues).toEqual([expect.objectContaining({ outcome: 'passed' })]);
  });
});

describe('PKG-013 wording', () => {
  it('flags a missing space after a full stop but not a paragraph break, a web address or a decimal', () => {
    const issues = of(checkText([{ where: 'L12', text: 'management directives.The course\nends here.\nNext step. See www.example.com and version 1.5 today.' }], 'test'), 'PKG-013');
    expect(issues.map((i) => i.title)).toEqual(['Missing space after "." (L12)']);
  });

  it('flags a term written two ways, but not sentence capitals or an all-capitals button label', () => {
    const issues = of(checkText([{ where: 'A', text: 'CoBank leaders. Continue. CONTINUE. continue with CoBank' }, { where: 'B', text: 'protecting co-bank safety' }], 'test'), 'PKG-013');
    expect(issues.map((i) => i.title)).toEqual(['Same term written 2 ways: "CoBank" (2×) vs "co-bank" (1×)']);
  });

  it('flags mixed straight and curly quotes, and passes consistent text', () => {
    expect(of(checkText([{ where: 'A', text: 'Let’s go' }, { where: 'B', text: "Let's go" }], 't'), 'PKG-013')[0]!.title).toBe('Straight and curly quotes are mixed');
    expect(of(checkText([{ where: 'A', text: 'Let’s go' }, { where: 'B', text: 'It’s fine' }], 't'), 'PKG-013')).toEqual([expect.objectContaining({ outcome: 'passed' })]);
  });
});

describe('which text is read', () => {
  const dir = (files: Record<string, string>) => {
    const root = mkdtempSync(path.join(tmpdir(), 'cqa-text-'));
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), body);
    }
    return { root, list: Object.entries(files).map(([rel, body]) => ({ rel, bytes: body.length })) };
  };

  it('reads HTML pages and captions of a plain package, ignoring scripts', () => {
    const { root, list } = dir({ 'index.html': '<html><body><p>the coarse is welcom</p><script>var mispeled = 1;</script></body></html>', 'v.vtt': 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nthe recieved file\n' });
    const words = checkPackageText(root, list).filter((i) => i.ruleId === 'PKG-012').map((i) => i.title).sort();
    expect(words).toEqual(['Possible misspelling: "recieved" (captions v.vtt)', 'Possible misspelling: "welcom" (index.html)']);
  });

  it('says Storyline text was not checked, rather than passing it', () => {
    const r = checkPackageText('.', [], { tool: 'storyline', product: 'Storyline 360' });
    expect(r.map((i) => [i.ruleId, i.outcome, i.reason])).toEqual([['PKG-012', 'not_tested', 'not_implemented'], ['PKG-013', 'not_tested', 'not_implemented']]);
  });

  it('says so when no text was found', () => {
    const { root, list } = dir({ 'a.js': '1' });
    expect(checkPackageText(root, list).map((i) => i.outcome)).toEqual(['not_applicable', 'not_applicable']);
  });
});
