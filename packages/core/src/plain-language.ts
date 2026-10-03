import type { Finding } from '@cqa/shared';

/** What the reader should do with a finding. */
export type IssueAction = 'fix' | 'check' | 'not_checked';

export const ACTION_LABEL: Record<IssueAction, string> = {
  fix: 'Fix',
  check: 'Check by hand',
  not_checked: 'Not checked',
};

interface PlainText {
  issue: string;
  change: string;
}

/** Plain wording for axe-core rules. Anything not listed falls back to axe's own description. */
const AXE: Record<string, PlainText> = {
  'image-alt': { issue: 'An image has no alternative text', change: 'Add alt text that describes the image. If it is purely decorative, set alt="" instead.' },
  'button-name': { issue: 'A button has no readable name', change: 'Give the button a text label, or an aria-label if it only shows an icon.' },
  'link-name': { issue: 'A link has no readable text', change: 'Add link text, or an aria-label if the link only shows an icon.' },
  label: { issue: 'A form field has no label', change: 'Add a visible label and connect it to the field.' },
  'color-contrast': { issue: 'Text is hard to read (low contrast)', change: 'Darken the text or lighten the background until contrast is at least 4.5 to 1 (3 to 1 for large text).' },
  'html-has-lang': { issue: 'The page does not say what language it is in', change: 'Add lang="en" (or the correct language code) to the html element.' },
  'html-lang-valid': { issue: 'The page language code is not valid', change: 'Use a valid language code such as "en" or "en-GB" on the html element.' },
  'document-title': { issue: 'The page has no title', change: 'Add a short title that names the page.' },
  'heading-order': { issue: 'Headings skip a level', change: 'Use heading levels in order (h1, then h2, then h3) without jumping.' },
  'page-has-heading-one': { issue: 'The page has no main heading', change: 'Add one h1 that names the page.' },
  'landmark-one-main': { issue: 'The page has no main content area', change: 'Wrap the main content in a main element.' },
  region: { issue: 'Some content sits outside the page structure', change: 'Place content inside landmarks such as main, nav, header, or footer.' },
  'scrollable-region-focusable': { issue: 'A scrolling area cannot be reached with the keyboard', change: 'Make the area focusable (tabindex="0") or make something inside it focusable.' },
  'target-size': { issue: 'Click or tap targets are very small', change: 'Make targets at least 24 by 24 px, or leave enough space around them.' },
  'meta-viewport': { issue: 'The page blocks pinch-zoom', change: 'Remove user-scalable=no and maximum-scale from the viewport meta tag.' },
  'aria-valid-attr-value': { issue: 'An accessibility attribute has an invalid value', change: 'Fix the aria-* value (for example, point aria-controls at an element that exists).' },
  'aria-allowed-role': { issue: 'An accessibility role does not fit its element', change: 'Remove the role or use an element that matches it (for example a real button).' },
  'aria-hidden-focus': { issue: 'Hidden content can still be tabbed to', change: 'Remove focusable items from hidden areas, or stop hiding them.' },
  'frame-tested': { issue: 'A frame could not be checked automatically', change: 'Check the frame content by hand.' },
  'frame-title': { issue: 'A frame has no title', change: 'Add a title attribute that describes what the frame contains.' },
  'duplicate-id': { issue: 'Two elements share the same ID', change: 'Give each element a unique id.' },
  tabindex: { issue: 'A tabindex above 0 changes the tab order', change: 'Use tabindex="0" or "-1" only, and fix the order in the page structure.' },
  bypass: { issue: 'There is no way to skip repeated content', change: 'Add a "Skip to content" link or proper landmarks.' },
  'empty-heading': { issue: 'A heading has no text', change: 'Add text to the heading or remove it.' },
  'video-caption': { issue: 'A video has no captions', change: 'Add a captions track, or confirm captions are part of the player.' },
  'select-name': { issue: 'A dropdown has no label', change: 'Add a visible label and connect it to the dropdown.' },
  'aria-required-children': { issue: 'An accessibility structure is incomplete', change: 'Add the child elements this role requires, or remove the role.' },
  'nested-interactive': { issue: 'A control sits inside another control', change: 'Do not place buttons or links inside other interactive elements.' },
};

/** Plain wording for the scanner's own rules. `{title}` keeps the finding's specific title. */
const OWN: Record<string, PlainText & { keepTitle?: boolean }> = {
  'RUN-001': { issue: '', keepTitle: true, change: 'Check the course address is published and reachable, then publish it again.' },
  'RUN-002': { issue: 'A script error happens on this screen', change: 'Ask a developer to fix the script error (see Technical details). It can break interactions.' },
  'RUN-003': { issue: 'The browser reported an error', change: 'Check whether it affects the course and fix it if it does.' },
  'RUN-004': { issue: '', keepTitle: true, change: 'Restore the missing file or remove the reference to it.' },
  'RUN-005': { issue: 'The page has no title', change: 'Add a short title that names the page.' },
  'NET-002': { issue: 'Something the page asked for was blocked for safety', change: 'Check by hand if the course needs it. It must be publicly reachable to be scanned.' },
  'NET-003': { issue: 'The course sent the scanner to a different website', change: 'Confirm the redirect is intended. Add the destination to the scan scope if it should be checked.' },
  'NAV-001': { issue: '', keepTitle: true, change: 'Fix the control so it shows its content when clicked and reports its open or selected state.' },
  'NAV-002': { issue: '', keepTitle: true, change: 'Check whether this control should do something at this point. If it should, fix it; if not, no action is needed.' },
  'NAV-003': { issue: 'A dialog could not be closed with its close button', change: 'Make the close button hide the dialog and return focus to the control that opened it.' },
  'COV-001': { issue: '', keepTitle: true, change: 'Test these controls by hand. The scanner did not click them.' },
  'COV-002': { issue: 'An embedded frame was not checked', change: 'Review the frame content by hand.' },
  'COV-003': { issue: 'Canvas content could not be checked', change: 'Review this content by hand. Text and images drawn on a canvas are invisible to automated checks.' },
  'COV-004': { issue: 'The scan stopped before reaching every screen', change: 'Raise the screen or depth limit and scan again, or scan sections separately.' },
  'LNK-001': { issue: '', keepTitle: true, change: 'Update the link to the right address, or remove it.' },
  'LNK-002': { issue: '', keepTitle: true, change: 'Confirm learners can open this with their own access.' },
  'LNK-003': { issue: '', keepTitle: true, change: 'Open the link by hand to confirm it works.' },
  'LNK-005': { issue: '', keepTitle: true, change: 'Use a real web address, or a button for in-page actions.' },
  'MED-001': { issue: '', keepTitle: true, change: 'Restore the image file or fix its path.' },
  'MED-002': { issue: '', keepTitle: true, change: 'Restore the media file, fix its path, or use a supported format.' },
  'MED-003': { issue: '', keepTitle: true, change: 'Add captions, or confirm they are burned in or provided by the player.' },
  'MED-004': { issue: '', keepTitle: true, change: 'Check that learners can pause and control this media. A custom player may already provide this.' },
  'MED-005': { issue: '', keepTitle: true, change: 'Compress or resize the file unless its size is needed.' },
  'TXT-001': { issue: '', keepTitle: true, change: 'Replace or remove this text before release.' },
  'TXT-002': { issue: '', keepTitle: true, change: 'Use the preferred wording if the context allows.' },
  'A11Y-008': { issue: 'Content needs sideways scrolling on a narrow screen', change: 'Make the layout fit a 320 px wide screen, or confirm the wide content is exempt (for example a data table).' },
  'KBD-001': { issue: 'Keyboard users get stuck here', change: 'Let the Tab key move past this component, or provide a key (such as Escape) that releases focus.' },
  'KBD-002': { issue: 'The keyboard focus is hard to see', change: 'Add a clear, visible outline for elements that have keyboard focus.' },
  'KBD-003': { issue: '', keepTitle: true, change: 'Move focus into the dialog when it opens, keep it inside while open, and return it to the opener on close.' },
  'KBD-004': { issue: '', keepTitle: true, change: 'Use a real button or link, or make it focusable and respond to Enter and Space.' },
};

/** Which group a finding belongs to. */
export function actionFor(f: Pick<Finding, 'ruleId' | 'type' | 'category'>): IssueAction {
  if (f.category === 'coverage' || f.ruleId === 'NET-002' || f.ruleId === 'NET-003') return 'not_checked';
  if (f.type === 'automated_defect' || f.type === 'standards_warning') return 'fix';
  return 'check';
}

function firstSentence(s: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(s.trim());
  return m ? m[1]! : s.trim();
}

/** "(3 elements)" suffix that axe titles carry, if present. */
function elementCount(title: string): number | undefined {
  const m = /\((\d+) elements?\)/.exec(title);
  return m ? Number(m[1]) : undefined;
}

export interface PlainFinding {
  issue: string;
  change: string;
  action: IssueAction;
}

/** Everyday wording for a finding. Technical details stay on the finding itself. */
export function plainFinding(f: Finding): PlainFinding {
  const action = actionFor(f);
  if (f.ruleId.startsWith('A11Y-AXE-')) {
    const axeId = f.ruleId.slice('A11Y-AXE-'.length);
    const p = AXE[axeId];
    const n = elementCount(f.title);
    const prefix = action === 'check' && f.type === 'manual_review' ? 'Check by hand: ' : '';
    if (p) return { action, issue: `${prefix}${p.issue}${n && n > 1 ? ` (${n} places)` : ''}`, change: p.change };
    const cleaned = f.title.replace(/^Needs review:\s*/, '');
    return { action, issue: `${prefix}${cleaned}`, change: firstSentence(f.remediation.replace(/^[^.]*\.\s*Guidance:.*$/, '')) || f.remediation };
  }
  const own = OWN[f.ruleId];
  if (own) {
    let issue = own.keepTitle ? f.title : own.issue;
    // The "Inconsistent:" marker from the traversal engine must survive.
    if (f.title.startsWith('Inconsistent:') && !issue.startsWith('Inconsistent:')) issue = `Inconsistent: ${issue}`;
    return { action, issue, change: own.change };
  }
  return { action, issue: f.title, change: firstSentence(f.remediation) };
}
