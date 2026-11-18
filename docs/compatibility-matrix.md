# Compatibility matrix

What this tool has actually been run against, and with what result. **Synthetic** means a local test page built for this purpose (`fixtures/`). **Real export** means a course a person exported from an authoring tool and supplied. Nothing here claims the tool works with every course, authoring tool version or LMS.

Last updated 17 November 2026, on Windows 11 with Playwright 1.64.1 and its Chromium (headless shell). No other browser has been tested.

## Real exports

| Course | Type and export | Environment | What was exercised | Outcome | Evidence |
| --- | --- | --- | --- | --- | --- |
| Leadership Expectations (CoBank) | Rise 360, SCORM package | Built-in SCORM test harness, not an LMS | Lesson walk (Continue buttons), tabs, flip cards, video, navigation menu, links, accessibility and layout checks | **Completed** on 17 Nov 2026: 12 of 14 lessons visited (2 not reached); 89 of 114 automated checks ran, 88 passed and 1 failed (MED-02: the video has no caption track, a real course issue). 30 of 106 detected interactions exercised; 58 manual checks remain; inventory discovery partial. Compared with the 7 Nov scan, all 26 findings are still there and none is new. | Scan `4e4de181` in the CoBank project (17 Nov 2026). Its HTML report shows the same 88 passed and 1 failed. Its evidence archive holds 56 files, all listed in its manifest. Earlier scans of 7 Nov. |
| Leadership Expectations, rescan | Same package | Built-in SCORM test harness | As above, with knowledge checks answered from the course's own data, plus the new package, caption and spelling checks | **Partial** (one replay step failed once) on 17 Nov 2026: all 12 lessons visited; 100 automated checks passed, 1 failed (MED-02). Package checks found the oversized image, video and package, the uncaptioned video, file names with spaces, and four words to review including two real typos. Compared with FULLPASS's report of the same package: same real findings, without its four wrong ones | Scan `539540f0` in the CoBank project; see "Follow-up: comparison with FULLPASS" in `docs/playwright-integration-progress.md` |
| Cyber Resilience Act | Storyline, SCORM package | Built-in SCORM test harness | Slide walk | **Partial.** The furthest it got was slide 19 of 52, so most slides were never reached | Earlier scans; see `docs/playwright-integration-progress.md` |

No real export with **known, seeded faults** has been scanned yet. The pilot needs at least one (see `docs/pilot-checklist.md`).

## Synthetic fixtures (deterministic, with seeded faults)

Measured by the detection scorecard (`npm run test:scorecard`, 13 Nov 2026):
- 27 of 27 seeded defects were caught, each for the right reason.
- 3 of 3 items the tool cannot judge were classified as unsupported.
- 0 of 158 checks with a result on known-good fixtures were wrongly failed.
- Repeat scans gave the same results.

| Area | Fixtures | Outcome |
| --- | --- | --- |
| Flip cards, carousels, audio, video | `recipes-good`, `recipes-broken` | Faults caught. An undecodable video and a one-sided card are reported as Not supported |
| Tabs, accordions, dialogs, Next/Previous | `functional-good`, `functional-broken`, `tabs`, `accordion`, `dialog-*` | Faults caught |
| Conditional rules | `logic-*` (early unlock, repeat counted, wrong outcome, never fires, optional counted, order, timing, media) | Faults caught |
| Quizzes with an answer key | `assess-quiz` with five seeded faults | Faults caught |
| SCORM tracking | Generated SCORM 1.2 and 2004 packages | Lifecycle, saving, status, resume, screen-versus-tracking; harness only |
| Runtime problems | `missing-asset`, `broken-media`, `js-exception` | Caught |
| Content the tool cannot inspect | `canvas`, out-of-scope frames | Reported as Not supported, never passed |

## Environments

| Environment | Status |
| --- | --- |
| Windows 11, Node 24, development workflow (`npm start`, `npm test`, `npm run test:ui`) | **Verified** 13 Nov 2026 |
| Linux server | **Unverified.** Instructions in `docs/SETUP.md` are not tested there |
| macOS | Unverified |
| A real LMS (Moodle, SCORM Cloud, others) | **Not tested.** Results come from the built-in test harness, which is not an LMS |
| Browsers other than Chromium | Not tested |
