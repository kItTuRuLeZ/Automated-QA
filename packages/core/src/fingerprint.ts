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
      const inPackage = PACKAGE_PATH.exec(u.pathname);
      scope = inPackage ? `package:${courseOfUpload(inPackage[1]!)}/${inPackage[2]}` : `${u.origin}${u.pathname}`;
    } catch {
      scope = input.url;
    }
  }
  return createHash('sha256')
    .update([input.ruleId, scope, withoutPackageId(input.stateKey ?? ''), withoutPackageId(input.targetKey ?? '')].join('|'))
    .digest('hex');
}

/**
 * How fingerprints are made. Version 2 names the logical course a page was served from instead of the uploaded copy
 * ("/p/<upload id>/"), so the same problem matches across a course's ZIP versions but never across unrelated courses
 * (reviewer decisions are kept per fingerprint). Package scans made under different versions are not compared.
 */
export const FINGERPRINT_SCHEME = 2;

const PACKAGE_PATH = /^\/p\/([0-9a-f-]{36})\/(.*)$/i;
const PACKAGE_ADDRESS = /(?:https?:\/\/[^/\s"']+)?\/p\/([0-9a-f-]{36})\//gi;
const withoutPackageId = (s: string) => s.replace(PACKAGE_ADDRESS, (_, id: string) => `package:${courseOfUpload(id)}/`);

/** Upload id → logical course, set by the worker for the scan it is running. An upload it was not told about keeps its own id. */
let uploadCourses = new Map<string, string>();
const courseOfUpload = (uploadId: string) => uploadCourses.get(uploadId.toLowerCase()) ?? uploadId.toLowerCase();
export function setUploadCourses(map: ReadonlyMap<string, string>): void {
  uploadCourses = new Map([...map].map(([k, v]) => [k.toLowerCase(), v]));
}

/** Opaque random identifier for DB rows and artifacts. */
export function newId<T extends string = string>(): T {
  return randomUUID() as T;
}

export function nowIso(): string {
  return new Date().toISOString();
}
