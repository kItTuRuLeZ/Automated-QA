import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArchiveError, DEFAULT_ARCHIVE_LIMITS, extractArchive, inspectPackage, validateArchive } from '@cqa/core';
import { makeZip, manifest12, manifest2004, markEncrypted, page, renameEntry } from './support/packages.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'cqa-pkg-'));
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ArchiveError) return e.code;
    throw e;
  }
  return 'accepted';
};
const inspect = (files: Record<string, string>) => {
  const dir = path.join(tmp(), 'content');
  extractArchive(makeZip(files), dir);
  return inspectPackage(dir);
};
const issues = (r: ReturnType<typeof inspect>, rule: string) => r.issues.filter((i) => i.ruleId === rule);

describe('archive safety', () => {
  const ok = { 'index.html': page('Hi') };

  it('accepts a normal package and writes exactly its files', () => {
    const dest = path.join(tmp(), 'out');
    const r = extractArchive(makeZip({ ...ok, 'assets/a.css': 'body{}', 'assets/deep/b.js': '1' }), dest);
    expect(r.files).toBe(3);
    expect(readFileSync(path.join(dest, 'assets', 'deep', 'b.js'), 'utf8')).toBe('1');
  });

  it.each([
    ['parent traversal', { '../evil.txt': 'x' }],
    ['nested traversal', { 'a/../../evil.txt': 'x' }],
    ['absolute path', { '/etc/evil.txt': 'x' }],
    ['drive letter', { 'C:/evil.txt': 'x' }],
    ['backslash', { 'a\\evil.txt': 'x' }],
    ['empty segment', { 'a//evil.txt': 'x' }],
  ])('rejects %s and writes nothing', (_name, files) => {
    const dest = path.join(tmp(), 'out');
    expect(codeOf(() => extractArchive(makeZip(files), dest))).toBe('unsafe_path');
    expect(existsSync(dest) ? readdirSync(dest) : []).toEqual([]);
  });

  it('rejects symbolic links, encrypted entries, duplicates, and letter-case twins', () => {
    expect(codeOf(() => validateArchive(makeZip({ 'index.html': 'x', link: '../../etc/passwd' }, { symlinks: ['link'] })))).toBe('symlink');
    expect(codeOf(() => validateArchive(markEncrypted(makeZip(ok))))).toBe('encrypted');
    expect(codeOf(() => validateArchive(renameEntry(makeZip({ 'a.txt': '1', 'b.txt': '2' }), 'b.txt', 'a.txt')))).toBe('duplicate');
    expect(codeOf(() => validateArchive(makeZip({ 'Lesson.html': '1', 'lesson.html': '2' })))).toBe('duplicate');
  });

  it('enforces size, entry-count, expansion, and ratio limits before inflating', () => {
    const zip = makeZip({ 'a.txt': 'x'.repeat(5000), 'b.txt': 'y'.repeat(5000) });
    expect(codeOf(() => validateArchive(zip, { ...DEFAULT_ARCHIVE_LIMITS, maxCompressedBytes: 50 }))).toBe('too_large');
    expect(codeOf(() => validateArchive(zip, { ...DEFAULT_ARCHIVE_LIMITS, maxEntries: 1 }))).toBe('too_many_entries');
    expect(codeOf(() => validateArchive(zip, { ...DEFAULT_ARCHIVE_LIMITS, maxExpandedBytes: 6000 }))).toBe('expanded_too_large');
    expect(codeOf(() => validateArchive(zip, { ...DEFAULT_ARCHIVE_LIMITS, maxEntryBytes: 4000 }))).toBe('expanded_too_large');
    // A real ZIP bomb shape: 8 MB of zeros stored in a few KB.
    const bomb = makeZip({ 'zeros.bin': new Uint8Array(8 * 1024 * 1024) });
    expect(bomb.length).toBeLessThan(50_000);
    const dest = path.join(tmp(), 'out');
    expect(codeOf(() => extractArchive(bomb, dest))).toBe('ratio');
    expect(existsSync(dest) ? readdirSync(dest) : []).toEqual([]);
  });

  it('rejects files that are not ZIPs or are empty', () => {
    expect(codeOf(() => validateArchive(Buffer.from('definitely not a zip file, just text')))).toBe('corrupt');
    expect(codeOf(() => validateArchive(makeZip({})))).toBe('empty');
  });
});

describe('manifest and package inspection', () => {
  it('reads a valid SCORM 1.2 package: version, launch, and clean checks', () => {
    const r = inspect({ 'imsmanifest.xml': manifest12(), 'index.html': page('Lesson 1', '<img src="img/a.png">'), 'img/a.png': 'png' });
    expect(r.kind).toBe('scorm12');
    expect(r.scormVersionDeclared).toBe('1.2');
    expect(r.title).toBe('Safety Basics');
    expect(r.launchChoices).toEqual([{ key: 'r1', title: 'Lesson 1', path: 'index.html', suffix: undefined }]);
    for (const rule of ['PKG-001', 'PKG-002', 'PKG-003', 'PKG-004', 'PKG-005', 'PKG-006']) expect(issues(r, rule).map((i) => i.outcome), rule).toEqual(['passed']);
    expect(issues(r, 'PKG-007')[0]!.outcome).toBe('not_applicable');
    expect(r.inventory.files).toBe(3);
    expect(r.limits.join(' ')).toMatch(/not validated against the SCORM XML schemas/);
  });

  it('detects SCORM 2004 from its namespaces and schema version', () => {
    const r = inspect({ 'imsmanifest.xml': manifest2004(), 'index.html': page('x') });
    expect(r.kind).toBe('scorm2004');
    expect(issues(r, 'PKG-003')[0]!.outcome).toBe('passed');
  });

  it('reports malformed XML, and refuses DTD/entity declarations without reading anything', () => {
    const broken = inspect({ 'imsmanifest.xml': '<manifest><organizations></manifest>', 'index.html': page('x') });
    expect(issues(broken, 'PKG-002')[0]).toMatchObject({ outcome: 'failed' });
    expect(issues(broken, 'PKG-004')[0]!.outcome).toBe('not_tested');

    const xxe = `<?xml version="1.0"?><!DOCTYPE m [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><manifest identifier="m"><metadata><schemaversion>&xxe;</schemaversion></metadata></manifest>`;
    const r = inspect({ 'imsmanifest.xml': xxe, 'index.html': page('x') });
    expect(issues(r, 'PKG-002')[0]).toMatchObject({ outcome: 'failed' });
    expect(issues(r, 'PKG-002')[0]!.detail).toMatch(/refused for safety/);
    expect(JSON.stringify(r)).not.toMatch(/root:|passwd:/);
  });

  it('flags a launch file that is missing, and one whose letter case differs', () => {
    const missing = inspect({ 'imsmanifest.xml': manifest12({ launch: 'lesson1.html' }), 'index.html': page('x') });
    expect(issues(missing, 'PKG-004').map((i) => i.outcome)).toEqual(['failed']);
    expect(missing.launchChoices).toEqual([]);

    const mismatch = inspect({ 'imsmanifest.xml': manifest12({ launch: 'Index.html' }), 'index.html': page('x') });
    const five = issues(mismatch, 'PKG-005');
    expect(five.some((i) => i.outcome === 'needs_review' && /index\.html/.test(i.detail))).toBe(true);
    expect(mismatch.launchChoices[0]!.path).toBe('index.html'); // opens the real file; the mismatch is reported, not hidden
  });

  it('finds missing resource dependencies, items pointing nowhere, and missing page references', () => {
    const r = inspect({
      'imsmanifest.xml': manifest12({
        items: [{ id: 'i1', title: 'Lesson 1', ref: 'r1' }, { id: 'i2', title: 'Ghost', ref: 'nope' }],
        resources: '<resource identifier="r1" type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/><file href="missing.js"/><dependency identifierref="shared"/></resource>',
      }),
      'index.html': page('x', '<script src="js/app.js"></script><img src="Img/Logo.png">'),
      'img/logo.png': 'p',
    });
    const titles = issues(r, 'PKG-005').map((i) => i.title ?? '');
    expect(titles.some((t) => /Listed file is missing: missing\.js/.test(t))).toBe(true);
    expect(titles.some((t) => /depends on a missing resource/.test(t))).toBe(true);
    expect(titles.some((t) => /Ghost/.test(t) && /missing resource/.test(t))).toBe(true);
    expect(titles.some((t) => /refers to a missing file: js\/app\.js/.test(t))).toBe(true);
    expect(titles.some((t) => /Letter case differs: Img\/Logo\.png/.test(t))).toBe(true);
    expect(issues(r, 'PKG-005').every((i) => i.outcome !== 'passed')).toBe(true);
  });

  it('applies xml:base when resolving the launch file', () => {
    const r = inspect({ 'imsmanifest.xml': manifest12({ base: 'content/', launch: 'start.html' }), 'content/start.html': page('x') });
    expect(r.launchChoices[0]!.path).toBe('content/start.html');
    expect(issues(r, 'PKG-004')[0]!.outcome).toBe('passed');
  });

  it('lists every lesson in every organization and says the choice is the person\'s', () => {
    const r = inspect({
      'imsmanifest.xml': manifest12({
        items: [{ id: 'i1', title: 'Intro', ref: 'r1' }, { id: 'i2', title: 'Module 2', ref: 'r2' }],
        resources: '<resource identifier="r1" type="webcontent" adlcp:scormtype="sco" href="a.html"/><resource identifier="r2" type="webcontent" adlcp:scormtype="sco" href="b.html"/><resource identifier="r3" type="webcontent" adlcp:scormtype="sco" href="c.html"/>',
        extraOrg: '<organization identifier="org2"><title>Alternate</title><item identifier="x" identifierref="r3"><title>Bonus</title></item></organization>',
      }),
      'a.html': page('a'),
      'b.html': page('b'),
      'c.html': page('c'),
    });
    expect(r.organizations.map((o) => [o.id, o.isDefault])).toEqual([['org1', true], ['org2', false]]);
    expect(r.launchChoices.map((c) => c.title)).toEqual(['Intro (Safety Basics)', 'Module 2 (Safety Basics)', 'Bonus (Alternate)']);
    expect(issues(r, 'PKG-007')[0]).toMatchObject({ outcome: 'needs_review' });
    expect(issues(r, 'PKG-007')[0]!.detail).toMatch(/Only the lessons you choose are scanned/);
  });

  it('lists outside websites found in package text, ignoring schema namespace identifiers', () => {
    const r = inspect({
      'imsmanifest.xml': manifest12(),
      'index.html': page('x', '<script src="https://cdn.example.net/lib.js"></script><a href="https://www.w3.org/1999/xhtml">ns</a>'),
      'js/app.js': 'fetch("https://api.tracker.example.org/v1/hit")',
    });
    expect(r.externalDependencies.map((d) => d.host)).toEqual(['api.tracker.example.org', 'cdn.example.net']);
    expect(issues(r, 'PKG-006')[0]).toMatchObject({ outcome: 'needs_review' });
  });

  it('treats a package without a manifest as plain HTML5 and offers launch files', () => {
    const r = inspect({ 'pages/two.html': page('two'), 'index.html': page('one') });
    expect(r.kind).toBe('html5');
    expect(r.launchChoices.map((c) => c.path)).toEqual(['index.html', 'pages/two.html']);
    expect(issues(r, 'PKG-002')[0]!.outcome).toBe('not_applicable');
    expect(issues(r, 'PKG-004')[0]!.outcome).toBe('needs_review');
    expect(inspect({ 'readme.txt': 'no pages' }).issues.some((i) => i.ruleId === 'PKG-004' && i.outcome === 'failed')).toBe(true);
  });
});
