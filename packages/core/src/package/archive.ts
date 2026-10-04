import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';

/**
 * Safe extraction of an uploaded course package. Every limit and every path
 * rule is checked from the ZIP's own directory BEFORE any file is inflated or
 * written, and extracted sizes are checked again against what the directory
 * claimed, so a lying header cannot expand past the limits.
 */
export interface ArchiveLimits {
  maxCompressedBytes: number;
  maxExpandedBytes: number;
  maxEntries: number;
  /** Largest allowed expanded/compressed ratio for one entry and for the whole archive. */
  maxRatio: number;
  maxEntryBytes: number;
  maxExtractMs: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxCompressedBytes: 250 * 1024 * 1024,
  maxExpandedBytes: 1024 * 1024 * 1024,
  maxEntries: 20_000,
  maxRatio: 100,
  maxEntryBytes: 300 * 1024 * 1024,
  maxExtractMs: 60_000,
};

export type ArchiveRejection = 'too_large' | 'too_many_entries' | 'expanded_too_large' | 'ratio' | 'unsafe_path' | 'symlink' | 'duplicate' | 'encrypted' | 'unsupported' | 'timeout' | 'corrupt' | 'empty';

export class ArchiveError extends Error {
  constructor(
    readonly code: ArchiveRejection,
    message: string,
  ) {
    super(message);
  }
}

export interface ArchiveEntry {
  name: string;
  isDirectory: boolean;
  compressedSize: number;
  size: number;
  method: number;
}

const EOCD = 0x06054b50;
const CEN = 0x02014b50;

/** Reads the ZIP central directory without inflating anything. */
export function readDirectory(zip: Buffer): Array<ArchiveEntry & { encrypted: boolean; symlink: boolean }> {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveError('corrupt', 'This is not a ZIP file (no end-of-archive record).');
  const total = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ArchiveError('unsupported', 'ZIP64 archives are not supported. Re-save the package as a standard ZIP.');
  if (cdOffset + cdSize > zip.length) throw new ArchiveError('corrupt', 'The ZIP directory is damaged.');
  const out: Array<ArchiveEntry & { encrypted: boolean; symlink: boolean }> = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > zip.length || zip.readUInt32LE(p) !== CEN) throw new ArchiveError('corrupt', 'The ZIP directory is damaged.');
    const madeBy = zip.readUInt16LE(p + 4);
    const flags = zip.readUInt16LE(p + 8);
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const ext = zip.readUInt32LE(p + 38);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    const hostUnix = madeBy >> 8 === 3;
    const mode = ext >>> 16;
    out.push({ name, isDirectory: name.endsWith('/'), compressedSize, size, method, encrypted: (flags & 1) !== 0, symlink: hostUnix && (mode & 0o170000) === 0o120000 });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Whether a stored name is safe to extract. Returns a reason, or undefined when fine. */
export function unsafeName(name: string): string | undefined {
  if (name.includes('\0')) return 'contains a NUL character';
  if (name.includes('\\')) return 'uses backslashes';
  if (name.startsWith('/')) return 'is an absolute path';
  if (/^[A-Za-z]:/.test(name)) return 'starts with a drive letter';
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some((s) => s === '..')) return 'contains ".."';
  if (parts.some((s) => s === '' || s === '.')) return 'contains an empty or "." segment';
  return undefined;
}

/** Validates the directory against the limits and path rules. Throws ArchiveError; writes nothing. */
export function validateArchive(zip: Buffer, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): ArchiveEntry[] {
  if (zip.length > limits.maxCompressedBytes) throw new ArchiveError('too_large', `The upload is ${(zip.length / 1048576).toFixed(0)} MB; the limit is ${(limits.maxCompressedBytes / 1048576).toFixed(0)} MB.`);
  const entries = readDirectory(zip);
  if (entries.length === 0) throw new ArchiveError('empty', 'The ZIP file is empty.');
  if (entries.length > limits.maxEntries) throw new ArchiveError('too_many_entries', `The package has ${entries.length} entries; the limit is ${limits.maxEntries}.`);
  const seen = new Set<string>();
  const seenFolded = new Map<string, string>();
  let expanded = 0;
  for (const e of entries) {
    const bad = unsafeName(e.name);
    if (bad) throw new ArchiveError('unsafe_path', `Entry "${e.name.slice(0, 120)}" ${bad}.`);
    if (e.encrypted) throw new ArchiveError('encrypted', `Entry "${e.name}" is encrypted. Encrypted ZIPs are not supported.`);
    if (e.symlink) throw new ArchiveError('symlink', `Entry "${e.name}" is a symbolic link, which is not allowed.`);
    if (e.method !== 0 && e.method !== 8) throw new ArchiveError('unsupported', `Entry "${e.name}" uses an unsupported compression method (${e.method}).`);
    const key = e.name.replace(/\/$/, '');
    if (seen.has(key)) throw new ArchiveError('duplicate', `The path "${key}" appears more than once in the ZIP.`);
    seen.add(key);
    const folded = key.toLowerCase();
    const clash = seenFolded.get(folded);
    if (clash !== undefined) throw new ArchiveError('duplicate', `"${clash}" and "${key}" differ only by letter case, so which one a server serves is ambiguous.`);
    seenFolded.set(folded, key);
    if (e.isDirectory) continue;
    if (e.size > limits.maxEntryBytes) throw new ArchiveError('expanded_too_large', `"${e.name}" expands to ${(e.size / 1048576).toFixed(0)} MB, over the per-file limit.`);
    if (e.compressedSize > 0 && e.size / e.compressedSize > limits.maxRatio && e.size > 1_000_000) throw new ArchiveError('ratio', `"${e.name}" expands more than ${limits.maxRatio} times its stored size, which looks like a ZIP bomb.`);
    expanded += e.size;
    if (expanded > limits.maxExpandedBytes) throw new ArchiveError('expanded_too_large', `The package expands to more than ${(limits.maxExpandedBytes / 1048576).toFixed(0)} MB.`);
  }
  if (expanded > 1_000_000 && zip.length > 0 && expanded / zip.length > limits.maxRatio) throw new ArchiveError('ratio', `The whole package expands more than ${limits.maxRatio} times its size.`);
  return entries;
}

/**
 * Extracts a validated archive into `destDir` (which must be new and private
 * to this package). Files are written only at paths re-checked to stay inside it.
 */
export function extractArchive(zip: Buffer, destDir: string, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): { files: number; bytes: number } {
  const entries = validateArchive(zip, limits);
  const declared = new Map(entries.map((e) => [e.name, e.size]));
  const started = Date.now();
  const root = path.resolve(destDir);
  mkdirSync(root, { recursive: true });
  let files = 0;
  let bytes = 0;
  let data: Record<string, Uint8Array>;
  try {
    data = unzipSync(new Uint8Array(zip), { filter: (f) => !f.name.endsWith('/') && declared.has(f.name) && f.originalSize === declared.get(f.name) });
  } catch (err) {
    throw new ArchiveError('corrupt', `The ZIP could not be read: ${(err as Error).message}`);
  }
  for (const [name, content] of Object.entries(data)) {
    if (Date.now() - started > limits.maxExtractMs) throw new ArchiveError('timeout', 'Extraction took too long and was stopped.');
    if (content.length !== declared.get(name)) throw new ArchiveError('ratio', `"${name}" expanded to a different size than the ZIP declared.`);
    const dest = path.resolve(root, ...name.split('/'));
    if (!dest.startsWith(root + path.sep)) throw new ArchiveError('unsafe_path', `Entry "${name}" would be written outside the package folder.`);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, content, { flag: 'wx' });
    files++;
    bytes += content.length;
  }
  return { files, bytes };
}
