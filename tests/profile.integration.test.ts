import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProfileId, ProfileSnapshot } from '@cqa/shared';
import { ProfileInput, buildRunReport, deltaE2000, newId, parseCssColor, profileScanOptions, toClientProfile } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';
import { type Harness, createHarness } from './support/harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let fx: FixtureServer;
let h: Harness;
beforeAll(async () => {
  fx = await startFixtureServer();
  h = createHarness({ exemptAddresses: [{ ip: '127.0.0.1', port: fx.port }, { ip: '127.0.0.1', port: fx.otherPort }] });
  h.startWorker();
});
afterAll(async () => {
  await h?.close();
  await fx?.close();
});

const parse = (v: unknown) => {
  const r = ProfileInput.safeParse(v);
  if (!r.success) throw new Error(JSON.stringify(r.error.issues));
  return r.data;
};
const snapshot = (input: unknown): ProfileSnapshot => profileScanOptions(toClientProfile(newId<ProfileId>(), parse(input))).snapshot;

const BRAND = { approvedFonts: ['Arial'], approvedColors: [{ name: 'Brand blue', value: '#1f4e9c' }], minTextSizePx: 12, source: 'Test brand guide v1, page 4' };

async function scanBrand(profile?: ProfileSnapshot) {
  const run = await h.waitForTerminal(h.queueScan(`${fx.origin}/brand/`, { explore: false, profile }).id);
  return { run, checks: h.store.listCheckResults(run.id), findings: h.store.listFindings(run.id) };
}

describe('colour distance', () => {
  it('is zero for the same colour, small for near colours, large for different ones', () => {
    const blue = parseCssColor('#1f4e9c')!;
    expect(deltaE2000(blue, blue)).toBe(0);
    expect(deltaE2000(blue, parseCssColor('rgb(33, 79, 154)')!)).toBeLessThan(2);
    expect(deltaE2000(blue, parseCssColor('#d9531e')!)).toBeGreaterThan(30);
    expect(deltaE2000(parseCssColor('#000')!, parseCssColor('#fff')!)).toBeGreaterThan(90);
  });
});

describe('client profiles', () => {
  it('brand values need a stated source, and unknown rules are refused', () => {
    expect(ProfileInput.safeParse({ name: 'X', brand: { approvedFonts: ['Arial'] } }).success).toBe(false);
    expect(ProfileInput.safeParse({ name: 'X', brand: { approvedFonts: ['Arial'], source: 'Guide v2' } }).success).toBe(true);
    expect(ProfileInput.safeParse({ name: 'Neutral' }).success).toBe(true);
    expect(ProfileInput.safeParse({ name: 'X', ruleExclusions: [{ ruleId: 'NOPE-999', reason: 'x' }] }).success).toBe(false);
    expect(ProfileInput.safeParse({ name: 'X', ruleExclusions: [{ ruleId: 'RUN-005', reason: '' }] }).success).toBe(false);
  });

  it('without brand values there are no brand checks at all', async () => {
    const { findings, checks } = await scanBrand(snapshot({ name: 'Neutral' }));
    expect(findings.filter((f) => f.ruleId.startsWith('BRD-'))).toEqual([]);
    expect(checks.filter((c) => c.ruleId.startsWith('BRD-'))).toEqual([]);
    const none = await scanBrand();
    expect(none.checks.filter((c) => c.ruleId.startsWith('BRD-'))).toEqual([]);
  });

  it('flags only what differs from the values the person supplied, as heuristic warnings', async () => {
    const { run, findings, checks } = await scanBrand(snapshot({ name: 'Acme', brand: BRAND }));
    const brand = findings.filter((f) => f.ruleId.startsWith('BRD-'));
    expect(brand.map((f) => f.ruleId).sort()).toEqual(['BRD-001', 'BRD-002', 'BRD-003']);
    expect(brand.every((f) => f.type === 'heuristic_warning')).toBe(true);
    const font = brand.find((f) => f.ruleId === 'BRD-001')!;
    expect(font.title).toContain('Georgia');
    expect(font.observed).toContain('Test brand guide v1, page 4');
    const colour = brand.find((f) => f.ruleId === 'BRD-002')!;
    expect(colour.title).toContain('rgb(217, 83, 30)');
    expect(brand.filter((f) => f.ruleId === 'BRD-002')).toHaveLength(1); // the near-blue and black text are not flagged
    expect(brand.find((f) => f.ruleId === 'BRD-003')!.title).toContain('9 px');
    expect(checks.filter((c) => c.ruleId === 'BRD-001').map((c) => c.outcome)).toEqual(['needs_review']);
    const report = buildRunReport(h.store, run.id);
    expect(report.scan.profile).toMatchObject({ name: 'Acme', brandSource: 'Test brand guide v1, page 4' });
    expect(report.scan.checksEnabled).toContain('brand (from client profile)');
  });

  it('switched-off rules show as not applicable with the reason; priority changes are recorded', async () => {
    const { findings, checks } = await scanBrand(
      snapshot({
        name: 'Acme',
        brand: BRAND,
        ruleExclusions: [{ ruleId: 'BRD-003', reason: 'Fine print is legal text' }],
        severityOverrides: [{ ruleId: 'BRD-001', severity: 'high', reason: 'Client treats font misuse as serious' }],
      }),
    );
    expect(findings.filter((f) => f.ruleId === 'BRD-003')).toEqual([]);
    const off = checks.filter((c) => c.ruleId === 'BRD-003');
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({ outcome: 'not_applicable', reason: 'excluded_by_profile' });
    expect(off[0]!.reasonDetail).toContain('Fine print is legal text');
    const font = findings.find((f) => f.ruleId === 'BRD-001')!;
    expect(font.severityOverride).toMatchObject({ from: 'low', to: 'high', reviewer: expect.stringContaining('Acme') });
  });

  it('API creates, applies to a scan, and keeps the scan unchanged when the profile is edited', async () => {
    const HOST = '127.0.0.1:4317';
    const app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`] });
    const hdr = { host: HOST, 'x-qa-request': '1', 'content-type': 'application/json' };
    try {
      const created = await app.inject({ method: 'POST', url: '/api/profiles', headers: hdr, payload: { name: 'Acme', brand: BRAND, viewports: ['desktop'] } });
      expect(created.statusCode).toBe(201);
      const profile = created.json() as { id: string; brand: { provenance: { source: string; note: string } } };
      expect(profile.brand.provenance).toMatchObject({ source: 'user_supplied', note: 'Test brand guide v1, page 4' });
      const bad = await app.inject({ method: 'POST', url: '/api/profiles', headers: hdr, payload: { name: 'Acme', brand: { approvedFonts: ['Arial'] } } });
      expect(bad.statusCode).toBe(400);

      const project = h.store.createProject({ name: 'Profile project' });
      const res = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/scans`, headers: hdr, payload: { url: `${fx.origin}/brand/`, profileId: profile.id, explore: false } });
      expect(res.statusCode).toBe(201);
      const run = res.json() as { id: string; config: { profileId?: string; engines: { brand?: boolean } } };
      expect(run.config.profileId).toBe(profile.id);
      expect(run.config.engines.brand).toBe(true);
      const done = await h.waitForTerminal(run.id);
      expect(h.store.listFindings(done.id).some((f) => f.ruleId === 'BRD-001')).toBe(true);

      await app.inject({ method: 'PUT', url: `/api/profiles/${profile.id}`, headers: hdr, payload: { name: 'Acme v2' } });
      expect(h.store.getRun(done.id)!.config.profile?.name).toBe('Acme');
      expect(buildRunReport(h.store, done.id).scan.profile?.name).toBe('Acme');
      expect((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/scans`, headers: hdr, payload: { url: `${fx.origin}/brand/`, profileId: newId() } })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
