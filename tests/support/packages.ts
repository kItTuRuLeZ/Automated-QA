import { strToU8, zipSync } from 'fflate';

export type Files = Record<string, string | Uint8Array>;

/** Builds a ZIP in memory. `symlinks` marks entries as Unix symbolic links. */
export function makeZip(files: Files, opts: { symlinks?: string[]; level?: 0 | 6 } = {}): Buffer {
  const entries: Record<string, [Uint8Array, { level?: 0 | 6; os?: number; attrs?: number }]> = {};
  for (const [name, body] of Object.entries(files)) {
    const data = typeof body === 'string' ? strToU8(body) : body;
    const link = opts.symlinks?.includes(name);
    entries[name] = [data, { level: opts.level ?? 6, ...(link ? { os: 3, attrs: (0o120777 << 16) >>> 0 } : {}) }];
  }
  return Buffer.from(zipSync(entries));
}

/** Sets the "encrypted" flag on every central-directory entry (the bytes stay readable; this only marks them). */
export function markEncrypted(zip: Buffer): Buffer {
  const out = Buffer.from(zip);
  for (let i = 0; i < out.length - 46; i++) {
    if (out.readUInt32LE(i) === 0x02014b50) out.writeUInt16LE(out.readUInt16LE(i + 8) | 1, i + 8);
  }
  return out;
}

/** Renames an entry to a same-length name in both the local and central headers (used to make duplicates). */
export function renameEntry(zip: Buffer, from: string, to: string): Buffer {
  if (from.length !== to.length) throw new Error('names must be the same length');
  const out = Buffer.from(zip);
  const needle = Buffer.from(from);
  let at = out.indexOf(needle);
  while (at >= 0) {
    to.split('').forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
    at = out.indexOf(needle, at + 1);
  }
  return out;
}

const page = (title: string, body = '', head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><main><h1>${title}</h1>${body}</main></body></html>`;
export { page };

export const manifest12 = (opts: { launch?: string; items?: Array<{ id: string; title: string; ref: string }>; resources?: string; extraOrg?: string; base?: string } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="m1" version="1" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>
  <organizations default="org1">
    <organization identifier="org1"><title>Safety Basics</title>
      ${(opts.items ?? [{ id: 'i1', title: 'Lesson 1', ref: 'r1' }]).map((i) => `<item identifier="${i.id}" identifierref="${i.ref}"><title>${i.title}</title></item>`).join('\n      ')}
    </organization>
    ${opts.extraOrg ?? ''}
  </organizations>
  <resources${opts.base ? ` xml:base="${opts.base}"` : ''}>
    ${opts.resources ?? `<resource identifier="r1" type="webcontent" adlcp:scormtype="sco" href="${opts.launch ?? 'index.html'}"><file href="${opts.launch ?? 'index.html'}"/></resource>`}
  </resources>
</manifest>`;

export const manifest2004 = (href = 'index.html') => `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="m2" xmlns="http://www.imsglobal.org/xsd/imscp_v1p1" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_v1p3" xmlns:adlseq="http://www.adlnet.org/xsd/adlseq_v1p3">
  <metadata><schema>ADL SCORM</schema><schemaversion>2004 4th Edition</schemaversion></metadata>
  <organizations default="o"><organization identifier="o"><title>Modern course</title><item identifier="i" identifierref="r"><title>Start</title></item></organization></organizations>
  <resources><resource identifier="r" type="webcontent" adlcp:scormType="sco" href="${href}"><file href="${href}"/></resource></resources>
</manifest>`;
