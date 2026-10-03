# Implementation Status

Source prompt: [`Claude_Code_Course_QA_Automation_Phased_Prompt.md`](Claude_Code_Course_QA_Automation_Phased_Prompt.md). Resume from this file; do not restart completed phases.

**Current state:** Phase 0 complete. **Next phase ready to run: Phase 1.**

## Phase checklist

| Phase | Title | Status |
| --- | --- | --- |
| 0 | Architecture, scope, and execution plan | ✅ Complete (2026-10-03) |
| 1 | Working local application and URL scan pipeline | ⏭ Next |
| 2 | Bounded traversal, functional checks, links, media | Not started |
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

## Phase 1 — plan (next)

1. Verify `better-sqlite3`, Fastify, Playwright, Vite installs on Node 24 / Windows; pin in lockfile.
2. `apps/server`: migrations (projects, scan_runs, jobs, states, check_results, findings, evidence, artifacts), zod schemas from shared types, Origin/Host/CSRF guard, project + scan endpoints, cancel, artifact serving.
3. `apps/worker`: job claim/lease/heartbeat, URL/IP policy module with injectable resolver, egress proxy, Chromium launch with hardening flags, `CaptureProvider` (RUN-001..006, NET-001..003), redaction, cancellation cleanup, restart recovery.
4. `fixtures/` + test server: healthy, missing asset, JS exception, redirect, timeout, disallowed targets.
5. `apps/web`: project list, New Scan, progress/status, history, findings table, finding detail with evidence; empty/loading/partial/error/cancelled states; keyboard accessible.
6. Tests per TEST_STRATEGY Phase 1 rows; update this file with commands and results.
