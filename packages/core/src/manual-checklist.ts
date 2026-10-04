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

/**
 * What only the target LMS can show. The test harness is not an LMS, so none
 * of these are answered by a scan; they are listed with every SCORM scan.
 */
export const SCORM_LMS_CHECKLIST: readonly ManualReviewItem[] = [
  { id: 'LMS-001', title: 'Completion is recorded in the LMS', howToCheck: 'Take the course to the end in your LMS and confirm the learner record shows completed (and passed or failed if the course is scored).', whyManual: 'The harness records what the course sends; only your LMS decides what it stores and shows.' },
  { id: 'LMS-002', title: 'Resume returns to the right place', howToCheck: 'Leave the course part-way, reopen it from the LMS, and confirm it returns to the same screen with progress intact.', whyManual: 'Whether your LMS hands back the bookmark, and whether the course lands on the right screen, depends on the LMS and the course together.' },
  { id: 'LMS-003', title: 'Attempts and retakes behave as intended', howToCheck: 'Finish the course, then reopen it. Confirm a new attempt starts (or does not) the way your LMS settings say, and scores are kept or replaced as intended.', whyManual: 'Attempt handling is LMS configuration the harness does not model.' },
  { id: 'LMS-004', title: 'Score and pass mark', howToCheck: 'Complete a passing and a failing attempt. Confirm the LMS shows the right score and applies the pass mark you expect.', whyManual: 'The harness does not compute pass or fail from a mastery score; your LMS may.' },
  { id: 'LMS-005', title: 'Certificates and other triggers', howToCheck: 'Confirm certificates, notifications, or learning-path unlocks fire when the learner completes or passes.', whyManual: 'These are LMS features outside the course package.' },
  { id: 'LMS-006', title: 'Browser, window, and exit behaviour in your LMS', howToCheck: 'Launch from the LMS in the browsers your learners use. Close the window and use the course Exit button, and confirm progress is kept both ways.', whyManual: 'Pop-up, frame, and unload behaviour differ between LMSes and browsers.' },
];
