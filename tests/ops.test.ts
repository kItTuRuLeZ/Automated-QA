import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectId, ScanRun } from '@cqa/shared';
import { ArtifactStore, BackupError, Store, buildScanConfig, createBackup, openDatabase, parseLocalTargets, resolveDataPaths, restoreBackup, sweepRetention, verifyBackup } from '@cqa/core';
import { buildApp } from '../apps/server/src/app.js';
import { buildCapabilities } from '../apps/server/src/capabilities.js';
import { type Harness, createHarness } from './support/harness.js';

const COURSE = 'https://course.example.com/';
const HOST = '127.0.0.1:4317';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

let h: Harness;
let projectId: ProjectId;
beforeEach(() => {
  h = createHarness({ resolver: async () => ['93.184.215.14'] });
  projectId = h.store.createProject({ name: 'Ops project', courseUrl: COURSE }).id;
});
afterEach(async () => {
  await h.close();
});

function finishedRun(url: string, finishedDaysAgo: number, withShot = true): { run: ScanRun; artifactId?: string; file?: string } {
  const run = h.store.createRun(buildScanConfig({ projectId, url: new URL(url) }), url);
  let artifactId: string | undefined;
  let file: string | undefined;
  if (withShot) {
    const art = h.artifacts.write(run.id, { kind: 'screenshot', mime: 'image/png', bytes: PNG });
    artifactId = art.id;
    file = h.artifacts.absolutePath(art);
  }
  h.store.finishRun(run.id, { status: 'completed' });
  h.store.db.prepare('UPDATE scan_runs SET finished_at = ? WHERE id = ?').run(new Date(Date.now() - finishedDaysAgo * 86_400_000).toISOString(), run.id);
  return { run, artifactId, file };
}

describe('local targets setting', () => {
  it('accepts only exact loopback address and port pairs', () => {
    const ok = parseLocalTargets('127.0.0.1:4400, [::1]:4401');
    expect(ok.exemptions).toEqual([{ ip: '127.0.0.1', port: 4400 }, { ip: '::1', port: 4401 }]);
    const bad = parseLocalTargets('10.0.0.5:80,169.254.169.254:80,0.0.0.0:80,localhost:80,127.0.0.1:99999,127.0.0.1,192.168.1.1:3000');
    expect(bad.exemptions).toEqual([]);
    expect(bad.rejected).toHaveLength(7);
    expect(parseLocalTargets(undefined)).toEqual({ exemptions: [], rejected: [] });
  });
});

describe('capabilities', () => {
  it('say plainly what is blocked, off, or not included', () => {
    const none = buildCapabilities({ browserExecutable: () => path.join(tmpdir(), 'no-such-browser') });
    const by = (id: string) => none.find((c) => c.id === id)!;
    expect(by('browser')).toMatchObject({ status: 'blocked' });
    expect(by('browser').detail).toContain('npm run browsers:install');
    expect(by('pdf').status).toBe('blocked');
    expect(by('reports').status).toBe('available');
    expect(by('local-targets').status).toBe('blocked');
    expect(by('ai')).toMatchObject({ status: 'not_included' });
    expect(by('docker-worker').status).toBe('not_included');
    expect(by('multi-user').status).toBe('not_included');
    const on = buildCapabilities({ browserExecutable: () => process.execPath, localTargets: [{ ip: '127.0.0.1', port: 4400 }], retentionDays: 90 });
    expect(on.find((c) => c.id === 'browser')!.status).toBe('available');
    expect(on.find((c) => c.id === 'local-targets')!.detail).toContain('127.0.0.1:4400');
    expect(on.find((c) => c.id === 'retention')!.status).toBe('available');
  });

  it('has no place to enter an AI key anywhere in the API or the interface', async () => {
    const app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`] });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/capabilities', headers: { host: HOST } });
      expect(res.statusCode).toBe(200);
      expect(JSON.stringify(res.json())).not.toMatch(/api[_ ]?key/i);
    } finally {
      await app.close();
    }
    const src = readdirSync(path.resolve(import.meta.dirname, '../apps/web/src/pages')).map((f) => readFileSync(path.resolve(import.meta.dirname, '../apps/web/src/pages', f), 'utf8')).join('\n');
    expect(src).not.toMatch(/api[_ -]?key|openai|anthropic/i);
  });
});

describe('backup and restore', () => {
  it('round-trips the database and every evidence file, and keeps the previous data', async () => {
    const a = finishedRun(COURSE, 1);
    const out = path.join(h.tmpRoot, 'b.zip');
    const manifest = await createBackup(resolveDataPaths(h.dataDir), out);
    expect(manifest.files.map((f) => f.name)).toContain('qa.sqlite');
    expect(manifest.files.some((f) => f.name.startsWith(`artifacts/${a.run.id}/`))).toBe(true);
    expect(verifyBackup(out).manifest.createdAt).toBe(manifest.createdAt);

    const root = mkdtempSync(path.join(tmpdir(), 'cqa-restore-'));
    // Existing data in the target is moved aside, not deleted.
    const existing = resolveDataPaths(root);
    const old = new Store(openDatabase(existing.dbFile));
    old.createProject({ name: 'Older data' });
    old.db.close();

    const restored = restoreBackup(out, root);
    expect(restored.keptPreviousAt && existsSync(path.join(restored.keptPreviousAt, 'qa.sqlite'))).toBe(true);
    const store2 = new Store(openDatabase(resolveDataPaths(root).dbFile));
    try {
      expect(store2.getRun(a.run.id)).toBeDefined();
      expect(store2.listProjects().map((p) => p.name)).toContain('Ops project');
      expect(store2.listProjects().map((p) => p.name)).not.toContain('Older data');
      const rec = store2.getArtifact(a.artifactId!)!;
      const bytes = readFileSync(new ArtifactStore(resolveDataPaths(root).artifacts, store2).absolutePath(rec));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(rec.sha256);
    } finally {
      store2.db.close();
    }
  });

  it('refuses a damaged backup and leaves the data directory untouched', async () => {
    const a = finishedRun(COURSE, 1);
    const out = path.join(h.tmpRoot, 'good.zip');
    await createBackup(resolveDataPaths(h.dataDir), out);
    const entries = unzipSync(new Uint8Array(readFileSync(out)));
    const name = Object.keys(entries).find((n) => n.startsWith(`artifacts/${a.run.id}/`))!;
    entries[name] = new Uint8Array([...entries[name]!, 1]); // one extra byte
    const damaged = path.join(h.tmpRoot, 'damaged.zip');
    writeFileSync(damaged, zipSync(entries));
    const root = mkdtempSync(path.join(tmpdir(), 'cqa-restore-'));
    expect(() => restoreBackup(damaged, root)).toThrow(/Checksum mismatch/);
    expect(existsSync(path.join(root, 'qa.sqlite'))).toBe(false);
  });

  it('cannot be tricked into writing outside the data directory', () => {
    const evil = strToU8('pwned');
    const sha = createHash('sha256').update(evil).digest('hex');
    const dir = mkdtempSync(path.join(tmpdir(), 'cqa-evil-'));
    const crafted = (name: string, listed: boolean) => {
      const manifest = { format: 'course-qa-backup', version: 1, createdAt: new Date().toISOString(), schemaVersion: 1, files: listed ? [{ name, bytes: evil.length, sha256: sha }] : [] };
      const file = path.join(dir, `${listed ? 'listed' : 'unlisted'}-${Math.random().toString(16).slice(2)}.zip`);
      writeFileSync(file, zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), [name]: evil }));
      return file;
    };
    for (const name of ['../evil.txt', 'artifacts/../../evil.txt', '/etc/evil.txt', 'artifacts/x/../../y.txt', 'other/evil.txt']) {
      expect(() => verifyBackup(crafted(name, true)), name).toThrow(BackupError);
    }
    expect(() => verifyBackup(crafted('artifacts/abc/evil.png', false))).toThrow(/no database|does not list/);
    expect(existsSync(path.join(dir, '..', 'evil.txt'))).toBe(false);
  });

  it('refuses a backup from a newer version of the app', async () => {
    finishedRun(COURSE, 1);
    const out = path.join(h.tmpRoot, 'new.zip');
    await createBackup(resolveDataPaths(h.dataDir), out);
    const entries = unzipSync(new Uint8Array(readFileSync(out)));
    const manifest = JSON.parse(Buffer.from(entries['manifest.json']!).toString());
    manifest.schemaVersion = 999;
    entries['manifest.json'] = strToU8(JSON.stringify(manifest));
    const newer = path.join(h.tmpRoot, 'newer.zip');
    writeFileSync(newer, zipSync(entries));
    expect(() => restoreBackup(newer, mkdtempSync(path.join(tmpdir(), 'cqa-restore-')))).toThrow(/newer version/);
  });
});

describe('retention and deletion', () => {
  it('deletes old scans and their files, but keeps the latest scan of each course and any scan holding a baseline', () => {
    const oldA = finishedRun(COURSE, 200);
    const oldBaseline = finishedRun(COURSE, 190);
    const midOld = finishedRun(COURSE, 150);
    const soloOld = finishedRun('https://solo.example.com/', 400); // the only scan of its course: kept even though it is old
    const otherOld = finishedRun('https://other.example.com/', 300);
    const otherLatest = finishedRun('https://other.example.com/', 5);
    const recent = finishedRun(COURSE, 2);
    h.store.setBaselines(projectId, COURSE, oldBaseline.run.id, [{ key: 'k', artifactId: oldBaseline.artifactId!, label: 'Desktop' }]);

    const dry = sweepRetention(h.store, h.artifacts, { days: 90, dryRun: true });
    expect(dry.deleted.map((d) => d.id).sort()).toEqual([oldA.run.id, midOld.run.id, otherOld.run.id].sort());
    expect(existsSync(oldA.file!)).toBe(true);

    const real = sweepRetention(h.store, h.artifacts, { days: 90 });
    expect(real.deleted.map((d) => d.id).sort()).toEqual([oldA.run.id, midOld.run.id, otherOld.run.id].sort());
    expect(real.kept).toEqual({ holdsBaseline: 1, latestForCourse: 1 });
    expect(h.store.getRun(oldA.run.id)).toBeUndefined();
    expect(existsSync(oldA.file!)).toBe(false);
    for (const keep of [oldBaseline, soloOld, otherLatest, recent]) expect(h.store.getRun(keep.run.id)).toBeDefined();
    expect(h.store.getBaseline(projectId, COURSE, 'k')).toBeDefined();
  });

  it('refuses to delete a scan that holds a baseline unless told to discard it', async () => {
    const r = finishedRun(COURSE, 1);
    h.store.setBaselines(projectId, COURSE, r.run.id, [{ key: 'k', artifactId: r.artifactId!, label: 'Desktop' }]);
    const app = buildApp({ store: h.store, artifacts: h.artifacts, policy: h.policy, allowedHosts: [HOST], allowedOrigins: [`http://${HOST}`] });
    try {
      const hdr = { host: HOST, 'x-qa-request': '1' };
      const refused = await app.inject({ method: 'DELETE', url: `/api/runs/${r.run.id}`, headers: hdr });
      expect(refused.statusCode).toBe(409);
      expect(h.store.getRun(r.run.id)).toBeDefined();
      const done = await app.inject({ method: 'DELETE', url: `/api/runs/${r.run.id}?discardBaselines=1`, headers: hdr });
      expect(done.statusCode).toBe(204);
      expect(h.store.getRun(r.run.id)).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
