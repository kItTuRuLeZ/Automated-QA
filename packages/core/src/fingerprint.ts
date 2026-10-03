import { createHash, randomUUID } from 'node:crypto';
import type { RuleId } from '@cqa/shared';

/**
 * Stable finding fingerprint: ruleId | origin+path | state key | target key.
 * Query strings, fragments, viewport, and run ID are deliberately excluded so
 * retests of the same issue match.
 */
export function fingerprint(input: { ruleId: RuleId; url?: string; stateKey?: string; targetKey?: string }): string {
  let scope = '';
  if (input.url) {
    try {
      const u = new URL(input.url);
      scope = `${u.origin}${u.pathname}`;
    } catch {
      scope = input.url;
    }
  }
  return createHash('sha256')
    .update([input.ruleId, scope, input.stateKey ?? '', input.targetKey ?? ''].join('|'))
    .digest('hex');
}

/** Opaque random identifier for DB rows and artifacts. */
export function newId<T extends string = string>(): T {
  return randomUUID() as T;
}

export function nowIso(): string {
  return new Date().toISOString();
}
