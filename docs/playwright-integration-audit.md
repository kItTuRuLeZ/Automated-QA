# Playwright integration audit (Phase 1)

Date: 3 November 2026. Scope: read-only inspection of `D:\projects\Automated-QA\tool` on the Windows development machine (PUN-4QGBV04), branch `claude/project-thread-60i2fi` at `ab6ccb5`, plus the uncommitted working tree listed in §9. No application code was changed in this phase.

**Headline:** Playwright is not something to add. The worker already scans every course with the Playwright library (Chromium), through a durable job queue, with a sandboxed browser behind a per-run egress proxy, a SCORM test API, traversal, functional test cases and evidence capture. The gaps are in result honesty and depth (statuses, coverage denominators, Rise interactions, traces, a few rule-7/8 violations in recent uncommitted code), and one environment fault on this machine that stops Playwright from starting at all outside the preview launcher.

## 1. What is installed

| Item | Found | Evidence |
| --- | --- | --- |
| `playwright` (library) | 1.64.1 in `node_modules` (declared `^1.63.0` in `apps/worker` and `apps/server`) | `node_modules/playwright/package.json`; `package-lock.json:3271` |
| `playwright-core` | 1.64.1 | lockfile `:3286` |
| `@playwright/test` | 1.64.1, newly added to root `devDependencies` (**uncommitted**) | `git diff package.json`; no `playwright.config.*` and no test imports it yet |
| Browser binaries | `%LOCALAPPDATA%\ms-playwright`: chromium-1217/1228/**1248**, chromium_headless_shell-1217/1228/1248, firefox-1532, webkit-2311, ffmpeg | directory listing |
| Global npm | `playwright@1.64.1`, `@playwright/cli@0.1.23` | `npm ls -g` |
| MCP server | None configured for Playwright | no `playwright` entry in `~/.claude.json` or `.mcp.json` |
| Browser extension | Claude in Chrome is installed in Chrome; it is unrelated to the scanner | Chrome extensions folder |
| axe-core | 4.13.0, injected as an init script | `apps/worker/package.json`, `runner.ts` |

**Environment fault (blocks scans when the tool is started from a terminal):** the Windows user variable `PLAYWRIGHT_BROWSERS_PATH=C:\Users\karthikeyan\.playwright-browsers` points at a folder that does not exist. Playwright then looks for `chromium_headless_shell-1248` there and fails:

```
browserType.launch: Executable doesn't exist at C:\Users\karthikeyan\.playwright-browsers\chromium_headless_shell-1248\chrome-headless-shell-win64\chrome-headless-shell.exe
```

With the variable pointing at `%LOCALAPPDATA%\ms-playwright` (or unset), the smoke check passes (§7). The preview launcher currently works only because `.claude/launch.json` now sets the variable for the tool (uncommitted). Fix: remove the user variable, or run `npx playwright install chromium` with it set so the binaries land in that folder. This needs the owner's decision because it changes Windows settings.

Runtime: Node 24.21.0, npm 11.19.0 (`engines: >=24 <25`). TypeScript 7, vitest 5.0.3.

## 2. Architecture as built

`ARCHITECTURE.md` matches the code:

- **Web** (`apps/web`, React/Vite): control panel only. No browser automation in the bundle.
- **Server** (`apps/server`, Fastify on 127.0.0.1:4317): validation, upload, enqueue/cancel, exports. Never launches scan browsers. (It does use Playwright for `page.pdf()` exports.)
- **Package server** (`apps/server/src/package-server.ts`, 127.0.0.1:4318): serves extracted packages from a **separate origin** so course scripts never run on the app origin.
- **Worker** (`apps/worker`): claims jobs from a SQLite `jobs` table with a 30 s lease and 1 s heartbeat (`worker.ts`, `runner.ts:100-126`), single concurrency, recovers orphaned runs on start (marks them `partial`/`failed`, does not re-run).
- **Core/shared** (`packages/core`, `packages/shared`): store, migrations, network policy, rules, report model, types.

Static hosting cannot run scans; the worker must run where Chromium can be launched (already stated in `ARCHITECTURE.md`).

## 3. Upload-to-report flow (traced)

1. **Upload:** `POST /api/projects/:id/packages` with raw ZIP bytes (`apps/server/src/packages.ts:179`). Extracted to a staging folder, then swapped in.
2. **Extraction hardening** (`packages/core/src/package/archive.ts`): entry-count limit (20 000), expanded-size limit (1 GB), compression-ratio check, rejects absolute paths, `..`, symlinks, duplicates, encrypted and corrupt archives. Covered by `tests/packages.static.test.ts`.
3. **Static inspection** (`packages/core/src/package/inspect.ts`, `authoring.ts`): manifest parsing, SCORM 1.2/2004 detection, launch choices, missing-file references (PKG-005), outside hosts (PKG-006), Rise/Storyline recognition and outline (lessons/blocks or scenes/slides/layers).
4. **Scan request:** `POST /api/packages/:id/scans` requires `acknowledgeLocalExecution`, picks launch entries, builds `ScanConfig` with scope locked to the package origin and path, runtime budget scaled by outline size (max 45 min).
5. **Run** (`apps/worker/src/runner.ts`): re-validates the target, seeds the inventory from the package outline, starts an egress proxy, launches Chromium (`headless`, `chromiumSandbox: true`, QUIC off, WebRTC proxied), one context per run (service workers blocked, downloads off), init scripts (axe, SCORM harness, Rise LMS bypass), then:
   - `InitialCapture` (`engines/capture.ts`): navigation, console/page errors, failed requests, platform detection.
   - `Traversal` (`engines/traversal.ts`): bounded BFS over states; per-state content, accessibility, keyboard, layout, brand checks.
   - Viewport pass, functional engine (`engines/functional.ts`), SCORM engine (`engines/scorm.ts`), link checks.
   - `finally`: heartbeat/timer cleared, browser closed, proxy stopped, temp dir removed (`runner.ts:504-507`).
6. **Progress:** `RunRecorder` (`apps/worker/src/recorder.ts`) writes `run_events` and `run_progress`; the UI polls `/api/runs/:id/events` and `/progress`.
7. **Store:** SQLite tables `scan_runs`, `course_states`, `check_results`, `findings`, `evidence`, `traversal_actions`, `inventory_units`, `interaction_instances`, `test_executions`; screenshots under `data/artifacts/<runId>/`.
8. **Report:** `export.json|html|pdf|xlsx`, `qa-export.*`, evidence ZIP (`apps/server/src/app.ts:266-307`).

## 4. Capabilities verified against code

| Area | Status | Where |
| --- | --- | --- |
| Live browser observation | Yes: DOM, console, network, screenshots | `capture.ts`, `traversal.ts` |
| Rise detection | Static only (package export). At run time `detectPlatform` returns only `storyline` or `unknown` | `layout-scripts.ts:193` |
| Storyline detection | Static and run time | `authoring.ts`, `detectPlatform` |
| Launch file selection | From manifest launch choices; manual pick when several | `packages.ts:252-258` |
| Frames | Content-root selection picks the richest allowed frame; other frames recorded as "not inspected" (COV-002) | `content-root.ts`, `traversal.ts` `inspectSurfaces` |
| Canvas | Recorded as unsupported (COV-003), never passed | `traversal.ts` |
| SCORM | Test API for 1.2 and 2004 in the scan browser plus a separate journey/resume harness; calls are recorded | `adapters/scorm-harness.ts`, `engines/scorm.ts` |
| Interaction recipes | Tabs, accordion open/policy, dialog open/dismiss, Next/Previous, and conditional rules: all-click, premature unlock, duplicate counting, order, sequence | `functional.ts:402-418, 616-733` |
| Fixtures for conditional logic | `logic-allclick-correct`, `-early`, `-delayed`, `-duplicate-bug`, `-never-fires`, `-optional-bug`, `-order-dependent`, `gate-quiz`, `gate-drag`, `auto-quiz` | `fixtures/` |
| Statuses | Checks: `passed, failed, needs_review, not_applicable, not_tested, error`. Tests: `pending, running, passed, failed, blocked, error, skipped, not_applicable, manual_review_required`. Screens: `not_tested, in_progress, issues_found, needs_manual_review, passed_automated` | `packages/shared/src/enums.ts`, `qa.ts` |
| Cancellation | Heartbeat sees `cancel_requested`, closes the browser, unfinished checks become `not_tested` | `runner.ts:118-122, 485-488` |
| Tracing | **Not used anywhere** (no `context.tracing`) | grep |
| Playwright Test | Installed, not configured. UI e2e tests use the library inside vitest | `tests/ui-flows.e2e.test.ts:21` |

## 5. Gaps against the prompt pack

Ordered by user impact.

1. **Machine setup:** `PLAYWRIGHT_BROWSERS_PATH` fault (§1). Scans started with `npm start` from a terminal cannot launch Chromium.
2. **Rule 7/8 violations, recent and uncommitted:**
   - `riseLmsBypassScript` (`scorm-harness.ts:513`) rewrites the course's `loadOnlyInLms` setting and stubs `RiseLMSInterface`. That is editing course runtime configuration. It needs either removal or an explicit, labelled "harness launch" mode with the deviation reported.
   - The Storyline walk (`traversal.ts`) force-clicks the transparent accessibility controls Storyline places over the slide, guesses answers until Next unlocks (`answerAgain`), and uses fixed waits and polling of `<audio>` state. Per rules 7–8 and Phase 8, guessing answers must be replaced by reviewer-supplied answers or test plans. Force-clicks need a documented adapter exception (the accessibility layer is the learner-facing control in Storyline) or a different action path.
   - Two `TEMP DEBUG` `console.log` lines remain in `traversal.ts`.
3. **No first-failure evidence beyond screenshots:** no Playwright traces, no per-attempt evidence folders. Retries in traversal (`retried` flag) keep only the final result text.
4. **Status model is coarser than Phase 4 asks:** no `unsupported`, `inconclusive` or `cancelled` at check level (they collapse into `not_tested`/`needs_review`/`error`). Expectation source, attempt number and error class are not stored per check result. The screen label `passed_automated` should read "Passed configured checks".
5. **Rise runtime adapter missing:** with no run-time Rise detection, Rise scans use the generic adapter. The Leadership Expectations scan (3 Nov) exercised 0 of 90 interactions and reported 7 flip cards and a "TAKE AGAIN" button as broken accordions, which are probably false positives. Auto-answer is Storyline-only.
6. **Coverage denominators:** inventory comes from the export outline, which is good, but Storyline layers and Rise blocks are counted differently. "Interactions exercised" was 0% on both real courses tested. Reports should show discovered versus expected versus exercised separately (Phase 5).
7. **Frame allow-list is broad:** `isAllowedContentFrameOrigin` accepts any frame sharing the last two hostname labels (for example any `*.co.uk`) and Articulate/CloudFront hosts. Fine for packages (scope still blocks requests), risky for URL scans. Review in Phase 3/12.
8. **Concurrency** is fixed at one worker and not configurable (Phase 2 asks for a configurable limit).
9. **Docs drift:** `docs/TEST_STRATEGY.md` says the project "does not depend on @playwright/test", which is no longer true once the uncommitted `package.json` change is kept.

## 6. Smallest integration design

The production path already exists; the work is to make it honest and deeper, not to add a second Playwright path.

- **Production scanning** stays in `apps/worker` with the `playwright` library. Add a small `BrowserSession` wrapper around the existing launch/context/close code in `runner.ts`. It should:
  - do a preflight check (`chromium.executablePath()` exists, with an actionable error naming `PLAYWRIGHT_BROWSERS_PATH`);
  - classify errors (launch, navigation, action, assertion, timeout, cancelled);
  - start and stop `context.tracing` with a first-failure retention policy;
  - give each attempt its own artifact folder.
- **Tests of the tool itself:** keep vitest for engine integration tests. Add `@playwright/test` with a `playwright.config.ts` only for UI end-to-end tests (upload, scan fixture, view, export), using its trace and retry policies. Production code must not import `@playwright/test`.
- **Adapters:** add a runtime Rise adapter (lesson routes, block types such as flashcards, accordions, tabs, process, knowledge checks) alongside the Storyline one. Gate auto-interactions on reviewer rules or test plans rather than guesses.
- **Deployment boundary:** browser execution runs only in the worker process on a machine with Chromium installed (this PC now; Docker "Mode B" before untrusted uploads, as `ARCHITECTURE.md` already requires). The web UI could be served statically, but the API, package server and worker must run together on the same host, bound to 127.0.0.1.

## 7. Checks executed in this phase

| Check | Command | Result |
| --- | --- | --- |
| Versions | `npx playwright --version` | `Version 1.64.1` |
| Smoke (current Windows setting) | isolated launch, `setContent`, role click, close | **Failed**: executable not found under `.playwright-browsers` |
| Smoke (default browser folder) | same, with `PLAYWRIGHT_BROWSERS_PATH=%LOCALAPPDATA%\ms-playwright` | **Passed**: Chromium 156.0.8078.4, 4.5 s, sandbox on, no network |
| Tool capability endpoint | `GET /api/capabilities` with the tool started from the preview launcher | `browser: available` |
| Existing tests | see §8 | see §8 |

## 8. Existing test results

9 browser-related test files, run one at a time: **113 passed, 3 failed**.

- One failure: a 404 page is expected to give a `completed` run, but the run came back `failed`. This was first recorded as pre-existing; that was wrong. The uncommitted soft-404 check caused it, and it was fixed on 6 Nov.
- Two traversal tests timed out under load and passed when re-run.

Details and timings are in the "Phase 1 test run" section of `docs/playwright-integration-progress.md`.

## 9. Uncommitted work present during the audit (not mine unless noted)

`git status` shows 18 modified files and new scripts/tests, including `PackagePage.tsx`, `NewScanPage.tsx`, `ProjectsPage.tsx`, `capture.ts`, `content-root.ts`, `scorm-harness.ts`, `runner.ts`, `functional.ts`, `package.json`/lock, `scripts/*.cjs` and `tests/real-course-qa-enhancements.test.ts`. Mine (this thread):

- the Storyline walk changes in `traversal.ts` and `dom-scripts.ts`;
- the package-page settings in `PackagePage.tsx`, `ScormJourneys.tsx` and `api.ts`;
- the `.claude/launch.json` browser path.

None of this has been reviewed or committed. Phase 2 should start by deciding what to keep, because some of it conflicts with the master rules (§5.2).

## 10. Recommended phase order

1. **Before Phase 2 (small, needs the owner):**
   - fix `PLAYWRIGHT_BROWSERS_PATH`;
   - review and commit or discard the uncommitted work;
   - remove or flag the Rise bypass and the answer-guessing, which also removes the `TEMP DEBUG` lines.
2. **Phase 2:** `BrowserSession` wrapper with preflight, error classes, tracing and per-attempt artifacts, plus a configurable worker limit. Fixture scan through the real API, plus missing-browser and cancellation tests.
3. **Phase 4 before 3:** the status model (add `unsupported`, `inconclusive`, `cancelled`, attempt and expectation source). Every later phase depends on it.
4. **Phase 3:** launch hardening, mostly in place; add fixtures for nested launch, unicode paths and an iframe wrapper.
5. **Phases 5–8:** the Rise runtime adapter and recipes, coverage separation, and assessments driven by reviewer answer keys.
6. **Phases 9–15** as written in the pack.
