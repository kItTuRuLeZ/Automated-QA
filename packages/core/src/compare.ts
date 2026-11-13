import type { CheckResult, Finding, ScanRun } from '@cqa/shared';
import type { Store } from './db/store.js';
import { ONE_RULE_MANY_TARGETS } from './workflow.js';

export type ComparisonStatus = 'new' | 'persistent' | 'resolved' | 'not_retested' | 'incomparable';

export interface ComparedFinding {
  status: ComparisonStatus;
  fingerprint: string;
  ruleId: string;
  title: string;
  /** Why this status, in plain words: what was checked and what was missing. */
  reason: string;
}

export interface RunComparison {
  before: { id: string; status: ScanRun['status']; at: string };
  after: { id: string; status: ScanRun['status']; at: string };
  /** Whether the two scans are of the same course in comparable conditions. When not, nothing is called resolved. */
  comparable: { sameCourse: boolean; differences: string[] };
  findings: ComparedFinding[];
  counts: Record<ComparisonStatus, number>;
}

/** The course a run looked at: the package's name, or the address without its query, which can change between versions. */
function courseOf(run: ScanRun): string {
  const t = run.config.target;
  if (t.kind === 'package') return `package:${t.packageName ?? t.packageId ?? ''}`;
  try {
    const u = new URL(t.url ?? '');
    return `${u.origin}${u.pathname}`;
  } catch {
    return t.url ?? '';
  }
}

const major = (v?: string) => v?.split('.')[0];
const isFinished = (r: ScanRun) => r.status === 'completed' || r.status === 'partial';

/** How each state was reached, plus its screen size, and its title. Two runs reached "the same screen" when the keys match. */
function screens(store: Store, runId: string): { key: Map<string, string>; title: Map<string, string> } {
  const actions = new Map(store.listActions(runId).map((a) => [a.id as string, a.targetDescription]));
  const key = new Map<string, string>();
  const title = new Map<string, string>();
  for (const s of store.listStates(runId)) {
    key.set(s.id, `${s.pathFromRoot.map((id) => actions.get(id as string) ?? '?').join(' > ')}@${s.viewportName}`);
    title.set(s.id, s.title ?? '');
  }
  return { key, title };
}

const screensOf = (f: Finding) => [...new Set([f.location.stateId, ...f.occurrences.map((o) => o.location.stateId)].filter((x): x is NonNullable<typeof x> => Boolean(x)))].map(String);

/**
 * Compares the findings of two scans of the same course, the earlier one first. A finding from the earlier scan is
 * resolved only when the same check ran again in the later scan, on an equivalent screen, under comparable conditions,
 * and passed. A screen that was not reached, a check that did not run, a changed rule or expectation, or different
 * conditions never resolve anything. A finding only in the later scan is new only where the earlier scan also looked.
 * The retest workflow uses this same judgement, so the two never disagree.
 */
export function compareRuns(store: Store, beforeId: string, afterId: string): RunComparison | undefined {
  let before = store.getRun(beforeId);
  let after = store.getRun(afterId);
  if (!before || !after) return undefined;
  // Always earlier to later, whichever order they were asked for in.
  if (before.queuedAt > after.queuedAt) [before, after] = [after, before];
  const sameCourse = courseOf(before) === courseOf(after);
  const browserDiffers = before.browser?.engine !== after.browser?.engine || major(before.browser?.version) !== major(after.browser?.version);
  const sizes = (r: ScanRun) => r.config.viewports.map((v) => `${v.name} ${v.width}x${v.height}`).sort().join(', ');
  const sizesDiffer = sizes(before) !== sizes(after);
  const differences = [
    ...(sameCourse ? [] : [`a different course (${courseOf(before)} vs ${courseOf(after)})`]),
    ...(browserDiffers ? [`browser ${before.browser?.engine ?? '?'} ${major(before.browser?.version) ?? '?'} vs ${after.browser?.engine ?? '?'} ${major(after.browser?.version) ?? '?'}`] : []),
    ...(sizesDiffer ? [`screen sizes ${sizes(before)} vs ${sizes(after)}`] : []),
  ];

  const priorFindings = store.listFindings(before.id).filter((f) => f.type !== 'ai_recommendation');
  const nowFindings = store.listFindings(after.id).filter((f) => f.type !== 'ai_recommendation');
  const nowPrints = new Set(nowFindings.map((f) => f.fingerprint));
  const priorPrints = new Set(priorFindings.map((f) => f.fingerprint));
  const byRule = new Map<string, CheckResult[]>();
  for (const r of isFinished(after) ? store.listCheckResults(after.id) : []) byRule.set(r.ruleId, [...(byRule.get(r.ruleId) ?? []), r]);
  const prior = screens(store, before.id);
  const now = screens(store, after.id);
  const nowByKey = new Map<string, string[]>();
  for (const [id, key] of now.key) nowByKey.set(key, [...(nowByKey.get(key) ?? []), id]);
  const priorKeySet = new Set(prior.key.values());
  const nowTitles = new Set(now.title.values());

  const judgeGone = (f: Finding): Pick<ComparedFinding, 'status' | 'reason'> => {
    if (!sameCourse) return { status: 'incomparable', reason: 'The later scan is of a different course.' };
    if (!isFinished(after)) return { status: 'not_retested', reason: `The later scan did not finish (${after.status}), so nothing it did not reach is confirmed.` };
    // Screen sizes change what layout and visibility checks see; the browser changes how interactions behave.
    if (sizesDiffer || (f.checkKey && browserDiffers)) return { status: 'incomparable', reason: `Not found later, but the conditions differ (${differences.join('; ')}).` };
    if (ONE_RULE_MANY_TARGETS.test(f.ruleId) && !f.checkKey) return { status: 'not_retested', reason: 'This finding was saved before checks had an identity, so a later pass cannot be matched to it.' };
    const ofRule = byRule.get(f.ruleId) ?? [];
    const onScreen = (r: CheckResult, where?: string[]) => !where || (Boolean(f.checkKey) && !r.stateId) || Boolean(r.stateId && where.includes(String(r.stateId)));
    const ids = screensOf(f);
    for (const id of ids.length ? ids : [undefined]) {
      const where = id ? nowByKey.get(prior.key.get(id) ?? '') : undefined;
      if (id && !where?.length) {
        const title = prior.title.get(id) ?? '';
        return { status: 'not_retested', reason: title && nowTitles.has(title) ? `A screen titled "${title}" was reached by a different route; it is not assumed to be the same screen.` : 'The same screen was not reached in the later scan.' };
      }
      if (ofRule.some((r) => r.outcome === 'passed' && (!f.checkKey || r.targetKey === f.checkKey) && onScreen(r, where))) continue;
      // The same check ran here in another version: the case, rule version or expectation changed.
      if (f.checkFamily && ofRule.some((r) => r.targetFamily === f.checkFamily && r.targetKey !== f.checkKey && onScreen(r, where))) return { status: 'incomparable', reason: 'The check changed between the scans (a new case version, rule version or expectation), so a pass cannot confirm the old one.' };
      return { status: 'not_retested', reason: 'The same check did not run and pass in the later scan.' };
    }
    return { status: 'resolved', reason: 'Not found later, and the same check passed on the same screen under comparable conditions.' };
  };

  const judgeNew = (f: Finding): Pick<ComparedFinding, 'status' | 'reason'> => {
    if (!sameCourse) return { status: 'incomparable', reason: 'The earlier scan is of a different course.' };
    if (!isFinished(before)) return { status: 'not_retested', reason: `Found later; the earlier scan did not finish (${before.status}), so it may simply not have looked.` };
    const ids = screensOf(f);
    if (ids.length && !ids.some((id) => priorKeySet.has(now.key.get(id) ?? ''))) return { status: 'not_retested', reason: 'Found later, on a screen the earlier scan did not reach.' };
    return { status: 'new', reason: 'Found only in the later scan, on a screen the earlier scan also checked.' };
  };

  const findings: ComparedFinding[] = [];
  for (const f of priorFindings) {
    const base = { fingerprint: f.fingerprint, ruleId: f.ruleId, title: f.title };
    if (nowPrints.has(f.fingerprint)) findings.push({ ...base, status: sameCourse ? 'persistent' : 'incomparable', reason: sameCourse ? 'Found in both scans.' : 'The later scan is of a different course.' });
    else findings.push({ ...base, ...judgeGone(f) });
  }
  for (const f of nowFindings) if (!priorPrints.has(f.fingerprint)) findings.push({ fingerprint: f.fingerprint, ruleId: f.ruleId, title: f.title, ...judgeNew(f) });

  const counts = { new: 0, persistent: 0, resolved: 0, not_retested: 0, incomparable: 0 } as Record<ComparisonStatus, number>;
  for (const f of findings) counts[f.status]++;
  return { before: { id: before.id, status: before.status, at: before.queuedAt }, after: { id: after.id, status: after.status, at: after.queuedAt }, comparable: { sameCourse, differences }, findings, counts };
}
