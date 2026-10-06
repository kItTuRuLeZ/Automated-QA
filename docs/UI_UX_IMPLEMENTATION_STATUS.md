# UI and UX implementation status

Source: `Automated-QA-UI-UX-Improvement-Claude-Code.md` (brief dated 2026-10-05, written against commit `0c6171e`). Work done on top of `0c6171e`, which already contained the Rise/Storyline adapters.

**State:** Phases 0 to 6 implemented. Live checks ran in real Chromium against the built app. Items that could not be checked are listed under "Pending" and were not claimed.

## Phase 0: baseline

- Read: `App.tsx`, `styles.css`, `api.ts`, every page and component under `apps/web/src`, the report model (`packages/core/src/report.ts`), the workbook export, the issue workflow, and the existing tests.
- No `AGENTS.md` in the repository.
- Baseline screenshots (1440×900 and 390 px, demo data from the sample course pack): [`docs/ui-ux/before/`](ui-ux/before/).
- Baseline behaviour recorded: project creation inline form; one long project page (upload, 20-field scan form, Excel links, history); results on one long page; check executions inside a collapsed section as an unpaginated table; report downloads as four plain links; About page led with a capability table.

Demo data without touching real projects: `scripts/ui-demo.ts` seeds a throwaway data folder through the app's own API using the sample course pack, and `scripts/ui-screens.ts` captures screenshots from it (see the header comments in both). The "before" and "after" screenshots come from the same demo data.

## Checklist

| Phase | Item | Status |
| --- | --- | --- |
| 1 | Navigation: Projects, Client settings, Help; current page marked; wraps on narrow screens | Done |
| 1 | Breadcrumbs use project and course names (captured page title, else readable address) | Done |
| 1 | Reusable page header, tabs, alert, pagination, copy button, export menu, screenshot viewer, issue status | Done (`components/`) |
| 1 | System font kept, 16 px body, no hosted fonts or CDN, no gradients or charts | Done |
| 1 | Skip link, focus to main on page change (not on tab change), visible focus, text with every colour | Done; automated axe check passes on 8 pages |
| 2 | Projects: description, search (shown above 4 projects), latest scan, next action, "No scans yet", copy full address | Done |
| 2 | Project page: Overview, Course files, Scan history tabs; Start new scan in the header | Done |
| 2 | Three-stage scan setup, Back keeps values, Enter means Next | Done |
| 2 | Advanced settings keep technical controls; values are sent while the section is closed | Done (tested) |
| 2 | ZIP path: upload box (drag and drop plus file input), limits read from `/api/package-limits`, inspection screen says nothing has run, acknowledgement still required | Done |
| 2 | Plain-language errors: blocked address, invalid values, app not reachable, browser not installed | Done |
| 2 | Duplicate submission prevented | Done (tested with a double click) |
| 3 | Honest states: queued (one scan at a time), running (elapsed time and screens captured so far, no percentage), cancelling, failed, cancelled, partial; keeps polling after a lost connection | Done (tested) |
| 4 | Course title, breadcrumb, source, date; "Scan finished — review the results"; coverage limit beside it | Done |
| 4 | Counts by unit: Issues to fix, Needs your review, Coverage gaps (areas), and separately Checks that did not run (executions) | Done |
| 4 | Findings in this scan vs Open work remaining | Done |
| 4 | Tabs: Summary, Issues, Coverage, Manual review, Technical details | Done |
| 4 | Issues: search, type, priority, status filters; open work by default, "include finished work"; 25 per page | Done |
| 4 | Issue detail: what happened, why it matters, where, what to do; stable ID kept | Done |
| 4 | Evidence viewer: preview, actual size, zoom, original in a new tab, Escape closes, missing file explained | Done (tested) |
| 4 | Status feedback: Unsaved changes, Saving, Saved, Not saved (never Saved after a failure) | Done (tested) |
| 4 | Technical details: check executions searchable, filterable by result, 50 per page | Done (tested) |
| 5 | Download report menu with scope text, preparing and error states, JSON under technical exports | Done (tested) |
| 5 | Help: how to use, limits of results, System status leading with readiness | Done |
| 5 | Workbook Summary labels the two "not checked" units | Done (tested) |
| 6 | Typecheck, build, tests, screenshots | See below |

## Tracing "Not checked = 0" in the sample workbook

The Summary sheet's "Not checked" column counts **listed areas** (`counts.notChecked` in the report model: frames, canvas, skipped controls, scan limits). The "Not checked" sheet's second table counts **check executions that did not run**, by reason (`untested`). They are different units, so a scan can show 0 areas and still have executions that did not run. Nothing was miscounted. Changes:

- Summary column renamed **Areas not checked**.
- New Summary column **Checks that did not run** (check executions, from the same `untested` list), as column 9 so existing column positions did not move.
- A note under the Summary table explains both.
- The results Summary shows the same two numbers, each with its unit, from the report API (no separate front-end calculation).

## Verification run

| Check | Result |
| --- | --- |
| `npm run typecheck` (all workspaces) | Passed |
| `npm run build -w @cqa/web` | Built |
| `tests/ui-flows.e2e.test.ts` (new, 15 tests, real Chromium against the built app) | 15 passed |
| `tests/own-ui.accessibility.test.ts` (axe-core, reflow at 320 px, focus, keyboard trap) now on 8 pages including the new scan setup, issues, coverage, technical and help pages | Passed (it found one contrast defect in a pressed button, fixed) |
| `tests/report-export.test.ts`, `tests/report-formats.test.ts` | Passed |
| Full suite | See the final line of this section |
| Screenshots | 1440×900, 1366×768, 720 px wide (what 200% zoom looks like at 1440), 390 px: [`docs/ui-ux/after/`](ui-ux/after/) |

What the new tests cover, mapped to the brief's minimum checks: 1 existing data and deep links; 2 queue a scan without Advanced; 3 advanced values, Back and Next; 4 ZIP inspection and acknowledgement; 5 double click queues one scan; 6 queued, running, cancelled, failed, partial states; 7 summary, workbook and report model agree and each count has its unit; 8 owner and status save, failure shows no "Saved", no way to set Verified; 9 filters, pagination and missing evidence; 10 an Excel download and a failing PDF; 11 keyboard: Enter, Escape in the menu and viewer, focus return; 12 no sideways page scroll at 390 px.

## Pending, not verified, or deliberately not done

- **Not tested by a person:** keyboard-only use of every screen, a screen reader, 200% browser zoom on a real display (checked as a 720 px layout), and real phones. Run the manual pass before a stakeholder demo.
- **Multi-lesson ZIP selection** keeps its existing behaviour on the package page; the new tests cover single-lesson inspection and the acknowledgement. Existing API tests (`tests/packages.integration.test.ts`) still cover lesson selection and "not scanned" reporting.
- **Project list course names** use the captured title only on the results pages. The project list shows the project name and a readable address, because resolving titles would need one extra request per project.
- **Failed scan "Retry"** starts a new scan of the same course through the setup screens (it does not re-run the failed scan).
- **Progress stages** (Opening course, Checking content, ...) are not shown: the backend only reports queued, running and finished, so only those are shown, with elapsed time and screens captured so far.
- **Presets** were not added (optional in the brief).
- **Package scans** use the package page's own options (lessons, outside sites, harness, acknowledgement); the three-stage flow applies to published links.
- Per-scan screens are not renamed in exports; screen IDs (S1, S2) stay as the secondary identifier next to captured titles on screen.
- Excel trackers remain a one-way export; the menu says so.
