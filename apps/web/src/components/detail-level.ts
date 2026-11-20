import { useSyncExternalStore } from 'react';

/**
 * How much detail the results pages show. "simple" (the default) is for course developers and reviewers: plain words,
 * no rule codes, web addresses or scanner notes. "technical" shows everything. Remembered per browser; if storage is
 * blocked the choice still applies for this page session.
 */
export type DetailLevel = 'simple' | 'technical';
const KEY = 'cqa.detailLevel';
const EVENT = 'cqa-detail-level';
function stored(): DetailLevel {
  try {
    return window.localStorage.getItem(KEY) === 'technical' ? 'technical' : 'simple';
  } catch {
    return 'simple';
  }
}
// Read once, then kept up to date here, so badges do not each read storage on every render.
let current: DetailLevel | undefined;
const read = (): DetailLevel => (current ??= stored());

function subscribe(onChange: () => void): () => void {
  const fromOtherTab = () => {
    current = stored();
    onChange();
  };
  window.addEventListener(EVENT, onChange);
  window.addEventListener('storage', fromOtherTab);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener('storage', fromOtherTab);
  };
}

export function setDetailLevel(l: DetailLevel): void {
  current = l;
  try {
    window.localStorage.setItem(KEY, l);
  } catch {
    /* not remembered across visits, but still applied */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useDetailLevel(): [DetailLevel, (l: DetailLevel) => void] {
  return [useSyncExternalStore(subscribe, read, () => 'simple' as DetailLevel), setDetailLevel];
}

/**
 * Findings that are notes about what the scanner itself could not do (a frame it could not open, a control it did not
 * click, a limit it reached), not problems in the course. Mirrors actionFor() in packages/core/src/plain-language.ts,
 * which groups the same findings as "not checked" in reports.
 */
export function isScannerNote(f: { ruleId: string; category?: string }): boolean {
  return f.category === 'coverage' || f.ruleId.startsWith('COV-') || f.ruleId === 'NET-002' || f.ruleId === 'NET-003';
}

/** A screen name without the web address the scanner adds to tell two same-titled pages apart. */
export function plainScreenName(title: string): string {
  return title.replace(/\s*\((?:https?:\/\/|\/)[^)]*\)\s*$/, '').trim() || title;
}

/**
 * Text without this tool's rule codes: a leading "NAV-02: " and lists such as "(A11Y-AXE-region, LAY-002)". Only codes
 * shaped like the tool's own (ending in digits, or starting A11Y-AXE-) are removed, so "(X-Frame-Options)" stays.
 */
const CODE = '(?:[A-Z][A-Z0-9]*-\\d{2,3}|A11Y-AXE-[a-z0-9*-]+)';
const LEADING = new RegExp(`^${CODE}:\\s*`);
const LIST = new RegExp(`\\s*\\((?:${CODE}(?:,\\s*)?)+\\)`, 'g');
export function withoutRuleCodes(text: string): string {
  return text.replace(LEADING, '').replace(LIST, '').trim();
}

/**
 * A problem title for the simple view: no rule codes, no "Check by hand:" prefix (the row's badge says that), and file
 * names as people write them ("Eric Itambo.mp4", not "Eric%20Itambo.mp4?[query-removed]").
 */
export function plainIssue(text: string): string {
  return withoutRuleCodes(text)
    .replace(/^Check by hand:\s*/i, '')
    .replace(/\?\[query-removed\]/g, '')
    .replace(/%20/g, ' ');
}

/** The reason a scan stopped, in plain words, including the wording older scans were saved with. */
export function plainReason(text: string): string {
  return text
    .replace(/(\d+) action\(s\) or state restorations failed\./g, (_, n: string) => (n === '1' ? 'The scan could not repeat one of its steps, so a screen may have been checked only in part.' : `The scan could not repeat ${n} of its steps, so some screens may have been checked only in part.`))
    .replace(/Exploration stopped at a scan budget \([^)]*\)\./g, 'The scan stopped at one of its limits, so later screens were not checked.');
}

/** Status words for the simple view. */
export const SIMPLE_STATUS: Record<string, string> = {
  needs_manual_review: 'Please check',
  manual_review_required: 'Please check',
  passed_automated: 'Automated checks passed',
  issues_found: 'Problem found',
  not_tested: 'Not checked',
  blocked: 'Not checked',
  error: 'Not checked',
  unsupported: 'Not checked',
  inconclusive: 'Not checked',
  skipped: 'Not checked',
  failed: 'Problem found',
};
