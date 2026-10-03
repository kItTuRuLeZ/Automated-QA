# Course QA Automation — Project Definition

## Purpose

Course QA Automation is a local, standalone application that inspects published web courses (and, later, uploaded HTML5/SCORM packages) and produces **evidence-backed findings** with honest coverage. It tells a reviewer what was observed, how it was tested, what evidence supports each finding, and what remains unverified.

It is a separate application. It does not modify or depend on the Rise Component Builder (AT&T or PMI) repositories.

## Users

| User | Needs |
| --- | --- |
| eLearning QA reviewer | Run repeatable scans, triage findings, attach evidence to defect reports, track retests. |
| Course developer (Rise, Storyline, custom HTML) | Reproduction steps, exact locations, and remediation guidance for each finding. |
| Production / project lead | Coverage and status per course and per client profile, without a misleading single quality score. |
| Accessibility specialist | Automated rule results plus an explicit list of what still needs manual review. |

## Problems addressed

1. Manual QA of courses is slow and inconsistent between reviewers and builds.
2. Broken assets, console errors, failed requests, and broken links are easy to miss by eye.
3. Automated accessibility tools are often reported as "compliance", which they cannot establish.
4. Responsive defects appear only at specific viewports.
5. Retests lack traceability: it is unclear whether a defect was fixed or simply not re-examined.
6. Client-specific rules (terminology, brand values, viewports) are applied by memory.

## Standalone principle

- Core scanning, findings, and reports run **locally with no AI API, cloud account, subscription, or telemetry**.
- After dependencies and browser binaries are installed, scans of local fixtures and local packages work offline. Scanning a public URL needs network access to that URL only.
- AI assistance (Phase 8) is optional, off by default, opt-in per run, and never changes deterministic results.

## V1 scope (Phases 0–5, standalone pilot)

- Local web control panel (React/Vite), Node backend, separate Playwright worker, SQLite storage, local artifact directory.
- Projects, published course URL targets, scan configuration with origin/path scope and budgets.
- Initial-state capture: screenshot, title, sanitized final URL, console exceptions, failed requests, navigation timing.
- Bounded, read-only, state-aware traversal of generic HTML courses (tabs, accordions, dialogs, Next/Back, safe links).
- Link checks, media checks, placeholder and terminology checks.
- axe-core accessibility rules per reached state and frame, bounded keyboard journeys, manual review checklist.
- Viewport simulations, geometry heuristics (overflow, clipped text, obscured controls), basic performance evidence, controlled baseline comparisons.
- Reports: JSON, Excel, self-contained HTML, PDF from one canonical model.
- Client profiles (neutral default; user-supplied brand values only), finding workflow, retest with stable fingerprints, backup/restore, retention.

## Extensions (Phases 6–9)

- Phase 6: ZIP/HTML5/SCORM package inspection and isolated package scans.
- Phase 7: SCORM 1.2 and 2004 runtime harnesses; Rise and Storyline adapters built from supplied fixtures.
- Phase 8: optional AI-assisted advisory review (only when explicitly requested).
- Phase 9: storyboard (DOCX/XLSX) to course fidelity comparison.

## Exclusions and non-claims

- **Not** a guarantee of complete course traversal. Unreached states are reported as unverified.
- **Not** an accessibility compliance certification. Automated checks cover a subset of WCAG; the rest is manual review.
- **Not** real-LMS compatibility testing. Harness results (Phase 7) are not target-LMS results.
- **Not** real-device or branded-browser certification. Viewports are CSS-pixel simulations in the installed engine; a Chromium scan is not an Edge test.
- **Not** a grammar checker or instructional-design evaluator.
- **No** inspection of canvas-rendered content via the DOM; such surfaces are detected and disclosed.
- **No** form submission, quiz brute-forcing, or destructive actions by default.
- **No** multi-user hosting, authentication, or network exposure in V1 (localhost only).
- **No** invented brand rules. AT&T, PMI, CoBank, and Aptara may exist as profile names; their values must be supplied by the user.
- **No** universal quality score on default dashboards.
