import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProjectId, TestExecution } from '@cqa/shared';
import { QaStore, buildScanConfig, seedStarterLibrary, starterDefinitions } from '@cqa/core';
import { type Harness, createHarness } from './support/harness.js';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 240_000 });

let fx: FixtureServer;
let h: Harness;
let qa: QaStore;

beforeAll(async () => {
  fx = await startFixtureServer();
  h = createHarness({ exemptAddresses: [{ ip: '127.0.0.1', port: fx.port }] });
  qa = new QaStore(h.store.db);
  h.startWorker();
});
afterAll(async () => {
  await h?.close();
  await fx?.close();
});

async function scan(fixture: string) {
  const project = h.store.createProject({ name: `Recipes ${fixture}` });
  const url = `${fx.origin}/${fixture}/`;
  const config = buildScanConfig({ projectId: project.id as ProjectId, url: new URL(url), explore: true, accessibility: false, layout: false, functional: true, qaProfile: 'functional' });
  const run = await h.waitForTerminal(h.store.createRun(config, url).id, 230_000);
  await h.worker!.idle();
  const execs = qa.currentExecutions(run.id);
  const interactions = qa.listInteractions(run.id);
  const labelOf = (e: TestExecution) => interactions.find((i) => i.id === e.instanceId)?.label ?? '';
  const of = (caseId: string, label: RegExp) => execs.filter((e) => e.definitionId === caseId && label.test(labelOf(e)));
  return { run, execs, interactions, of };
}

describe('working interactions', () => {
  let r: Awaited<ReturnType<typeof scan>>;
  beforeAll(async () => {
    r = await scan('recipes-good');
  });

  it('a flip card flips to readable content and turns back', () => {
    const [e] = r.of('FLP-01', /Safety/);
    expect(e?.status, e?.reason).toBe('passed');
    expect(e!.actual).toMatch(/Safety means nobody gets hurt/);
    expect(e!.trace.filter((t) => t.step === 'action').map((t) => t.detail).join(' ')).toMatch(/Flip.*Flip back/s);
  });

  it('a carousel moves forward, shows different content and comes back', () => {
    const [e] = r.of('TIM-01', /Steps/);
    expect(e?.status, e?.reason).toBe('passed');
    expect(e!.actual).toMatch(/Step two/);
  });

  it('audio plays and pauses: time moves while playing, and stops when paused', () => {
    const [e] = r.of('AUD-01', /Narration/);
    expect(e?.status, e?.reason).toBe('passed');
    const observed = e!.trace.filter((t) => t.step === 'observed').map((t) => t.detail).join(' ');
    expect(observed).toMatch(/time/i);
  });

  it('a section that opens a moment after the click passes, not fails', () => {
    const [e] = r.of('ACC-01', /Slow section/);
    expect(e?.status, e?.reason).toBe('passed');
  });

  it('a button hidden from learners is not treated as a control', () => {
    expect(r.interactions.some((i) => /TAKE AGAIN/.test(i.label))).toBe(false);
  });

  it('flip cards are not tested as accordions', () => {
    expect(r.interactions.filter((i) => /flip/i.test(i.label)).every((i) => i.type === 'flip_card')).toBe(true);
    // Other cases list ACC-01 as not applicable; what matters is that it never ran on a card.
    expect(r.of('ACC-01', /flip/i)).toEqual([]);
  });

  it('nothing is reported as a course defect', () => {
    expect(h.store.listFindings(r.run.id).filter((f) => f.ruleId === 'FUN-001' || f.ruleId === 'NAV-001')).toEqual([]);
  });
});

describe('broken interactions are caught', () => {
  let r: Awaited<ReturnType<typeof scan>>;
  beforeAll(async () => {
    r = await scan('recipes-broken');
  });

  it('a flip button that does nothing fails', () => {
    const [e] = r.of('FLP-01', /Dead card/);
    expect(e?.status, e?.reason).toBe('failed');
    expect(e!.reason).toMatch(/did not flip/i);
  });

  it('a card whose back is empty fails', () => {
    const [e] = r.of('FLP-01', /Empty back/);
    expect(e?.status, e?.reason).toBe('failed');
    expect(e!.reason).toMatch(/empty/i);
  });

  it('a card that cannot be turned back fails', () => {
    const [e] = r.of('FLP-01', /Stuck card/);
    expect(e?.status, e?.reason).toBe('failed');
    expect(e!.reason).toMatch(/turn.*back|back.*front/i);
  });

  it('a card with no back side in the page cannot be judged: unsupported, not passed or failed', () => {
    const [e] = r.of('FLP-01', /One sided/);
    expect(e?.status, e?.reason).toBe('unsupported');
  });

  it('a carousel whose Next does nothing fails', () => {
    const [e] = r.of('TIM-01', /Dead steps/);
    expect(e?.status, e?.reason).toBe('failed');
  });

  it('a play button that is not connected to the audio fails', () => {
    const [e] = r.of('AUD-01', /Silent narration/);
    expect(e?.status, e?.reason).toBe('failed');
    expect(e!.reason).toMatch(/did not (start|play)/i);
  });

  it('audio whose file is missing fails, and metadata alone never counts as playing', () => {
    const [e] = r.of('AUD-01', /Missing narration/);
    expect(e?.status, e?.reason).toBe('failed');
    expect(e!.reason).toMatch(/could not load|failed to load/i);
  });

  it('a format this browser cannot decode is unsupported: a limit of the scanner, not a course defect', () => {
    const [e] = r.of('VID-01', /Odd format video/);
    expect(e?.status, e?.reason).toBe('unsupported');
    expect(e!.reason).toMatch(/cannot (decode|play)/i);
  });
});

describe('the test library', () => {
  it('marks flip cards, carousels, audio and video as automated, naming a real capability', () => {
    for (const id of ['FLP-01', 'TIM-01', 'AUD-01', 'VID-01']) {
      const d = starterDefinitions().find((x) => x.id === id)!;
      expect(d.automation, id).not.toBe('manual');
      expect(d.body.requiredCapability, id).toBeTruthy();
    }
  });

  it('an existing database picks up the new automation for starter cases, and leaves reviewer-edited cases alone', () => {
    const store = new QaStore(h.store.db);
    seedStarterLibrary(store);
    const flip = store.getDefinition('FLP-01')!;
    // Stored as it was before this capability existed.
    store.saveDefinition({ ...flip, automation: 'manual', body: { ...flip.body, requiredCapability: undefined } }, 'system', 'old starter');
    const edited = store.getDefinition('TIM-01')!;
    store.saveDefinition({ ...edited, origin: 'user', automation: 'manual', body: { ...edited.body, requiredCapability: undefined } }, 'reviewer', 'edited by a person');
    seedStarterLibrary(store);
    expect(store.getDefinition('FLP-01')!.body.requiredCapability).toBe('flip_card');
    expect(store.getDefinition('TIM-01')!.automation).toBe('manual');
  });
});
