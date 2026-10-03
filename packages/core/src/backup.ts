import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { type DataPaths, resolveDataPaths } from './config.js';
import { MIGRATIONS } from './db/migrations.js';

/**
 * Local backup and restore. A backup is one zip with a consistent copy of the
 * database, every artifact (screenshots and other evidence), and a manifest of
 * SHA-256 checksums. Restore verifies everything before touching the data
 * directory, only writes the expected names, and keeps the previous data.
 */
export interface BackupManifest {
  format: 'course-qa-backup';
  version: 1;
  createdAt: string;
  schemaVersion: number;
  files: Array<{ name: string; bytes: number; sha256: string }>;
}

const DB_NAME = 'qa.sqlite';
const SAFE_ARTIFACT = /^artifacts\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/** Writes a backup zip. The database copy is taken with SQLite's online backup, so a running app is safe. */
export async function createBackup(paths: DataPaths, outFile: string): Promise<BackupManifest> {
  const tmp = mkdtempSync(path.join(paths.tmp, 'backup-'));
  try {
    const copy = path.join(tmp, DB_NAME);
    const db = new Database(paths.dbFile, { readonly: true, fileMustExist: true });
    let schemaVersion = 0;
    try {
      await db.backup(copy);
      schemaVersion = (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number } | undefined)?.v ?? 0;
    } finally {
      db.close();
    }
    const entries: Record<string, Uint8Array> = {};
    const files: BackupManifest['files'] = [];
    const add = (name: string, bytes: Uint8Array) => {
      entries[name] = bytes;
      files.push({ name, bytes: bytes.length, sha256: sha(bytes) });
    };
    add(DB_NAME, readFileSync(copy));
    if (existsSync(paths.artifacts)) {
      for (const rel of listFiles(paths.artifacts)) {
        const name = `artifacts/${rel}`;
        if (SAFE_ARTIFACT.test(name)) add(name, readFileSync(path.join(paths.artifacts, rel)));
      }
    }
    const manifest: BackupManifest = { format: 'course-qa-backup', version: 1, createdAt: new Date().toISOString(), schemaVersion, files };
    entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
    mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    writeFileSync(outFile, zipSync(entries, { level: 6 }));
    return manifest;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export class BackupError extends Error {}

/** Reads and fully verifies a backup without writing anything to the data directory. */
export function verifyBackup(file: string): { manifest: BackupManifest; entries: Record<string, Uint8Array> } {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(readFileSync(file)), { filter: (f) => f.originalSize <= MAX_ENTRY_BYTES });
  } catch (err) {
    throw new BackupError(`Not a readable backup file: ${(err as Error).message}`);
  }
  const rawManifest = entries['manifest.json'];
  if (!rawManifest) throw new BackupError('The backup has no manifest.');
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(strFromU8(rawManifest)) as BackupManifest;
  } catch {
    throw new BackupError('The backup manifest is not valid.');
  }
  if (manifest.format !== 'course-qa-backup' || manifest.version !== 1) throw new BackupError('This is not a Course QA backup, or it is from a newer version.');
  const listed = new Set<string>();
  for (const f of manifest.files) {
    // Only the database and well-formed artifact paths are accepted, so a crafted zip cannot write elsewhere.
    if (f.name !== DB_NAME && !SAFE_ARTIFACT.test(f.name)) throw new BackupError(`Unexpected file in the backup: ${f.name}`);
    const bytes = entries[f.name];
    if (!bytes) throw new BackupError(`The backup is missing ${f.name}.`);
    if (sha(bytes) !== f.sha256) throw new BackupError(`Checksum mismatch for ${f.name}; the backup is damaged.`);
    listed.add(f.name);
  }
  for (const name of Object.keys(entries)) if (name !== 'manifest.json' && !listed.has(name)) throw new BackupError(`The backup contains a file the manifest does not list: ${name}`);
  if (!listed.has(DB_NAME)) throw new BackupError('The backup has no database.');
  return { manifest, entries };
}

/**
 * Restores a backup into the data directory. The app must be stopped. The
 * current database and artifacts are moved aside (not deleted) so a wrong
 * restore can be undone.
 */
export function restoreBackup(file: string, root?: string): { manifest: BackupManifest; keptPreviousAt?: string } {
  const { manifest, entries } = verifyBackup(file);
  const newest = Math.max(...MIGRATIONS.map((m) => m.version));
  if (manifest.schemaVersion > newest) throw new BackupError(`This backup was made by a newer version of the app (database version ${manifest.schemaVersion}, this app supports ${newest}). Update the app first.`);
  const paths = resolveDataPaths(root);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const staging = path.join(paths.root, `restore-staging-${stamp}`);
  mkdirSync(path.join(staging, 'artifacts'), { recursive: true });
  try {
    for (const f of manifest.files) {
      const dest = f.name === DB_NAME ? path.join(staging, DB_NAME) : path.join(staging, f.name);
      const inside = path.resolve(dest);
      if (!inside.startsWith(path.resolve(staging) + path.sep)) throw new BackupError(`Refusing unsafe path ${f.name}`);
      mkdirSync(path.dirname(inside), { recursive: true });
      writeFileSync(inside, entries[f.name]!);
    }
    // The restored database must open and pass SQLite's own integrity check before it replaces anything.
    const probe = new Database(path.join(staging, DB_NAME), { readonly: true });
    try {
      const result = probe.pragma('integrity_check', { simple: true });
      if (result !== 'ok') throw new BackupError(`The restored database failed its integrity check: ${String(result)}`);
    } finally {
      probe.close();
    }
    let keptPreviousAt: string | undefined;
    const hasCurrent = existsSync(paths.dbFile) || (existsSync(paths.artifacts) && readdirSync(paths.artifacts).length > 0);
    if (hasCurrent) {
      keptPreviousAt = path.join(paths.root, `before-restore-${stamp}`);
      mkdirSync(keptPreviousAt, { recursive: true });
      for (const f of [paths.dbFile, `${paths.dbFile}-wal`, `${paths.dbFile}-shm`]) if (existsSync(f)) renameSync(f, path.join(keptPreviousAt, path.basename(f)));
      if (existsSync(paths.artifacts)) renameSync(paths.artifacts, path.join(keptPreviousAt, 'artifacts'));
    }
    renameSync(path.join(staging, DB_NAME), paths.dbFile);
    renameSync(path.join(staging, 'artifacts'), paths.artifacts);
    return { manifest, keptPreviousAt };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function describeBackupSize(file: string): string {
  const mb = statSync(file).size / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}
