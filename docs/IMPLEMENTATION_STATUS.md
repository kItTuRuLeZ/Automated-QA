# Implementation Status

Source prompt: [`Claude_Code_Course_QA_Automation_Phased_Prompt.md`](Claude_Code_Course_QA_Automation_Phased_Prompt.md). Resume from this file; do not restart completed phases.

**Current state:** Phase 2 complete (2a traversal and coverage, 2b links, media, text). **Next phase ready to run: Phase 3.**

## Phase checklist

| Phase | Title | Status |
| --- | --- | --- |
| 0 | Architecture, scope, and execution plan | ✅ Complete (2026-10-03) |
| 1 | Working local application and URL scan pipeline | ✅ Complete (2026-10-03) |
| 2 | Bounded traversal, functional checks, links, media | ✅ Complete (2026-10-03) |
| 3 | Automated accessibility and keyboard review | ⏭ Next |
| 4 | Responsive, visual heuristics, performance evidence | Not started |
| 5 | Reports, client profiles, retest, standalone V1 | Not started |
| 6 | HTML5/SCORM package inspection and isolated scans | Not started |
| 7 | SCORM runtime harness and platform adapters | Not started |
| 8 | Optional AI-assisted review (only on explicit request) | Not started |
| 9 | Storyboard-to-course fidelity comparison | Not started |

## Phase 0 — delivered

- [`PROJECT.md`](../PROJECT.md): users, problems, standalone principle, V1 scope, exclusions and non-claims.
- [`ARCHITECTURE.md`](../ARCHITECTURE.md): component boundaries, resolved technology decisions, job lifecycle, results model, fingerprints, artifact storage, providers, deployment model.
- [`QA_RULE_CATALOG.md`](QA_RULE_CATALOG.md): rule IDs, evidence, applicability, limitations, default severity/confidence, severity mapping, axe outcome mapping, capability matrix.
- [`SECURITY_MODEL.md`](SECURITY_MODEL.md): outbound policy, egress proxy with connect-time IP pinning, browser hardening, worker isolation modes, unsafe actions, uploads, redaction, retention.
- [`TEST_STRATEGY.md`](TEST_STRATEGY.md): layers, fixture server and test-only policy override, fixtures per phase, false-positive cases, security tests, manual checklist.
- `packages/shared`: types for `ScanConfig`, `ScanRun`, `CourseState`, `TraversalAction`, `CheckResult`, `Finding`, `Evidence`, `ClientProfile`, `EngineResult`, `RuleDefinition`; closed vocabularies; provider interfaces (capture, navigation/adapter, content, accessibility, layout, package analysis, content comparison, advisory with a no-op `none` default). No engines implemented.
- Workspace scaffolding: root `package.json` (npm workspaces, Node `>=24 <25`), `.nvmrc`, `tsconfig.base.json` (strict), `.gitignore`, `.gitattributes`.

### Commands run (Phase 0)

| Command | Result |
| --- | --- |
| `node --version` | v24.18.0 |
| `npm --version` | 11.16.0 |
| `docker --version` | Docker 29.2.1 (available for worker Mode B) |
| `npm install` | 3 packages added, 0 vulnerabilities |
| `npm run typecheck` (TypeScript 7.0.2) | Passed, exit 0 |

No runtime tests exist yet; Phase 0 contains no executable behavior beyond the no-op advisory provider.

### Acceptance

| Criterion | Result |
| --- | --- |
| Architecture supports no-AI execution | Passed: no AI dependency in the scan path; `AdvisoryProvider` defaults to `none`; `EngineSelection.advisory` defaults off. |
| Architecture supports a separately running worker | Passed: SQLite jobs table with leases, heartbeats, cancel flag, restart recovery defined. |
| Capability matrix distinguishes implemented, planned, heuristic, manual | Passed: see rule catalog. Nothing is implemented yet, by design. |
| Phase 1 can proceed without unresolved decisions affecting its data contracts | Passed: stack, DB driver, worker communication, isolation mode, network enforcement design, redaction and fingerprint definitions are resolved. |

### Decisions recorded

- npm workspaces; Node 24 LTS; TypeScript 7 strict; Fastify; React/Vite; zod; `better-sqlite3` (fallback `node:sqlite`); Playwright Chromium; `pino` logs; `vitest`.
- Backend ↔ worker via SQLite jobs table. Orphaned runs marked `partial`/`failed` with `worker_lost`, not auto re-run.
- Worker Mode A (local process) for Phases 1–5 with documented limits; Mode B (Docker) required before uploaded packages (Phase 6).
- Network enforcement via a per-run worker egress proxy that resolves and pins IPs; Playwright routes are a secondary logging layer.
- Phases 1 and 2 may be delivered as vertical slices (1a backend/worker/fixtures, 1b UI; 2a traversal, 2b links/media/text) across sessions.

### Known limitations

- Shared types are compile-time contracts only; zod runtime schemas arrive with the Phase 1 API.
- `better-sqlite3` installation on this Windows machine is not yet verified (Phase 1 first step).
- WCAG criterion references in the catalog must be re-verified against the current W3C publication when each rule is implemented.
- No user-supplied Rise, Storyline, or custom HTML samples yet. Collect them early; product-specific validation remains pending.

## Phase 1 — delivered

A working local application: create a project, configure and validate a URL scan, queue it, run it in a separate worker with an isolated Chromium context, capture real evidence, persist results, view them, and cancel.

- `packages/core`: SQLite store (`better-sqlite3`, WAL, forward-only migrations), network policy (WHATWG parsing, scheme/credential/scope checks, full DNS resolution, `ipaddr.js` range classification incl. IPv4-mapped and NAT64 forms, test-only exact `ip:port` exemptions), redaction, fingerprints, opaque-ID artifact store with root confinement, zod API schemas, Phase 1 rule definitions, pino logger with redaction.
- `apps/worker`: job loop (claim with lease, heartbeat, cancel flag, orphan recovery on start, temp cleanup); per-run **egress proxy** that resolves and pins validated IPs for every HTTP request and CONNECT tunnel; hardened Chromium launch (sandbox on, proxy incl. loopback, QUIC off, WebRTC proxied-only, service workers blocked, downloads off); `InitialCapture` engine for RUN-001..006, NET-002, NET-003.
- `apps/server`: Fastify on `127.0.0.1:4317`; Host/Origin/`Sec-Fetch-Site` checks, `X-QA-Request` + JSON requirement on state changes; projects, scans (NET-001 pre-validation, denied targets never queued), runs, cancel, findings, checks, artifacts by opaque ID; serves the built UI.
- `apps/web`: React/Vite UI — project list, new project, New Scan (URL, extra origins, path prefixes, timeout, viewport), live status with cancel, scan history, summary (unique rules vs executions, not-tested count), findings table, all checks, configuration/environment, finding detail with evidence and screenshots. Designed empty, loading, error, partial, failed, and cancelled states; skip link, focus management, visible focus, labelled controls.
- `fixtures/` + `tests/support/fixture-server.ts`: healthy, missing asset, JS exception, no title, blocked subrequest, HTTP 404, in/out-of-scope redirect, slow (timeout).

### Commands run (Phase 1)

| Command | Result |
| --- | --- |
| `npm install` (workspaces) | Installed; `better-sqlite3` loads on Windows (SQLite 3.53.4) |
| `npx playwright install chromium` | Chrome Headless Shell 153.0.8010.12 (Playwright 1.63.0) |
| `npm run typecheck` | Passed, exit 0 (shared, core, server, worker, web) |
| `npm run build -w @cqa/web` | Built (245 kB JS, 6 kB CSS) |
| `npx vitest run` | **74 passed / 74** in 4 files (policy & redaction 45, server 15, hardening 1, real-Chromium scan integration 13) |
| Manual: `npm start`, UI at http://127.0.0.1:4317 | Created a project; scanned `https://example.com/` → completed, 8 checks, screenshot shown; scanned `https://example.com/missing-page-test` → Critical RUN-001 (HTTP 404) with evidence and repro steps; `http://169.254.169.254/...` refused in the form with the policy reason |

### Acceptance

| Criterion | Result |
| --- | --- |
| Real fixture scan goes queued → completed with real evidence | Passed (`healthy page` test: PNG on disk, SHA-256 matches DB). |
| Console exceptions and network failures captured accurately | Passed (exact messages; 404 script = High, 404 image = Medium; policy blocks are NET-002, not RUN-004). |
| Denied targets never launch | Passed (submission returns 422/NET-001 and creates no run; run-time rebinding fails before browser launch, no artifacts). |
| Cancellation works | Passed (running scan cancelled in < 10 s, unexecuted checks `not_tested`/`cancelled`, temp dir removed; queued scan cancelled without launching). |
| Restart recovery works | Passed (run left `running` by a dead worker → `failed`/`worker_lost`, not re-run). |
| Build/type checks and integration tests pass | Passed (see commands). |

### Known limitations (Phase 1)

- Worker runs in **Mode A** (local process). The Docker worker (Mode B) is not built yet; it is required before Phase 6.
- The production policy denies loopback, so local fixtures can be scanned only by the test harness. A deliberate, administrator-enabled local-fixture mode is needed for Phase 5's offline acceptance.
- Out-of-scope redirect destinations still load (the IP policy still applies); scope is evaluated after navigation and the destination's page checks are marked `not_tested`/`out_of_scope`.
- Only the runtime and byte budgets are enforced; page/state/depth budgets apply from Phase 2.
- UI was verified by a manual click-through; an automated UI end-to-end test is not written yet.
- Use `127.0.0.1`, not `localhost`: the server binds IPv4 loopback only and some browsers resolve `localhost` to `::1`.
- Server and worker run TypeScript through `tsx` (no compiled bundle).
- npm 11 reports `esbuild` install scripts as not yet approved (`npm approve-scripts`); builds and tests work without it.

## Phase 2a — delivered (traversal and coverage)

- **State signatures** (`apps/worker/src/adapters/dom-scripts.ts`): URL without query (hash kept for SPA routes), lesson ID from hash routes or `data-lesson-id`, open dialogs, selected tabs, expanded sections, and a hash of visible text. Replay verification accepts a strict match or a structural match (same everything except text hash).
- **Generic HTML adapter** (`adapters/generic-html.ts`): recognizes ARIA tabs, disclosure buttons, `<details>`, dialog openers (`aria-haspopup="dialog"` or `aria-controls` to a dialog), close controls inside dialogs, Next/Back controls, in-scope links (including hash routes). Each action carries machine-checkable postconditions (`PostconditionCheck` in `packages/shared`). Disabled, already-selected, and already-expanded controls are not attempted. Modal dialogs restrict discovery to their contents.
- **Unsafe-action policy**: form submit buttons, `submit`/`reset`/`file` inputs, and names matching the deny list (submit, delete, send, buy, pay, order, sign out, reset, save, download, exit, retake, check answer, …) are skipped as `unsafe_action`. Unrecognized controls are skipped as `ambiguous_action`, never clicked blindly.
- **Traversal engine** (`engines/traversal.ts`): breadth-first, restores each state by reloading the target and replaying its action path, detects loops by signature, explores in-page interactions before links, and stops at max states, max depth, max pages, or the runtime budget. Results: NAV-001 (tabs/accordions/dialog openers), NAV-002 (Next/Back/links with no change, inconclusive), NAV-003 (dialog close), uncaught exceptions and failed requests triggered by an action (RUN-002/RUN-004 with the action path as reproduction steps), and a screenshot per new state.
- **Coverage**: COV-001 (skipped actions), COV-002 (frames out of scope, blocked, or not yet explored), COV-003 (canvas surfaces), COV-004 (budgets). Run is `partial` when a budget is reached or a transition fails. Coverage summary stored on the run.
- **Storage/API**: migration 2 adds `traversal_actions`; `GET /api/runs/:id/actions`; scan input accepts `explore`, `maxStates`, `maxDepth`.
- **UI**: New Scan has an Exploration section (toggle, max states, max depth). Run page has a Coverage section: summary, states table with per-state screenshots, actions table filtered by Problems / Attempted / Skipped / All.

### Commands run (Phase 2a)

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed, exit 0 |
| `npm run build -w @cqa/web` | Built |
| `npx vitest run` | **85 passed / 85** (adds 11 traversal tests with real Chromium) |
| `npx vitest run tests/traversal.integration.test.ts` after reordering | 11 passed |
| Manual: UI scan of the W3C APG tabs example (`maxStates` 8, `maxDepth` 1) | Partial (state budget), states table with screenshots, COV-001 for a form submit button, COV-002 for an embedded third-party frame, COV-004 budget finding. It revealed that site links were explored before the tabs; fixed by ordering in-page interactions first, then re-verified with a harness run: all three tabs and the disclosure were exercised and passed before any link. |

### Acceptance (Phase 2 rows covered by 2a)

| Criterion | Result |
| --- | --- |
| SPA lessons produce expected coverage | Passed (lessons 1–3 recorded via hash routes; disabled Next/Back not attempted). |
| Accordion, tab, modal fixtures produce expected results | Passed (working controls pass; dead tab, dead section, dead dialog opener → NAV-001; dead close → NAV-003). |
| Navigation loop terminates | Passed (cycling Next returns to a known state; no budget hit). |
| Inaccessible iframe disclosed | Passed (out-of-scope, policy-blocked, and in-scope-but-unexplored frames each reported; never counted as passed). |
| Scan budgets stop exploration predictably | Passed (max states 2 → exactly 2 states, partial, COV-004; max depth 1 → no state deeper than 1). |
| Unsafe actions skipped with reasons | Passed (submit, delete, buy skipped as unsafe; "Show hint" skipped as ambiguous; page state proves none were clicked). |
| Findings have actionable reproduction paths | Passed (NAV findings list open URL + each replayed action + the failing action + expected result, with a screenshot). |
| Restricted link, lazy image, broken media fixtures | **Pending: Phase 2b.** |

### Known limitations (Phase 2a)

- Controls inside frames are not explored yet; in-scope frames are disclosed as `not_implemented` (COV-002).
- Restoring a state replays its whole path from a fresh load, so deep paths cost time. Content that changes on every load (timers, random order) can make restoration fail; this is reported as a failed transition, not hidden.
- The same broken control is retried in each state where it appears; findings merge by fingerprint (one finding, several occurrences) but each attempt is a separate check execution.
- A lesson reached by URL hash (for example `#/lessons/1`) and the same lesson at the bare URL are distinct states, because their URLs differ.
- The page receives a tiny `globalThis.__name` shim so serialized helper functions run under `tsx`; it does not affect course behavior.
- Recognition is pattern-based: custom widgets without ARIA roles/attributes are skipped as ambiguous until a platform adapter (Phase 7) knows them.

### Validation on user-supplied courses (2026-10-03)

| Sample | Result |
| --- | --- |
| Storyline HTML5 (`elearning.aptaracorp.com/.../story_html5.html`) | Loaded; only the player's HELP (skipped, not recognized) and EXIT (skipped, unsafe) links were found. The slide area is a 993×624 canvas, disclosed as COV-003. Slide content and player navigation were **not** explored. Needs the Storyline adapter (Phase 7). |
| Rise 360 (`share.articulate.com/...`) | Lessons reached through the sidebar links (15 states with a 15-state budget). Exposed three problems, all fixed with regression tests: (1) a request the page cancels itself (`net::ERR_ABORTED`) was reported as a failed request; (2) the title, set by script after load, was reported missing; (3) when Rise rendered slowly, discovery ran too early and found no controls. The engine now waits for visible content to stop changing before discovery. Re-scanned twice: consistent, no false findings. A real content issue is visible in the lesson screenshots (a "Note to the GD: Please enhance this screen" reviewer note left in the course); Phase 2b's placeholder check should flag it. |

Product-specific validation status: **Rise — partial** (navigation works; Continue blocks, knowledge checks, and in-lesson interactions not yet exercised). **Storyline 360 (modern player) — partial** (see below). **Older canvas-based Storyline HTML5 output — pending** (adapter needed). **Custom HTML — pending** (no sample yet).

## Phase 2b — delivered (links, media, text)

- **Per-state content checks** (`engines/content.ts`, `adapters/content-scripts.ts`): run on every reached state (root and each new state during traversal, or the captured page when exploration is off). The page is scrolled through first so lazy content loads.
  - MED-001 broken images: loaded but undecodable (`complete`, `naturalWidth` 0, and `img.decode()` rejects). Images still loading are not tested, not passed.
  - MED-002 audio/video errors (`MediaError` or no playable source), MED-003 video without a captions/subtitles track, MED-004 media without native controls (heuristic), MED-005 asset size over threshold (sizes only where the browser exposes them; thresholds are application defaults with stated provenance).
  - TXT-001 placeholders and production notes (lorem ipsum, TBD/TBC/TODO/FIXME/XXX in capitals only, `[Insert …]`, "Note to the GD/dev/SME…", `{{…}}`), one finding per element, exclusions honoured, hidden text ignored. TXT-002 terminology only when a list is configured.
  - LNK-005 `javascript:`, empty, and malformed hrefs.
- **Link checker** (`engines/links.ts`): unique destinations from all states (fragments removed), HEAD then GET on any error status, 5xx retried once, redirects followed manually with every hop validated by the network policy and connected to the pinned IP, bodies never downloaded. Results: LNK-001 broken (404/410/other errors), LNK-002 restricted (401/403/407), LNK-003 unverified (timeout, DNS, rate limit, blocked by policy, redirect loops). Restricted and unverified links are `not_tested` for LNK-001, never passed. Budgets: 200 unique URLs, 10 s per request, 120 s total, 4 concurrent.
- **Noise reductions**: with media checks on, images and media go to MED-001/002 rather than RUN-004; Chromium's "Failed to load resource" console lines are not RUN-003 (the network finding has better detail).
- **Contracts**: `TextRules`, `MediaThresholds`, link budgets, reason codes `access_restricted` and `rate_limited`. Engines `links`, `media`, `content` are on by default. Any owned rule without a result gets an explicit `not_tested` with a reason at the end of the run.
- **UI**: New Scan has a Text checks section (terms to flag with `term => preferred`, and exclusions).

### Commands run (Phase 2b)

| Command | Result |
| --- | --- |
| `npm run typecheck` / `npm run build -w @cqa/web` | Passed / built |
| `npx vitest run` | **99 passed / 99** (adds 12 content/link tests; the Phase 1 missing-asset test now expects MED-001 for the image) |
| Harness scan of the Rise sample (`maxStates` 6, `maxDepth` 1) | Partial (state budget). Found 7 "Note to the GD" production notes across the first lessons. Adobe Stock link (403) reported as restricted, AT&T Brand Center link (timeout) as unverified; neither called broken. No other findings. |

### Acceptance (remaining Phase 2 rows)

| Criterion | Result |
| --- | --- |
| Restricted link fixture | Passed (401 and 403 → LNK-002, not broken). |
| Lazy image fixture | Passed (valid lazy image passes after scrolling; broken lazy image → MED-001; decorative empty-alt image not flagged). |
| Broken media fixture | Passed (missing audio and video → MED-002; playable WAV passes; uncaptioned video → MED-003). |
| Link classification | Passed (404/410/redirect-to-404 broken; HEAD-405 server passes via GET; redirect followed; timeout, metadata address, and redirect to a private IP unverified; fragments de-duplicated). |
| Placeholder checks with exclusions, no full grammar claim | Passed. |

**Phase 2 is complete.**

### Known limitations (Phase 2b)

- CSS background images, images inside frames, and canvas content are not checked.
- Media checks read element state; they do not play media end to end. Embedded players (YouTube, Vimeo, Storyline) are not inspected.
- Link checks see the link from outside the learner's session: destinations that need sign-in show as restricted, and sites that block automated requests may time out (unverified).
- Placeholder patterns are English and rule-based; client-specific patterns and exclusions arrive with client profiles in Phase 5.
- Scrolling each state for lazy content adds time per state on long pages.

### Validation on a Storyline 360 course (2026-10-03)

Sample: `salesportal.aptaracorp.com/ProtectingOurPlanet/story.html` (Storyline 360 modern player). The player and slide text are in the DOM, so the generic engine reaches real slides once it recognizes "Start Course" and the player's Next/Previous buttons.

Fixed after the first scan, each with a regression fixture and test:
1. Storyline hyperlinks are `javascript:DS.windowOpen.open({ url: '…' })`; they were flagged as script links (10 × LNK-005). The destination is now extracted and link-checked instead.
2. Storyline's inline `data:` placeholder video was flagged for captions and controls; inline media is now skipped for MED-003/MED-004.
3. Player-driven audio/video (visible Pause/Mute buttons) was flagged for missing native controls; MED-004 is skipped when a custom player exposes controls.
4. "Back to top" was treated as Back navigation; it is now excluded.
5. "Start Course" / "Start" / "Begin" / "Get started" are recognized as forward navigation.
6. A recognized control that fails is now retried once from a fresh restore before it is reported (defects must reproduce). Page-load errors during that reload are no longer attributed to the action, and runtime failures seen during exploration merge with the initial-capture finding for the same URL.

Remaining findings on this course: the embedded AI avatar frame (`genx.aptaracorp.com`) fails to load its scripts (404, wrong MIME type) and its HeyGen API call is blocked by CORS; the course video has no caption track; GLOSSARY and RESOURCES did not open on the first slide after Start on two attempts (they did open on later slides; confirm manually). The slide outline menu (`treeitem`s) and player controls such as Settings are not exercised yet; a Storyline adapter (Phase 7) should drive the outline. Scans of this course take about 4 minutes because each state is restored by reloading the player.

## Phase 3 — plan (next)

1. Inject axe-core into each reached state and supported frame; record engine version, rule ID, impact, nodes, tags; map violations/incomplete/passes/inapplicable as in the catalog; deduplicate across states with occurrences.
2. Missing vs empty alt handled per catalog (A11Y-001/002); heading jumps as warnings; page language, accessible names, hidden focusable elements, target size, reflow at 320 CSS px.
3. Bounded keyboard journeys (Tab, Shift+Tab, Enter, Space, Escape) with focus sequences; keyboard trap detection; dialog focus entry/containment/return for recognized dialogs; visible focus heuristic.
4. Manual review checklist in reports; explicit statement that automated checks do not establish compliance.
5. Accessibility audit of the application's own UI.
