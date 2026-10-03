# Course QA Automation — Phased Claude Code Build Prompt

## How to use this file

Create a new repository for this application. Keep the existing Rise Component Builder AT&T and PMI repositories separate. Place this file in the new repository's `docs/` folder.

In Claude Code, start with:

> Read docs/Claude_Code_Course_QA_Automation_Phased_Prompt.md. Apply the Master Instructions and implement Phase 0 only. Inspect the repository first, create the required documentation, and complete that phase's acceptance checks. Do not implement later phases yet.

For each subsequent phase, use:

> Read the phased prompt and current implementation status. Implement Phase N only, following the Master Instructions and all completed phase contracts. Run the relevant checks, update documentation, and report evidence, limitations, and the next phase. Do not advance automatically.

Replace N with the phase number. Continue in the same repository. A phase may span several sessions; resume from `docs/IMPLEMENTATION_STATUS.md` rather than restarting. If a phase is too large for one session, complete a coherent vertical slice, record remaining tasks, and continue that phase in the next session.

Phases 0–5 form the first standalone release. Phases 6–9 extend it. AI integration is optional and is introduced only in Phase 8.

---

## Master Instructions — apply to every phase

You are building a working **Course QA Automation** application for eLearning production teams. It should inspect published web courses and, in later phases, uploaded HTML5/SCORM packages. It should support Rise, Storyline, and custom HTML where their content and interaction states are accessible.

The product must produce evidence-backed findings, show what it actually tested, and export actionable reports. Do not promise complete course traversal, full accessibility compliance, or real LMS compatibility from a generic scan.

### Architecture and constraints

1. Build a separate application, not a modification of the Rise Component Builder.
2. Use TypeScript throughout, with a React/Vite frontend, a Node backend, a separate Playwright worker process, and SQLite for the initial single-user/local deployment. Use a maintained Node LTS release; verify current compatibility in official documentation and pin versions in the lockfile.
3. Use `axe-core` for automated accessibility rules, Playwright for browser execution, and maintained libraries for schema validation, ZIP/XML parsing, and exports. Verify current APIs against official documentation. Avoid unnecessary frameworks and services.
4. The frontend is a control panel; scans run in the worker. This cannot operate as a GitHub Pages-only app. Document local execution first. An IIS deployment would need a separately running backend/worker and reverse proxy configuration; static file hosting alone is insufficient.
5. Core operation requires no AI API, cloud account, subscription, or external telemetry. Browser binaries and dependencies must be installed before offline use. Scanning public URLs needs network access; offline operation applies to local packages and local assets, not internet-dependent courses.
6. Do not use AI for deterministic findings. Keep optional advisory providers outside the critical scan path.
7. Run inspected course code in isolated, disposable browser contexts and a restricted worker/container. Never execute package scripts through Node, install dependencies from uploads, or open uploaded code in the application's privileged origin.
8. Do not fabricate scan output, screenshots, pass rates, course names, or completed checks. Demo data must be explicitly marked and stored separately.
9. Support client profiles without forking the application. Include neutral default branding; AT&T, PMI, CoBank, and Aptara may be profile names, but do not invent approved brand rules.
10. Favor usable implementation over placeholder modules. Future capabilities belong in roadmap documentation, not enabled buttons that do nothing.

### Accuracy contracts

- Track check results independently from findings: `passed`, `failed`, `needs_review`, `not_applicable`, `not_tested`, `error`.
- Keep run status separate: `queued`, `running`, `completed`, `partial`, `failed`, `cancelled`. A completed run means the configured scan finished, not that the course passed QA.
- Classify findings as `automated_defect`, `standards_warning`, `heuristic_warning`, `ai_recommendation`, or `manual_review`.
- Severity is a separate field: Critical / High / Medium / Low / Informational. Define repeatable mappings and allow documented reviewer overrides.
- Overlap, alignment, focus order, clipped text, and image distortion often need context. Treat geometry-based detection as heuristic unless a rule can establish a concrete defect.
- Missing `alt` and empty `alt` are different. Empty alt can correctly identify a decorative image. Do not report every empty alt as a defect.
- A heading level jump is a warning, not automatic proof of a WCAG failure.
- A successful HTTP response does not prove that a link points to the correct destination. A 401/403, timeout, or blocked request is not automatically a broken link.
- Caption/transcript presence does not establish accuracy or adequacy.
- DOM-based checks cannot inspect all canvas-rendered Storyline content. Detect and disclose unsupported surfaces, inaccessible frames, and unexplored interaction branches.
- Never interpret skipped checks or unreachable content as passed.
- Default dashboards show findings and coverage, not a misleading universal quality score.

### Scan safety and data handling

- Scan only user-supplied targets within configured origins/path scope. Use a read-only exploration policy by default. Do not blindly click every button or submit forms.
- Define action allowlists, denied actions, maximum pages/states, depth, runtime, downloads, redirects, asset bytes, and concurrency. Destructive or ambiguous actions must remain untested with reasons.
- Build centralized outbound network enforcement covering initial URLs, redirects, browser subrequests, link checks, WebSockets, and package dependencies. Deny private, loopback, link-local, metadata, and other reserved targets by default, including IPv6 and alternate IP encodings. Validate resolved destinations and enforce at connection time; prevent DNS rebinding. Use worker network isolation as defense in depth.
- Support deliberate intranet scans later through an administrator-configured host/CIDR policy. The worker's own package server is a narrowly scoped exception, not blanket private-network permission.
- Reject non-HTTP(S) targets and embedded credentials. Do not expose a proxy endpoint accepting arbitrary URLs.
- Bind the first release to localhost, with strict origin checks and protection for state-changing requests. Shared/network deployment requires authentication and authorization before exposure.
- Keep sessions, storage state, API keys, and signed URLs out of logs, source control, reports, screenshots where possible, and exports. Sanitize URL queries and visible evidence according to a configurable redaction policy. Prefer fixtures without sensitive data for demonstrations.
- Store artifacts under opaque IDs; prevent path traversal and enforce ownership on access. Provide retention and deletion settings. Cancellation must terminate browsers and worker tasks and clean up temporary resources.
- Keep browser sandboxing enabled. Document and test worker filesystem/network restrictions; a disposable browser context alone is not a security boundary.

### Implementation discipline

Inspect existing files and repository instructions first. Preserve completed behavior. Make small, reviewable changes. Add tests that verify meaningful behavior, including false positives, failure paths, and security boundaries. Do not write tests that merely restate implementation details.

At the end of each phase, provide:

- Implemented behavior and files changed.
- Exact commands run and their actual results.
- Acceptance criteria passed, failed, or blocked.
- Known limitations and unsupported cases.
- Updated `docs/IMPLEMENTATION_STATUS.md` with the next phase ready to run.

Never claim tests passed when you did not run them. Do not publish, deploy, or introduce paid services as part of these prompts.

---

## Phase 0 — Architecture, scope, and execution plan

### Build

Inspect the repository, then create:

- `PROJECT.md`: users, problems, standalone principle, V1 scope, exclusions.
- `ARCHITECTURE.md`: frontend/backend/worker boundaries, artifact storage, job lifecycle, deployment model.
- `docs/QA_RULE_CATALOG.md`: rule IDs, categories, evidence, applicability, limitations, default severity and confidence.
- `docs/SECURITY_MODEL.md`: outbound network policy, worker isolation, unsafe actions, upload threats, data retention.
- `docs/IMPLEMENTATION_STATUS.md`: phased checklist and current state.
- `docs/TEST_STRATEGY.md`: fixtures, engine tests, false-positive cases, manual verification.

Define shared types for ScanConfig, ScanRun, CourseState, TraversalAction, CheckResult, Finding, Evidence, ClientProfile, and EngineResult. Define provider interfaces for accessibility, navigation, package analysis, content comparison, and optional advisory analysis without implementing future engines.

A finding must include stable rule ID, category, type, severity, confidence, course/lesson/state location when known, viewport/browser, observed behavior, expected behavior or rule, evidence references, reproduction steps, remediation, standard mapping where justified, reviewer status, and fingerprint. Do not require a lesson/screen value that the scanner cannot determine.

A check record must include rule, state, result, duration, and a reason for any untested/error outcome. Distinguish unique rules from their executions across multiple states and viewports.

### Acceptance

Architecture supports no-AI execution and a separately running worker. The capability matrix distinguishes implemented, planned, heuristic, and manual checks. Phase 1 can proceed without unresolved decisions that affect its data contracts.

---

## Phase 1 — Working local application and URL scan pipeline

### Build

Implement the frontend, backend, database migrations, and separate job worker. Deliver a complete first vertical slice:

1. Create a project and add a published course URL.
2. Configure allowed origin/path, timeout, and initial viewport.
3. Validate the target and queue a scan.
4. Launch an isolated browser and record the initial page state.
5. Capture screenshot, page title, final sanitized URL, console exceptions, failed requests, and basic navigation timing.
6. Persist findings/check records and display the result.
7. Cancel a running scan and clean up resources.

UI: project list, New Scan, progress/status view, scan history, finding table, and finding detail with evidence. Use a clean corporate design, clear status labels, readable typography, and keyboard-accessible controls. Empty, loading, partial, error, and cancelled states must be designed.

Keep SQLite and the local artifact directory durable across app restarts. Start with one worker and bounded concurrency. Detect and recover or mark orphaned jobs after restart.

Use local test fixtures: healthy page, missing asset, thrown JavaScript exception, redirect, timeout, and disallowed destination. Do not rely solely on public websites for tests.

### Acceptance

A real fixture scan goes from queued to completed with real evidence. Console exceptions and network failures are captured accurately. Denied targets never launch. Cancellation and restart recovery work. Build/type checks and relevant integration tests pass.

---

## Phase 2 — Bounded course traversal, functional checks, links, and media

### Build

Implement a state-aware traversal engine. URLs alone are insufficient for SPA courses: record lesson identifiers where observable, significant DOM/state signatures, selected tabs, open dialogs, and action paths. Prevent loops and cap exploration.

Implement a generic HTML adapter plus an adapter interface. Support safe links and recognized tabs, accordions, dialogs, and Next/Back controls with observable postconditions. A click with no observable result is inconclusive until the adapter defines what should happen; do not automatically label it broken.

Capture state/action graphs and coverage: reached states, attempted actions, skipped actions, inaccessible frames, failed transitions, and limits reached. Restore state before exploring sibling paths. Do not brute-force quiz answers or attempt every possible branch.

Link checks: normalize URLs, deduplicate, inspect redirects, use bounded GET fallback where HEAD is unsupported, enforce network policy throughout, and distinguish HTTP failure, access restriction, timeout, and unverified destination. Avoid downloading entire large resources just to check them.

Media checks: broken images using loading state and natural dimensions, observed media errors, failed media requests, controls/caption track metadata where inspectable, and configurable size warnings. Do not infer guaranteed playback from metadata alone or flag lazy-loaded media before scrolling/waiting appropriately.

Add simple rule-based placeholder and terminology checks with exclusion lists. Do not claim full grammar review.

### Acceptance

Fixtures for SPA lessons, accordion, tab, modal, navigation loop, inaccessible iframe, restricted link, lazy image, and broken media produce expected coverage and results. Scan budgets stop exploration predictably. Unsafe actions are skipped with reasons. Findings have actionable reproduction paths.

---

## Phase 3 — Automated accessibility and keyboard review

### Build

Run axe-core on each reached state, including supported frames, and record rule outcomes without counting untested surfaces as passes. Keep the actual engine version, rule ID, impact, node evidence, and standard tags. Deduplicate repeated defects while retaining all affected locations.

Implement bounded keyboard journeys using Tab, Shift+Tab, Enter, Space, and Escape in supported scenarios. Record active elements and focus transitions. Test recognized dialogs for entry focus, trap behavior, and return focus according to their intended pattern. Escape is not a universal requirement for every popup.

Add evidence-based checks or review tasks for visible focus, hidden focusable elements, accessible names, labels, page language, target size, and zoom/reflow. Use current official WCAG guidance for mappings; do not invent criterion IDs. Logical focus order, screen-reader experience, alt adequacy, and media equivalence need manual review.

Make the application's own interface accessible and provide a separate manual review checklist in reports.

### Acceptance

Known accessibility fixtures trigger expected rules, with decorative empty-alt images excluded appropriately. Keyboard tests handle a working dialog and a broken dialog. Canvas/unsupported-frame content is disclosed. Reports explicitly state that automated checks do not establish full accessibility compliance.

---

## Phase 4 — Responsive, visual heuristics, and performance evidence

### Build

Run selected reached states at configurable CSS-pixel viewports. Start with desktop 1440×900, laptop 1366×768, tablet 768×1024, and mobile 390×844. Call these viewport simulations, not real-device certification. Keep browser engine and device emulation settings visible.

Capture screenshots after fonts and relevant assets settle using bounded waits. Collect viewport overflow, element geometry, computed styles, scroll/clip dimensions, and font loading errors. Implement documented heuristics for likely clipped text, unintended horizontal overflow, obscured controls, and off-screen dialogs.

Exclude expected overlap in overlays, tooltips, badges, sliders, and intentional scroll containers. Geometry intersecting does not establish harmful overlap. Where possible attach a crop and an annotated full screenshot with measurable bounds. Preserve the original screenshot.

Collect initial transfer estimates where observable, largest assets, page-load/navigation timing, worker-side timings, console exceptions, and failed requests. Mark unavailable metrics. Explain cache, network, test machine, and third-party effects. Do not label basic timings as a comprehensive performance audit. Advanced lab metrics may be a later engine.

Add configurable warning thresholds with provenance. Enable baseline screenshot comparisons only for matching viewport/browser/state/config and controlled fixtures; treat diffs as review signals, not proof of defects.

### Acceptance

Intentional overlay/scroll fixtures do not produce confirmed defects. Overflow and clipped-text fixtures produce measured warnings at the affected viewport. Baselines detect a known visual change and do not compare incompatible configurations. Reports show tested viewport/state coverage and performance conditions.

---

## Phase 5 — Reports, client profiles, retest, and standalone V1 release

### Build

Export JSON, Excel, self-contained HTML, and PDF reports from one canonical report model. Bundle local evidence in the HTML where feasible; PDF generation must load trusted report templates and local artifacts with outbound networking disabled. Escape course-supplied HTML and protect spreadsheet exports against formula injection.

Report content:

- Scan configuration, timestamps, tool/engine versions, and tested scope.
- Unique rules and total check executions, with clearly defined denominators.
- Results by category/severity and separate advisory findings.
- Coverage, skipped states/actions, errors, and manual review items.
- Evidence, steps, remediation, and stable finding identifiers.

Client profiles: allowed fonts/colors and tolerances, minimum text-size rules, terminology, link policy, viewports, thresholds, scope rules, and exclusions. Require user-supplied approved brand values. Flag style deviations as warnings where their use is contextual.

Workflow: Open → Assigned → Fixed → Retest → Verified, plus Accepted Risk and False Positive with reason. Local owner names are metadata; assigning a finding does not send messages. Retest creates an immutable new run and links recurring findings using stable fingerprints. A finding disappears into Verified only when its rule and equivalent state were retested successfully; otherwise mark Not Reproduced / Not Retested distinctly.

Add local backup/restore, artifact retention, deletion, setup documentation, dependency/browser installation instructions, and a sample course fixture pack. Show blocked/unavailable capabilities honestly. No AI key fields or required AI setup in V1.

### Acceptance

Reports are readable and match dashboard totals. Evidence resolves after export. Untrusted text cannot execute script or spreadsheet formulas. Retest distinguishes fixed findings from untested locations. A fresh local installation completes a scan and export with no AI service. Test runtime operation without external AI connections; local fixture scans must also work with internet disabled after installation.

**Release gate:** Phases 0–5 constitute the standalone pilot. Document supported content surfaces and remaining manual QA. Validate on a user-provided Rise export, Storyline export, and custom HTML sample when available; otherwise mark product-specific validation pending, never passed.

---

## Phase 6 — HTML5/SCORM package inspection and isolated package scans

### Build

Accept ZIP uploads with limits for compressed bytes, expanded bytes, entry count, compression ratio, and extraction time. Reject traversal paths, absolute paths, symlinks, ambiguous duplicate paths, and unsupported encrypted archives. Avoid ZIP bombs. Parse XML with external entities/DTD/network resolution disabled.

Inspect the manifest: XML well-formedness, declared SCORM version, organizations/items/resources, resource dependencies, launch file resolution, missing local references, case mismatches, and external dependencies. Respect XML namespaces and relative base paths. Well-formed XML and custom checks do not establish formal schema conformance; report validated checks accurately.

Support plain HTML5 packages separately with explicit launch-file selection. Multiple organizations/SCOs require a clear selection policy; do not silently scan only the first and imply complete coverage.

Serve extracted content from a separate restricted origin and run it through the existing worker. Apply browser outbound policy to uploaded content; external dependencies are denied or allowlisted and logged. Keep app sessions inaccessible. Display package inventory, size, dependencies, static inspection results, and runtime findings separately.

### Acceptance

Valid packages launch; malformed XML, missing launches, resource dependencies, multi-SCO scope, case differences, traversal, symlinks, and oversized archives are tested. Unsafe uploads cannot escape extraction storage or access privileged application endpoints. Inventory analysis works offline; runtime checks disclose missing external dependencies.

---

## Phase 7 — SCORM runtime harness and deeper platform adapters

### Build

Create separate instrumented SCORM 1.2 and SCORM 2004 harnesses using their respective API object names, method names, data models, lifecycle, and error behavior. Implement enough validated behavior for documented scenarios; do not invent a fully conformant LMS simulator. Capture timestamps, API calls, return values, commits, termination, score/status/bookmark/suspend data, and error codes. Redact learner data.

Run scripted launch → progress → exit → reopen → resume → completion scenarios where an adapter or user-authored journey can reach them. Persist committed learner state in the harness and define how it is restored. Test pass and fail separately against user-supplied expected tracking settings. SCORM 1.2 lesson status and SCORM 2004 completion/success status must not be conflated.

Build Rise and Storyline adapters incrementally using actual supplied fixtures. Canvas-based interactions may require explicit scripted coordinates or other platform-specific evidence; never claim DOM coverage of their internal content. Report adapter version and supported scenarios.

Distinguish static package validation, harness runtime results, and actual target-LMS verification. Provide a manual target-LMS checklist for completion, resume, attempts, score, certificate triggers, and browser behavior. Real LMS results require testing that LMS.

### Acceptance

Separate 1.2/2004 fixtures demonstrate valid and invalid lifecycle behavior, commit/resume, and expected status/score transitions. Unsupported sequencing and multi-SCO behavior are disclosed. No actual-LMS compatibility claim is derived solely from the harness.

---

## Phase 8 — Optional AI-assisted review

### Build

Only implement this phase when explicitly requested. Add a provider interface with None as default and one approved provider first. Use server-side secrets, cost limits, request limits, timeouts, and opt-in per run. Never send course content silently or expose keys to the browser.

Provide a preview of selected text/screenshots to be sent, redaction options, and content-transfer confirmation. Treat course content as untrusted data; defend against prompt injection and prohibit model-initiated browsing, commands, or tool execution. Validate structured outputs.

Start with instruction clarity, writing suggestions, terminology context, assessment plausibility, and useful-alt-text review. Model-generated remediation is advisory. Keep recommendations separate from deterministic findings and never allow AI to override an executed check result.

Record provider/model, prompt version, reviewed scope, and uncertainty without retaining secrets. A provider failure must leave core scans and reports usable. Pricing must be configurable/verified, not hardcoded as a current fact. Organization-hosted endpoints may be supported through a validated allowlist.

### Acceptance

With AI disabled, no provider request occurs and core behavior is unchanged. Missing credentials, timeouts, budget exhaustion, invalid outputs, and injected course instructions fail safely. Every AI recommendation identifies its scope and advisory nature.

---

## Phase 9 — Storyboard-to-course fidelity comparison

### Build

Accept approved DOCX/XLSX storyboards using documented templates and user-confirmed column/field mappings. Do not require Word macros or run uploaded macros. Apply file/archive limits to document parsers as well.

Extract lesson/screen IDs, titles, body text, interaction type, assessment text/options/feedback, and asset references where available. Present a mapping review before comparison. Align by explicit IDs first, titles/structure second, and user-confirmed matches for ambiguities. Unmatched or unvisited content is Unverified, not Missing.

Provide exact comparison and configurable normalization for whitespace, line breaks, and typographic punctuation. Preserve raw source text and show diffs. Report additions, omissions, altered text, and metadata differences with evidence. Missing feedback can be asserted only if the corresponding course state was reached and captured.

Optional semantic comparison may use Phase 8 only when enabled. It must not hide exact edits to approved wording. Separate source fidelity from instructional quality. Detecting an image reference does not prove visual equivalence of the rendered image.

### Acceptance

Fixtures cover exact matches, harmless normalization, approved-text edits, duplicated titles, reordered sections, ambiguous mapping, unreachable feedback, and unsupported document structures. Reports preserve traceability to storyboard and course locations and disclose unverified content.

---

## Future work — document, do not implement automatically

- Multi-user hosting, authentication, roles, tenant isolation, and audited access.
- Cross-browser jobs with installed Chromium/Firefox/WebKit engines. Do not call a Chromium scan an Edge test; actual branded-browser validation needs its own environment.
- Organization intranet policies, approved authenticated course sessions, and enterprise deployment.
- Target-LMS connectors or dedicated test environments.
- Localization expansion checks and deeper instructional-design analysis.
- CI integration and regression baselines for repeat builds.

## Final product acceptance principle

The tool earns trust by showing **what was observed, how it was tested, the evidence, and what remains unverified**. A small reliable set of checks with honest coverage is the release target. Expand only after each phase's behavior is demonstrated.
