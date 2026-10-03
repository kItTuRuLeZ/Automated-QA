import type { Page } from 'playwright';
import type { CourseAdapter, PostconditionCheck, ProviderContext, ReasonCode, StateId, TraversalAction, TraversalActionKind } from '@cqa/shared';
import { sanitizeUrl } from '@cqa/core';
import { type RawControl, discoverControls, snapshotState } from './dom-scripts.js';

export type CandidateAction = Omit<TraversalAction, 'id' | 'runId' | 'outcome'>;

const MAX_AMBIGUOUS_PER_STATE = 40;

const KIND: Partial<Record<RawControl['category'], TraversalActionKind>> = {
  tab: 'select_tab',
  accordion: 'expand',
  details: 'expand',
  dialog_open: 'open_dialog',
  dialog_close: 'close_dialog',
  next: 'next',
  back: 'back',
  link: 'navigate',
};

/**
 * Generic HTML adapter: recognizes ARIA tabs, disclosure buttons, <details>,
 * dialog openers/closers, Next/Back controls, and in-scope links. It declares
 * what each action should observably do; the traversal engine checks it.
 * Unrecognized controls are reported as skipped, never clicked blindly.
 */
export class GenericHtmlAdapter implements CourseAdapter {
  readonly id = 'generic-html';
  readonly version = '1.0.0';
  readonly platform = 'generic_html' as const;
  readonly supportedScenarios = [
    'ARIA tabs (role=tab with aria-selected / aria-controls)',
    'Disclosure buttons (aria-expanded + aria-controls) and <details>',
    'Dialog openers (aria-haspopup=dialog or aria-controls to a dialog) and close buttons inside dialogs',
    'Next/Continue and Back/Previous controls',
    'In-scope links, including hash-routed SPA lessons',
  ];

  async detect(): Promise<number> {
    return 0.1; // Fallback adapter: applies to any HTML page with low specificity.
  }

  async signature(ctx: ProviderContext): Promise<string> {
    return JSON.stringify(await (ctx.page as Page).evaluate(snapshotState));
  }

  async discoverActions(ctx: ProviderContext): Promise<CandidateAction[]> {
    const page = ctx.page as Page;
    const fromStateId = ctx.state!.id as StateId;
    const policy = ctx.config.actionPolicy;
    const raw = await page.evaluate(discoverControls, {
      allowedOrigins: ctx.config.scope.allowedOrigins,
      allowedPathPrefixes: ctx.config.scope.allowedPathPrefixes,
      deniedPatterns: policy.deniedNamePatterns,
      maxAmbiguous: MAX_AMBIGUOUS_PER_STATE,
    });
    return raw.map((c) => this.toCandidate(c, fromStateId, ctx));
  }

  private toCandidate(c: RawControl, fromStateId: StateId, ctx: ProviderContext): CandidateAction {
    const base = { fromStateId, locator: c.locator, adapter: this.id, targetDescription: describe(c) };
    const skip = (reason: ReasonCode, reasonDetail: string): CandidateAction => ({ ...base, kind: 'click', reason, reasonDetail });

    if (c.category === 'unsafe') return skip('unsafe_action', c.detail ?? 'Matches the unsafe-action policy.');
    if (c.category === 'ambiguous') return skip('ambiguous_action', 'No recognized pattern defines what this control should do, so it was not clicked.');
    if (c.category === 'out_of_scope_link') return { ...base, kind: 'navigate', href: sanitizeUrl(c.href!, ctx.config.redaction), reason: 'out_of_scope', reasonDetail: 'Link destination is outside the scan scope.' };

    const kind = KIND[c.category]!;
    if (!ctx.config.actionPolicy.allowedKinds.includes(kind)) return skip('unsafe_action', `Action kind ${kind} is not allowed by the scan policy.`);

    const post: PostconditionCheck[] = [];
    let expected = '';
    switch (c.category) {
      case 'tab':
        post.push({ type: 'attribute_equals', locator: c.locator, attribute: 'aria-selected', value: 'true' });
        if (c.controlsLocator) post.push({ type: 'visible', locator: c.controlsLocator });
        expected = 'The tab becomes selected and its panel is shown.';
        break;
      case 'accordion':
        post.push({ type: 'attribute_equals', locator: c.locator, attribute: 'aria-expanded', value: 'true' });
        if (c.controlsLocator) post.push({ type: 'visible', locator: c.controlsLocator });
        expected = 'The section expands and its content is shown.';
        break;
      case 'details':
        post.push({ type: 'property_true', locator: c.controlsLocator!, property: 'open' });
        expected = 'The details element opens.';
        break;
      case 'dialog_open':
        post.push(c.controlsLocator ? { type: 'visible', locator: c.controlsLocator } : { type: 'dialog_count_increases' });
        expected = 'A dialog opens.';
        break;
      case 'dialog_close':
        post.push({ type: 'hidden', locator: c.dialogLocator! });
        expected = 'The dialog closes.';
        break;
      case 'next':
      case 'back':
        post.push({ type: 'signature_changes' });
        expected = c.category === 'next' ? 'The course advances to different content.' : 'The course returns to different content.';
        break;
      case 'link':
        post.push({ type: 'url_changes' });
        expected = 'The browser navigates to the link destination.';
        break;
    }
    const action: CandidateAction = { ...base, kind, postconditions: post, expectedPostcondition: expected };
    if (c.href) action.href = sanitizeUrl(c.href, ctx.config.redaction);
    if (c.category === 'link') (action as CandidateAction & { rawHref?: string }).rawHref = c.href;
    return action;
  }
}

function describe(c: RawControl): string {
  const label = c.name ? `"${c.name.slice(0, 80)}"` : '(unnamed)';
  switch (c.category) {
    case 'tab':
      return `tab ${label}`;
    case 'accordion':
    case 'details':
      return `expandable section ${label}`;
    case 'dialog_open':
      return `dialog opener ${label}`;
    case 'dialog_close':
      return `dialog close control ${label}`;
    case 'next':
    case 'back':
      return `${c.category === 'next' ? 'Next' : 'Back'} control ${label}`;
    case 'link':
    case 'out_of_scope_link':
      return `link ${label}`;
    default:
      return `${c.role} ${label}`;
  }
}
