# Implementation Status

Source prompt: [`Claude_Code_Course_QA_Automation_Phased_Prompt.md`](Claude_Code_Course_QA_Automation_Phased_Prompt.md). Resume from this file; do not restart completed phases.

**Current state:** Phase 1 complete. **Next phase ready to run: Phase 2.**

## Phase checklist

| Phase | Title | Status |
| --- | --- | --- |
| 0 | Architecture, scope, and execution plan | ✅ Complete (2026-10-03) |
| 1 | Working local application and URL scan pipeline | ✅ Complete (2026-10-03) |
| 2 | Bounded traversal, functional checks, links, media | ⏭ Next |
| 3 | Automated accessibility and keyboard review | Not started |
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

## Phase 2 — plan (next)

1. State signatures (URL, lesson ID where observable, open dialogs, selected tabs, normalized DOM hash) and a bounded traversal engine with loop prevention and state restoration.
2. Generic HTML adapter (safe links, tabs, accordions, dialogs, Next/Back) with expected postconditions; unsafe-action deny list (COV-001).
3. Coverage: inaccessible frames (COV-002), canvas surfaces (COV-003), budgets (COV-004), state/action graph in UI.
4. Link checks (LNK-001..005) through the same policy and pinning; HEAD with bounded GET fallback.
5. Media checks (MED-001..005) with scroll/wait for lazy content; placeholder/terminology (TXT-001..002) with exclusions.
6. Fixtures and tests per TEST_STRATEGY Phase 2 rows. Consider splitting into 2a (traversal) and 2b (links/media/text).
