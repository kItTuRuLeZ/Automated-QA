import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_CAPABILITIES, QaStore, Store, commitImport, csvCell, definitionsToCsv, effectiveAutomation, openDatabase, parseCsv, previewImport, seedStarterLibrary, starterDefinitions, suggestMapping } from '@cqa/core';

// Every ID in the brief's baseline matrix.
const EXPECTED_IDS = [
  ...['01', '02', '03', '04', '05', '06', '07', '08'].map((n) => `NAV-${n}`),
  ...['01', '02', '03'].map((n) => `ACC-${n}`),
  ...['01', '02'].map((n) => `TAB-${n}`),
  ...['01', '02'].map((n) => `HOT-${n}`),
  ...['01', '02'].map((n) => `CLK-${n}`),
  ...['01', '02', '03'].map((n) => `LAY-${n}`),
  ...['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'].map((n) => `LOG-${n}`),
  ...['01', '02', '03', '04'].map((n) => `MCQ-${n}`),
  ...['01', '02'].map((n) => `MSQ-${n}`),
  ...['01', '02', '03', '04', '05'].map((n) => `QUIZ-${n}`),
  ...['01', '02', '03', '04', '05'].map((n) => `DND-${n}`),
  'TXT-01', 'SLD-01', 'FLP-01', 'TIM-01', 'AUD-01', 'VID-01',
  ...['01', '02', '03'].map((n) => `MED-${n}`),
  'LNK-01', 'RES-01', 'CMP-01',
  ...['01', '02', '03', '04'].map((n) => `LMS-${n}`),
  ...['01', '02', '03'].map((n) => `A11Y-${n}`),
  ...['01', '02'].map((n) => `VIS-${n}`),
  ...['01', '02'].map((n) => `ERR-${n}`),
];

let qa: QaStore;
beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cqa-lib-'));
  qa = new QaStore(new Store(openDatabase(path.join(dir, 'qa.sqlite'))).db);
});

describe('starter library', () => {
  it('has a full definition for every row of the baseline matrix, and nothing extra', () => {
    const ids = starterDefinitions().map((d) => d.id);
    expect(ids.sort()).toEqual([...EXPECTED_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every case actions, an expected result with its source, evidence needs, and starter status', () => {
    for (const d of starterDefinitions()) {
      expect(d.reviewState, d.id).toBe('starter');
      expect(d.origin, d.id).toBe('starter');
      expect(d.body.expectedResult.length, d.id).toBeGreaterThan(5);
      expect(d.body.expectationSource, d.id).toBe('starter_baseline');
      expect(d.body.actions.length, d.id).toBeGreaterThan(0);
      expect(d.body.assertions.length, d.id).toBeGreaterThan(0);
      expect(d.body.evidence.length, d.id).toBeGreaterThan(0);
      expect(d.body.timeoutMs, d.id).toBeGreaterThan(0);
    }
  });

  it('classifies automation by implemented capability: automated and partial cases name a real capability, manual ones do not', () => {
    for (const d of starterDefinitions()) {
      if (d.automation === 'manual') expect(d.body.requiredCapability, d.id).toBeUndefined();
      else expect(ENGINE_CAPABILITIES as readonly string[], d.id).toContain(d.body.requiredCapability);
      expect(effectiveAutomation(d), d.id).toBe(d.automation);
    }
    const byClass = (c: string) => starterDefinitions().filter((d) => d.automation === c).length;
    expect(byClass('automated') + byClass('partially_automated')).toBeGreaterThan(10);
    expect(byClass('manual')).toBeGreaterThan(30); // most interactions have no adapter yet and say so
  });

  it('seeds once, never overwrites a case a person edited, and keeps history', () => {
    expect(seedStarterLibrary(qa)).toEqual({ added: EXPECTED_IDS.length, total: EXPECTED_IDS.length });
    expect(seedStarterLibrary(qa).added).toBe(0);
    const d = qa.getDefinition('ACC-01')!;
    const edited = qa.saveDefinition({ ...d, title: 'Team wording for accordions', reviewState: 'reviewed' }, 'Sam', 'Aligned with team case TC-12');
    expect(edited.version).toBe(2);
    seedStarterLibrary(qa);
    expect(qa.getDefinition('ACC-01')!.title).toBe('Team wording for accordions');
    const history = qa.definitionHistory('ACC-01');
    expect(history.map((h) => [h.version, h.actor])).toEqual([[2, 'Sam'], [1, 'system']]);
    expect(history[1]!.snapshot.title).toBe(d.title); // the earlier version is kept
  });
});

describe('CSV', () => {
  it('parses quoted fields, doubled quotes, commas and newlines inside quotes, and CRLF', () => {
    const rows = parseCsv('a,b,c\r\n1,"two, with comma","line1\nline2"\r\n"quote ""x""",,3\r\n');
    expect(rows).toEqual([['a', 'b', 'c'], ['1', 'two, with comma', 'line1\nline2'], ['quote "x"', '', '3']]);
  });

  it('neutralizes spreadsheet formulas on the way out', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    for (const lead of ['=', '+', '-', '@']) expect(csvCell(`${lead}cmd`).startsWith(`"'${lead}`)).toBe(true);
    expect(csvCell('plain')).toBe('"plain"');
  });

  it('exports the library and reads it back unchanged in the fields it carries', () => {
    seedStarterLibrary(qa);
    const defs = qa.listDefinitions();
    const csv = definitionsToCsv(defs);
    const [header, ...rows] = parseCsv(csv);
    expect(rows).toHaveLength(defs.length);
    const mapping = suggestMapping(header!);
    const preview = previewImport(header!, rows, mapping, (id) => qa.getDefinition(id), (e) => qa.getDefinitionByExternalId(e));
    expect(preview.every((p) => p.status === 'duplicate')).toBe(true);
    expect(preview.find((p) => p.id === 'LOG-01')!.definition!.body.expectedResult).toBe(qa.getDefinition('LOG-01')!.body.expectedResult);
  });
});

describe('importing team cases', () => {
  const headers = ['Case No', 'Case Name', 'Module', 'Steps', 'Expected', 'Priority', 'Type'];
  const map = () => suggestMapping(headers);
  const run = (rows: string[][]) => previewImport(headers, rows, { ...map(), id: 'Case No' }, (id) => qa.getDefinition(id), (e) => qa.getDefinitionByExternalId(e));

  it('suggests a mapping from common header names and lets the reviewer confirm it', () => {
    expect(map()).toMatchObject({ title: 'Case Name', category: 'Module', steps: 'Steps', expected_result: 'Expected', priority: 'Priority', interaction_type: 'Type' });
  });

  it('keeps the team ID and wording exactly, and stores imported cases as drafts', () => {
    const [r] = run([['TC-0042', 'Accordion – every panel opens (v2)', 'Interactions', 'Open panel 1 | Open panel 2', 'Each panel shows its text', '1', 'accordion']]);
    expect(r!.status).toBe('new');
    expect(r!.externalId).toBe('TC-0042');
    expect(r!.definition).toMatchObject({ id: 'TC-0042', externalId: 'TC-0042', title: 'Accordion – every panel opens (v2)', category: 'Interactions', priority: 1, interactionType: 'accordion', reviewState: 'draft', origin: 'import' });
    expect(r!.definition!.body.expectedResult).toBe('Each panel shows its text');
    expect(r!.definition!.body.actions.map((a) => (a.kind === 'manual' ? a.instruction : ''))).toEqual(['Open panel 1', 'Open panel 2']);
  });

  it('explains every malformed row and does not guess', () => {
    const rows = run([
      ['TC-1', '', 'M', 'step', 'exp', '2', 'accordion'],
      ['TC-2', 'Bad type', 'M', 'step', 'exp', '2', 'wormhole'],
      ['TC-3', 'Bad priority', 'M', 'step', 'exp', '9', 'tab'],
      ['TC-4', 'Fine', 'M', 'step', 'exp', '3', 'tab'],
      ['TC-4', 'Same ID twice', 'M', 'step', 'exp', '3', 'tab'],
    ]);
    expect(rows.map((r) => r.status)).toEqual(['invalid', 'invalid', 'invalid', 'new', 'invalid']);
    expect(rows[0]!.problems.join(' ')).toMatch(/Title is missing/);
    expect(rows[1]!.problems.join(' ')).toMatch(/Interaction type "wormhole" is not one of/);
    expect(rows[2]!.problems.join(' ')).toMatch(/Priority "9" must be 1, 2 or 3/);
    expect(rows[4]!.problems.join(' ')).toMatch(/appears more than once/);
    expect(rows.every((r) => r.row >= 2)).toBe(true);
  });

  it('never lets imported text claim automation, and never treats it as code', () => {
    const h = [...headers, 'Automation', 'Capability'];
    const [claimed, real] = previewImport(
      h,
      [
        ['TC-9', 'Claims automation', 'M', '=cmd|calc\'!A1 | <script>alert(1)</script>', 'exp', '2', 'tab', 'automated', 'telepathy'],
        ['TC-10', 'Names a real capability', 'M', 'step', 'exp', '2', 'tab', 'automated', 'tabs'],
      ],
      { ...suggestMapping(h), id: 'Case No', automation: 'Automation', required_capability: 'Capability' },
      () => undefined,
      () => undefined,
    );
    expect(claimed!.definition!.automation).toBe('manual');
    expect(claimed!.definition!.body.actions.every((a) => a.kind === 'manual')).toBe(true);
    expect(real!.definition!.automation).toBe('automated');
  });

  it('handles duplicates by ID or team ID with an explicit skip or replace choice', () => {
    seedStarterLibrary(qa);
    commitImport(qa, run([['TC-7', 'Existing team case', 'M', 'step', 'exp', '2', 'tab']]), { duplicates: 'skip', actor: 'Sam' });
    const again = run([
      ['TC-7', 'Existing team case, reworded', 'M', 'step', 'exp', '2', 'tab'],
      ['ACC-01', 'Collides with a starter ID', 'M', 'step', 'exp', '2', 'accordion'],
    ]);
    expect(again.map((r) => r.status)).toEqual(['duplicate', 'duplicate']);
    expect(again[0]!.existing).toMatchObject({ id: 'TC-7' });
    expect(commitImport(qa, again, { duplicates: 'skip', actor: 'Sam' })).toEqual({ created: 0, replaced: 0, skipped: 2, invalid: 0 });
    expect(qa.getDefinition('TC-7')!.title).toBe('Existing team case');
    expect(commitImport(qa, again, { duplicates: 'replace', actor: 'Sam' })).toEqual({ created: 0, replaced: 2, skipped: 0, invalid: 0 });
    expect(qa.getDefinition('TC-7')).toMatchObject({ title: 'Existing team case, reworded', version: 2 });
    expect(qa.definitionHistory('TC-7').map((h) => h.version)).toEqual([2, 1]);
  });
});
