# QA Rule Catalog

Every check the application runs has a stable rule ID listed here. Rule IDs never change meaning; retired rules are marked `retired`, not reused. Machine-readable definitions will live in `packages/shared` as `RuleDefinition` records generated from this catalog when each rule is implemented.

## Vocabulary

**Check results** (per execution of a rule on one state × viewport × frame):
`passed`, `failed`, `needs_review`, `not_applicable`, `not_tested`, `error`.
`not_tested` and `error` always carry a reason. Neither counts as a pass.

**Finding types:** `automated_defect` (rule establishes a concrete defect), `standards_warning` (likely standards issue needing confirmation), `heuristic_warning` (geometry/text heuristics), `ai_recommendation` (Phase 8, advisory only), `manual_review` (a task for a human).

**Severity:** Critical / High / Medium / Low / Informational. **Confidence:** `high` / `medium` / `low`.

**Capability status:** `implemented`, `planned`, `heuristic` (implemented or planned as a heuristic), `manual` (review task, not automated). The status column shows `implemented` once a rule ships; otherwise the planned capability kind.

## Severity mapping

axe-core impact → severity (repeatable, documented): `critical` → Critical, `serious` → High, `moderate` → Medium, `minor` → Low. axe `incomplete` results are always Informational manual-review items.

| Situation | Default severity |
| --- | --- |
| Course cannot load / initial navigation fails | Critical |
| Uncaught JS exception on load, required asset (script/style) fails, keyboard trap | High |
| Broken image/media, HTTP-failed link, axe `serious` | High |
| axe `critical` | Critical |
| axe `moderate`, focus not visible, missing accessible name on control | Medium |
| axe `minor`, heading level jump, target-size warning | Low |
| Heuristic layout warnings | Medium (confidence `low`/`medium`) |
| Access-restricted/timeout link, unverified destination, coverage notes | Informational |
| Manual review tasks | Informational (severity set by reviewer) |

Reviewer overrides store the original severity, the new severity, reviewer name (local metadata), timestamp, and a required reason. Overrides never alter the underlying `CheckResult`.

axe mapping: `violations` → `failed` (`standards_warning`, confidence `high`); `incomplete` → `needs_review` (`manual_review`, confidence `medium`); `passes` → `passed`; `inapplicable` → `not_applicable`. Surfaces axe cannot reach (canvas, cross-origin frames not instrumented) → `not_tested` with reason.

WCAG references use WCAG 2.2 success criterion numbers and must be verified against the current W3C publication when a rule is implemented. A mapping means "relevant to", not "fails".

## Rules

Columns: **Type** = default finding type; **Sev/Conf** = default severity / confidence; **Ph** = phase; **Cap** = capability status.

### Capture and runtime (RUN)

| ID | Check | Evidence | Applicability | Type | Sev/Conf | Ph | Cap | Limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| RUN-001 | Initial page loads (navigation succeeds, non-error final status) | Final sanitized URL, status, screenshot, timing | Every URL target | automated_defect | Critical/high | 1 | implemented | Cannot tell a "correct" page from a wrong-but-200 page. |
| RUN-002 | Uncaught JavaScript exceptions | Message, stack (sanitized), state, timestamp | Every state | automated_defect | High/high | 1 | implemented | Third-party exceptions are flagged with origin; impact on learner unknown. |
| RUN-003 | Console errors (`console.error`) | Text (sanitized), source location | Every state | heuristic_warning | Low/medium | 1 | implemented | Many console errors are benign. Chromium's own "Failed to load resource" lines and lines for requests our policy blocked are not reported (RUN-004, MED-001/002, NET-002 cover them). |
| RUN-004 | Failed subrequests (network error or HTTP ≥ 400) | URL (sanitized), resource type, status/error | Every state | automated_defect | High (script/style/doc) · Medium (other)/high | 1 | implemented | Requests blocked by our policy are NET-002. Requests the page aborts itself (`net::ERR_ABORTED`) are not failures. With media checks on, images and audio/video are reported by MED-001/MED-002 instead. |
| RUN-005 | Page title present | Title text | Top document | standards_warning | Low/high | 1 | implemented | Title adequacy is manual. WCAG 2.4.2. |
| RUN-006 | Navigation timing captured | Navigation Timing entries | Top document | (metric, no finding) | —/— | 1 | implemented | Single sample; machine and network dependent. |

### Network policy and scope (NET)

| ID | Check | Evidence | Applicability | Type | Sev/Conf | Ph | Cap | Limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NET-001 | Target rejected by outbound policy | Reason (scheme, credentials, reserved IP, out of scope) | Scan submission | (submission error, no run) | —/— | 1 | implemented | — |
| NET-002 | Subrequest blocked by policy | Sanitized URL, reason | Every state | manual_review | Informational/high | 1 | implemented | Blocked content may hide course behavior; disclosed as coverage gap. |
| NET-003 | Redirect leaves allowed scope | Redirect chain | Navigation | manual_review | Informational/high | 1 | implemented | — |

### Navigation, traversal, functional (NAV, COV)

| ID | Check | Evidence | Applicability | Type | Sev/Conf | Ph | Cap | Limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| NAV-001 | Recognized control produces its expected postcondition (tab selects panel, accordion expands, dialog opens, Next advances) | Action path, before/after state signature, screenshots | Adapter-recognized controls | automated_defect | High/medium | 2 | implemented | Only for controls whose expected result the adapter defines; otherwise NAV-002. |
| NAV-002 | Action produced no observable change | Action, before/after signature | Attempted actions | manual_review | Low/low | 2 | implemented | Inconclusive, never labelled broken automatically. |
| NAV-003 | Dialog can be closed | Action path | Recognized dialogs | automated_defect | Medium/medium | 2 | implemented | Close mechanism must be recognized. |
| COV-001 | Unsafe or ambiguous action skipped | Element, reason | Discovered actions | manual_review | Informational/high | 2 | implemented | — |
| COV-002 | Inaccessible frame (cross-origin/sandboxed/blocked) | Frame URL (sanitized), reason | Every state | manual_review | Informational/high | 2 | implemented | Content inside is unverified. |
| COV-003 | Canvas/unsupported rendering surface detected | Canvas size, location, screenshot | Every state | manual_review | Informational/high | 2 | implemented | DOM checks cannot inspect canvas content (e.g. parts of Storyline). |
| COV-004 | Scan budget reached (pages, states, depth, time) | Budget, counts | Run | manual_review | Informational/high | 2 | implemented | Remaining states unverified. |

### Links (LNK)

| ID | Check | Evidence | Applicability | Type | Sev/Conf | Ph | Cap | Limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LNK-001 | Link returns HTTP error (404, 410, 5xx) | Normalized URL, method, status, redirect chain | HTTP(S) links within link policy | automated_defect | High/high | 2 | implemented | 5xx may be transient; retried once. |
| LNK-002 | Link access-restricted (401/403) | Status | Same | manual_review | Informational/high | 2 | implemented | Not a broken link. |
| LNK-003 | Link timeout / blocked / DNS failure | Error | Same | manual_review | Informational/medium | 2 | implemented | Not a broken link. |
| LNK-004 | Destination correctness | — | Every link | manual_review | Informational/— | 2 | manual | A 200 response does not prove the right destination. |
| LNK-005 | Malformed or empty href / `javascript:` link | href | Anchors | standards_warning | Low/high | 2 | implemented | — |

### Media (MED)

| ID | Check | Evidence | Applicability | Type | Sev/Conf | Ph | Cap | Limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MED-001 | Broken image (complete, naturalWidth 0, or failed request) | src (sanitized), state, screenshot crop | `img` after scroll/wait | automated_defect | High/high | 2 | implemented | Lazy images checked only after being brought into view. |
| MED-002 | Media element error (`MediaError`) or failed media request | Error code, src | `audio`/`video` | automated_defect | High/high | 2 | implemented | Metadata load ≠ guaranteed playback. |
| MED-003 | Video without caption/subtitle track metadata | Track list | `video` with audio | standards_warning | Medium/medium | 2 | implemented | Captions may be burned in or in a custom player; accuracy is manual (MAN-004). WCAG 1.2.2. |
| MED-004 | Media without visible controls | Attributes, custom controls detected | `audio`/`video` | heuristic_warning | Low/low | 2 | implemented (heuristic) | Custom players may provide controls. |
| MED-005 | Asset exceeds configured size threshold | Bytes (when observable), threshold provenance | Images, media | heuristic_warning | Low/high | 2 | implemented | Transfer size may be unavailable (cache, opaque). |

### Content text (TXT)

| ID | Check | Evidence | Applicability | Type | Sev/Conf | Ph | Cap | Limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TXT-001 | Placeholder text (lorem ipsum, TBD, TODO, XXX, `[insert …]`) | Matched text, element, state | Visible text | automated_defect | Medium/medium | 2 | implemented | Exclusion list per profile; intentional uses possible. |
| TXT-002 | Terminology rule violation (profile list) | Term, preferred term, context | Visible text | heuristic_warning | Low/medium | 2 | implemented | Context-dependent; no grammar review claimed. |

### Accessibility (A11Y, KBD)

| ID | Check | Evidence | Applicability | Type | Sev/Conf | Ph | Cap | Limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A11Y-ENG | Automated accessibility engine ran on this state | axe-core version, rules evaluated | Every reached state | manual_review | —/— | 3 | implemented | Records that axe-core ran, not that the state is accessible. |
| A11Y-AXE-* | Each axe-core rule (`A11Y-AXE-<axeRuleId>`), run with tags wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa, best-practice | axe version, rule ID, impact, up to 25 nodes per rule per state (selector, sanitized HTML, failure summary), tags | Every reached state, and frames axe can reach | standards_warning (WCAG-tagged), heuristic_warning (best-practice only) | Impact-mapped (below)/high (WCAG), medium (best-practice) | 3 | implemented | Automated rules cover a subset of WCAG. Violations → `failed`; incomplete → `needs_review` (finding type `manual_review`, informational); passes → `passed`; inapplicable → `not_applicable`. Results are grouped per rule and page URL, retaining every affected element and state. Frames axe cannot reach are reported by its `frame-tested` rule, not counted as passes. |
| A11Y-001..007 | Missing alt, empty alt on informative images, heading jumps, page language, accessible names, hidden focusable elements, target size | — | — | — | — | 3 | covered by axe | Delivered through axe-core rules instead of separate checks: `image-alt` (A11Y-001; `alt=""` is treated as decorative and not reported), `heading-order` (A11Y-003, a heuristic warning, not proof of a WCAG failure), `html-has-lang` / `html-lang-valid` (A11Y-004), `button-name` / `link-name` / `label` / `input-button-name` (A11Y-005), `aria-hidden-focus` (A11Y-006), `target-size` (A11Y-007). A11Y-002 (informative image with empty alt inside a control) is covered by `link-name` / `button-name`. |
| A11Y-008 | Content reflows at 320 CSS px without horizontal scrolling | Scroll width, overflowing elements | Every reached state | heuristic_warning | Medium/low | 3 | implemented (heuristic) | Viewport simulation, not zoom. Fixed-size stages (for example Storyline) may be flagged; two-dimensional content is allowed by the criterion. WCAG 1.4.10 (relevant). |
| KBD-001 | Keyboard trap while tabbing | Focus sequence, confirmation attempt (Escape + further Tab) | Reached states without an open dialog | automated_defect | High/medium | 3 | implemented | At most 60 Tab presses per state; reports only a trap that survives Escape and more Tab presses. Frames: focus inside an iframe is not followed. WCAG 2.1.2 (relevant). |
| KBD-002 | Focus indicator not visible | Computed style focused vs unfocused | Elements focused during the Tab journey | heuristic_warning | Medium/medium | 3 | implemented (heuristic) | Compares outline, shadow, border, background, color, text decoration; not pixels. Subtle or low-contrast indicators need manual review. WCAG 2.4.7 (relevant). |
| KBD-003 | Recognized dialog: focus enters, is contained (if modal), returns on close | Active element after open, focus sequence while open, active element after close | Dialog openers that worked with the mouse | automated_defect | Medium/medium | 3 | implemented | Closing uses the dialog's own close button; Escape is not required. Containment only for `aria-modal` dialogs. At most 12 keyboard activations per scan. |
| KBD-004 | Recognized control reachable and operable by keyboard | Focusability, result of Enter then Space | Tabs, expandable sections, dialog openers that worked with the mouse | automated_defect | High/medium | 3 | implemented | Only generic-adapter-recognized controls; at most 12 keyboard activations per scan. WCAG 2.1.1 (relevant). |

### Layout, responsive, visual (LAY, VIS)

| ID | Check | Evidence | Applicability | Type | Sev/Conf | Ph | Cap | Limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LAY-001 | Unintended horizontal page overflow | scrollWidth vs viewport, offending element bounds, annotated screenshot | Each viewport | heuristic_warning | Medium/medium | 4 | implemented (heuristic) | Intentional scroll containers excluded. |
| LAY-002 | Likely clipped text | scroll vs client dimensions, overflow style, crop | Text elements | heuristic_warning | Medium/low | 4 | implemented (heuristic) | Ellipsis/intentional truncation possible. |
| LAY-003 | Control obscured by another element | Hit-test at control center, bounds | Interactive elements | heuristic_warning | Medium/low | 4 | implemented (heuristic) | Overlays, tooltips, badges excluded. |
| LAY-004 | Dialog off-screen | Dialog bounds vs viewport | Open dialogs | heuristic_warning | Medium/medium | 4 | implemented (heuristic) | — |
| LAY-005 | Font failed to load | FontFace status, failed request | Every state | automated_defect | Low/high | 4 | implemented | — |
| VIS-001 | Baseline screenshot differs | Diff image, ratio, matching config key | Controlled baselines only | manual_review | Informational/medium | 4 | implemented | Diff is a review signal, not a defect. Incompatible configs never compared. |
| PERF-001 | Threshold exceeded (load timing, transfer, largest asset) | Metric, threshold + provenance, conditions | Top document | heuristic_warning | Low/medium | 4 | implemented | Not a performance audit; cache, network, machine affect results. |

### Client profile / brand (BRD)

| ID | Check | Evidence | Applicability | Type | Sev/Conf | Ph | Cap | Limitations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| BRD-001 | Font family not in approved list | Computed style, element | Profile with fonts | heuristic_warning | Low/medium | 5 | heuristic | Requires user-supplied values and a stated source. First font in the computed list only; icon fonts skipped. |
| BRD-002 | Color outside approved palette tolerance | Computed color, nearest approved, ΔE | Profile with colors | heuristic_warning | Low/low | 5 | heuristic | Text colour only; black, white, grey ignored; images/gradients not evaluated. CIEDE2000, default tolerance 10. |
| BRD-003 | Text below profile minimum size | Computed font-size | Profile rule | heuristic_warning | Low/medium | 5 | heuristic | Measured at the primary screen size. |

### Package, SCORM, fidelity (PKG, SCO, FID) — Phases 6, 7, 9

| ID | Check | Ph | Cap |
| --- | --- | --- | --- |
| PKG-001 | Archive rejected (limits, traversal, symlink, duplicate, encrypted) | 6 | planned |
| PKG-002 | `imsmanifest.xml` well-formed | 6 | planned |
| PKG-003 | Declared SCORM version detected | 6 | planned |
| PKG-004 | Launch file resolves | 6 | planned |
| PKG-005 | Missing local reference / case mismatch | 6 | planned |
| PKG-006 | External dependency declared or requested | 6 | planned |
| PKG-007 | Multiple organizations/SCOs — scan selection disclosed | 6 | planned |
| SCO-001..n | SCORM 1.2 / 2004 lifecycle, commit, resume, status/score transitions (separate rule sets per version) | 7 | planned |
| FID-001..n | Storyboard text match / omission / alteration / unverified | 9 | planned |

Detailed columns are added when each phase begins.

### Manual review tasks (MAN)

Always listed in reports; never auto-passed.

| ID | Task |
| --- | --- |
| MAN-001 | Logical focus order matches visual/reading order (WCAG 2.4.3). |
| MAN-002 | Screen-reader experience of key interactions. |
| MAN-003 | Alt text adequacy for informative images. |
| MAN-004 | Caption/transcript accuracy and media equivalence. |
| MAN-005 | Link destinations are correct. |
| MAN-006 | Canvas-rendered and unreached content. |
| MAN-007 | Color contrast on images, gradients, and video. |
| MAN-009 | Zoom, text spacing, and orientation (WCAG 1.4.4, 1.4.10, 1.4.12, 1.3.4). |
| MAN-010 | Time limits, motion, and flashing (WCAG 2.2.x, 2.3.1, 1.4.2). |
| MAN-008 | Target-LMS completion, resume, score, and certificate behavior (Phase 7). |

## Capability matrix (summary)

| Area | Implemented | Planned (deterministic) | Heuristic | Manual |
| --- | --- | --- | --- | --- |
| Load / runtime / network | RUN-001..006, NET-001..003 (Phase 1) | — | RUN-003 | — |
| Traversal & coverage | NAV-001..003, COV-001..004 (Phase 2a) | — | NAV-002 (inconclusive) | MAN-006 |
| Links | LNK-001..003, LNK-005 (Phase 2b) | — | — | LNK-004, MAN-005 |
| Media | MED-001..003, MED-005 (Phase 2b) | — | MED-004 (Phase 2b) | MAN-004 |
| Text | TXT-001 (Phase 2b) | — | TXT-002 (Phase 2b) | — |
| Accessibility | A11Y-ENG, A11Y-AXE-* (Phase 3), A11Y-001..007 via axe, KBD-001, KBD-003, KBD-004 | — | A11Y-008, KBD-002 | MAN-001..003, MAN-007, MAN-009, MAN-010 |
| Layout / visual / perf | LAY-005, VIS-001 (Phase 4) | — | LAY-001..004, PERF-001 (Phase 4) | — |
| Brand | — | — | BRD-001..003 (Phase 5; only with a profile that supplies brand values) | — |
| Package / SCORM / fidelity | — | PKG-*, SCO-*, FID-* | — | MAN-008 |

The "Implemented" column is updated as each phase lands; see [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md).
