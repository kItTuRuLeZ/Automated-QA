import { strToU8, zipSync } from 'fflate';

/** Builds a ZIP in memory from relative paths to bytes or text. Paths are written exactly as given. */
export function buildZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(files)) entries[name] = typeof body === 'string' ? strToU8(body) : body;
  return zipSync(entries, { level: 6 });
}
