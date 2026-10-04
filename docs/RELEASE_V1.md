# V1 release notes and gate

Status: **release candidate for local use by a small team that understands the limits below.** Not a certification tool.

## What V1 is

A local web app that scans a published course URL, clicks through what it can reach, runs automated checks, and gives a course developer "what to change and where" with screenshots, plus a trackable Excel workbook, a self-contained HTML report, a PDF, and a JSON export. It runs on one computer, needs no account and no AI service, and stores everything locally.

## Supported surfaces

| Surface | Status |
| --- | --- |
| Public URL of a course (Rise share link, Storyline `story.html`, custom HTML) | Supported. See validation below |
| Same-origin pages, ARIA tabs, accordions, `<details>`, dialogs, Next/Back, in-scope links, hash-routed lessons | Explored with bounded limits and an honest coverage report |
| Links, images, audio/video (including captions), placeholder and production-note text, terminology | Checked |
| Automated accessibility (axe-core), keyboard journey and control operation | Checked; never establishes compliance |
| Screen sizes (desktop, laptop, tablet, mobile), overflow/clipping/obscured/off-screen/font heuristics, page-load evidence, visual baseline compare | Checked as heuristics; Storyline is not tested at other screen sizes by default |
| Client profiles: brand fonts, colours, minimum text size (as supplied), terminology, link policy, screen sizes, thresholds, scope, switched-off rules, priority changes | Supported |
| Finding status, owner, reasons, history; retest with Verified / Not reproduced / Not retested | Supported |
| Reports: JSON, HTML, PDF, Excel (per scan, per course, per project), from one report model | Supported |
| Backup and restore, retention, deletion, offline operation with the sample pack | Supported (command line for backup/restore/retention) |

## Not in V1

- Shared use by a team, sign-in, hosting (the app is bound to loopback; shared hosting needs authentication first).
- Containerized worker.
- AI recommendations (no AI is used, and there is nowhere to enter a key).
- LMS behaviour. A SCORM 1.2 / 2004 test harness checks what a course sends (Phase 7), but it is not an LMS and says nothing about how yours behaves. Storyboard fidelity comparison is a later phase. Package upload and static inspection are in (Phase 6); the scan of an uploaded package is not isolated in a container.
- Authenticated courses (anything behind a sign-in cannot be scanned; a Review 360 link, for example, needs sign-in and is unusable).
- Real devices, screen readers, or browsers other than Chromium.
- Importing Excel status changes back into the app (the workbook is a one-way export; status is changed in the app).

## Validation status

| Authoring tool | Status |
| --- | --- |
| Rise (share link) | **Partial.** One Rise course was scanned and drove fixes (late-rendered controls, aborted requests, late titles). Not validated across versions, block types, or large courses |
| Storyline 360 (`story.html`) | **Partial.** Two courses scanned (one Aptara-hosted, one Storyline 360). Fixed-stage handling, script links, and inline placeholder video were fixed from these |
| Older Storyline (2/3), Captivate, Lectora, custom HTML from other teams | **Pending.** No samples supplied. Only the fixture pack covers custom HTML patterns |
| Courses with video, audio, large media, or LMS-only behaviour | **Pending.** Fixture coverage only |

"Partial" means the scanner ran on real output and its findings were reviewed by hand for false positives; it does not mean every feature of that tool is covered. Please send further samples; each real course so far has found a real gap.

## Remaining manual QA (do before relying on a result)

Every report carries the manual review checklist. For a release of a course, a person still needs to:

1. Test with a screen reader and by keyboard only; check reading order and dynamic announcements.
2. Check captions and transcripts for accuracy, and audio/video for playback.
3. Check colour, contrast in images, and focus visibility where automation could not decide.
4. Test in the LMS (SCORM tracking, completion, bookmarking), on real phones/tablets, and in other browsers.
5. Check content accuracy, tone, and fidelity to the storyboard.
6. Read the "Check by hand" and "Not checked" lists in the report; they are not passes.

## Release gate checklist

| Gate | Result |
| --- | --- |
| Typecheck clean | See docs/IMPLEMENTATION_STATUS.md for the run on the release commit |
| Full automated suite passes (real Chromium against fixtures) | See docs/IMPLEMENTATION_STATUS.md |
| Offline run of the sample pack produces JSON, HTML, PDF, and Excel with no name lookups | Automated test `tests/offline.e2e.test.ts` |
| Reports escape course text; HTML and PDF make no network requests | Automated test `tests/report-formats.test.ts` |
| Skipped/not-tested checks never counted as passed; denominators stated | Automated tests `report-export`, `report-formats` |
| Verified status only when rule and equivalent screen were retested | Automated test `tests/retest.test.ts` |
| Backup is verified, restore refuses damaged or unsafe files and keeps previous data | Automated test `tests/ops.test.ts` |
| No AI key field anywhere; AI not used in any result | Automated test `tests/ops.test.ts`; reports state it |
| Network policy has no exemptions unless an administrator sets `CQA_ALLOW_LOCAL_TARGETS` | `tests/policy.test.ts`, `tests/ops.test.ts` |
| Validation on supplied Rise / Storyline / custom HTML samples | Partial; see table above |
