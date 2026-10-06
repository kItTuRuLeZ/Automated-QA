# Course QA Automation: Capability Matrix

This matrix provides a comprehensive breakdown of automated, hybrid, and manual quality assurance capabilities across supported authoring formats and runtime environments.

---

## 1. Supported Course Types

| Format | Discovery Mechanism | Primary Counting Unit | Non-Primary Listed Units |
| :--- | :--- | :--- | :--- |
| **Articulate Rise 360** | Package manifest (`imsmanifest.xml`), authoring data export (`course.json`), player navigation DOM | Lessons | Blocks, interactive sections |
| **Articulate Storyline 360** | Manifest, `story.js` data model, player slide DOM | Slides | Scenes, layers, lightboxes |
| **Custom HTML5 / SCORM** | Manifest items, standard HTML anchor/button traversal, DOM state mutations | Screens (distinct URL/hash or state identifier) | Multi-SCO packages, embedded frames |

---

## 2. Functional & Technical QA Capability Matrix

### Automation Classification Key
- **Automated**: Fully executed by the scanner without human intervention. Reaches deterministic `passed` or `failed` status with screenshots and DOM traces.
- **Hybrid / Assisted**: Scanner collects observations, evaluates structural prerequisites, flags anomalies, and registers a `manual_review_required` item for reviewer sign-off.
- **Manual Only**: Scanner flags requirement and generates a checklist row in exports; verification requires human judgment.

---

### Matrix Table

| QA Domain / Capability | Rise 360 | Storyline 360 | Custom HTML5 | Automation Level | Test Cases / Rules | Evidence Captured |
| :--- | :---: | :---: | :---: | :--- | :--- | :--- |
| **Package Integrity & Manifest** | Yes | Yes | Yes | **Automated** | `STAT-01`, `STAT-02`, `STAT-03` | File inventory, byte counts, manifest XML validation |
| **Static Text & Placeholder Audits** | Yes | Yes | Yes | **Automated** | `TYP-01`, `CONT-01`..`03` | Matched strings, XPath/DOM selectors |
| **All-Click Logic & Sequencing** | Yes | Yes | Yes | **Automated** | `LOG-01`..`08` | Action sequence trace, state transition screenshots |
| **Tab Controls & Panels** | Yes | Yes | Yes | **Automated** | `TAB-01`..`03` | ARIA state, element visibility, panel text diff |
| **Accordion Expand/Collapse** | Yes | Yes | Yes | **Automated / Hybrid** | `ACC-01`, `ACC-02` | Heights, `aria-expanded` attributes, review note |
| **Modals & Dialog Trap/Restore** | Yes | Yes | Yes | **Automated** | `LAY-01`, `LAY-02` | Focus element history, bounding box occlusion |
| **Screen Discovery & Navigation** | Yes | Yes | Yes | **Automated** | `NAV-01`..`04` | Visited screen list, depth graph, transition logs |
| **Responsive Viewports & Overflow** | Yes | Yes | Yes | **Automated** | `LAY-03`..`06` | Viewport bounding rects, clipping offsets, screenshots |
| **Keyboard Accessibility & Focus** | Yes | Yes | Yes | **Automated** | `A11Y-01`..`04` | Active element trace, tab cycle detection |
| **Media & Asset Loading** | Yes | Yes | Yes | **Automated** | `MED-01`..`03` | HTTP 404/500 logs, failed network requests |
| **SCORM 1.2 / 2004 LMS Communication** | Yes | Yes | Yes | **Automated** | `SCORM-01`..`06` | CMI call log, error codes, commit sequence |
| **Visual Baseline Comparisons** | Yes | Yes | Yes | **Automated** | `VIS-01`..`02` | Pixel diff percentage, before/after overlay |
| **Complex Drag & Drop Interactions** | Partial | Partial | Partial | **Hybrid** | `INT-04`, `DRAG-01` | Drop target coordinates, manual verification flag |
| **Audio/Video Transcript & Closed Captions**| Manual | Manual | Manual | **Manual Only** | `A11Y-MAN-01` | Checklist entry with timestamps |
| **Pedagogical Clarity & Editorial Flow** | Manual | Manual | Manual | **Manual Only** | `MAN-01`..`04` | Reviewer notes sheet in Excel export |

---

## 3. Guarantees vs. Non-Claims

### What the Scanner Guarantees
1. **Zero False Passes**: An unopened screen or unvisited branch is never marked as passed.
2. **Deterministic Status Derivation**: Screen statuses (`Passed automated checks`, `Issues found`, `Needs manual review`, `Not tested`) are computed purely from execution rows.
3. **Explicit Denominators**: Every percentage (visits, executed checks, pass rate) is presented alongside its numerator and denominator (e.g., `12 of 14 screens (85.7%)`).
4. **Local Privacy**: Runs strictly on `127.0.0.1` without outbound network access.

### What the Scanner Explicitly Does NOT Claim
1. **Not Full Accessibility Compliance**: Passing automated accessibility checks does not guarantee full WCAG 2.1/2.2 AA compliance.
2. **Not Full Course Coverage**: Traversal respects depth and state budgets; unreached states remain unverified.
3. **Not LMS Acceptance Guarantee**: Passing SCORM communication checks verifies runtime API compliance but does not guarantee specific third-party LMS behavior.
4. **No Artificial Intelligence**: No generative models or probabilistic classifiers are used to score or evaluate course quality.
