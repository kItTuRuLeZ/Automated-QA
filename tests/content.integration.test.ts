import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CheckResult, Finding } from '@cqa/shared';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';
import { type Harness, createHarness } from './support/harness.js';

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
  const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/${path}`, { explore: false, linkCheckTimeoutMs: 3_000, ...opts }).id, 120_000);
  return { run, checks: h.store.listCheckResults(run.id), findings: h.store.listFindings(run.id) };
}
const of = (findings: Finding[], ruleId: string) => findings.filter((f) => f.ruleId === ruleId);
const titleFor = (findings: Finding[], text: string) => findings.find((f) => f.title.includes(text));
const outcomes = (checks: CheckResult[], ruleId: string) => checks.filter((c) => c.ruleId === ruleId).map((c) => c.outcome);

describe('link checks', () => {
  let r: Awaited<ReturnType<typeof scan>>;
  beforeAll(async () => {
    r = await scan('links/');
  });

  it('flags only real HTTP errors as broken (404, 410, redirect to 404)', () => {
    expect(of(r.findings, 'LNK-001').map((f) => f.title).sort()).toEqual([
      'Broken link "Missing page" (HTTP 404)',
      'Broken link "Moved then missing" (HTTP 404)',
      'Broken link "Removed page" (HTTP 410)',
    ]);
  });

  it('treats 401/403 as access-restricted, not broken', () => {
    expect(titleFor(r.findings, 'Members area')?.ruleId).toBe('LNK-002');
    expect(titleFor(r.findings, 'Staff only')?.ruleId).toBe('LNK-002');
  });

  it('treats timeouts and policy-blocked destinations (including redirects to private IPs) as unverified', () => {
    expect(titleFor(r.findings, 'Slow server')?.ruleId).toBe('LNK-003');
    expect(titleFor(r.findings, 'Redirects to a private address')?.ruleId).toBe('LNK-003');
    expect(titleFor(r.findings, 'Metadata address')?.ruleId).toBe('LNK-003');
  });

  it('passes working links, HEAD-405 servers via GET, followed redirects, and external origins; de-duplicates fragments', () => {
    for (const t of ['Working page', 'No HEAD support', 'Moved page', 'External resource']) expect(titleFor(r.findings, t), t).toBeUndefined();
    const passed = r.checks.filter((c) => c.ruleId === 'LNK-001' && c.outcome === 'passed');
    // /links/ok and /links/ok#section are one destination.
    expect(passed).toHaveLength(4);
    // Restricted and unverified links are never counted as passed.
    expect(r.checks.filter((c) => c.ruleId === 'LNK-001' && c.outcome === 'not_tested')).toHaveLength(5);
  });

  it('flags javascript: and empty hrefs; ignores mailto', () => {
    expect(of(r.findings, 'LNK-005').map((f) => f.title).sort()).toEqual(['Link "Empty link" has an empty href', 'Link "Script link" uses a javascript: URL']);
    expect(r.findings.some((f) => f.title.includes('Email us'))).toBe(false);
  });

  it('broken link findings say where the link appears and how to reach it', () => {
    const f = titleFor(r.findings, 'Missing page')!;
    expect(f.occurrences[0]?.location.elementDescription).toBe('link "Missing page"');
    expect(f.reproductionSteps.at(-1)).toContain('Follow the link "Missing page"');
    expect(f.evidenceIds).toHaveLength(1);
  });
});

describe('images and media', () => {
  it('lazy images are checked after scrolling: the broken one fails, the valid one and decorative empty-alt image do not', async () => {
    const { findings, checks } = await scan('lazy-image/');
    expect(of(findings, 'MED-001').map((f) => f.title)).toEqual(['Broken image: missing-lazy.png']);
    expect(outcomes(checks, 'MED-001')).toEqual(['failed']);
  });

  it('oversized assets are a size warning with the threshold source', async () => {
    const { findings } = await scan('lazy-image/');
    const big = of(findings, 'MED-005');
    expect(big).toHaveLength(1);
    expect(big[0]?.expected).toContain('Application default');
  });

  it('media: missing audio/video fail, playable audio passes, uncaptioned and control-less video are flagged', async () => {
    const { findings } = await scan('broken-media/');
    expect(of(findings, 'MED-002').map((f) => f.title).sort()).toEqual(['Audio failed to load: missing.mp3', 'Video failed to load: missing.mp4']);
    expect(findings.some((f) => f.title.includes('tone.wav'))).toBe(false);
    expect(of(findings, 'MED-003').map((f) => f.title)).toEqual(['Video has no caption track: missing.mp4']);
    expect(of(findings, 'MED-004').map((f) => f.type)).toEqual(['heuristic_warning']);
  });
});

describe('text checks', () => {
  it('flags placeholders and production notes, respects exclusions, ignores hidden text and lowercase "to do"', async () => {
    const { findings } = await scan('placeholder-text/', { textExclusions: ['XXX Series'] });
    const matched = of(findings, 'TXT-001').map((f) => f.title);
    expect(matched).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Lorem ipsum'),
        expect.stringContaining('Note to the GD'),
        expect.stringContaining('[Insert image'),
        expect.stringContaining('TBD'),
      ]),
    );
    expect(matched).toHaveLength(4);
    expect(matched.some((t) => /to ?do|XXX/i.test(t))).toBe(false);
  });

  it('terminology rules run only when configured', async () => {
    const without = await scan('placeholder-text/');
    expect(outcomes(without.checks, 'TXT-002')).toEqual(['not_applicable']);
    const withTerms = await scan('placeholder-text/', { terminology: [{ term: 'e-learning', preferred: 'eLearning' }] });
    expect(of(withTerms.findings, 'TXT-002').map((f) => f.title)).toEqual(['Term "e-learning" (preferred: "eLearning")']);
  });
});

describe('checks run on every explored state', () => {
  it('placeholder text revealed only by expanding a section is found during traversal, with the click in its repro steps', async () => {
    const hidden = await scan('hidden-placeholder/');
    expect(of(hidden.findings, 'TXT-001')).toEqual([]);
    const explored = await scan('hidden-placeholder/', { explore: true });
    const [f] = of(explored.findings, 'TXT-001');
    expect(f?.title).toContain('Lorem ipsum');
    expect(f?.reproductionSteps.some((s) => s.includes('Expand expandable section "More details"'))).toBe(true);
    expect(explored.checks.filter((c) => c.ruleId === 'TXT-001')).toHaveLength(2); // one per reached state
  }, 180_000);
});

describe('authoring-tool patterns (found on real Storyline output)', () => {
  it('checks Storyline-style script link destinations instead of flagging them, and ignores Back to top', async () => {
    const { findings, checks } = await scan('authoring-patterns/', { explore: true });
    expect(of(findings, 'LNK-005')).toEqual([]);
    expect(of(findings, 'LNK-001').map((f) => f.title)).toEqual(['Broken link "Read the article" (HTTP 404)']);
    expect(checks.filter((c) => c.ruleId === 'LNK-001' && c.outcome === 'passed').length).toBeGreaterThanOrEqual(1);
    const actions = h.store.listActions(h.store.getRun(checks[0]!.runId)!.id);
    expect(actions.some((a) => a.targetDescription.includes('Back to top') && a.kind === 'back')).toBe(false);
    expect(actions.find((a) => a.targetDescription.includes('Start Course'))).toMatchObject({ kind: 'next', outcome: 'succeeded' });
  });

  it('does not report inline placeholder video or player-controlled media', async () => {
    const { findings } = await scan('authoring-patterns/');
    expect(of(findings, 'MED-003')).toEqual([]);
    expect(of(findings, 'MED-004')).toEqual([]);
  });
});
