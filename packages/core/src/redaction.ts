import type { RedactionPolicy, SanitizedUrl } from '@cqa/shared';

export const DEFAULT_REDACTION: RedactionPolicy = {
  stripQueryStrings: true,
  preservedQueryParams: [],
  sensitiveParamPatterns: ['token', 'key', 'sig', 'signature', 'auth', 'session', 'password', 'passwd', 'secret', 'code', 'credential', 'jwt'],
  stripFragments: true,
};

const REDACTED = 'REDACTED';

function isSensitive(name: string, policy: RedactionPolicy): boolean {
  const lower = name.toLowerCase();
  return policy.sensitiveParamPatterns.some((p) => lower.includes(p.toLowerCase()));
}

/**
 * Applies the redaction policy to a URL. Credentials are always removed.
 * Sensitive parameters are always redacted, even when preserved.
 * Unparseable input is replaced wholesale rather than stored raw.
 */
export function sanitizeUrl(raw: string, policy: RedactionPolicy = DEFAULT_REDACTION): SanitizedUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '[unparseable-url]' as SanitizedUrl;
  }
  url.username = '';
  url.password = '';
  const kept = new URLSearchParams();
  let dropped = false;
  for (const [name, value] of url.searchParams) {
    const preserved = !policy.stripQueryStrings || policy.preservedQueryParams.includes(name);
    if (!preserved) {
      dropped = true;
      continue;
    }
    kept.append(name, isSensitive(name, policy) ? REDACTED : value);
  }
  const query = kept.toString();
  url.search = query ? `?${query}` : dropped ? '?[query-removed]' : '';
  if (policy.stripFragments) url.hash = '';
  return url.toString().replace('%5Bquery-removed%5D', '[query-removed]') as SanitizedUrl;
}

/** Replaces any absolute URLs found inside free text (messages, stacks) with sanitized forms. */
export function sanitizeText(text: string, policy: RedactionPolicy = DEFAULT_REDACTION, maxLength = 4000): string {
  const replaced = text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>()]+/gi, (m) => sanitizeUrl(m, policy));
  return replaced.length > maxLength ? `${replaced.slice(0, maxLength)}… [truncated]` : replaced;
}
