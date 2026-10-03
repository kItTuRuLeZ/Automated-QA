import type { Page } from 'playwright';
import type { CourseState, EvidenceId, FindingLocation, PostconditionCheck, ProviderContext } from '@cqa/shared';
import { nowIso } from '@cqa/core';
import { type CandidateAction } from '../adapters/generic-html.js';
import type { StateSnapshot } from '../adapters/dom-scripts.js';
import { type FocusInfo, blurredStyle, describeActive, focusIsOn, focusWithin, focusabilityOf, prepareTabbing } from '../adapters/a11y-scripts.js';
import { type NewCheck, type NewFinding, check, finding, truncate } from './helpers.js';

export interface KeyboardResult {
  checks: NewCheck[];
  findings: NewFinding[];
}

const MAX_TABS = 60;
const MAX_ACTIVATIONS_PER_RUN = 12;
const KEYBOARD_KINDS = new Set(['select_tab', 'expand', 'open_dialog']);
const CLOSE_NAME = /^(close|dismiss|×|✕|x|ok|okay|done|cancel|got it)\b/i;

export interface KeyboardPassInput {
  page: Page;
  ctx: ProviderContext;
  state: CourseState;
  repro: string[];
  candidates: Array<CandidateAction & { outcome?: string }>;
  restore: () => Promise<boolean>;
  snap: () => Promise<StateSnapshot>;
  verify: (post: PostconditionCheck[], before: StateSnapshot, after: StateSnapshot) => Promise<boolean>;
}

/**
 * Bounded keyboard review: a Tab journey per state (traps, focus visibility)
 * and keyboard activation of recognized controls and dialogs.
 */
export class KeyboardChecks {
  readonly id = 'keyboard';
  readonly version = '1.0.0';
  private activations = 0;

  // ---- Tab journey ----
  async journey(ctx: ProviderContext, state: CourseState, repro: string[]): Promise<KeyboardResult> {
    const page = ctx.page as Page;
    const viewportName = ctx.viewport.name;
    const base = { stateId: state.id, viewportName };
    const checks: NewCheck[] = [];
    const findings: NewFinding[] = [];
    const loc = (extra: Partial<FindingLocation> = {}): FindingLocation => ({ stateId: state.id, url: state.url, lessonId: state.lessonId, viewportName, browser: 'chromium', ...extra });
    const t0 = Date.now();

    const { total } = await page.evaluate(prepareTabbing);
    if (total === 0) {
      checks.push(check('KBD-001', 'not_applicable', 0, [], { ...base, reasonDetail: 'No tabbable elements in this state.' }));
      checks.push(check('KBD-002', 'not_applicable', 0, [], { ...base, reasonDetail: 'No tabbable elements in this state.' }));
      return { checks, findings };
    }

    const seq: FocusInfo[] = [];
    const seen = new Set<string>();
    const blurred = new Map<string, string>();
    let prev: FocusInfo | undefined;
    let leftContent = false;
    let revisit = false;
    let consecutive = 0;
    let stuckOn: FocusInfo | undefined;
    const max = Math.min(total + 3, MAX_TABS);

    for (let i = 0; i < max && !ctx.signal.aborted; i++) {
      await page.keyboard.press('Tab');
      await page.waitForTimeout(40);
      let info: FocusInfo;
      try {
        info = await page.evaluate(describeActive);
      } catch (err) {
        // Never swallow engine failures: record them so the state is not counted as checked.
        const detail = truncate((err as Error).message, 200);
        checks.push(check('KBD-001', 'error', Date.now() - t0, [], { ...base, reason: 'engine_error', reasonDetail: detail }));
        checks.push(check('KBD-002', 'error', 0, [], { ...base, reason: 'engine_error', reasonDetail: detail }));
        return { checks, findings };
      }
      if (prev && !prev.isBody && prev.key !== info.key) {
        const b = await page.evaluate(blurredStyle, prev.key).catch(() => null);
        if (b !== null) blurred.set(prev.key, b);
      }
      if (info.isBody) {
        leftContent = true;
      } else if (prev && info.key === prev.key) {
        consecutive++;
        if (info.tag !== 'iframe' && consecutive >= 6) {
          stuckOn = info;
          break;
        }
        continue; // focus is inside a frame or on the same element; not a new stop
      } else {
        consecutive = 0;
        if (seen.has(info.key)) {
          revisit = true;
          seq.push(info);
          break;
        }
        seen.add(info.key);
        if (!seq.some((s) => s.key === info.key)) first(info, seq);
      }
      prev = info;
      if (info.isBody) seq.push(info);
    }
    if (prev && !prev.isBody) {
      const b = await page.evaluate(blurredStyle, prev.key).catch(() => null);
      if (b !== null) blurred.set(prev.key, b);
    }
    const distinct = seen.size;
    const focusedStyles = new Map(seq.filter((s) => !s.isBody).map((s) => [s.key, s.focusedStyle]));

    const seqEvidence: EvidenceId = (
      await ctx.evidence.addEvidence({
        kind: 'focus_sequence',
        caption: `Tab journey: ${distinct} distinct stop(s) of ${total} tabbable element(s)`,
        data: {
          tabbableElements: total,
          distinctStops: distinct,
          returnedToStart: revisit,
          leftContent,
          sequence: seq.slice(0, MAX_TABS).map((s) => (s.isBody ? '(document)' : `${s.tag}${s.role ? `[${s.role}]` : ''} "${s.name}" ${s.selector}`)),
        },
        stateId: state.id,
        viewportName,
        capturedAt: nowIso(),
        redacted: false,
      })
    ).id;

    // ---- KBD-001 ----
    const modalOpen = state.openDialogs.length > 0;
    if (modalOpen) {
      checks.push(check('KBD-001', 'not_applicable', Date.now() - t0, [seqEvidence], { ...base, reasonDetail: 'A dialog is open; keeping focus inside it is expected (see KBD-003).' }));
    } else {
      let trapped: { among: number; detail: string } | undefined;
      if (stuckOn) {
        await page.keyboard.press('Escape');
        await page.keyboard.press('Tab');
        const after = await page.evaluate(describeActive);
        if (after.key === stuckOn.key) trapped = { among: 1, detail: `Focus stayed on ${stuckOn.tag} "${stuckOn.name}" through repeated Tab presses and Escape.` };
      } else if (revisit && !leftContent && total - distinct >= 3 && distinct <= total * 0.6) {
        await page.keyboard.press('Escape');
        const escaped = new Set<string>();
        for (let i = 0; i < 6; i++) {
          await page.keyboard.press('Tab');
          await page.waitForTimeout(40);
          const info = await page.evaluate(describeActive);
          if (!info.isBody && !seen.has(info.key)) escaped.add(info.key);
        }
        if (escaped.size === 0) trapped = { among: distinct, detail: `Tab cycled among ${distinct} element(s) while ${total - distinct} other tabbable element(s) were never reached, even after Escape.` };
      }
      if (trapped) {
        checks.push(check('KBD-001', 'failed', Date.now() - t0, [seqEvidence], base));
        findings.push(
          finding('KBD-001', loc({ selector: seq[0]?.selector }), {
            title: `Keyboard focus is trapped${trapped.among > 1 ? ` among ${trapped.among} elements` : ''}`,
            observed: trapped.detail,
            expected: 'Keyboard users can move focus away from any component using standard keys (Tab, Shift+Tab, or Escape).',
            evidenceIds: [seqEvidence],
            reproductionSteps: [...repro, 'Press Tab repeatedly from the top of the page and note that focus cycles in a small group.', 'Press Escape and keep pressing Tab; focus still cannot reach the rest of the page.'],
            remediation: 'Let Tab move past the component, or provide a documented key (such as Escape) that releases focus.',
            targetKey: 'trap',
            stateKey: '',
          }),
        );
      } else {
        checks.push(check('KBD-001', 'passed', Date.now() - t0, [seqEvidence], { ...base, itemsEvaluated: distinct }));
      }
    }

    // ---- KBD-002 focus visible (heuristic) ----
    const invisible = [...seen].filter((k) => blurred.has(k) && focusedStyles.get(k) === blurred.get(k));
    const compared = [...seen].filter((k) => blurred.has(k)).length;
    if (compared === 0) {
      checks.push(check('KBD-002', 'not_applicable', 0, [seqEvidence], { ...base, reasonDetail: 'No focus changes to compare.' }));
    } else if (invisible.length === 0) {
      checks.push(check('KBD-002', 'passed', 0, [seqEvidence], { ...base, itemsEvaluated: compared }));
    } else {
      checks.push(check('KBD-002', 'needs_review', 0, [seqEvidence], { ...base, itemsEvaluated: compared }));
      const els = invisible.map((k) => seq.find((s) => s.key === k)!).filter(Boolean);
      const ev = (
        await ctx.evidence.addEvidence({
          kind: 'dom_snippet',
          caption: 'Elements whose computed style does not change on focus',
          data: { elements: els.map((e) => ({ tag: e.tag, name: e.name, selector: e.selector, style: e.focusedStyle })) },
          stateId: state.id,
          viewportName,
          capturedAt: nowIso(),
          redacted: false,
        })
      ).id;
      findings.push(
        finding('KBD-002', loc({ selector: els[0]?.selector }), {
          title: `No visible focus change detected on ${els.length} element(s)`,
          observed: `When focused with the keyboard, these elements' outline, shadow, border, background, color, and text decoration were identical to their unfocused style: ${els.slice(0, 5).map((e) => `${e.tag} "${truncate(e.name, 30)}"`).join(', ')}${els.length > 5 ? ', …' : ''}.`,
          expected: 'Keyboard focus is visible. A pixel-level indicator the scanner cannot measure may exist, so confirm by tabbing through the state.',
          evidenceIds: [ev, seqEvidence],
          reproductionSteps: [...repro, 'Press Tab to move through the controls and watch for a visible focus indicator.'],
          remediation: 'Add a visible :focus-visible style (outline or equivalent) with sufficient contrast.',
          targetKey: 'focus-visible',
          stateKey: '',
          occurrences: els.map((e) => ({ location: loc({ selector: e.selector, elementDescription: `${e.tag} "${truncate(e.name, 60)}"` }), checkResultIds: [], evidenceIds: [ev], observed: 'Computed style unchanged on focus.' })),
        }),
      );
    }

    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.()).catch(() => undefined);
    return { checks, findings };
  }

  // ---- keyboard activation of recognized controls and dialogs ----
  async activate(input: KeyboardPassInput): Promise<KeyboardResult> {
    const { page, ctx, state, repro } = input;
    const viewportName = ctx.viewport.name;
    const checks: NewCheck[] = [];
    const findings: NewFinding[] = [];
    const base = { stateId: state.id, viewportName };

    for (const cand of input.candidates) {
      if (!KEYBOARD_KINDS.has(cand.kind) || !cand.locator || !cand.postconditions?.length) continue;
      if (this.activations >= MAX_ACTIVATIONS_PER_RUN) break;
      this.activations++;
      const t0 = Date.now();
      const loc = (extra: Partial<FindingLocation> = {}): FindingLocation => ({ stateId: state.id, url: state.url, lessonId: state.lessonId, viewportName, browser: 'chromium', selector: cand.locator, elementDescription: cand.targetDescription, ...extra });
      const steps = [...repro, `Move focus to ${cand.targetDescription} using the Tab key.`];

      if (!(await input.restore())) {
        checks.push(check('KBD-004', 'not_tested', 0, [], { ...base, reason: 'state_unreachable', reasonDetail: `Could not restore the state to test ${cand.targetDescription}.` }));
        continue;
      }
      const foc = await page.evaluate(focusabilityOf, cand.locator);
      if (!foc.found) {
        checks.push(check('KBD-004', 'not_tested', 0, [], { ...base, reason: 'state_unreachable', reasonDetail: `${cand.targetDescription} was not found after restoring the state.` }));
        continue;
      }
      if (!foc.focusable) {
        checks.push(check('KBD-004', 'failed', Date.now() - t0, [], base));
        findings.push(
          finding('KBD-004', loc(), {
            title: `${cap(cand.targetDescription)} cannot be reached with the keyboard`,
            observed: `${cand.targetDescription} (${foc.tag}${foc.role ? `[role=${foc.role}]` : ''}) responds to the mouse but is not focusable: it is not a native control and has no tabindex.`,
            expected: 'Every control that can be operated with a mouse can be reached and operated with the keyboard.',
            evidenceIds: [],
            reproductionSteps: [...steps, 'Observe that focus never lands on it.'],
            remediation: 'Use a native <button> or <a href>, or add tabindex="0", a role, and Enter/Space key handling.',
            targetKey: `${cand.targetDescription}|focus`,
            stateKey: '',
          }),
        );
        continue;
      }

      // Enter first, then Space (either satisfies native and ARIA button/tab patterns).
      let before = await input.snap();
      let operated = false;
      let usedKey = 'Enter';
      for (const key of ['Enter', 'Space'] as const) {
        if (key === 'Space' && !(await input.restore())) break;
        before = await input.snap();
        await page.locator(cand.locator).first().focus();
        await page.keyboard.press(key === 'Space' ? ' ' : 'Enter');
        await page.waitForTimeout(200);
        const after = await input.snap();
        operated = await input.verify(cand.postconditions, before, after);
        usedKey = key;
        if (operated) break;
      }
      if (!operated) {
        checks.push(check('KBD-004', 'failed', Date.now() - t0, [], base));
        findings.push(
          finding('KBD-004', loc(), {
            title: `${cap(cand.targetDescription)} cannot be operated with the keyboard`,
            observed: `${cand.targetDescription} can be focused and works with the mouse, but pressing Enter or Space did not ${cand.expectedPostcondition?.toLowerCase().replace(/\.$/, '') ?? 'produce the expected result'}.`,
            expected: 'Controls respond to Enter and/or Space as well as to the mouse.',
            evidenceIds: [],
            reproductionSteps: [...steps, 'Press Enter, then Space.', `Expected: ${cand.expectedPostcondition}`],
            remediation: 'Handle keyboard activation (native <button> does this automatically).',
            targetKey: `${cand.targetDescription}|operate`,
            stateKey: '',
          }),
        );
        continue;
      }
      checks.push(check('KBD-004', 'passed', Date.now() - t0, [], { ...base, reasonDetail: `Operated with ${usedKey}.` }));

      if (cand.kind === 'open_dialog') {
        const dialogLoc = cand.postconditions.find((p) => p.type === 'visible')?.locator;
        const r = dialogLoc ? await this.dialogChecks(page, ctx, state, cand, dialogLoc, steps, loc) : undefined;
        if (!r) checks.push(check('KBD-003', 'not_applicable', 0, [], { ...base, reasonDetail: 'The dialog element was not identified.' }));
        else {
          checks.push(...r.checks);
          findings.push(...r.findings);
        }
      }
    }
    return { checks, findings };
  }

  private async dialogChecks(
    page: Page,
    ctx: ProviderContext,
    state: CourseState,
    cand: CandidateAction,
    dialogLoc: string,
    steps: string[],
    loc: (extra?: Partial<FindingLocation>) => FindingLocation,
  ): Promise<KeyboardResult> {
    const base = { stateId: state.id, viewportName: ctx.viewport.name };
    const problems: Array<{ what: string; observed: string; remediation: string }> = [];
    const notes: string[] = [];
    const focusLog: string[] = [];

    await page.waitForTimeout(300);
    let w = await page.evaluate(focusWithin, dialogLoc);
    focusLog.push(`after opening: ${w.active}${w.inside ? ' (inside dialog)' : ' (outside dialog)'}`);
    if (!w.inside) problems.push({ what: 'does not move focus into the dialog', observed: `After opening with the keyboard, focus stayed on ${w.active}, outside the dialog.`, remediation: 'Move focus to the dialog (or its first focusable element) when it opens.' });

    const modal = await page.evaluate((l) => document.querySelector(l)?.getAttribute('aria-modal') === 'true', dialogLoc);
    if (modal && w.inside) {
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Tab');
        await page.waitForTimeout(30);
        w = await page.evaluate(focusWithin, dialogLoc);
        focusLog.push(`Tab ${i + 1}: ${w.active}${w.inside ? '' : ' (outside dialog)'}`);
        if (!w.inside) {
          problems.push({ what: 'does not keep focus inside the modal dialog', observed: `Pressing Tab moved focus to ${w.active}, outside the aria-modal dialog.`, remediation: 'Contain Tab and Shift+Tab within the dialog while it is open (or use <dialog> with showModal()).' });
          break;
        }
      }
    } else if (!modal) notes.push('not aria-modal, so containment was not required');

    // Close with the dialog's own close control, then check focus return.
    const closer = page.locator(dialogLoc).getByRole('button', { name: CLOSE_NAME }).first();
    if ((await closer.count()) === 0) {
      notes.push('no recognizable close button, so return of focus was not tested');
    } else {
      await closer.focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      const closed = !(await page.locator(dialogLoc).first().isVisible());
      if (!closed) notes.push('the dialog did not close with its close button (reported separately as NAV-003), so return of focus was not tested');
      else {
        const returned = await page.evaluate(focusIsOn, cand.locator!);
        focusLog.push(`after closing: focus ${returned ? 'returned to the opener' : 'did not return to the opener'}`);
        if (!returned) problems.push({ what: 'does not return focus to the opener when closed', observed: `After closing, focus was not on ${cand.targetDescription}.`, remediation: 'Return focus to the control that opened the dialog when it closes.' });
      }
    }

    const ev: EvidenceId = (
      await ctx.evidence.addEvidence({ kind: 'focus_sequence', caption: `Dialog keyboard test for ${cand.targetDescription}`, data: { log: focusLog, notes }, stateId: state.id, viewportName: ctx.viewport.name, capturedAt: nowIso(), redacted: false })
    ).id;
    if (problems.length === 0) return { checks: [check('KBD-003', 'passed', 0, [ev], { ...base, reasonDetail: notes.join('; ') || undefined })], findings: [] };
    return {
      checks: [check('KBD-003', 'failed', 0, [ev], base)],
      findings: problems.map((p) =>
        finding('KBD-003', loc(), {
          title: `Dialog opened by ${cand.targetDescription} ${p.what}`,
          observed: p.observed,
          expected: 'A dialog moves focus in when it opens, keeps it inside while it is modal, and returns it to the opener when it closes.',
          evidenceIds: [ev],
          reproductionSteps: [...steps, 'Press Enter to open the dialog.', 'Use Tab, then close the dialog with its close button.'],
          remediation: p.remediation,
          targetKey: `${cand.targetDescription}|${p.what}`,
          stateKey: '',
        }),
      ),
    };
  }
}

function first(info: FocusInfo, seq: FocusInfo[]): void {
  seq.push(info);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
