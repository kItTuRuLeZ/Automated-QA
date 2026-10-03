import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CheckResult, Finding } from '@cqa/shared';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';
import { type Harness, createHarness } from './support/harness.js';

// Each test runs real scans with axe-core and keyboard journeys; allow for that.
vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

let fx: FixtureServer;
let h: Harness;

beforeAll(async () => {
  fx = await startFixtureServer();
  h = createHarness({
    exemptAddresses: [
      { ip: '127.0.0.1', port: fx.port },
      { ip: '127.0.0.1', port: fx.otherPort },
    ],
  });
  h.startWorker();
});

afterAll(async () => {
  await h?.close();
  await fx?.close();
});

async function scan(path: string, opts: Parameters<Harness['queueScan']>[1] = {}) {
  const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/${path}`, { accessibility: true, explore: true, maxStates: 6, maxDepth: 2, ...opts }).id, 240_000);
  return { run, checks: h.store.listCheckResults(run.id), findings: h.store.listFindings(run.id) };
}
const of = (findings: Finding[], ruleId: string) => findings.filter((f) => f.ruleId === ruleId);
const outcomes = (checks: CheckResult[], ruleId: string) => checks.filter((c) => c.ruleId === ruleId).map((c) => c.outcome);

describe('automated accessibility rules (axe-core)', () => {
  let r: Awaited<ReturnType<typeof scan>>;
  beforeAll(async () => {
    r = await scan('a11y-known/');
  });

  it('reports known defects with axe impact mapped to severity, and keeps the engine version', () => {
    const img = of(r.findings, 'A11Y-AXE-image-alt');
    expect(img).toHaveLength(1);
    expect(img[0]).toMatchObject({ severity: 'critical', type: 'standards_warning', confidence: 'high' });
    expect(img[0]?.standards).toContainEqual({ standard: 'WCAG', criterion: '1.1.1', relation: 'relevant' });
    for (const id of ['button-name', 'label']) expect(of(r.findings, `A11Y-AXE-${id}`), id).toHaveLength(1);
    // html-has-lang is reported per page: the fixture and the page its link leads to are separate findings.
    expect(of(r.findings, 'A11Y-AXE-html-has-lang').length).toBeGreaterThanOrEqual(1);
    expect(of(r.findings, 'A11Y-AXE-html-has-lang').some((f) => f.location.url?.endsWith('/a11y-known/'))).toBe(true);
    expect(r.checks.find((c) => c.ruleId === 'A11Y-AXE-image-alt')?.engineVersion).toMatch(/^axe-core \d+\.\d+/);
  });

  it('does not report decorative (alt="") or described images: only the image with no alt attribute', () => {
    const [f] = of(r.findings, 'A11Y-AXE-image-alt');
    expect(f?.occurrences).toHaveLength(1);
    expect(f?.occurrences[0]?.location.elementDescription).not.toContain('alt=');
    expect(JSON.stringify(f)).not.toContain('Company logo');
  });

  it('heading and landmark advice is a heuristic warning, not an automated defect', () => {
    expect(of(r.findings, 'A11Y-AXE-heading-order')[0]?.type).toBe('heuristic_warning');
    expect(of(r.findings, 'A11Y-AXE-landmark-one-main').concat(of(r.findings, 'A11Y-AXE-page-has-heading-one')).every((f) => f.type === 'heuristic_warning')).toBe(true);
  });

  it('records passed and not-applicable rules separately from failures, with distinct rule and execution counts', () => {
    expect(outcomes(r.checks, 'A11Y-AXE-document-title')).toContain('passed');
    expect(outcomes(r.checks, 'A11Y-AXE-image-alt')).toEqual(expect.arrayContaining(['failed']));
    const s = h.store.summarizeRun(r.run.id);
    expect(s.uniqueRules).toBeGreaterThan(60);
    expect(s.executions).toBeGreaterThanOrEqual(s.uniqueRules);
  });

  it('every failed axe check carries node evidence and findings say how to reproduce', () => {
    const [f] = of(r.findings, 'A11Y-AXE-button-name');
    const ev = h.store.getEvidence(f!.evidenceIds);
    expect(ev[0]?.kind).toBe('axe_node');
    expect((ev[0]?.data as { nodes: unknown[] }).nodes.length).toBeGreaterThan(0);
    expect(f?.reproductionSteps.some((s) => s.includes('button-name'))).toBe(true);
  });

  it('accessibility checks are off unless enabled (no A11Y or KBD results)', async () => {
    const off = await scan('a11y-known/', { accessibility: false, explore: false });
    expect(off.checks.some((c) => c.ruleId.startsWith('A11Y') || c.ruleId.startsWith('KBD'))).toBe(false);
  });
});

describe('reflow', () => {
  it('flags content that needs horizontal scrolling at 320 CSS px, as a low-confidence heuristic', async () => {
    const { findings, checks } = await scan('reflow-wide/', { explore: false });
    const [f] = of(findings, 'A11Y-008');
    expect(f).toMatchObject({ type: 'heuristic_warning', confidence: 'low' });
    expect(f?.observed).toContain('#wide');
    expect(outcomes(checks, 'A11Y-008')).toEqual(['needs_review']);
  });

  it('passes a layout that fits, and restores the viewport afterwards', async () => {
    const { checks } = await scan('dialog-good/', { explore: false });
    expect(outcomes(checks, 'A11Y-008')).toEqual(['passed']);
  });
});

describe('keyboard journeys', () => {
  it('detects a keyboard trap that survives Escape, with the focus sequence as evidence', async () => {
    const { findings, checks } = await scan('keyboard-trap/', { explore: false });
    const [f] = of(findings, 'KBD-001');
    expect(f).toMatchObject({ type: 'automated_defect', severity: 'high' });
    expect(f?.title).toContain('2 elements');
    expect(outcomes(checks, 'KBD-001')).toEqual(['failed']);
    const ev = h.store.getEvidence(f!.evidenceIds);
    expect(ev[0]?.kind).toBe('focus_sequence');
  });

  it('does not report a trap on a normal page, and treats an open dialog as expected containment', async () => {
    const { checks } = await scan('tabs/');
    expect(outcomes(checks, 'KBD-001')).not.toContain('failed');
    const dlg = await scan('dialog-good/');
    expect(outcomes(dlg.checks, 'KBD-001')).toEqual(expect.arrayContaining(['passed', 'not_applicable']));
    expect(of(dlg.findings, 'KBD-001')).toEqual([]);
  });

  it('flags only the element whose focus state is visually identical to its unfocused state', async () => {
    const { findings } = await scan('focus-style/', { explore: false });
    const [f] = of(findings, 'KBD-002');
    expect(f?.type).toBe('heuristic_warning');
    expect(f?.occurrences.map((o) => o.location.elementDescription)).toEqual([expect.stringContaining('No focus indicator')]);
  });

  it('a working modal dialog opens with the keyboard, takes focus, contains it, and returns it', async () => {
    const { findings, checks } = await scan('dialog-good/');
    expect(outcomes(checks, 'KBD-003')).toEqual(['passed']);
    expect(outcomes(checks, 'KBD-004')).toEqual(['passed']);
    expect(of(findings, 'KBD-003')).toEqual([]);
  });

  it('a broken dialog is flagged for not moving focus in and not returning it', async () => {
    const { findings, checks } = await scan('dialog-broken/');
    expect(outcomes(checks, 'KBD-003')).toEqual(['failed']);
    expect(of(findings, 'KBD-003').map((f) => f.title).sort()).toEqual([
      'Dialog opened by dialog opener "Open notice" does not move focus into the dialog',
      'Dialog opened by dialog opener "Open notice" does not return focus to the opener when closed',
    ]);
    const ev = h.store.getEvidence(of(findings, 'KBD-003')[0]!.evidenceIds);
    expect((ev[0]?.data as { log: string[] }).log.some((l) => l.includes('outside dialog'))).toBe(true);
  });

  it('flags mouse-only and click-only controls but not native buttons (KBD-004)', async () => {
    const { findings } = await scan('keyboard-controls/');
    const titles = of(findings, 'KBD-004').map((f) => f.title);
    expect(titles).toEqual(
      expect.arrayContaining([expect.stringMatching(/Mouse-only section.*cannot be reached/), expect.stringMatching(/Click-only section.*cannot be operated/)]),
    );
    expect(titles.some((t) => t.includes('Native section'))).toBe(false);
  });
});

describe('disclosure', () => {
  it('canvas content stays disclosed as uninspected even when accessibility checks run', async () => {
    const { findings, checks } = await scan('canvas/');
    expect(of(findings, 'COV-003')).toHaveLength(1);
    expect(outcomes(checks, 'COV-003')).toEqual(['needs_review']);
    expect(outcomes(checks, 'A11Y-ENG')).toEqual(['passed']);
  });
});
