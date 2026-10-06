import type { AutomationClass, InteractionType, ReviewState, TestAction, TestAssertion, TestDefinition, TestDefinitionBody } from '@cqa/shared';
import { AUTOMATION_CLASSES, EXPECTATION_SOURCES, INTERACTION_TYPES, REVIEW_STATES } from '@cqa/shared';
import { z } from 'zod';
import type { QaStore } from '../db/qa-store.js';
import { nowIso } from '../fingerprint.js';

/**
 * The starter functional test library. Every row of the baseline matrix is a full definition: preconditions,
 * ordered actions, an expected result with its source, evidence needs, an automation class and the adapter capability
 * it needs. The automation class says what this tool really implements today; nothing here claims more.
 *
 * Starter cases are baseline expectations, not client requirements. They stay in the "starter" review state until a
 * person reviews them. Where course behaviour legitimately varies, the case says it needs a configured expectation.
 */

export const ENGINE_CAPABILITIES = [
  'launch', // the launch target opens and renders
  'next_previous', // Next and Previous change the content and return
  'accordion_open', // every accordion item opens and shows content
  'accordion_policy', // observed single-open or multi-open behaviour (needs a declared policy to judge)
  'tabs', // every tab selects its panel
  'dialog_open', // dialogs and layers open
  'dialog_dismiss', // dialogs dismiss and focus returns
  'rule_all_click', // behavior rule: event fires after the final required item
  'rule_premature', // behavior rule: event absent while one item is untouched
  'rule_duplicate', // behavior rule: repeated clicks do not count as new items
  'rule_order', // behavior rule: order independence
  'rule_sequence', // behavior rule: only declared sequences fire
  'mapped', // judged by an existing engine's recorded checks (see qa/mapping.ts)
] as const;
export type EngineCapability = (typeof ENGINE_CAPABILITIES)[number];

interface Row {
  id: string;
  area: string;
  category: string;
  type: InteractionType | 'general';
  title: string;
  action: string;
  expected: string;
  automation: AutomationClass;
  capability?: EngineCapability;
  severity?: TestDefinition['severity'];
  /** Extra plain-language note on why the case is not (fully) automated. */
  note?: string;
}

const ROWS: Row[] = [
  { id: 'NAV-01', area: 'Launch', category: 'Navigation', type: 'general', title: 'Launch target opens and renders', action: 'Open the detected launch target', expected: 'Initial content renders within the configured threshold', automation: 'automated', capability: 'launch', severity: 'high' },
  { id: 'NAV-02', area: 'Next/Previous', category: 'Navigation', type: 'next', title: 'Next and Previous move between adjacent units', action: 'Navigate both directions', expected: 'Intended adjacent units load without losing required state', automation: 'partially_automated', capability: 'next_previous', severity: 'high', note: 'Automation proves the content changes and returns; whether it is the intended adjacent unit needs the course map.' },
  { id: 'NAV-03', area: 'Menu', category: 'Navigation', type: 'menu', title: 'Menu entries open their destinations', action: 'Open each supported menu entry', expected: 'The expected destination loads', automation: 'manual', note: 'No menu adapter yet.' },
  { id: 'NAV-04', area: 'Restricted navigation', category: 'Navigation', type: 'next', title: 'Gating changes at the intended point', action: 'Attempt Next before prerequisites, then complete prerequisites', expected: 'Gating changes at the intended point', automation: 'manual', note: 'Needs the course\'s gating rules. Use a behavior rule for the supported "Next enabled" case.' },
  { id: 'NAV-05', area: 'Branching', category: 'Navigation', type: 'general', title: 'Branches reach their declared destinations', action: 'Follow configured choices', expected: 'Each reaches its declared destination', automation: 'manual', note: 'Needs the declared branch map.' },
  { id: 'NAV-06', area: 'Return path', category: 'Navigation', type: 'general', title: 'Returning from a branch restores parent and state', action: 'Return from a branch', expected: 'The expected parent and state are restored', automation: 'manual' },
  { id: 'NAV-07', area: 'Dead end', category: 'Navigation', type: 'general', title: 'Terminal paths have a completion or return action', action: 'Exercise known terminal paths', expected: 'An intentional completion or return action exists according to expectations', automation: 'manual' },
  { id: 'NAV-08', area: 'Restart', category: 'Navigation', type: 'general', title: 'Restart follows the declared reset policy', action: 'Restart with declared reset policy', expected: 'Progress and interaction states match that policy', automation: 'manual', note: 'Restart controls are treated as unsafe to click during read-only exploration.' },
  { id: 'ACC-01', area: 'Accordion', category: 'Accordions', type: 'accordion', title: 'Every accordion item opens and shows readable content', action: 'Open every item', expected: 'Associated content becomes visible and readable', automation: 'automated', capability: 'accordion_open' },
  { id: 'ACC-02', area: 'Accordion state', category: 'Accordions', type: 'accordion', title: 'Single-open or multi-open behavior matches configuration', action: 'Open/close items', expected: 'Single-open or multi-open behavior matches configuration', automation: 'partially_automated', capability: 'accordion_policy', note: 'Automation records which behavior it observed. Whether that is intended needs a declared policy.' },
  { id: 'ACC-03', area: 'Accordion completion', category: 'Accordions', type: 'accordion', title: 'Completion changes only when the rule is satisfied', action: 'Open required items once', expected: 'Completion/gating changes only when the rule is satisfied', automation: 'manual', note: 'Configure a behavior rule to test this automatically.' },
  { id: 'TAB-01', area: 'Tabs', category: 'Tabs', type: 'tab', title: 'Each tab shows its own panel', action: 'Activate each tab', expected: 'Correct panel becomes active and prior panel behaves as designed', automation: 'automated', capability: 'tabs' },
  { id: 'TAB-02', area: 'Tabs visited state', category: 'Tabs', type: 'tab', title: 'Visited indicators and persistence', action: 'Visit tabs', expected: 'Configured visited indicators and persistence behave correctly', automation: 'manual' },
  { id: 'HOT-01', area: 'Hotspots', category: 'Hotspots', type: 'hotspot', title: 'Hotspots open their content', action: 'Activate each identified hotspot', expected: 'Associated content or layer opens', automation: 'manual', note: 'Hotspots are usually canvas or custom shapes with no reliable accessible role.' },
  { id: 'HOT-02', area: 'Hotspot return', category: 'Hotspots', type: 'hotspot', title: 'Base screen stays usable after hotspot content', action: 'Close/return from hotspot content', expected: 'Base screen remains usable', automation: 'manual' },
  { id: 'CLK-01', area: 'Click-to-reveal', category: 'Click to reveal', type: 'click_reveal', title: 'Every reveal shows its content', action: 'Activate every reveal', expected: 'Expected content becomes visible', automation: 'manual', note: 'No generic way to recognize a click-to-reveal control.' },
  { id: 'CLK-02', area: 'Repeated activation', category: 'Click to reveal', type: 'click_reveal', title: 'Repeated clicks do not duplicate state', action: 'Click an item repeatedly', expected: 'No duplicated counter, event, overlay, or broken state', automation: 'manual', note: 'Covered automatically for configured behavior rules (LOG-03).' },
  { id: 'LAY-01', area: 'Layers/dialogs', category: 'Layers and dialogs', type: 'dialog', title: 'Dialog or layer opens with its content', action: 'Open configured layer/dialog', expected: 'Expected content is present', automation: 'automated', capability: 'dialog_open' },
  { id: 'LAY-02', area: 'Layer dismissal', category: 'Layers and dialogs', type: 'dialog', title: 'Dismissal returns focus and state', action: 'Dismiss through supported controls', expected: 'Focus/navigation/state return appropriately', automation: 'automated', capability: 'dialog_dismiss' },
  { id: 'LAY-03', area: 'Layer sequencing', category: 'Layers and dialogs', type: 'dialog', title: 'Stacking and dismissal of several layers', action: 'Open multiple configured layers', expected: 'Stacking and dismissal match the intended behavior', automation: 'manual' },
  { id: 'LOG-01', area: 'All-click completion', category: 'Interaction logic', type: 'required_item_group', title: 'Event fires after the final required item', action: 'Complete all unique required items', expected: 'The configured event fires after the final requirement', automation: 'automated', capability: 'rule_all_click', severity: 'high' },
  { id: 'LOG-02', area: 'Premature event', category: 'Interaction logic', type: 'required_item_group', title: 'Event does not fire while one item is untouched', action: 'Leave one required item untouched', expected: 'The event does not fire', automation: 'automated', capability: 'rule_premature', severity: 'high' },
  { id: 'LOG-03', area: 'Duplicate-count protection', category: 'Interaction logic', type: 'required_item_group', title: 'Repeated clicks on one item do not complete the group', action: 'Repeatedly click one item while others remain untouched', expected: 'Completion does not falsely trigger', automation: 'automated', capability: 'rule_duplicate', severity: 'high' },
  { id: 'LOG-04', area: 'Order independence', category: 'Interaction logic', type: 'required_item_group', title: 'Representative click orders behave the same', action: 'Test representative click orders', expected: 'Behavior is consistent when the rule is order-independent', automation: 'automated', capability: 'rule_order', severity: 'high', note: 'Tests listed, reverse and shuffled orders. It does not claim to try every possible order.' },
  { id: 'LOG-05', area: 'Sequence dependency', category: 'Interaction logic', type: 'required_item_group', title: 'Only declared sequences trigger the event', action: 'Test valid and invalid sequences', expected: 'Only declared valid sequences trigger the event', automation: 'automated', capability: 'rule_sequence', severity: 'high' },
  { id: 'LOG-06', area: 'Partial state', category: 'Interaction logic', type: 'required_item_group', title: 'State after leaving and returning', action: 'Leave/return or reload after some actions', expected: 'State matches the declared persistence policy', automation: 'manual', note: 'Needs a declared persistence policy.' },
  { id: 'LOG-07', area: 'Event frequency', category: 'Interaction logic', type: 'required_item_group', title: 'Event frequency matches once or repeat policy', action: 'Complete requirements then repeat actions', expected: 'Event frequency matches the declared once/repeat policy', automation: 'manual', note: 'Needs a declared policy and an observable event counter.' },
  { id: 'LOG-08', area: 'Reset logic', category: 'Interaction logic', type: 'required_item_group', title: 'Reset clears counters, visited states and outcomes', action: 'Reset and repeat', expected: 'Required counters, visited states, and outcomes reset correctly', automation: 'manual' },
  { id: 'LOG-09', area: 'Combined conditions', category: 'Interaction logic', type: 'required_item_group', title: 'Event waits until every condition is met', action: 'Satisfy clicks but not required media/time/answer condition', expected: 'Event waits until all conditions are met', automation: 'manual' },
  { id: 'LOG-10', area: 'Conditional variables', category: 'Interaction logic', type: 'general', title: 'Visible outcomes match the declared variable rules', action: 'Exercise configured input/state combinations', expected: 'Visible outcomes match the declared rules', automation: 'manual', note: 'Variables are not readable in published output without a supported observation mechanism.' },
  { id: 'MCQ-01', area: 'Single choice', category: 'Multiple choice', type: 'mcq', title: 'Only one option stays selected', action: 'Select options', expected: 'Only one is selected where required', automation: 'manual' },
  { id: 'MCQ-02', area: 'No-answer submission', category: 'Multiple choice', type: 'mcq', title: 'Submitting without an answer is handled', action: 'Submit without selecting', expected: 'Configured validation appears and scoring is not incorrectly changed', automation: 'manual', note: 'Submit controls are treated as unsafe to click during read-only exploration.' },
  { id: 'MCQ-03', area: 'Correct response', category: 'Multiple choice', type: 'mcq', title: 'Correct answer gives the right feedback and score', action: 'Submit the configured correct answer', expected: 'Feedback and score match expectations', automation: 'manual', severity: 'high' },
  { id: 'MCQ-04', area: 'Incorrect response', category: 'Multiple choice', type: 'mcq', title: 'Incorrect answer gives the right feedback and score', action: 'Submit a configured incorrect answer', expected: 'Feedback and score match expectations', automation: 'manual', severity: 'high' },
  { id: 'MSQ-01', area: 'Multiple select', category: 'Multiple select', type: 'msq', title: 'Selected set is tracked correctly', action: 'Select/deselect combinations', expected: 'Selected set is tracked correctly', automation: 'manual' },
  { id: 'MSQ-02', area: 'Combination scoring', category: 'Multiple select', type: 'msq', title: 'Scoring follows the declared rule', action: 'Test complete, partial, and incorrect sets', expected: 'Scoring follows the declared rule', automation: 'manual', severity: 'high' },
  { id: 'QUIZ-01', area: 'Retry', category: 'Assessment', type: 'mcq', title: 'Retry follows the attempt policy', action: 'Use allowed attempts', expected: 'Retry availability and state match the attempt policy', automation: 'manual' },
  { id: 'QUIZ-02', area: 'Feedback controls', category: 'Assessment', type: 'mcq', title: 'Feedback opens and dismisses; navigation stays usable', action: 'Open/dismiss feedback', expected: 'Navigation and focus remain usable', automation: 'manual' },
  { id: 'QUIZ-03', area: 'Results', category: 'Assessment', type: 'mcq', title: 'Results match the scoring model', action: 'Execute a known answer set', expected: 'Displayed totals and pass/fail match the configured scoring model', automation: 'manual', severity: 'high' },
  { id: 'QUIZ-04', area: 'Retake', category: 'Assessment', type: 'mcq', title: 'Retake respects the reset policy', action: 'Retake assessment', expected: 'Declared question/score/progress reset policy is respected', automation: 'manual' },
  { id: 'QUIZ-05', area: 'Randomization', category: 'Assessment', type: 'mcq', title: 'Question pool and selection are as allowed', action: 'With a controllable seed where available, verify pool/selection behavior', expected: 'Allowed pool/selection behavior; otherwise flag bounded observation', automation: 'manual' },
  { id: 'DND-01', area: 'Correct drop', category: 'Drag and drop', type: 'dnd', title: 'Correct drop gives the right state and feedback', action: 'Drag a configured item to a correct target', expected: 'State/feedback match expectations', automation: 'manual', note: 'Drag targets are not reliably recognizable in published output.' },
  { id: 'DND-02', area: 'Incorrect drop', category: 'Drag and drop', type: 'dnd', title: 'Incorrect drop is handled per the rule', action: 'Drop on an incorrect target', expected: 'Acceptance/rejection/feedback follows the rule', automation: 'manual' },
  { id: 'DND-03', area: 'Outside target', category: 'Drag and drop', type: 'dnd', title: 'Dropping outside targets behaves as declared', action: 'Drop outside valid targets', expected: 'Item returns or remains according to the declared behavior', automation: 'manual' },
  { id: 'DND-04', area: 'Target constraints', category: 'Drag and drop', type: 'dnd', title: 'Target capacity and repeated drops', action: 'Test repeated drops and target capacity', expected: 'No unintended duplicate assignment occurs', automation: 'manual' },
  { id: 'DND-05', area: 'Reset/submit', category: 'Drag and drop', type: 'dnd', title: 'Reset and submit give the right result', action: 'Reset and submit known arrangements', expected: 'State, feedback, and completion are correct', automation: 'manual' },
  { id: 'TXT-01', area: 'Text/numeric input', category: 'Text input', type: 'text_input', title: 'Input validation for valid, invalid, blank and boundary values', action: 'Submit valid, invalid, blank, and boundary values', expected: 'Configured validation is correct', automation: 'manual', note: 'Typing into fields and submitting is treated as unsafe during read-only exploration.' },
  { id: 'SLD-01', area: 'Slider/dial', category: 'Sliders', type: 'slider', title: 'Minimum, maximum and thresholds update dependent content', action: 'Exercise minimum, maximum, and configured thresholds', expected: 'Dependent content updates correctly', automation: 'manual' },
  { id: 'FLP-01', area: 'Flip cards', category: 'Flip cards', type: 'flip_card', title: 'Every card flips and returns', action: 'Flip each card and return', expected: 'Expected content and completion state are correct', automation: 'manual' },
  { id: 'TIM-01', area: 'Timeline/carousel', category: 'Timelines and carousels', type: 'timeline', title: 'Every item is reachable; end conditions hold', action: 'Visit each item', expected: 'Forward/back controls and end conditions follow configuration', automation: 'manual' },
  { id: 'AUD-01', area: 'Audio', category: 'Audio', type: 'audio', title: 'Audio starts, pauses and resumes', action: 'Start/pause/resume', expected: 'Observed media state changes correctly', automation: 'manual', note: 'Autoplay and audio output cannot be observed reliably in a headless browser.' },
  { id: 'VID-01', area: 'Video', category: 'Video', type: 'video', title: 'Video starts, pauses and seeks', action: 'Start/pause/seek where allowed', expected: 'Observed media state and controls work', automation: 'manual' },
  { id: 'MED-01', area: 'Media completion', category: 'Media', type: 'video', title: 'Media completion fires the declared event', action: 'Observe media end', expected: 'Declared completion/gating event occurs at the intended time', automation: 'manual' },
  { id: 'MED-02', area: 'Captions/transcript', category: 'Media', type: 'video', title: 'Captions or transcript are available', action: 'Enable available captions/transcript', expected: 'Content displays; semantic accuracy remains a manual check', automation: 'partially_automated', capability: 'mapped', note: 'Automation checks that a caption track exists. Accuracy is always manual.' },
  { id: 'MED-03', area: 'Playback failure', category: 'Media', type: 'video', title: 'A failed media load is detectable', action: 'Simulate a controlled failed media load', expected: 'Failure is detectable and the course recovery behavior is reviewed', automation: 'partially_automated', capability: 'mapped', note: 'Automation reports media that failed to load. Simulated failures are not injected.' },
  { id: 'LNK-01', area: 'Links', category: 'Links', type: 'link', title: 'Links reach their targets', action: 'Activate supported internal/external links', expected: 'Expected target and window behavior are observed', automation: 'automated', capability: 'mapped', note: 'Link destinations are requested and judged; window behavior is not observed.' },
  { id: 'RES-01', area: 'Resources', category: 'Resources', type: 'resource', title: 'Resources open or download', action: 'Open/download configured resources', expected: 'Expected files are accessible', automation: 'manual', note: 'Downloads are disabled during scans.' },
  { id: 'CMP-01', area: 'Course completion', category: 'Completion', type: 'general', title: 'Visible completion matches the requirements', action: 'Complete declared requirements', expected: 'Visible completion state matches expectations', automation: 'manual', severity: 'high' },
  { id: 'LMS-01', area: 'Initialization', category: 'Tracking', type: 'general', title: 'Expected initialization calls and errors', action: 'In a local compatible harness, verify expected initialization calls and errors', expected: 'Expected initialization calls and errors', automation: 'automated', capability: 'mapped', severity: 'high', note: 'Judged against the local SCORM test harness, not a real LMS.' },
  { id: 'LMS-02', area: 'Score/status', category: 'Tracking', type: 'general', title: 'Score and status values match the specification', action: 'Execute known results', expected: 'Emitted score/status values match the declared package specification', automation: 'partially_automated', capability: 'mapped', severity: 'high', note: 'Needs the expected tracking settings; judged against the local harness, not a real LMS.' },
  { id: 'LMS-03', area: 'Commit/terminate', category: 'Tracking', type: 'general', title: 'Commit and terminate are recorded', action: 'Finish/exit', expected: 'Expected commit/termination behavior is recorded', automation: 'automated', capability: 'mapped', severity: 'high', note: 'Judged against the local SCORM test harness, not a real LMS.' },
  { id: 'LMS-04', area: 'Resume', category: 'Tracking', type: 'general', title: 'Saved state resumes', action: 'Restore saved state in the supported harness', expected: 'Location and relevant progress resume correctly', automation: 'automated', capability: 'mapped', severity: 'high', note: 'Judged against the local SCORM test harness, not a real LMS.' },
  { id: 'A11Y-01', area: 'Keyboard', category: 'Accessibility', type: 'general', title: 'Controls work by keyboard', action: 'Traverse supported controls', expected: 'Keyboard activation and navigation work', automation: 'automated', capability: 'mapped' },
  { id: 'A11Y-02', area: 'Focus', category: 'Accessibility', type: 'general', title: 'Focus is visible and managed around overlays', action: 'Observe focus when opening/closing overlays and changing screens', expected: 'Relevant controls remain reachable', automation: 'partially_automated', capability: 'mapped' },
  { id: 'A11Y-03', area: 'Names/roles', category: 'Accessibility', type: 'general', title: 'Controls have accessible names and roles', action: 'Inspect supported controls', expected: 'Required accessible names/roles are present', automation: 'partially_automated', capability: 'mapped', note: 'An automated rule checker finds only some problems. This is not an accessibility certification.' },
  { id: 'VIS-01', area: 'Overflow', category: 'Layout', type: 'general', title: 'No detectable clipping of text or controls', action: 'Inspect supported viewports', expected: 'Text and essential controls are not detectably clipped', automation: 'automated', capability: 'mapped' },
  { id: 'VIS-02', area: 'Responsive layout', category: 'Layout', type: 'general', title: 'Layout stays usable at selected sizes', action: 'Run selected viewport/zoom profiles', expected: 'Controls and content remain usable', automation: 'partially_automated', capability: 'mapped', note: 'Screen sizes are simulated in a desktop browser, not real devices.' },
  { id: 'ERR-01', area: 'Runtime errors', category: 'Errors', type: 'general', title: 'Browser errors are captured and classified', action: 'Capture browser errors', expected: 'Classify whether they are relevant to course behavior', automation: 'automated', capability: 'mapped', severity: 'high' },
  { id: 'STAT-01', area: 'Package files', category: 'Package (static)', type: 'general', title: 'Package archive, manifest and launch file are valid', action: 'Read the uploaded package files', expected: 'The archive is accepted, the manifest is well-formed, a launch file resolves and referenced files exist', automation: 'automated', capability: 'mapped', severity: 'high', note: 'Static: reads files only. It says nothing about how the course behaves.' },
  { id: 'STAT-02', area: 'Package dependencies', category: 'Package (static)', type: 'general', title: 'Outside web dependencies are listed', action: 'Read the package text for outside web addresses', expected: 'Outside dependencies are disclosed for review', automation: 'automated', capability: 'mapped', note: 'Static: addresses built in code at run time are not found.' },
  { id: 'STAT-03', area: 'Package scope', category: 'Package (static)', type: 'general', title: 'Which lessons were and were not scanned is disclosed', action: 'Compare the lessons chosen with the lessons in the manifest', expected: 'Lessons not scanned are listed', automation: 'automated', capability: 'mapped', note: 'Static: reads the manifest only.' },
  { id: 'ERR-02', area: 'Asset failures', category: 'Errors', type: 'general', title: 'Failed required assets are tied to the affected unit', action: 'Capture failed required assets', expected: 'Associated with affected units; optional requests distinguished', automation: 'automated', capability: 'mapped' },
];

const COURSE_TYPES = ['Rise', 'Storyline', 'HTML5'];

const ASSERT_BY_CAP: Partial<Record<EngineCapability, { actions: TestAction[]; assertions: TestAssertion[] }>> = {
  launch: { actions: [{ kind: 'open_launch' }], assertions: [{ kind: 'visible', target: 'page content' }] },
  next_previous: { actions: [{ kind: 'activate', target: 'Next' }, { kind: 'activate', target: 'Previous' }], assertions: [{ kind: 'url_changes' }, { kind: 'manual_review', question: 'Was the unit that loaded the intended adjacent one?' }] },
  accordion_open: { actions: [{ kind: 'activate', target: 'each accordion item' }], assertions: [{ kind: 'expanded', target: 'each accordion item', value: true }, { kind: 'visible', target: 'its content region' }] },
  accordion_policy: { actions: [{ kind: 'activate', target: 'first item' }, { kind: 'activate', target: 'second item' }], assertions: [{ kind: 'manual_review', question: 'Is the observed single-open or multi-open behavior the intended one?' }] },
  tabs: { actions: [{ kind: 'activate', target: 'each tab' }], assertions: [{ kind: 'selected', target: 'the tab', value: true }, { kind: 'visible', target: 'its panel' }] },
  dialog_open: { actions: [{ kind: 'activate', target: 'each dialog opener' }], assertions: [{ kind: 'visible', target: 'the dialog' }, { kind: 'text_contains', target: 'the dialog', text: '' }] },
  dialog_dismiss: { actions: [{ kind: 'activate', target: 'each dialog opener' }, { kind: 'activate', target: 'its close control' }], assertions: [{ kind: 'hidden', target: 'the dialog' }] },
  rule_all_click: { actions: [{ kind: 'reset', policy: 'fresh_context' }, { kind: 'activate_all', group: 'required items' }], assertions: [{ kind: 'event_fires', event: 'the rule\'s expected event', withinMs: 2000 }] },
  rule_premature: { actions: [{ kind: 'reset', policy: 'fresh_context' }, { kind: 'activate_all', group: 'required items', skip: ['one item'] }], assertions: [{ kind: 'event_absent', event: 'the rule\'s expected event', observeMs: 1500 }] },
  rule_duplicate: { actions: [{ kind: 'reset', policy: 'fresh_context' }, { kind: 'activate', target: 'one required item', times: 4 }], assertions: [{ kind: 'event_absent', event: 'the rule\'s expected event', observeMs: 1500 }] },
  rule_order: { actions: [{ kind: 'reset', policy: 'fresh_context' }, { kind: 'activate_all', group: 'required items', order: 'reverse' }], assertions: [{ kind: 'event_fires', event: 'the rule\'s expected event', withinMs: 2000 }] },
  rule_sequence: { actions: [{ kind: 'reset', policy: 'fresh_context' }, { kind: 'activate_all', group: 'required items', order: 'listed' }], assertions: [{ kind: 'event_fires', event: 'the rule\'s expected event', withinMs: 2000 }] },
};

const SOURCES_BY_CAP: Partial<Record<EngineCapability, string[]>> = {
  rule_all_click: ['Ordered action trace', 'State before and after', 'Event observation with timestamps', 'Screenshot'],
  rule_premature: ['Ordered action trace', 'State before and after', 'Observation window length', 'Screenshot'],
  rule_duplicate: ['Ordered action trace', 'Unique items completed', 'Observation window length'],
  rule_order: ['Ordered action trace for each order tried', 'Event observation'],
  rule_sequence: ['Ordered action trace for each sequence tried', 'Event observation'],
};

export function starterDefinitions(): TestDefinition[] {
  const at = nowIso();
  return ROWS.map((r) => {
    const cap = r.capability;
    const structured = cap ? ASSERT_BY_CAP[cap] : undefined;
    const body: TestDefinitionBody = {
      preconditions: r.automation === 'manual' ? ['The course is open in a browser at the screen being tested.'] : ['The course launch target opens.'],
      applicability: applicabilityFor(r),
      actions: structured?.actions ?? [{ kind: 'manual', instruction: r.action }],
      assertions: structured?.assertions ?? [{ kind: 'manual_review', question: r.expected }],
      resetPolicy: r.id.startsWith('LOG-') ? 'fresh_context' : 'none',
      timeoutMs: 15_000,
      expectedResult: r.expected,
      expectationSource: 'starter_baseline',
      evidence: (cap && SOURCES_BY_CAP[cap]) ?? (r.automation === 'manual' ? ['Reviewer notes', 'Screenshot or recording if useful'] : ['Screenshot', 'Recorded observation']),
      requiredCapability: cap,
      courseTypes: COURSE_TYPES,
      environments: ['Chromium (headless)'],
    };
    if (r.note) body.preconditions.push(`Note: ${r.note}`);
    return {
      id: r.id,
      version: 1,
      title: r.title,
      category: r.category,
      interactionType: r.type,
      severity: r.severity ?? 'medium',
      priority: r.severity === 'high' || r.severity === 'critical' ? 1 : 2,
      automation: r.automation,
      reviewState: 'starter' as ReviewState,
      body,
      origin: 'starter' as const,
      createdAt: at,
      updatedAt: at,
    };
  });
}

function applicabilityFor(r: Row): string {
  if (r.id.startsWith('LOG-')) return 'Applies where a behavior rule is configured for the screen. Without one, the expected behavior is unknown and the case needs a person.';
  if (r.capability === 'mapped') return 'Judged from the checks the scan already runs; the result is recorded against the case.';
  if (r.automation === 'manual') return 'A person decides whether the course has this interaction. There is no automation for it yet.';
  return `Applies to screens where the scanner detects ${r.area.toLowerCase()} controls.`;
}

/** Adds any starter case that is missing. Never overwrites a case a person has edited or imported. */
export function seedStarterLibrary(qa: QaStore): { added: number; total: number } {
  const have = new Set(qa.listDefinitions().map((d) => d.id));
  let added = 0;
  for (const d of starterDefinitions()) {
    if (have.has(d.id)) continue;
    qa.saveDefinition(d, 'system', 'Starter case added');
    added++;
  }
  return { added, total: have.size + added };
}

// ---- schema for editing, import and export ----

const actionSchema: z.ZodType<TestAction> = z.union([
  z.object({ kind: z.literal('open_launch') }),
  z.object({ kind: z.literal('activate'), target: z.string().min(1).max(300), times: z.number().int().min(1).max(20).optional() }),
  z.object({ kind: z.literal('activate_all'), group: z.string().min(1).max(300), order: z.enum(['listed', 'reverse', 'shuffle']).optional(), skip: z.array(z.string().max(300)).max(50).optional() }),
  z.object({ kind: z.literal('press_key'), key: z.string().min(1).max(40) }),
  z.object({ kind: z.literal('wait'), ms: z.number().int().min(0).max(30_000) }),
  z.object({ kind: z.literal('reload') }),
  z.object({ kind: z.literal('reset'), policy: z.enum(['fresh_context', 'reload', 'none']) }),
  z.object({ kind: z.literal('observe'), note: z.string().max(500).optional() }),
  z.object({ kind: z.literal('manual'), instruction: z.string().min(1).max(2000) }),
]);

const assertionSchema: z.ZodType<TestAssertion> = z.union([
  z.object({ kind: z.literal('visible'), target: z.string().min(1).max(300) }),
  z.object({ kind: z.literal('hidden'), target: z.string().min(1).max(300) }),
  z.object({ kind: z.literal('enabled'), target: z.string().min(1).max(300) }),
  z.object({ kind: z.literal('disabled'), target: z.string().min(1).max(300) }),
  z.object({ kind: z.literal('expanded'), target: z.string().min(1).max(300), value: z.boolean() }),
  z.object({ kind: z.literal('selected'), target: z.string().min(1).max(300), value: z.boolean() }),
  z.object({ kind: z.literal('text_contains'), target: z.string().min(1).max(300), text: z.string().max(500) }),
  z.object({ kind: z.literal('url_changes') }),
  z.object({ kind: z.literal('event_fires'), event: z.string().min(1).max(200), withinMs: z.number().int().min(0).max(30_000) }),
  z.object({ kind: z.literal('event_absent'), event: z.string().min(1).max(200), observeMs: z.number().int().min(0).max(30_000) }),
  z.object({ kind: z.literal('manual_review'), question: z.string().min(1).max(1000) }),
]);

export const TestDefinitionInput = z.object({
  id: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/, 'Use letters, digits, dot, dash and underscore'),
  externalId: z.string().trim().max(120).optional(),
  title: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(80),
  interactionType: z.enum([...INTERACTION_TYPES, 'general']),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  automation: z.enum(AUTOMATION_CLASSES),
  reviewState: z.enum(REVIEW_STATES),
  body: z.object({
    preconditions: z.array(z.string().max(500)).max(30),
    applicability: z.string().max(1000),
    actions: z.array(actionSchema).max(60),
    assertions: z.array(assertionSchema).max(60),
    inputData: z.record(z.string(), z.string().max(500)).optional(),
    resetPolicy: z.enum(['fresh_context', 'reload', 'none']),
    timeoutMs: z.number().int().min(1_000).max(300_000),
    expectedResult: z.string().max(2000),
    expectationSource: z.enum(EXPECTATION_SOURCES),
    evidence: z.array(z.string().max(200)).max(20),
    requiredCapability: z.string().max(60).optional(),
    courseTypes: z.array(z.string().max(40)).max(10),
    environments: z.array(z.string().max(60)).max(10),
  }),
});
export type TestDefinitionInput = z.infer<typeof TestDefinitionInput>;

/**
 * An automated or partially automated case must name a capability the engine really has. A team case that names none is
 * stored as manual: imported text is never trusted to claim automation.
 */
export function effectiveAutomation(def: Pick<TestDefinition, 'automation' | 'body'>): AutomationClass {
  const cap = def.body.requiredCapability;
  if (def.automation !== 'manual' && (!cap || !(ENGINE_CAPABILITIES as readonly string[]).includes(cap))) return 'manual';
  return def.automation;
}

// ---- CSV and JSON ----

export const CSV_COLUMNS = ['id', 'external_id', 'title', 'category', 'interaction_type', 'severity', 'priority', 'automation', 'review_state', 'course_types', 'preconditions', 'applicability', 'steps', 'expected_result', 'expectation_source', 'evidence', 'reset_policy', 'timeout_ms', 'required_capability'] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

/** RFC 4180 parser: quoted fields, doubled quotes, CRLF or LF, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

/** Quotes every field, and neutralizes a leading = + - @ so a spreadsheet never runs a team case as a formula. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

const listOut = (a: string[]) => a.join(' | ');
const listIn = (s: string) => s.split(/\s*\|\s*|\r?\n/).map((x) => x.trim()).filter(Boolean);
/** Step text for the CSV: plain readable lines for people; structured actions round-trip through JSON. */
export function stepsText(def: TestDefinition): string {
  return def.body.actions.map((a) => (a.kind === 'manual' ? a.instruction : `${a.kind}${'target' in a ? `: ${a.target}` : 'group' in a ? `: ${a.group}` : ''}`)).join(' | ');
}

export function definitionsToCsv(defs: readonly TestDefinition[]): string {
  const lines = [CSV_COLUMNS.map((c) => csvCell(c)).join(',')];
  for (const d of defs) {
    const cells: Record<CsvColumn, string> = {
      id: d.id,
      external_id: d.externalId ?? '',
      title: d.title,
      category: d.category,
      interaction_type: d.interactionType,
      severity: d.severity,
      priority: String(d.priority),
      automation: d.automation,
      review_state: d.reviewState,
      course_types: listOut(d.body.courseTypes),
      preconditions: listOut(d.body.preconditions),
      applicability: d.body.applicability,
      steps: stepsText(d),
      expected_result: d.body.expectedResult,
      expectation_source: d.body.expectationSource,
      evidence: listOut(d.body.evidence),
      reset_policy: d.body.resetPolicy,
      timeout_ms: String(d.body.timeoutMs),
      required_capability: d.body.requiredCapability ?? '',
    };
    lines.push(CSV_COLUMNS.map((c) => csvCell(cells[c])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export interface ImportRowResult {
  row: number;
  /** The team's own ID exactly as given. */
  externalId?: string;
  id: string;
  status: 'new' | 'duplicate' | 'invalid';
  problems: string[];
  definition?: TestDefinition;
  existing?: { id: string; version: number; title: string };
}

/** The columns a team sheet maps to. Missing optional columns fall back to safe defaults and are listed as such in the preview. */
export type ColumnMapping = Partial<Record<CsvColumn, string>>;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
/** Suggests a mapping by comparing header names to our column names. The reviewer confirms it. */
export function suggestMapping(headers: readonly string[]): ColumnMapping {
  const out: ColumnMapping = {};
  const synonyms: Partial<Record<CsvColumn, string[]>> = {
    id: ['id', 'testid', 'caseid', 'caseno', 'caseno', 'tcid'],
    external_id: ['externalid', 'teamid', 'reference'],
    title: ['title', 'name', 'casename', 'testcase', 'testcasename', 'summary', 'scenario'],
    category: ['category', 'area', 'module', 'group'],
    interaction_type: ['interactiontype', 'type', 'interaction'],
    severity: ['severity'],
    priority: ['priority'],
    steps: ['steps', 'action', 'actions', 'procedure', 'teststeps'],
    expected_result: ['expectedresult', 'expected', 'expectedbehavior', 'expectedbehaviour', 'result'],
    preconditions: ['preconditions', 'precondition', 'prerequisites'],
  };
  for (const [col, names] of Object.entries(synonyms) as Array<[CsvColumn, string[]]>) {
    const hit = headers.find((h) => names.includes(norm(h)));
    if (hit) out[col] = hit;
  }
  for (const c of CSV_COLUMNS) if (!out[c]) {
    const hit = headers.find((h) => norm(h) === norm(c));
    if (hit) out[c] = hit;
  }
  return out;
}

/**
 * Turns sheet rows into definitions without executing or trusting anything in them. Team wording is kept exactly.
 * Cases whose steps are free text become manual cases; they only become automated if they name a capability this
 * engine actually has.
 */
export function previewImport(headers: readonly string[], rows: ReadonlyArray<readonly string[]>, mapping: ColumnMapping, existing: (id: string) => TestDefinition | undefined, existingByExternal: (ext: string) => TestDefinition | undefined): ImportRowResult[] {
  const col = (c: CsvColumn) => (mapping[c] ? headers.indexOf(mapping[c]!) : -1);
  const get = (r: readonly string[], c: CsvColumn): string => {
    const i = col(c);
    return i >= 0 ? (r[i] ?? '').trim() : '';
  };
  const seen = new Set<string>();
  const at = nowIso();
  return rows.map((r, idx): ImportRowResult => {
    const rowNo = idx + 2; // header is row 1
    const external = get(r, 'external_id') || get(r, 'id');
    const problems: string[] = [];
    const title = get(r, 'title');
    if (!title) problems.push('Title is missing.');
    const rawId = get(r, 'id') || (external ? `T-${external}` : '');
    const id = rawId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
    if (!id) problems.push('There is no ID and no team ID to build one from.');
    if (seen.has(id) && id) problems.push(`The ID ${id} appears more than once in this file.`);
    seen.add(id);
    const pick = <T extends string>(value: string, allowed: readonly T[], fallback: T, label: string): T => {
      if (!value) return fallback;
      const hit = allowed.find((a) => a.toLowerCase() === value.toLowerCase());
      if (!hit) problems.push(`${label} "${value}" is not one of: ${allowed.join(', ')}.`);
      return hit ?? fallback;
    };
    const interactionType = pick(get(r, 'interaction_type'), [...INTERACTION_TYPES, 'general'] as const, 'general', 'Interaction type');
    const severity = pick(get(r, 'severity'), ['critical', 'high', 'medium', 'low'] as const, 'medium', 'Severity');
    const priorityText = get(r, 'priority');
    const priority = (priorityText === '1' || priorityText === '2' || priorityText === '3' ? Number(priorityText) : 2) as 1 | 2 | 3;
    if (priorityText && !['1', '2', '3'].includes(priorityText)) problems.push(`Priority "${priorityText}" must be 1, 2 or 3.`);
    const steps = listIn(get(r, 'steps'));
    const capability = get(r, 'required_capability') || undefined;
    const requestedAutomation = pick(get(r, 'automation'), AUTOMATION_CLASSES, 'manual', 'Automation');
    const def: TestDefinition = {
      id,
      externalId: external || undefined,
      version: 1,
      title,
      category: get(r, 'category') || 'Imported',
      interactionType,
      severity,
      priority,
      automation: requestedAutomation,
      // Imported cases are drafts until a person reviews them.
      reviewState: 'draft',
      body: {
        preconditions: listIn(get(r, 'preconditions')),
        applicability: get(r, 'applicability'),
        actions: steps.length ? steps.map((s) => ({ kind: 'manual' as const, instruction: s })) : [{ kind: 'manual' as const, instruction: '(no steps given)' }],
        assertions: [{ kind: 'manual_review', question: get(r, 'expected_result') || 'Does the course behave as the team case describes?' }],
        resetPolicy: pick(get(r, 'reset_policy'), ['fresh_context', 'reload', 'none'] as const, 'none', 'Reset policy'),
        timeoutMs: Number(get(r, 'timeout_ms')) >= 1000 ? Number(get(r, 'timeout_ms')) : 15_000,
        expectedResult: get(r, 'expected_result'),
        expectationSource: 'approved_case',
        evidence: listIn(get(r, 'evidence')),
        requiredCapability: capability,
        courseTypes: listIn(get(r, 'course_types')),
        environments: [],
      },
      origin: 'import',
      createdAt: at,
      updatedAt: at,
    };
    // Free-text steps cannot run. Whatever the sheet says, it is stored as manual unless it names a real capability.
    def.automation = effectiveAutomation(def);
    const check = TestDefinitionInput.safeParse({ ...def, body: { ...def.body } });
    if (!check.success) for (const i of check.error.issues) problems.push(`${i.path.join('.') || 'row'}: ${i.message}`);
    const dup = (id && existing(id)) || (external ? existingByExternal(external) : undefined);
    if (problems.length) return { row: rowNo, externalId: external || undefined, id, status: 'invalid', problems };
    return dup
      ? { row: rowNo, externalId: external || undefined, id, status: 'duplicate', problems: [], definition: def, existing: { id: dup.id, version: dup.version, title: dup.title } }
      : { row: rowNo, externalId: external || undefined, id, status: 'new', problems: [], definition: def };
  });
}

/** Applies previewed rows. `duplicates` decides what happens when an ID or team ID already exists. */
export function commitImport(qa: QaStore, results: readonly ImportRowResult[], opts: { duplicates: 'skip' | 'replace'; actor: string }): { created: number; replaced: number; skipped: number; invalid: number } {
  const out = { created: 0, replaced: 0, skipped: 0, invalid: 0 };
  for (const r of results) {
    if (r.status === 'invalid' || !r.definition) {
      out.invalid++;
      continue;
    }
    if (r.status === 'duplicate') {
      if (opts.duplicates === 'skip') {
        out.skipped++;
        continue;
      }
      const target = r.existing!.id;
      qa.saveDefinition({ ...r.definition, id: target }, opts.actor, `Replaced by import (team ID ${r.externalId ?? 'none'})`);
      out.replaced++;
      continue;
    }
    qa.saveDefinition(r.definition, opts.actor, 'Imported');
    out.created++;
  }
  return out;
}
