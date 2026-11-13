import { readdirSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';
import { type Harness, createHarness } from './support/harness.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

let fx: FixtureServer;
let h: Harness | undefined;
beforeAll(async () => {
  fx = await startFixtureServer();
});
afterAll(async () => {
  await fx?.close();
});
afterEach(async () => {
  await h?.close();
  h = undefined;
});
const harness = () => createHarness({ exemptAddresses: [{ ip: '127.0.0.1', port: fx.port }] });
const tempDirs = (root: string) => {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
};

describe('two scans at the same time', () => {
  it('each keeps its own screens and findings, and cleans up its own files', async () => {
    h = harness();
    h.startWorker({ concurrency: 2 });
    const healthy = h.queueScan(`${fx.origin}/healthy/`, { explore: false });
    const broken = h.queueScan(`${fx.origin}/js-exception/`, { explore: false });
    const [a, b] = await Promise.all([h.waitForTerminal(healthy.id, 150_000), h.waitForTerminal(broken.id, 150_000)]);
    await h.worker!.idle();
    expect(['completed', 'partial']).toContain(a.status);
    expect(['completed', 'partial']).toContain(b.status);
    // Nothing from one scan appears in the other.
    expect(h.store.listStates(a.id).every((s) => s.url.includes('/healthy/'))).toBe(true);
    expect(h.store.listStates(b.id).every((s) => s.url.includes('/js-exception/'))).toBe(true);
    expect(h.store.listFindings(a.id).some((f) => f.ruleId === 'RUN-002')).toBe(false);
    expect(h.store.listFindings(b.id).some((f) => f.ruleId === 'RUN-002')).toBe(true);
    expect(h.store.listFindings(b.id).every((f) => !f.location.url || String(f.location.url).includes('/js-exception/'))).toBe(true);
    expect(tempDirs(h.tmpRoot)).toEqual([]);
  });
});

describe('storage failure', () => {
  it('a scan whose evidence cannot be written still finishes with its results, and says so instead of crashing', async () => {
    h = harness();
    h.artifacts.write = () => {
      throw new Error('disk full (simulated)');
    };
    h.startWorker();
    const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/js-exception/`, { explore: false }).id, 150_000);
    await h.worker!.idle();
    expect(run.status).not.toBe('running');
    // The page error is still found: losing a screenshot does not lose the result.
    expect(h.store.listFindings(run.id).some((f) => f.ruleId === 'RUN-002')).toBe(true);
    // No evidence points at a file that was never written.
    const ids = h.store.listFindings(run.id).flatMap((f) => f.evidenceIds);
    for (const ev of h.store.getEvidence(ids)) if (ev.artifactId) expect(h.store.getArtifact(ev.artifactId)).toBeTruthy();
  });
});
