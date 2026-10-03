import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ArtifactId, ScanRunId } from '@cqa/shared';
import type { ArtifactRecord, Store } from './db/store.js';
import { newId, nowIso } from './fingerprint.js';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'application/json': 'json', 'text/plain': 'txt' };
const SAFE_ID = /^[0-9a-f-]{36}$/;

/**
 * Artifacts are stored as <root>/<runId>/<artifactId>.<ext>. Both IDs are
 * server-generated UUIDs; user input never forms a path.
 */
export class ArtifactStore {
  constructor(
    private readonly root: string,
    private readonly store: Store,
  ) {}

  write(runId: ScanRunId, input: { kind: string; mime: string; bytes: Uint8Array }): ArtifactRecord {
    if (!SAFE_ID.test(runId)) throw new Error('Invalid run id');
    const id = newId<ArtifactId>();
    const ext = EXT[input.mime] ?? 'bin';
    const relPath = `${runId}/${id}.${ext}`;
    const abs = this.resolveInside(relPath);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, input.bytes);
    const record: ArtifactRecord = {
      id,
      runId,
      kind: input.kind,
      mime: input.mime,
      bytes: input.bytes.byteLength,
      sha256: createHash('sha256').update(input.bytes).digest('hex'),
      relPath,
      createdAt: nowIso(),
    };
    this.store.insertArtifact(record);
    return record;
  }

  /** Absolute path for a stored record, verified to stay inside the artifact root. */
  absolutePath(record: ArtifactRecord): string {
    return this.resolveInside(record.relPath);
  }

  deleteRunArtifacts(runId: string): void {
    if (!SAFE_ID.test(runId)) return;
    rmSync(this.resolveInside(runId), { recursive: true, force: true });
  }

  private resolveInside(rel: string): string {
    const rootAbs = path.resolve(this.root);
    const abs = path.resolve(rootAbs, rel);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw new Error('Artifact path escapes the artifact root');
    return abs;
  }
}

export function isOpaqueId(value: string): boolean {
  return SAFE_ID.test(value);
}
