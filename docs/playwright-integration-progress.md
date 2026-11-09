# Playwright integration progress

Tracks the phases in `supporting-files/prompts/Automated_QA_Playwright_Integration_Prompts.md`. Each entry records what was verified, not what was planned.

| Phase | Status | Evidence |
| --- | --- | --- |
| 1. Audit | Done (3–4 Nov 2026) | `docs/playwright-integration-audit.md`; test run below |
| 2. Browser execution foundation | Done (4 Nov 2026) | See "Phase 2" below |
| 4. Result model | Done (4 Nov 2026) | See "Phase 4" below |
| 3. Upload and launch | Done (4 Nov 2026) | See "Phase 3" below |
| 5. Discovery and coverage | Done (6 Nov 2026) | See "Phase 5" below |
| 6. Interaction recipes | Done (7 Nov 2026) | See "Phase 6" below and `docs/interaction-support-matrix.md` |
| 7. Conditional rules | Done (9 Nov 2026) | See "Phase 7" below |
| 8–15 | Not started | |

## Phase 1 test run

Run on 3 Nov 2026, Windows, Node 24.21.0, Playwright 1.64.1, Chromium 156.0.8078.4. The run used `PLAYWRIGHT_BROWSERS_PATH=%LOCALAPPDATA%\ms-playwright`, because the user-level value points at a missing folder.

Command:

```
npx vitest run tests/browser-hardening.test.ts tests/packages.static.test.ts tests/packages.integration.test.ts tests/scorm-harness.test.ts tests/scorm.integration.test.ts tests/scan.integration.test.ts tests/traversal.integration.test.ts tests/functional.integration.test.ts tests/real-course-qa-enhancements.test.ts
```

Each file was run on its own. The run was paused at the owner's request after 4 of the 9 files:

| File | Result | Time |
| --- | --- | --- |
| browser-hardening | 1 passed | 33 s |
| packages.static | 22 passed | 39 s |
| packages.integration | 7 passed | 108 s |
| scorm-harness | 13 passed | 14 s |
| scorm.integration | 8 passed | 211 s |
| scan.integration | 14 passed, **1 failed** | 186 s |
| traversal.integration | 12 passed, **2 failed (timeouts)** | 431 s |
| functional.integration | 16 passed | 800 s |
| real-course-qa-enhancements | 13 passed | 32 s |

The last 5 files ran on 4 Nov 2026. **Total: 113 passed, 3 failed.**

What the failures are:

- **`scan.integration` › "HTTP 404 document completes the scan with a critical RUN-001 finding":** expected run status `completed`, got `failed`. **Correction (6 Nov):** this was first recorded as pre-existing and failing on the last commit. That was wrong: the comparison copy shared the working tree through workspace links, so it ran the current code. The real cause was the then-uncommitted soft-404 check in `capture.ts`, which also treated a real HTTP 404 titled "Not found" as a soft error. Fixed on 6 Nov: soft-error and blank checks now run only for pages that answered below 400. See "Final run" below.
- **`traversal.integration` › "tabs: working tabs pass…" and "accordion: expands working sections…":** both hit the 60 s test timeout. They passed when re-run alone, on the working tree (the comparison on a copy of the last commit is not valid evidence, for the reason above). The failing run overlapped with starting the QA tool on the same machine. Treated as **timing-sensitive (flaky under load)**, not a confirmed defect. Phase 13 should give these tests more headroom or make them deterministic.

## Phase 2

The existing worker path was kept: browser launch, context, proxy and clean-up stay in `apps/worker/src/runner.ts`. No new service was added, and no second scan path, because the audit found the existing one was already the real Playwright path.

### What changed

- `apps/worker/src/browser-errors.ts` (new): `classifyBrowserError` maps a failure to a reason code and an actionable sentence:
  - `browser_unavailable`: the executable is missing or could not be spawned. The detail names the path, `npm run browsers:install` and `PLAYWRIGHT_BROWSERS_PATH`.
  - `browser_crashed`: the target, context or browser closed.
  - `timeout`: a Playwright timeout.
  - `engine_error`: anything else.
- `packages/shared/src/enums.ts`: reason codes `browser_unavailable` and `browser_crashed` added. They are stored as text, so no migration is needed.
- `apps/worker/src/runner.ts`:
  - **Launch failure:** classified. The run ends `failed` with that reason, and every owned check becomes `not_tested` with the same reason.
  - **Crash detection:** a browser that goes away mid-scan aborts the run as `browser_crashed`. This is detected through the `disconnected` event, `page.isClosed()` / `browser.isConnected()` after the first navigation, and an abort check before finalising. Engines that swallow errors can no longer turn a dead browser into "course page failed to load".
  - **Other failures:** classified instead of always `engine_error`.
  - **Test hook:** optional `launchBrowser` dependency, so tests can simulate a missing or crashing browser with the real Playwright API.
- `apps/worker/src/worker.ts`: the job loop runs up to `concurrency` scans at once. The default is 1; values above 4 are capped at 4. `concurrencyFromEnv` reads `CQA_WORKER_CONCURRENCY`, and `main.ts` uses it and logs it at start-up. Each scan keeps its own browser, context, proxy and temp folder.
- `tests/support/harness.ts`: `startWorker()` accepts `launchBrowser` and `concurrency` overrides.
- `docs/SETUP.md`: the new setting and two new troubleshooting rows.

### Tests (4 Nov 2026, `PLAYWRIGHT_BROWSERS_PATH=%LOCALAPPDATA%\ms-playwright`)

`tests/browser-session.test.ts` is new. All 8 failed before the change (6 failed, the default-limit guard passed as expected), then passed:

- missing-executable classification;
- crash classification;
- timeout and fallback classification;
- concurrency parsing;
- a missing browser through the real worker: run `failed`, reason `browser_unavailable`, all checks `not_tested`, job `done`, temp folder removed;
- a browser closed 1.5 s into a slow navigation: run ends `browser_crashed` within 20 s;
- limit 2: two scans `running` at once, both cancel cleanly;
- limit 1: the second scan stays `queued`.

The concurrency-parsing helper was written before its test.

| Suite | Result |
| --- | --- |
| browser-session (new) | 8 passed |
| scan.integration | 14 passed, 1 failed (the 404 test; see the correction in the Phase 1 test run) |
| server | 15 passed |
| packages.integration | 7 passed |
| scorm.integration | 8 passed |
| traversal.integration | 14 passed |
| functional.integration | 16 passed |

`tsc --noEmit` passes for `apps/worker` and `packages/shared`.

### Not done in Phase 2

- **Tracing:** Playwright traces belong to Phase 9.
- **Capability check:** the server's `/api/capabilities` checks `chromium.executablePath()` (full Chromium), but headless scans use `chromium_headless_shell`. It can say "available" when only one of the two is installed. The run-time error is now clear, but the capability check should be made to match.
- **Hardware limits:** concurrency above 1 is tested on fixtures only, not with real courses at the same time on this PC.
- **Browsers:** Chromium only. Firefox and WebKit are installed, but they are not used and not advertised.

## Phase 4

Done before Phase 3 because every later phase reports through these statuses. Much of the model already existed:
- separate test, screen and reviewer statuses;
- "an empty result is never a pass";
- blocked and runner errors kept apart from course defects;
- reviewer decisions stored beside the machine result;
- an expectation source on test definitions.

This phase filled the remaining gaps.

### What changed

- **New outcomes:** `unsupported` and `inconclusive` added for checks (`CHECK_OUTCOMES`) and for test executions (`TEST_STATUSES`). Both require a reason. Cancelled checks stay `not_tested` with reason `cancelled`, which the model already distinguished.
- **Migration 8** (`packages/core/src/db/migrations.ts`): rebuilds `check_results` with the wider CHECK constraint and copies every row unchanged.
  - On this PC the real database upgraded with all 42,927 results kept.
  - A full backup was taken first: `backups/course-qa-backup-2026-11-04-11-13-38.zip`.
- **Rollups:**
  - `statusFromChecks` (`qa/mapping.ts`) ranks: failed, then error, then not run, then inconclusive, then unsupported, then needs review, then passed. A pass next to an unsupported or inconclusive result is not a pass.
  - `countStatuses`/`gapCount` (`qa/aggregation.ts`) count unsupported, inconclusive and any unrecognised status as gaps. Before this, an unknown status was silently dropped, so a screen could show "passed".
  - Screens give a reason for each new gap.
- **Retry history:** `CheckResult.attempt` and `firstAttemptOutcome`. A traversal check that passes only on its second attempt is stored as `attempt: 2, firstAttemptOutcome: failed`.
- **Scanner:** COV-002 (frame not inspected) and COV-003 (canvas) record `unsupported` with a reason, instead of `needs_review`.
- **Progress counters:** `testsUnsupported` and `testsInconclusive`, shown in the progress panel. Older rows default to 0.
- **Reports:**
  - `checkTotals` gains `unsupported` and `inconclusive`.
  - Their reasons appear in the "did not run" list.
  - The HTML totals sentence lists them.
  - The web summary line now reads "Checks without a result".
- **Wording:** the screen label is "Passed configured checks" everywhere: app, exports, reviewer guide, status rules, capability matrix and the UI test. `docs/coverage-and-status-rules.md` documents the new statuses, retry history and unknown statuses.

### Tests (4 Nov 2026)

`tests/result-statuses.test.ts` is new, with 12 tests. They were watched failing before the change and now pass. They cover:
- the new statuses exist;
- unsupported or inconclusive alone, or next to a pass, is never a pass;
- a failure still wins;
- a screen with passes plus a gap is "Needs manual review";
- an error or exhausted timeout cannot become a pass;
- the database saves the new statuses and refuses them without a reason;
- retry history round-trips;
- the report and HTML export count them;
- a database at version 7 upgrades and keeps its rows.

Changed expectations, also watched failing first:
- `accessibility.integration` and `traversal.integration` expect `unsupported` for canvas and frames;
- the slow-first-tab test expects `attempt: 2, firstAttemptOutcome: failed`.

`report-formats` expects the new totals sentence.

22 files run one at a time:
- **All passed** except `scan.integration`, which has the 404 test that already failed before this work.
- **Two re-runs:** `report-formats` and `qa-ui.e2e` failed on the first run because the old sentence was still expected and the web bundle had not been rebuilt. Both passed after updating the sentence and rebuilding (8/8).
- **Type-check:** `tsc` passes for shared, core, worker, server and web.

### Not done in Phase 4

- **Wider use of the new statuses:** only canvas and frame limits use `unsupported` so far. Interaction recipes (Phase 6) and conditional rules (Phase 7) should use `unsupported` and `inconclusive` where they apply. The Storyline auto-reveal and quiz-answer notes still go to coverage only, not to stored results.
- **Retry history:** only the traversal retry records it. Functional-engine retries were not changed.
- **Report headings:** the HTML/Excel heading "Checks that did not run" now also counts not-supported and inconclusive checks. The wording was kept for compatibility with the UI test, but it should be renamed.

## Phase 3

Most of Phase 3 already existed and is covered by `packages.static` and `packages.integration`:
- extraction limits (size, count, expansion, ratio);
- rejection of `..`, absolute paths, drive letters, backslashes, symlinks, encrypted entries, duplicates and letter-case twins;
- malformed and non-ZIP uploads;
- manifest-driven launch choices with manual pick when there are several;
- a launch file that is missing, or differs only in letter case;
- missing-file references;
- a separate package origin with exact-case, read-only serving;
- no `file://` use.

This phase tested the remaining acceptance cases and fixed the two gaps they exposed.

### What changed

- **Unsafe names** (`packages/core/src/package/archive.ts`, `unsafeName`): entries are rejected when any path segment is a Windows device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`, with or without an extension) or ends in a dot or a space. Windows opens a device for the first, and silently drops the trailing character for the second, so two entries could land on one file.
- **Blank launch** (`apps/worker/src/engines/capture.ts`): after the first navigation and the existing soft-error check, the scan waits up to 8 s, or the navigation timeout if that is shorter, for any visible content. That means text, an image, SVG, canvas, video, object/embed, frame or a form control (`hasVisibleContent`). It uses a condition wait, not a fixed sleep. A page that stays empty is recorded as RUN-001 `failed` with "The page loaded but stayed blank…", so the run cannot pass a player that failed to start.

### Tests (4 Nov 2026)

`tests/package-launch.integration.test.ts` is new. It uses synthetic packages, labelled as such, run through the real upload API, package server, worker and Chromium:

| Case | Result before the change | After |
| --- | --- | --- |
| Launch file in `content/Lesson One/Café ü.html`, with an image `Bilder/Ölberg 1.png` | passed (already supported) | passed |
| `index_lms.html` wrapper that loads the course in an iframe; placeholder text only inside the frame is found (TXT-001) | passed (already supported) | passed |
| Launch page that loads and stays empty | **failed** (RUN-001 was `passed`) | passed |
| Canvas-only page is not called blank | passed (guard) | passed |

`packages.static` gained 4 unsafe-name cases. They failed before the change and pass after.

17 related files were run one at a time. All passed apart from the 404 test (see the correction in the Phase 1 test run) in `scan.integration`:
- 26 static, 7 packages, 4 launch, 8 browser-session, 12 statuses;
- 16 accessibility, 14 content, 18 layout, 14 traversal, 16 functional, 8 SCORM;
- 13 real-course enhancements, 2 offline e2e, 15 UI flows, 3 QA UI.

`real-exports` was skipped: it only runs when `CQA_REAL_EXPORTS` points at real exported courses, and that was not set.

### Not done in Phase 3

- **Real-export checks:** they were not repeated in this phase.
- **Frame content:** the wrapper test proves the content frame is chosen. Nested frames more than one level deep, and cross-origin frames, are still reported as not inspected (COV-002, now `unsupported`). Locators are not reacquired across frames beyond the existing content-root logic.
- **Blank check limits:** the check looks at the top page. A wrapper whose frame is itself blank counts as having content, because the frame is visible.
- **Outside prerequisites** (external media, sign-in walls): still reported through the existing blocked-request (NET-002) and soft-error (auth wall) checks, not as a new category.

## Phase 5

Already in place before this phase, with tests:
- expected inventory from the manifest and export, kept apart from units found only at run time;
- discovery completeness: complete, partial or unknown;
- "N found so far" with no percentage when the total is unknown;
- visits, executed checks, pass rate and interactions exercised kept apart;
- not-reached units with a reason;
- loop termination (`nav-loop`) and state, depth and runtime budgets.

### What changed

- **Run-time Rise detection:** `detectPlatform` (`apps/worker/src/adapters/layout-scripts.ts`) returns `rise` when the page has `[data-block-id]` or loads `lib/rise/`. Capture (`engines/capture.ts`) now asks every frame, so courses inside an LMS wrapper frame are recognised. `platform` gains `'rise'` in `CoverageSummary`. Side effect: a Storyline course inside a wrapper frame is now also recognised.
- **Rise block visibility:** `apps/worker/src/adapters/rise.ts`, `blocksScrolledIntoView`. On each Rise state, the scan scrolls the lesson top to bottom in learner-sized steps, waiting two animation frames per step instead of a fixed time. It records each `[data-block-id]` that appeared in the viewport, then restores the scroll position. `RunRecorder.blocksSeen` marks those listed block units as shown. Blocks the course does not list are ignored.
- **Coverage:** `CoverageSummary.blocksSeen` reports seen blocks out of listed blocks. The statement adds "N of M blocks were scrolled into view (seen, not tested)". There is no number when the course lists no blocks. Lesson visit coverage is unchanged.

### Tests

New tests, all passing:
- `qa-aggregation`: blocks-seen ratio and statement, and no block number without blocks. Both failed first.
- `package-launch.integration`:
  - A synthetic Rise-style package is recognised as `rise`. Two blocks are marked seen; a `display:none` block is not. This failed first.
  - Reaching an end screen with an unexplored branch: the end screen is reached, the branch page is not, coverage is not `complete`, and the branch control is listed under COV-001. This passed on its first run, so it records existing behaviour rather than proving a fix.

The full results are in "Final run" below. Type-check passed for all five packages.

### Not done in Phase 5

- **Rise interactions:** blocks are seen, not tested. Tests of Rise interactions such as flashcards, accordions, tabs, process and knowledge checks belong to Phase 6.
- **Rise block containers:** blocks inside Rise's own inner scroll containers (if a theme uses them) are only counted when they enter the window viewport.
- **Real export:** the Leadership Expectations course has not been re-scanned with this change yet.

## Final run (6 Nov 2026)

Every test file was run one at a time with `PLAYWRIGHT_BROWSERS_PATH=%LOCALAPPDATA%\ms-playwright`, because this session still had the old value:

- **All pass:** 30 files, 361 tests, after the two fixes below. The 31st file, `real-exports`, is skipped because it needs `CQA_REAL_EXPORTS`.
- **404 test:** fixed by limiting the soft-error and blank checks to pages that answered below 400 (see the correction under Phase 1).
- **`own-ui.accessibility`:** ran for the first time in this work and failed on low-contrast text in the uncommitted Projects and New Scan pages. Text colours `#94a3b8` and `#64748b` on those pages are now `#475569`. It passes, and `qa-ui.e2e` and `ui-flows.e2e` were re-run after the change and pass.

### Review notes for later phases

These were committed because they are not defects in the scans so far, but they need follow-up:

- **Frame allow-list** (`isAllowedContentFrameOrigin`): the last-two-labels rule treats any two `*.co.uk` sites as one organisation, and `endsWith('articulate.com')` also matches `evilarticulate.com`. It only chooses which frame is checked; network scope still applies. Tighten it in Phase 12.
- **Rise bypass and answer guessing** stay until Phases 7–8 replace them (owner decision, 6 Nov). Scans do not yet say in their results that these were used.
- **Web page changes** were judged by type checks and UI tests, not a line-by-line review.

### Left out of the commit

- `scripts/*.cjs`: 9 throwaway helper scripts with fixed run IDs.
- `.claude/launch.json`: a personal browser path, no longer needed once Claude restarts without the old Windows setting.

## Phase 6

The recipes extend the existing registry (the test library's `requiredCapability` and the `dispatch` switch in `engines/functional.ts`). What each covers, and on what evidence, is in `docs/interaction-support-matrix.md`.

### What changed

- **New recipes:** Rise flip cards (FLP-01), ARIA carousels (TIM-01), and audio and video playback (AUD-01, VID-01). Playback passes only when the media time is seen moving and stops on pause. A format the scan browser cannot decode is Not supported.
- **Library upgrade:** `seedStarterLibrary` moves untouched starter cases to the new automation. Cases a person wrote or imported are not changed.
- **Controls a learner cannot reach:** anything inside `[inert]` or `[aria-hidden="true"]` is no longer a control.
- **False alarms removed:** a rule committed in Phase 5 treated any button in a quiz or interactive block, or named "flip" or "reveal", as an accordion. That rule is gone. Those buttons are now listed as unrecognised and are not clicked.
- **Rise walk** (`walkOnly`): exploration follows Continue buttons and lesson links, each destination once, for at most half the run's time. Before, it clicked everything and left no time for the recipes.
- **Rise lessons:** the scan now scrolls the lesson's own container, not the window. It waits for blocks to be built and for visible controls to stop changing before listing them.
- **Stable locators:** `data-testid` is preferred over a position in the page, and tabs use block id plus position. Rise tab ids change on each load, which had left all 14 tabs Blocked.
- **Where tests run:** each test runs on the screen where its control was first found (migration 9 adds `interaction_instances.state_id`). It waits up to 5 s for the control to appear.

### Tests (7 Nov 2026)

New: `tests/recipes.integration.test.ts` (17 tests, working and deliberately broken fixtures) and a Rise-style walk test in `package-launch.integration`. They were seen failing first, with two exceptions: the fade-in check in the walk test passed before its fix, so it does not prove that fix, and some of the broken-fixture cases were written and first run together with the code.

Whole suite, one file at a time: **30 files, 379 tests, all passed.** `real-exports` is skipped because it needs `CQA_REAL_EXPORTS`.

### Real course (Leadership Expectations, 7 Nov 2026, seventh scan of this phase)

The scan took about 6.5 minutes and ended `partial`.

| Result | Detail |
| --- | --- |
| Tabs | 9 passed |
| Flip cards | 10 passed |
| Video | 1 passed |
| Navigation menu | 1 passed |
| Blocked or errored | 0 |
| NAV-001 and FUN-001 findings | 0 (flip cards, TAKE AGAIN and the menu no longer raise false alarms) |
| Blocks seen | 69 of 80 |
| Lessons visited | 12 of 14 |
| Interactions exercised | 21 of 106 |

- **Why `partial`:** one replay failed, so Continue "Course wrap-up" was not attempted. That is probably why "Congratulations!" was not reached; not confirmed.
- **The one failed check:** MED-02 (captions), from MED-003: the video has no caption track. This is a real course finding.

### Not done in Phase 6

- **Fixtures only:** carousels and audio. Rise process, gallery, labeled graphic and accordion blocks have no real sample, so the first two and labeled graphics stay manual, and a Rise accordion block is untested.
- **Video:** seeking is not tested. Playback time only reached 0.2 s before pausing, which is enough to show it moves.
- **Replay route:** deep routes through Continue buttons can fail to replay, as "Course wrap-up" did.
- **Two workers:** starting a second copy of the tool on the same data folder clears the temp folders of a running scan, which is the likely cause of one failed scan here. Add a guard in Phase 12.
- **Storyline:** the Storyline walk was not re-scanned on a real course in this phase.

## Phase 7

Extends the existing behavior rules (LOG-01 to LOG-05) rather than adding a second engine. Every scenario uses normal learner clicks from a fresh copy of the screen; no course variable is read or changed.

### What changed

- **Repeat does not substitute** (`engines/functional.ts`, `rule_duplicate`): one walk activates N-1 distinct items, repeats one, and only then activates the last. The outcome must stay absent until that last item.
- **Media requirements** (`adapters/drag.ts` `parseMediaItem`, `functional.ts`): an item written `media: Play narration` must play to its end, waited for up to 2 minutes (longer is Blocked, never passed). LOG-02 adds "started but not finished". Media and ordinary items combine in one rule. The course walk does not wait for media and records a coverage gap (`traversal.ts`).
- **Provisional rules** (`runOne`): a rule sourced from `observed_hypothesis` turns a pass or fail into Inconclusive with a reason, and raises no FUN-002 finding.
- **Versions** (`qa-store.ts`, `qa.ts`): every save raises `version`; each rule test's trace names the version it ran against.
- **Import and export** (`qa-routes.ts`, `RulesPanel.tsx`): `GET` and `POST /api/projects/:id/behavior-rules/export|import`. Import uses a strict schema: an unknown field refuses the whole file and saves nothing. Imported rules are always drafts.
- **Fixtures:** `logic-repeat-bug`, `logic-wrong-target`, `logic-media-gate` (`?early` unlocks on play). Premature unlocking and failure to unlock were already covered by `logic-allclick-early` and `logic-never-fires`.

### Tests (9 Nov 2026)

- `tests/rules.integration.test.ts`: 11 of 11 pass. Before the change the repeat-counting fixture went uncaught (`expected 'passed' to be 'failed'`).
- Type-check: clean.
- Whole suite: 384 passed, 6 failed, 1 file skipped (`real-exports`). All 6 were time-limit failures. Five traversal tests hit 60 s in the full run and pass when `tests/traversal.integration.test.ts` runs alone. One functional test ran three scans inside 240 s; it is now two tests and both pass. The whole suite was not re-run after that split.

### Not done in Phase 7

- **No real course:** rules have only been run on local fixtures.
- **Persistence and reset:** not tested. Every scenario starts fresh, and `resetPolicy` is still not acted on.
- **Orders:** reverse and one fixed shuffle are tried, not every permutation.
- **`prerequisites`:** the field is still stored but unused; combined requirements are written as required items.
- **Early-fire window:** between clicks the check is 350 ms. Longer delays are covered by the full window in the omission scenarios.
- **Drafts still run:** an imported draft is tested like any other rule. Only a rule marked as observed is provisional.
- **Owner's Rise bypass and Storyline answer-guessing:** not replaced in this phase. Both stay for Phase 8.
- **Suite speed:** a simple fixture scan takes about a minute here and the full suite over 30 minutes, which is why time limits are being hit. Not investigated.

## Architecture decisions

- Production scans keep using the `playwright` library in `apps/worker`. No second browser path.
- `@playwright/test` is for testing this tool's own UI only. It must not be imported by production code.

## Open decisions (owner)

Resolved on 6 Nov: the Windows `PLAYWRIGHT_BROWSERS_PATH` setting was removed, the uncommitted work was reviewed and committed, and the Rise bypass and answer guessing stay until Phases 7–8 replace them.
