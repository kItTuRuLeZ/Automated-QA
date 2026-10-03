import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import type {
  ActionId,
  ActionOutcome,
  CourseState,
  EngineResult,
  EvidenceId,
  FindingLocation,
  PostconditionCheck,
  ProviderContext,
  ReasonCode,
  RuleId,
  StateId,
  SurfaceInfo,
  TraversalAction,
} from '@cqa/shared';
import { TRAVERSAL_RULES, newId, nowIso, sanitizeText, sanitizeUrl } from '@cqa/core';
import { type CandidateAction, GenericHtmlAdapter } from '../adapters/generic-html.js';
import { type StateSnapshot, snapshotState, surfaceScan } from '../adapters/dom-scripts.js';
import type { BlockedConnection } from '../net/egress-proxy.js';
import { isAbort } from './capture.js';
import type { KeyboardPassInput } from './keyboard.js';
import { type NewCheck, type NewFinding, check, dedupe, finding, hostOf, truncate } from './helpers.js';

type Candidate = CandidateAction & { rawHref?: string };

interface Node {
  state: CourseState;
  snap: StateSnapshot;
  path: Candidate[];
}

export interface TraversalOutput extends EngineResult {
  states: CourseState[];
  actions: TraversalAction[];
  failedTransitions: number;
  inaccessibleFrames: number;
  unsupportedSurfaces: number;
  budgetsReached: ReasonCode[];
}

const POST_TIMEOUT_MS = 1_500;

const KIND_PRIORITY: Record<TraversalAction['kind'], number> = {
  select_tab: 0,
  expand: 1,
  collapse: 1,
  open_dialog: 2,
  close_dialog: 3,
  next: 4,
  back: 5,
  click: 6,
  key_press: 6,
  scroll: 6,
  wait: 6,
  navigate: 7,
};
const SETTLE_IDLE_MS = 1_500;
const STABLE_QUIET_MS = 600;
const STABLE_MAX_MS = 8_000;

/** Which rule judges an action of this kind. */
function ruleForKind(kind: TraversalAction['kind']): RuleId {
  if (kind === 'close_dialog') return 'NAV-003';
  if (kind === 'select_tab' || kind === 'expand' || kind === 'open_dialog') return 'NAV-001';
  return 'NAV-002';
}

const strictKey = (s: StateSnapshot) => JSON.stringify(s);
const structuralKey = (s: StateSnapshot) => JSON.stringify({ ...s, textHash: '' });

/**
 * Bounded, read-only, state-aware exploration. States are identified by a
 * signature (URL without query, lesson ID, open dialogs, selected tabs,
 * expanded sections, visible-text hash). Each state is restored by reloading
 * the target and replaying its action path before siblings are explored.
 */
export class Traversal {
  readonly id = 'bounded-traversal';
  readonly version = '1.0.0';
  readonly rules = TRAVERSAL_RULES;
  private readonly adapter = new GenericHtmlAdapter();

  constructor(
    private readonly deps: {
      targetUrl: string;
      rootState: CourseState;
      deadline: number;
      blocked: () => readonly BlockedConnection[];
      excludeResourceTypes?: readonly string[];
      /** Called once per reached state while the page shows it (per-state content checks). */
      onStateReady?: (state: CourseState, reproductionSteps: string[]) => Promise<void>;
      /** Keyboard activation of recognized controls (Phase 3); optional. */
      keyboardPass?: (input: KeyboardPassInput) => Promise<{ checks: NewCheck[]; findings: NewFinding[] }>;
    },
  ) {}

  async explore(ctx: ProviderContext, onState: (state: CourseState) => void): Promise<TraversalOutput> {
    const started = Date.now();
    const page = ctx.page as Page;
    const { budgets, redaction } = ctx.config;
    const viewportName = ctx.viewport.name;
    const san = (u: string) => sanitizeUrl(u, redaction);

    const checks: NewCheck[] = [];
    const findings: NewFinding[] = [];
    const coverage: EngineResult['coverage'] = [];
    const errors: EngineResult['errors'] = [];
    const actions: TraversalAction[] = [];
    const budgetsReached = new Set<ReasonCode>();
    let failedTransitions = 0;
    let inaccessibleFrames = 0;
    let unsupportedSurfaces = 0;

    // Runtime problems observed while exploring, attributed to the action that triggered them.
    let collecting = false;
    let observed: Array<{ kind: 'exception' | 'request'; text: string; url?: string; resourceType?: string }> = [];
    page.on('pageerror', (e) => collecting && observed.push({ kind: 'exception', text: sanitizeText(e.message, redaction) }));
    page.on('response', (r) => {
      if (!collecting || r.request().isNavigationRequest() || r.status() < 400 || r.headers()['x-cqa-blocked'] === '1') return;
      if (this.deps.excludeResourceTypes?.includes(r.request().resourceType())) return;
      observed.push({ kind: 'request', url: san(r.url()), text: `${san(r.url())} (HTTP ${r.status()})`, resourceType: r.request().resourceType() });
    });
    page.on('requestfailed', (r) => {
      if (!collecting || r.isNavigationRequest() || isAbort(r.failure()?.errorText) || this.deps.blocked().some((b) => b.host === hostOf(r.url()))) return;
      if (this.deps.excludeResourceTypes?.includes(r.resourceType())) return;
      observed.push({ kind: 'request', url: san(r.url()), text: `${san(r.url())} (${r.failure()?.errorText ?? 'failed'})`, resourceType: r.resourceType() });
    });

    const settle = async () => {
      await page.waitForLoadState('load', { timeout: budgets.navigationTimeoutMs }).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: SETTLE_IDLE_MS }).catch(() => undefined);
      // SPAs (for example Rise) keep rendering after network idle; wait until visible content stops changing.
      const stableUntil = Date.now() + STABLE_MAX_MS;
      let last = '';
      let stableSince = Date.now();
      while (Date.now() < stableUntil) {
        const s = await page.evaluate(snapshotState).catch(() => undefined);
        const key = s ? strictKey(s) : '';
        if (key !== last) {
          last = key;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= STABLE_QUIET_MS && key) break;
        await page.waitForTimeout(150);
      }
    };
    const snap = () => page.evaluate(snapshotState);
    const timeLeft = () => this.deps.deadline - Date.now() > 0;

    const execute = async (a: Candidate) => {
      if (a.kind === 'navigate') await page.goto(a.rawHref ?? a.href!, { waitUntil: 'load', timeout: budgets.navigationTimeoutMs });
      else await page.locator(a.locator!).first().click({ timeout: budgets.actionTimeoutMs });
      await settle();
    };

    const restore = async (node: Node): Promise<boolean> => {
      try {
        await page.goto(this.deps.targetUrl, { waitUntil: 'load', timeout: budgets.navigationTimeoutMs });
        await settle();
        for (const step of node.path) await execute(step);
        const now = await snap();
        return strictKey(now) === strictKey(node.snap) || structuralKey(now) === structuralKey(node.snap);
      } catch {
        return false;
      }
    };

    const describePath = (path: Candidate[]) => [
      `Open ${san(this.deps.targetUrl)} in Chromium with a ${ctx.viewport.width}×${ctx.viewport.height} CSS-pixel viewport.`,
      ...path.map((p) => stepText(p)),
    ];

    const screenshot = async (caption: string, stateId: StateId): Promise<EvidenceId | undefined> => {
      try {
        const bytes = await page.screenshot({ type: 'png', timeout: 10_000 });
        const artifactId = await ctx.evidence.writeArtifact({ kind: 'screenshot', mime: 'image/png', bytes });
        return (await ctx.evidence.addEvidence({ kind: 'screenshot', artifactId, caption, stateId, viewportName, capturedAt: nowIso(), redacted: false })).id;
      } catch {
        return undefined;
      }
    };

    // ---- root ----
    // Reload the target so the root snapshot reflects a clean, settled page.
    await page.goto(this.deps.targetUrl, { waitUntil: 'load', timeout: budgets.navigationTimeoutMs });
    await settle();
    const rootSnap = await snap();
    const root: Node = {
      state: { ...this.deps.rootState, signature: signatureOf(rootSnap), lessonId: rootSnap.lessonId ?? undefined, openDialogs: rootSnap.dialogs, selectedTabs: rootSnap.selectedTabs },
      snap: rootSnap,
      path: [],
    };
    const nodes = new Map<string, Node>([[strictKey(rootSnap), root]]);
    const states: CourseState[] = [root.state];
    const pages = new Set([pageKey(rootSnap.url)]);
    onState(root.state);
    await this.deps.onStateReady?.(root.state, describePath([]));
    const queue: Node[] = [root];
    let stop = false;

    const addFinding = (ruleId: RuleId, node: Node, f: Parameters<typeof finding>[2], location?: Partial<FindingLocation>) =>
      findings.push(finding(ruleId, { stateId: node.state.id, url: node.state.url, lessonId: node.state.lessonId, viewportName, browser: 'chromium', ...location }, f));

    while (queue.length && !stop) {
      const node = queue.shift()!;
      if (!timeLeft()) {
        budgetsReached.add('budget_runtime');
        break;
      }
      if (node.state.depth >= budgets.maxDepth) {
        budgetsReached.add('budget_depth');
        coverage.push({ reason: 'budget_depth', detail: `State at depth ${node.state.depth} was not explored further (max depth ${budgets.maxDepth}).`, stateId: node.state.id });
        continue;
      }
      if (!(await restore(node))) {
        failedTransitions++;
        coverage.push({ reason: 'state_unreachable', detail: `Could not restore state "${node.state.title ?? node.state.url}" by replaying its action path.`, stateId: node.state.id });
        continue;
      }

      // ---- surfaces: frames and canvas ----
      const surfaces = await this.inspectSurfaces(page, ctx);
      node.state.surfaces = [{ kind: 'document' }, ...surfaces.frames, ...surfaces.canvases.map(() => ({ kind: 'canvas' as const, reason: 'unsupported_surface' as const }))];
      onState(node.state);
      const uninspected = surfaces.frames.filter((f) => f.reason);
      inaccessibleFrames += uninspected.length;
      checks.push(check('COV-002', uninspected.length ? 'needs_review' : surfaces.frames.length ? 'passed' : 'not_applicable', 0, [], { stateId: node.state.id, viewportName, itemsEvaluated: surfaces.frames.length }));
      for (const f of uninspected) {
        addFinding('COV-002', node, {
          title: `Frame not inspected: ${f.frameUrl || '(no URL)'}`,
          observed: `${f.frameUrl || 'An embedded frame'} was not inspected (${f.reason}).`,
          expected: 'Frame content is reviewed manually; automated checks did not cover it.',
          evidenceIds: [],
          reproductionSteps: describePath(node.path),
          remediation: 'Review the frame content manually, or widen the scan scope if the frame belongs to the course.',
          targetKey: `${f.frameUrl}|${f.reason}`,
          stateKey: '',
        }, { frameUrl: f.frameUrl });
      }
      unsupportedSurfaces += surfaces.canvases.length;
      checks.push(check('COV-003', surfaces.canvases.length ? 'needs_review' : 'passed', 0, [], { stateId: node.state.id, viewportName, itemsEvaluated: surfaces.canvases.length }));
      for (const c of surfaces.canvases) {
        addFinding('COV-003', node, {
          title: `Canvas content not inspectable (${c.width}×${c.height})`,
          observed: `A ${c.width}×${c.height} canvas is visible. Its contents are drawn as pixels and cannot be checked through the DOM.`,
          expected: 'Canvas-rendered content is reviewed manually.',
          evidenceIds: [],
          reproductionSteps: describePath(node.path),
          remediation: 'Review this content manually. Platform adapters for canvas-based tools are planned for Phase 7.',
          targetKey: c.locator,
          stateKey: '',
        }, { selector: c.locator });
      }

      // ---- discover actions ----
      const candidates = (await this.adapter.discoverActions({ ...ctx, state: node.state })) as Candidate[];
      const skipped = candidates.filter((c) => c.reason);
      // In-page interactions first; links last, so site navigation does not consume the state budget before the content is explored.
      const runnable = candidates.filter((c) => !c.reason).sort((x, y) => KIND_PRIORITY[x.kind] - KIND_PRIORITY[y.kind]);
      for (const s of skipped) actions.push(toAction(ctx.runId, s, 'skipped'));
      const unsafe = skipped.filter((s) => s.reason === 'unsafe_action');
      const ambiguous = skipped.filter((s) => s.reason === 'ambiguous_action');
      checks.push(check('COV-001', unsafe.length || ambiguous.length ? 'needs_review' : 'passed', 0, [], { stateId: node.state.id, viewportName, itemsEvaluated: skipped.length }));
      for (const u of dedupe(unsafe, (x) => x.targetDescription)) {
        addFinding('COV-001', node, {
          title: `Not clicked (unsafe): ${u.targetDescription}`,
          observed: `${u.targetDescription} was not clicked: ${u.reasonDetail}.`,
          expected: 'Destructive or state-changing controls are verified manually.',
          evidenceIds: [],
          reproductionSteps: describePath(node.path),
          remediation: 'Test this control manually.',
          targetKey: u.targetDescription,
          stateKey: '',
        }, { selector: u.locator, elementDescription: u.targetDescription });
      }
      if (ambiguous.length) {
        addFinding('COV-001', node, {
          title: 'Controls not exercised because their behavior is not recognized',
          observed: `${ambiguous.length} control(s) were not clicked: ${ambiguous.slice(0, 8).map((a) => a.targetDescription).join(', ')}${ambiguous.length > 8 ? ', …' : ''}.`,
          expected: 'Unrecognized controls are reviewed manually or covered by a platform adapter.',
          evidenceIds: [],
          reproductionSteps: describePath(node.path),
          remediation: 'Review these controls manually. Their content is unverified.',
          targetKey: 'ambiguous',
          stateKey: '',
        });
      }

      // ---- execute actions ----
      for (const cand of runnable) {
        if (stop) break;
        if (!timeLeft()) {
          budgetsReached.add('budget_runtime');
          actions.push(toAction(ctx.runId, { ...cand, reason: 'budget_runtime' }, 'not_attempted'));
          continue;
        }
        if (cand.kind === 'navigate' && cand.rawHref && !pages.has(pageKey(cand.rawHref)) && pages.size >= budgets.maxPages) {
          budgetsReached.add('budget_pages');
          actions.push(toAction(ctx.runId, { ...cand, reason: 'budget_pages' }, 'not_attempted'));
          continue;
        }
        const current = await snap().catch(() => undefined);
        if (!current || strictKey(current) !== strictKey(node.snap)) {
          if (!(await restore(node))) {
            failedTransitions++;
            actions.push(toAction(ctx.runId, { ...cand, reason: 'state_unreachable', reasonDetail: 'The parent state could not be restored.' }, 'not_attempted'));
            continue;
          }
        }

        const ruleId = ruleForKind(cand.kind);
        const before = await snap();
        const t0 = Date.now();
        observed = [];
        collecting = true;
        try {
          await execute(cand);
        } catch (err) {
          collecting = false;
          failedTransitions++;
          const raw = (err as Error).message;
          const detail = raw.includes("Timeout") ? `The control did not become clickable within ${budgets.actionTimeoutMs} ms (it may be disabled until media or an animation finishes, or covered by another element).` : truncate(raw, 200);
          actions.push(toAction(ctx.runId, { ...cand, reason: 'engine_error', reasonDetail: detail, durationMs: Date.now() - t0 }, 'failed'));
          checks.push(check(ruleId, 'error', Date.now() - t0, [], { stateId: node.state.id, viewportName, reason: 'engine_error', reasonDetail: `Could not perform ${cand.targetDescription}: ${detail}` }));
          continue;
        }
        let after = await snap();
        let postOk = await this.verify(page, cand.postconditions ?? [], before, after);
        let retried = false;
        // A defect must reproduce: before reporting a recognized control as broken, restore the state and try once more.
        collecting = false; // reloading for the retry must not attribute page-load problems to this action
        if (!postOk && ruleId !== 'NAV-002' && timeLeft() && (await restore(node))) {
          collecting = true;
          retried = true;
          try {
            await execute(cand);
            after = await snap();
            postOk = await this.verify(page, cand.postconditions ?? [], before, after);
          } catch {
            postOk = false;
          }
        }
        collecting = false;
        const duration = Date.now() - t0;
        const changed = strictKey(after) !== strictKey(before);

        // Resolve the resulting state: known, new, or over budget.
        let target: Node | undefined = changed ? nodes.get(strictKey(after)) : node;
        let createdNew = false;
        if (changed && !target) {
          if (states.length >= budgets.maxStates) {
            budgetsReached.add('budget_states');
            coverage.push({ reason: 'budget_states', detail: `Stopped after reaching ${budgets.maxStates} states.`, stateId: node.state.id });
            stop = true;
          } else {
            const id = newId<StateId>();
            const title = (await page.title().catch(() => '')) || undefined;
            target = {
              snap: after,
              path: [...node.path, cand],
              state: {
                id,
                runId: ctx.runId,
                url: san(after.url),
                title,
                signature: signatureOf(after),
                lessonId: after.lessonId ?? undefined,
                openDialogs: after.dialogs,
                selectedTabs: after.selectedTabs,
                depth: node.state.depth + 1,
                pathFromRoot: [],
                surfaces: [{ kind: 'document' }],
                viewportName,
                capturedAt: nowIso(),
              },
            };
            nodes.set(strictKey(after), target);
            states.push(target.state);
            pages.add(pageKey(after.url));
            createdNew = true;
          }
        }

        const outcome: ActionOutcome = postOk ? 'succeeded' : ruleId === 'NAV-002' ? 'no_observable_change' : 'failed';
        const action = toAction(ctx.runId, { ...cand, durationMs: duration, toStateId: target?.state.id }, outcome);
        actions.push(action);
        if (createdNew && target) {
          target.state.pathFromRoot = [...(node.state.pathFromRoot ?? []), action.id];
          const shot = await screenshot(`State reached by ${stepText(cand)}`, target.state.id);
          void shot;
          onState(target.state);
          await this.deps.onStateReady?.(target.state, describePath(target.path));
          queue.push(target);
        }

        const stateForResult = target ?? node;
        if (postOk) {
          checks.push(check(ruleId, 'passed', duration, [], { stateId: node.state.id, viewportName, reasonDetail: retried ? 'Passed on the second attempt; the first attempt did not show the expected result in time.' : undefined }));
        } else {
          const shot = await screenshot(`After ${stepText(cand)}`, stateForResult.state.id);
          const ev = shot ? [shot] : [];
          const repro = [...describePath(node.path), stepText(cand), `Expected: ${cand.expectedPostcondition}`];
          if (ruleId === 'NAV-002') {
            checks.push(check(ruleId, 'needs_review', duration, ev, { stateId: node.state.id, viewportName }));
            addFinding('NAV-002', node, {
              title: `No observable change after ${cand.targetDescription}`,
              observed: `Activating ${cand.targetDescription} did not change the URL, dialogs, selections, or visible content.`,
              expected: `${cand.expectedPostcondition} This may be intended (for example a gated or final screen).`,
              evidenceIds: ev,
              reproductionSteps: repro,
              remediation: 'Check whether the control should do something at this point in the course.',
              targetKey: cand.targetDescription,
            }, { selector: cand.locator, elementDescription: cand.targetDescription });
          } else {
            checks.push(check(ruleId, 'failed', duration, ev, { stateId: node.state.id, viewportName, reasonDetail: controlKeyOf(cand) }));
            addFinding(ruleId, node, {
              title: ruleId === 'NAV-003' ? `Dialog did not close with ${cand.targetDescription}` : `${capitalizeFirst(cand.targetDescription)} did not work as expected`,
              observed: `After activating ${cand.targetDescription}, the expected result was not observed within ${POST_TIMEOUT_MS} ms, on two separate attempts.`,
              expected: cand.expectedPostcondition ?? '',
              evidenceIds: ev,
              reproductionSteps: repro,
              remediation: ruleId === 'NAV-003' ? 'Make the close control hide the dialog and return focus to the page.' : 'Fix the control so it updates its state (aria-selected / aria-expanded) and shows the content it controls.',
              targetKey: cand.targetDescription,
            }, { selector: cand.locator, elementDescription: cand.targetDescription });
          }
        }

        // Runtime problems triggered by this action.
        for (const o of dedupe(observed, (x) => x.url ?? x.text)) {
          const where = stateForResult;
          const ev = await ctx.evidence.addEvidence({ kind: o.kind === 'exception' ? 'console_entry' : 'network_entry', caption: o.kind === 'exception' ? 'Uncaught exception during exploration' : 'Failed request during exploration', data: { text: o.text, resourceType: o.resourceType ?? null, afterAction: cand.targetDescription }, stateId: where.state.id, viewportName, capturedAt: nowIso(), redacted: true });
          const repro = [...describePath(node.path), stepText(cand)];
          if (o.kind === 'exception') {
            addFinding('RUN-002', where, {
              title: `Uncaught JavaScript exception: ${truncate(o.text, 120)}`,
              observed: o.text,
              expected: 'Interacting with the course does not throw uncaught exceptions.',
              evidenceIds: [ev.id],
              reproductionSteps: [...repro, 'Open the developer tools console to see the exception.'],
              remediation: 'Fix the script error, or guard the failing code path.',
              targetKey: o.text.split('\n')[0],
              stateKey: 'initial', // same key as the initial capture: one problem, several occurrences
            });
          } else {
            addFinding('RUN-004', where, {
              title: `${o.resourceType ?? 'Resource'} request failed after ${cand.targetDescription}`,
              observed: `${o.text} failed after ${cand.targetDescription}.`,
              expected: 'Resources requested during interaction load successfully.',
              evidenceIds: [ev.id],
              reproductionSteps: [...repro, 'Open the developer tools Network panel.'],
              remediation: 'Restore the missing resource or remove the reference to it.',
              targetKey: o.url ?? o.text,
              stateKey: 'initial',
              severity: o.resourceType && ['document', 'script', 'stylesheet'].includes(o.resourceType) ? 'high' : 'medium',
            });
          }
        }
      }

      // ---- keyboard activation of controls whose mouse action worked ----
      if (this.deps.keyboardPass && !stop && timeLeft()) {
        const worked = runnable.filter((c) => actions.some((a) => a.outcome === 'succeeded' && a.fromStateId === node.state.id && a.locator === c.locator && a.kind === c.kind));
        if (worked.length) {
          try {
            const kb = await this.deps.keyboardPass({
              page,
              ctx,
              state: node.state,
              repro: describePath(node.path),
              candidates: worked,
              restore: () => restore(node),
              snap,
              verify: (post, b, a) => this.verify(page, post, b, a),
            });
            checks.push(...kb.checks);
            findings.push(...kb.findings);
          } catch (err) {
            if (ctx.signal.aborted) throw err;
            checks.push(check('KBD-004', 'error', 0, [], { stateId: node.state.id, viewportName, reason: 'engine_error', reasonDetail: truncate((err as Error).message, 200) }));
          }
        }
      }
    }

    if (this.deps.keyboardPass) {
      for (const ruleId of ['KBD-003', 'KBD-004'] as const) {
        if (!checks.some((c) => c.ruleId === ruleId)) {
          checks.push(
            check(ruleId, 'not_applicable', 0, [], {
              stateId: root.state.id,
              viewportName,
              reasonDetail: ruleId === 'KBD-003' ? 'No recognized dialog opener worked with the mouse in the states reached.' : 'No recognized tab, expandable section, or dialog opener worked with the mouse in the states reached.',
            }),
          );
        }
      }
    }

    // A control that worked in other states but not here is inconsistent rather than proven broken
    // (often timing in animated players): downgrade to a manual-review item instead of a defect.
    const controlKey = (description?: string, locator?: string) => `${description ?? ''}|${locator ?? ''}`;
    const workedSomewhere = new Set(actions.filter((a) => a.outcome === 'succeeded').map((a) => controlKey(a.targetDescription, a.locator)));
    for (const f of findings) {
      if ((f.ruleId === 'NAV-001' || f.ruleId === 'NAV-003') && workedSomewhere.has(controlKey(f.location.elementDescription, f.location.selector))) {
        f.type = 'manual_review';
        f.severity = 'low';
        f.confidence = 'low';
        f.title = `Inconsistent: ${f.title}`;
        f.observed += ' The same control worked in other states of this scan, so this may be timing rather than a defect. Confirm manually.';
      }
    }
    for (const c of checks) {
      if ((c.ruleId === 'NAV-001' || c.ruleId === 'NAV-003') && c.outcome === 'failed' && c.reasonDetail && workedSomewhere.has(c.reasonDetail)) {
        c.outcome = 'needs_review';
        c.reasonDetail = `Inconsistent: ${c.reasonDetail.split('|')[0]} worked in other states.`;
      } else if (c.outcome === 'failed' && c.reasonDetail?.includes('|')) {
        c.reasonDetail = undefined;
      }
    }

    // Anything still queued when exploration stopped was reached but not explored.
    for (const n of queue) coverage.push({ reason: [...budgetsReached][0] ?? 'budget_states', detail: `State "${n.state.title ?? n.state.url}" was reached but not explored.`, stateId: n.state.id });

    // ---- COV-004 budgets ----
    const reached = [...budgetsReached];
    checks.push(check('COV-004', reached.length ? 'needs_review' : 'passed', 0, [], { stateId: root.state.id, viewportName }));
    if (reached.length) {
      findings.push(
        finding('COV-004', { stateId: root.state.id, url: root.state.url, viewportName, browser: 'chromium' }, {
          title: `Exploration stopped at a scan budget (${reached.map(budgetLabel).join(', ')})`,
          observed: `Reached ${states.length} state(s) and attempted ${actions.filter((a) => a.outcome !== 'skipped' && a.outcome !== 'not_attempted').length} action(s) before hitting: ${reached.map(budgetLabel).join(', ')}.`,
          expected: 'Content beyond the budget is unverified. Increase the budget or scan sections separately for more coverage.',
          evidenceIds: [],
          reproductionSteps: describePath([]),
          remediation: 'Raise the relevant budget in the scan configuration if more coverage is needed.',
          targetKey: reached.sort().join(','),
        }),
      );
    }

    // ---- requests blocked during exploration (beyond those reported at initial capture) ----
    void errors;
    return {
      engine: this.id,
      engineVersion: this.version,
      checkResults: checks,
      findings,
      coverage,
      errors,
      durationMs: Date.now() - started,
      states,
      actions: actions.map(stripInternal),
      failedTransitions,
      inaccessibleFrames,
      unsupportedSurfaces,
      budgetsReached: reached,
    };
  }

  private async verify(page: Page, post: PostconditionCheck[], before: StateSnapshot, after: StateSnapshot): Promise<boolean> {
    const deadline = Date.now() + POST_TIMEOUT_MS;
    let latest = after;
    for (;;) {
      const results = await Promise.all(post.map((p) => this.evalPost(page, p, before, latest)));
      if (results.every(Boolean)) return true;
      if (Date.now() > deadline) return false;
      await page.waitForTimeout(150);
      latest = await page.evaluate(snapshotState).catch(() => latest);
    }
  }

  private async evalPost(page: Page, p: PostconditionCheck, before: StateSnapshot, after: StateSnapshot): Promise<boolean> {
    try {
      switch (p.type) {
        case 'attribute_equals':
          return (await page.locator(p.locator).first().getAttribute(p.attribute, { timeout: 500 })) === p.value;
        case 'property_true':
          return await page.locator(p.locator).first().evaluate((el, prop) => Boolean((el as unknown as Record<string, unknown>)[prop]), p.property, { timeout: 500 });
        case 'visible':
          return await page.locator(p.locator).first().isVisible();
        case 'hidden':
          return !(await page.locator(p.locator).first().isVisible());
        case 'dialog_count_increases':
          return after.dialogs.length > before.dialogs.length;
        case 'signature_changes':
          return strictKey(after) !== strictKey(before);
        case 'url_changes':
          return after.url !== before.url;
      }
    } catch {
      return false;
    }
  }

  private async inspectSurfaces(page: Page, ctx: ProviderContext): Promise<{ frames: SurfaceInfo[]; canvases: Array<{ locator: string; width: number; height: number }> }> {
    const frames: SurfaceInfo[] = [];
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      const raw = f.url();
      if (raw === 'about:blank' || raw === '') continue;
      if (raw === 'about:srcdoc') {
        frames.push({ kind: 'frame_same_origin', frameUrl: 'about:srcdoc' as SurfaceInfo['frameUrl'] & string, reason: 'not_implemented' });
        continue;
      }
      const frameUrl = sanitizeUrl(raw, ctx.config.redaction);
      let origin = '';
      try {
        origin = new URL(raw).origin;
      } catch {
        frames.push({ kind: 'frame_inaccessible', frameUrl, reason: 'inaccessible_frame' });
        continue;
      }
      if (!raw.startsWith('http')) {
        frames.push({ kind: 'frame_inaccessible', frameUrl, reason: 'inaccessible_frame' });
        continue;
      }
      if (!ctx.config.scope.allowedOrigins.includes(origin)) {
        frames.push({ kind: 'frame_cross_origin', frameUrl, reason: 'out_of_scope' });
        continue;
      }
      const ok = await Promise.race([f.evaluate(() => document.readyState).then(() => true, () => false), new Promise<boolean>((r) => setTimeout(() => r(false), 2_000))]);
      // In-scope, scriptable frames are reachable, but the generic adapter does not yet explore controls inside frames.
      frames.push(ok ? { kind: 'frame_same_origin', frameUrl, reason: 'not_implemented' } : { kind: 'frame_inaccessible', frameUrl, reason: 'inaccessible_frame' });
    }
    const { canvases } = await page.evaluate(surfaceScan).catch(() => ({ canvases: [] }));
    return { frames, canvases };
  }
}

function signatureOf(s: StateSnapshot): string {
  return createHash('sha256').update(JSON.stringify(s)).digest('hex');
}

function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}


function toAction(runId: TraversalAction['runId'], c: Candidate & { toStateId?: StateId; durationMs?: number }, outcome: ActionOutcome): TraversalAction & { rawHref?: string } {
  return { ...c, id: newId<ActionId>(), runId, outcome };
}

function stripInternal(a: TraversalAction & { rawHref?: string }): TraversalAction {
  const { rawHref: _drop, ...rest } = a;
  return rest;
}

function stepText(a: Candidate): string {
  switch (a.kind) {
    case 'select_tab':
      return `Select ${a.targetDescription}.`;
    case 'expand':
      return `Expand ${a.targetDescription}.`;
    case 'open_dialog':
      return `Activate ${a.targetDescription}.`;
    case 'close_dialog':
      return `Activate ${a.targetDescription}.`;
    case 'navigate':
      return `Follow ${a.targetDescription}${a.href ? ` (${a.href})` : ''}.`;
    default:
      return `Activate ${a.targetDescription}.`;
  }
}

function budgetLabel(r: ReasonCode): string {
  return { budget_states: 'maximum states', budget_depth: 'maximum depth', budget_pages: 'maximum pages', budget_runtime: 'runtime limit' }[r as string] ?? r;
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function controlKeyOf(a: { targetDescription: string; locator?: string }): string {
  return `${a.targetDescription}|${a.locator ?? ''}`;
}
