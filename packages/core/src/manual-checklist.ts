/**
 * Manual review tasks. Automated checks cannot establish these, so they are
 * listed with every scan and are never counted as passed or tested.
 * Ids match docs/QA_RULE_CATALOG.md (MAN-xxx).
 */
export interface ManualReviewItem {
  id: string;
  title: string;
  howToCheck: string;
  /** Why the scanner cannot decide this. */
  whyManual: string;
  standards?: string[];
}

export const MANUAL_REVIEW_CHECKLIST: readonly ManualReviewItem[] = [
  {
    id: 'MAN-001',
    title: 'Focus order is logical',
    howToCheck: 'Tab through each screen. Focus should move in an order that matches the visual and reading order, including into and out of dialogs and tab panels.',
    whyManual: 'The scanner records the focus sequence but cannot judge whether that order makes sense to a person.',
    standards: ['WCAG 2.4.3 (relevant)'],
  },
  {
    id: 'MAN-002',
    title: 'Screen reader experience',
    howToCheck: 'Walk through key interactions with a screen reader (for example NVDA with Firefox or Chrome): headings, links, form fields, dialogs, quiz feedback, and dynamic updates.',
    whyManual: 'Automated rules check markup, not how it is announced or whether the experience is usable.',
  },
  {
    id: 'MAN-003',
    title: 'Alternative text is adequate',
    howToCheck: 'For every informative image, confirm the alt text conveys the same information. Confirm decorative images use alt="".',
    whyManual: 'The scanner can see whether alt text exists, not whether it is meaningful. An empty alt is correct for decorative images.',
    standards: ['WCAG 1.1.1 (relevant)'],
  },
  {
    id: 'MAN-004',
    title: 'Captions, transcripts, and audio descriptions are accurate',
    howToCheck: 'Play each video and audio file with captions or transcripts on. Check accuracy, speaker identification, sound cues, and whether visual-only information is described.',
    whyManual: 'The scanner can detect a caption track, not whether it is correct or complete.',
    standards: ['WCAG 1.2.x (relevant)'],
  },
  {
    id: 'MAN-006',
    title: 'Canvas-rendered, framed, and unreached content',
    howToCheck: 'Review everything listed under Coverage as not inspected: canvas areas, cross-origin or sandboxed frames, skipped controls, and screens beyond the scan budget.',
    whyManual: 'DOM-based checks cannot see inside canvas or inaccessible frames, and unreached screens were not tested.',
  },
  {
    id: 'MAN-007',
    title: 'Color contrast on images, gradients, and video',
    howToCheck: 'Check text placed over images, gradients, or video, and non-text elements such as icons and focus indicators, using a contrast tool.',
    whyManual: 'axe-core reports such cases as "needs review" because it cannot determine the background color.',
    standards: ['WCAG 1.4.3, 1.4.11 (relevant)'],
  },
  {
    id: 'MAN-009',
    title: 'Zoom, text spacing, and orientation',
    howToCheck: 'Zoom the browser to 200% and 400%, apply text-spacing overrides, and rotate a mobile device. Confirm nothing is cut off or lost.',
    whyManual: 'The scanner simulates a 320 CSS px viewport only; it does not zoom or change text spacing.',
    standards: ['WCAG 1.4.4, 1.4.10, 1.4.12, 1.3.4 (relevant)'],
  },
  {
    id: 'MAN-010',
    title: 'Time limits, motion, and flashing',
    howToCheck: 'Check for timed activities, auto-advancing content, animations, and anything that flashes. Confirm learners can pause, stop, or extend them.',
    whyManual: 'These depend on behavior over time that the scanner does not measure.',
    standards: ['WCAG 2.2.x, 2.3.1, 1.4.2 (relevant)'],
  },
];

/** Statement shown wherever accessibility results appear. */
export const ACCESSIBILITY_DISCLAIMER =
  'Automated checks find a subset of accessibility problems. A clean automated result does not mean the course is accessible or compliant with WCAG or any other standard. The manual review list below always applies.';
