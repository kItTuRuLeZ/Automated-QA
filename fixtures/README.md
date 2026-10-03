# Test fixtures

Local course fixtures served by `tests/support/fixture-server.ts` on `127.0.0.1` during tests. They contain no client content or sensitive data.

| Fixture | Purpose |
| --- | --- |
| `healthy/` | Clean page: title, stylesheet, image. Expect no findings. |
| `missing-asset/` | 404 script and 404 image (RUN-004). |
| `js-exception/` | Console error (RUN-003) and uncaught exception on load (RUN-002). |
| `blocked-subrequest/` | Image from `169.254.169.254`; must be NET-002, not RUN-004. |
| `no-title/` | Missing `<title>` (RUN-005). |
| `late-title/` | Title set 1.5 s after load; must not be RUN-005. |
| `aborted-fetch/` | Page aborts its own fetch; must not be RUN-004. |
| `spa-lessons/`, `tabs/`, `accordion/`, `modal/`, `nav-loop/` | Traversal: hash-routed lessons, working and broken tabs/sections/dialogs, a cycling Next. |
| `a11y-known/`, `reflow-wide/` | Known axe-core defects (missing alt, label, button name, lang, contrast, headings); decorative and described images that must not be flagged; 900 px fixed layout (A11Y-008). |
| `dialog-good/`, `dialog-broken/`, `keyboard-trap/`, `focus-style/`, `keyboard-controls/` | Working and broken modal dialog keyboard behavior; a Tab trap; four focus styles; native, mouse-only, and click-only controls (KBD-001..004). |
| `late-controls/` | Tabs rendered 3 s after the page looks stable; discovery must look again. |
| `layout-overflow/`, `layout-clipped/`, `layout-intentional/`, `layout-obscured/`, `layout-dialog/`, `layout-fonts/`, `responsive-hidden/` | Screen-size checks: a 900 px block, clipped text (with ellipsis, line clamp, scroller, hidden helper text that must not be flagged), intentional overlaps that must not be flagged, a covered button, an off-screen dialog, a missing web font, a control that only exists on wide screens (LAY-001..005). |
| `storyline-like/` | Defines Storyline's loader global and a fixed 900 px stage; screen sizes beyond the first must be skipped, with an override. |
| `perf-heavy/` | Two large images for page-load thresholds (PERF-001). |
| `inconsistent-control/` | A control that works in one state and not another (review item, not a defect). |
| `authoring-patterns/`, `slow-first-tab/` | Storyline-style script links, inline placeholder video, player controls, Back to top, Start Course; a control slow only the first time (must not be reported). |
| `brand/` | Approved and off-palette colours, an unapproved font, tiny text; used with a client profile (BRD-001..003). |
| `canvas/`, `unsafe-actions/` | Canvas disclosure (COV-003); unsafe and ambiguous controls skipped (COV-001). |
| `lazy-image/`, `broken-media/` | Lazy valid/broken images, oversized image, playable and missing audio/video, uncaptioned video (MED-001..005). |
| `placeholder-text/`, `hidden-placeholder/` | Placeholders and production notes, exclusions, hidden text, placeholder revealed only by expanding (TXT-001/002). |

Dynamic routes in the fixture server: `/baseline/` (blue or red block, chosen by the test, for visual baselines), `/links/` (link page) and `/links/*` (200, 404, 410, 401, 403, slow, HEAD-405, redirects, redirect to a private IP), `/media/*` (generated WAV, VTT, oversized PNG), `/iframe/` (out-of-scope, blocked, and in-scope frames), `/redirect/in` (302 to `/healthy/`), `/redirect/out` (302 to a second origin, outside scope), `/slow` (responds after the navigation timeout), `/http-404` (404 document).
