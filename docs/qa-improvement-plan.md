# Course QA Automation: Improvement Plan & Roadmap

This document outlines the strategic improvement roadmap for the Automated-QA platform following the completion of the Functional QA Layer. The platform is designed strictly for local-only, evidence-backed quality assurance of published eLearning course packages (Articulate Rise 360, Articulate Storyline 360, and custom HTML5/SCORM courses).

---

## 1. Executive Summary & Current Baseline

The system provides an evidence-backed scanning and analysis workflow that never inflates numbers, never claims a scan "passed QA", and separates all coverage dimensions with explicit denominators.

### Current Architectural Capabilities
- **Functional QA Layer**: Run events and progress tracking, content inventory discovery (manifest, player menu, authoring exports, run time), test definitions and execution tracking, deterministic screen status aggregation, behavior-rule all-click engine (LOG-01 through LOG-08), starter test library (69 baseline cases plus STAT-01..03 static checks), CSV/XLSX/JSON import/export, QA export tables, and evidence ZIP archive.
- **Web UI**: Screens tab, progress panel, coverage panel with discrete ratios, test library management with review workflow, behavior rules configurator, and scan profiles (Quick, Functional, Full, Custom).
- **Core Security & Sandbox Invariants**: Local loopback binding (`127.0.0.1`), strict Host/Origin/CSRF validation, scanning sandbox with process isolation, strict SSRF/network policy, offline execution with no hosted fonts, and zero reliance on generative AI.

---

## 2. Identified Functional Gaps & Future Roadmap

To preserve strict engineering honesty, the known limitations of the current architecture are prioritized below into actionable enhancement initiatives.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Course QA Improvement Themes                          │
├───────────────────────┬─────────────────────────────┬───────────────────────┤
│  Phase 1: Near-Term   │    Phase 2: Medium-Term     │   Phase 3: Long-Term  │
├───────────────────────┼─────────────────────────────┼───────────────────────┤
│ • Scoped Retest       │ • Real-Time SSE Streaming   │ • Cross-Browser Engine│
│ • Media Prerequisites │ • Automation Expansion      │ • SCORM 2004 Rollup   │
│ • State Permutations  │ • Canvas / SVG Automation   │ • Offline CI Package  │
└───────────────────────┴─────────────────────────────┴───────────────────────┘
```

---

## 3. Detailed Improvement Initiatives

### Initiative 1: Scoped Retest & Targeted Rescans
* **Current State**: When defects are fixed or rules are updated, the user triggers a full Retest. Retests create a new linked scan run, copying baselines and historical context.
* **Proposed Enhancement**:
  - Implement granular retest targets: single screen/lesson, specific test definition failure subset, or modified behavior rules only.
  - Retain previously passed screen results while invalidating only dirty nodes in the content graph.
  - Maintain immutability: retest runs will clearly state the retest scope in the coverage denominator (e.g., "Retest of 2 affected screens out of 14 discovered").

### Initiative 2: Media Prerequisite Simulation & Fixtures
* **Current State**: Test cases verify media asset presence, network load errors, and media control accessibility. However, complex logic depending on media playback completion (e.g., "video ends before next button unlocks") relies on manual review or timing windows.
* **Proposed Enhancement**:
  - Introduce dedicated media prerequisite fixtures with synthetic HTML5 `<video>` and `<audio>` events (`timeupdate`, `ended`, `canplaythrough`).
  - Add Playwright audio/video fast-forward triggers to simulate completion deterministically without wall-clock sleep.
  - Implement rule condition `media_completed` alongside `interaction_completed` in the Behavior Rules engine.

### Initiative 3: Real-Time Event Push via Server-Sent Events (SSE)
* **Current State**: The UI tracks run progress using polling (`useLiveRun` fetches `/api/runs/:id/progress` and delta events via `/api/runs/:id/events?after=N`).
* **Proposed Enhancement**:
  - Implement an SSE endpoint (`GET /api/runs/:id/events/stream`) using Fastify SSE support.
  - Maintain the existing sequence-number deduplication model (`lastSeq`) for seamless reconnection over loopback.
  - Fall back gracefully to polling if the stream disconnects, ensuring zero UI degradation.

### Initiative 4: Test Library Automation Expansion
* **Current State**: The starter library defines 69 standard test cases covering Navigation, Layout, Interaction, Accordions, Tabs, Modals, Media, Typography, and Accessibility. A significant portion are classified as `manual_review_required` or hybrid when expected behavioral policies cannot be derived from markup alone.
* **Proposed Enhancement**:
  - Increase automated coverage for interactive widgets (drag-and-drop matchers, numeric slider inputs, multi-tier quiz branches).
  - Implement heuristic layout inspection for multi-column text wrap and sticky header occlusion across custom breakpoints.
  - Add custom authoring export parsers to extract declarative authoring intentions from Storyline `story.js` and Rise `course.json` files.

### Initiative 5: Multi-Browser Engine Execution
* **Current State**: Execution utilizes headless Chromium via Playwright.
* **Proposed Enhancement**:
  - Extend Playwright worker execution to support WebKit (Safari engine) and Firefox (Gecko engine) profiles.
  - Enable differential layout rendering comparisons between Chromium and WebKit for font rendering, flexbox gaps, and CSS grid quirks common on iOS/macOS devices.
  - Keep browser execution sandboxed locally on `127.0.0.1`.

### Initiative 6: Advanced SCORM 2004 Sequencing & Navigation (SN)
* **Current State**: Comprehensive SCORM 1.2 and 2004 runtime simulation tracks CMI calls, data model constraints, commit sequences, and LMS checklists.
* **Proposed Enhancement**:
  - Implement SCORM 2004 3rd and 4th Edition Sequencing & Navigation state machine to validate multi-SCO activity trees, objective rollups, and global objectives.
  - Provide an automated sequence tree visualization in the Technical tab.

---

## 4. Architectural Non-Negotiables

All future enhancements must strictly adhere to the system's foundational principles:
1. **Local-Only Operation**: Bind only to `127.0.0.1`. No outbound network calls to external CDNs, hosted fonts, telemetry, or cloud APIs.
2. **Honest Reporting**: Never calculate a single overall pass percentage. Never report an unvisited screen or unreached state as passed.
3. **Deterministic Rules**: The same database rows must produce identical status counts and coverage statements regardless of runtime timing.
4. **No Generative AI**: All findings, test outcomes, and coverage metrics are deterministic, verifiable, and backed by screenshots and DOM traces.
