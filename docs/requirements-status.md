# Requirements status

The final list for the Playwright integration pack (15 phases) and the audit of 9 November 2026, as of 13 November 2026. **Implemented** means built and tested; **partial** means built with a stated gap; **not supported** means deliberately not done or not possible here. Evidence for each item is in `docs/playwright-integration-progress.md` (a section per phase) and `docs/audit-2026-11-09-status.md`.

## Implemented

- **Phase 2:** browser start and crash handling, with plain failure reasons; a configurable scan limit.
- **Phase 3:** upload and launch of SCORM 1.2, SCORM 2004 and HTML5 packages; blank and soft-error launches detected; unsafe archives refused.
- **Phase 4:** a result model in which skipped, unsupported, inconclusive, blocked and untested results are never counted as passed, and retried passes keep their history.
- **Phase 5:** discovery and honest coverage. Unknown totals stay unknown, and screens that were not reached are listed.
- **Phase 6:** recipes for tabs, accordions, dialogs, Next and Previous, flip cards, ARIA carousels, audio and video.
- **Phase 7:** conditional rules. They are locked until met, a repeat does not stand in for a missing item, the named outcome must appear, and media requirements are supported. Rules are versioned, import is limited to data, and draft or inferred rules give no verdict.
- **Phase 8:** quiz checks against a supplied answer key, which is never guessed. SCORM checks compare what the screen says with the tracking. The Rise load workaround is disclosed.
- **Phase 9:** evidence. Each failed check keeps a browser trace from its first attempt, each attempt keeps its own evidence, a save that fails is reported, and there is an evidence archive with a manifest.
- **Phase 10:** live progress built from stored records; repeated or late updates are handled; the course index can be searched.
- **Phase 11:** HTML and PDF reports include coverage with its denominators, every screen and reviewer decisions; partial and cancelled scans are labelled; text is escaped and protected against formula injection.
- **Phase 12:** the frame allow-list is tightened; the browser check starts the browser as scans do; two concurrent scans and a storage failure are shown not to corrupt results.
- **Phase 13:** a detection scorecard and a Playwright Test project for the tool's own screens.
- **Phase 14:** two scans can be compared; a finding is resolved only when the same check passed again in comparable conditions; retests use the same judgement.
- **Audit A1 to A5:** exact retest matching, the worker lock, coverage gaps in summaries, player controls shared between screens, and draft rules.

## Partial

- **Storyline:** the slide walk reached at most slide 19 of 52 on the one real Storyline course. Hotspots and layers are handled only as walk steps.
- **Rise blocks:** process, gallery, labeled graphic, sorting and scenario blocks have no recipe, and no real sample of them has been tested.
- **Player controls:** they are recognised by name and fixed address, not by the adapter knowing that a control belongs to the player.
- **Isolation:** the browser sandbox and network policy are on, but a browser context is not a full security boundary. A container or VM is a deployment prerequisite for hostile courses.
- **Real-course validation:** one Rise course. No real course with known faults has been scanned.
- **Platforms:** Windows only is verified. Linux and macOS instructions are unverified.

## Not supported

- **Audit A6:** rules do not look inside a course frame.
- **Audit A7:** "nothing happens" checks are capped at 3 seconds, and 800 ms while media is playing.
- **Rule options:** the stored `prerequisites` and `resetPolicy` options are not acted on.
- **LMS behavior:** only the built-in SCORM test harness is used; no real LMS is tested.
- **Drag and drop:** not tested as a check; it is used only as a walk step.
- **Canvas content:** reported as Not supported.
- **Other browsers:** only Chromium is used.
- **Login and multi-user access:** none; the tool must stay on the local computer.
- **Video recording of scans:** not added (optional in the pack).
