/**
 * Administrator opt-in for scanning courses served from this computer (for
 * example the sample course pack on 127.0.0.1:4400). It is off unless the
 * `CQA_ALLOW_LOCAL_TARGETS` environment variable names exact loopback
 * address and port pairs. It is read once at process start, can never be set
 * through the API or the UI, and never opens private-network, link-local, or
 * metadata addresses: only loopback pairs are accepted.
 */
export interface LocalTargetExemptions {
  exemptions: Array<{ ip: string; port: number }>;
  /** Entries that were ignored, with the reason, so the operator is told rather than guessing. */
  rejected: Array<{ entry: string; reason: string }>;
}

export function parseLocalTargets(raw: string | undefined): LocalTargetExemptions {
  const out: LocalTargetExemptions = { exemptions: [], rejected: [] };
  for (const entry of (raw ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\[::1\]|127(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(entry);
    if (!m) {
      out.rejected.push({ entry, reason: 'Use loopback address and port only, for example 127.0.0.1:4400.' });
      continue;
    }
    const port = Number(m[2]);
    if (port < 1 || port > 65535) {
      out.rejected.push({ entry, reason: 'Port must be between 1 and 65535.' });
      continue;
    }
    const ip = m[1] === '[::1]' ? '::1' : m[1]!;
    if (ip !== '::1' && ip.split('.').some((o) => Number(o) > 255)) {
      out.rejected.push({ entry, reason: 'Not a valid address.' });
      continue;
    }
    out.exemptions.push({ ip, port });
  }
  return out;
}
