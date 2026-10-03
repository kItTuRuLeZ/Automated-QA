# Architecture

This document defines component boundaries, data flow, the job lifecycle, artifact storage, and the deployment model. Shared data contracts live in [`packages/shared`](packages/shared/src/index.ts). Security details are in [`docs/SECURITY_MODEL.md`](docs/SECURITY_MODEL.md).

## Components

```
┌────────────────────┐   HTTP (127.0.0.1)   ┌─────────────────────┐
│  Web UI            │ ───────────────────▶ │  Server (API)       │
│  React + Vite      │   JSON, same origin  │  Node + Fastify     │
│  control panel     │ ◀─────────────────── │  validation, CRUD,  │
└────────────────────┘                      │  job enqueue/cancel │
                                            └─────────┬───────────┘
                                                      │ SQLite (WAL)
                                                      │ jobs table, results
                                            ┌─────────▼───────────┐
                                            │  Worker process     │
                                            │  Node + Playwright  │
                                            │  egress proxy       │
                                            │  engines/providers  │
                                            └─────────┬───────────┘
                                                      │ writes
                                            ┌─────────▼───────────┐
                                            │  data/ (gitignored) │
                                            │  qa.sqlite          │
                                            │  artifacts/<opaque> │
                                            └─────────────────────┘
```

| Component | Package | Responsibilities | Never does |
| --- | --- | --- | --- |
| Web UI | `apps/web` | Projects, scan config, progress, history, findings, evidence viewer, reports. | Execute course code; talk to course origins; hold secrets. |
| Server | `apps/server` | REST API, input validation (zod), target pre-validation, enqueue/cancel jobs, serve artifacts by opaque ID with ownership checks, report export. | Launch browsers; fetch course URLs; proxy arbitrary URLs. |
| Worker | `apps/worker` | Claim jobs, run browser contexts, enforce outbound policy via its own egress proxy, run engines, persist check results/findings/evidence. | Serve HTTP to the UI; run package scripts through Node; install dependencies from uploads. |
| Shared | `packages/shared` | Types, enums, provider interfaces, constants. No runtime I/O. | Depend on server/worker/web. |

The UI is a control panel only. The application cannot run as a static site (GitHub Pages or static IIS hosting): scans require the server and worker processes.

## Technology decisions (resolved for Phase 1)

| Decision | Choice | Notes |
| --- | --- | --- |
| Runtime | Node.js 24 LTS (`>=24 <25`), pinned in `.nvmrc` and `engines`. | Verified locally: v24.18.0. Re-check the Node release schedule before upgrading majors. |
| Language | TypeScript 7 (pinned in lockfile), strict mode, ES modules. | Shared `tsconfig.base.json`. |
| Workspaces | npm workspaces (`apps/*`, `packages/*`). | npm ships with Node; no extra tool. Lockfile committed. |
| Frontend | React + Vite. | Accessible controls; no UI framework required. |
| Backend | Fastify. | Built-in schema hooks; bind to `127.0.0.1` only. |
| Validation | zod schemas mirroring `packages/shared` types. | Added in Phase 1 alongside the API. |
| Database | SQLite via `better-sqlite3`, WAL mode, numbered SQL migrations. | Prebuilt Windows binaries normally available; if install fails, fall back to built-in `node:sqlite` behind the same repository interface. |
| Backend ↔ worker | Durable **jobs table** in SQLite. Worker polls, claims with a lease, heartbeats, checks `cancel_requested`. | No message broker. Survives restarts. |
| Browser | Playwright, Chromium only in V1. | Firefox/WebKit are future work. Browser sandbox stays enabled. |
| Accessibility | `axe-core` injected per state/frame (Phase 3). | Record engine version per run. |
| Exports | `exceljs` (XLSX), Playwright `page.pdf()` for PDF, self-contained HTML template (Phase 5). | PDF rendered with outbound networking disabled. |
| IP policy | `ipaddr.js` for range classification, own resolver + connect-time check. | See security model. |
| Worker isolation | **Mode A (default, Phase 1–5): local process** with documented limits. **Mode B: Docker container** for the worker; required before uploaded packages are scanned (Phase 6). | Docker is available on the dev machine; Mode A is not a security boundary. |
| Logging | Structured JSON lines (`pino`), redaction applied before write. | Secrets, cookies, query strings redacted per policy. |
| Testing | `vitest` for units/integration; local fixture HTTP server; Playwright for UI smoke. | No reliance on public websites. |

## Repository layout

```
apps/
  web/        React/Vite control panel             (Phase 1)
  server/     Fastify API, migrations, exports      (Phase 1)
  worker/     job runner, egress proxy, engines     (Phase 1)
packages/
  shared/     types, enums, provider interfaces     (Phase 0)
fixtures/     local course fixtures served in tests (Phase 1+)
docs/         rule catalog, security, tests, status
data/         runtime DB + artifacts (gitignored)
```

## Job lifecycle

Run status (`RunStatus`): `queued → running → completed | partial | failed | cancelled`.

1. **Submit.** Server validates the `ScanConfig` (scheme, credentials, scope, budgets) and pre-checks the target against the outbound policy. Denied targets are rejected with a reason and never queued.
2. **Queue.** A `scan_runs` row (`queued`) and a `jobs` row are written in one transaction.
3. **Claim.** The worker claims the oldest queued job with `UPDATE … WHERE status='queued'` and sets `lease_expires_at`. Concurrency is bounded (V1: one worker, one active run).
4. **Run.** The worker re-validates the target (DNS may have changed), starts its egress proxy, launches a fresh browser context, and executes engines. It heartbeats every few seconds, extending the lease, and records `CheckResult`s and `Finding`s incrementally so partial work survives.
5. **Finish.**
   - `completed`: the configured scan finished. This does **not** mean the course passed QA.
   - `partial`: finished with budget limits reached, engine errors, or unreachable content.
   - `failed`: the scan could not produce its primary capture (e.g. target unreachable, worker crash).
6. **Cancel.** The server sets `cancel_requested=1`. The worker checks between actions and on heartbeat, closes the browser/context, stops the proxy, deletes temp files, and marks the run `cancelled`. Checks not executed are `not_tested` with reason `cancelled`.
7. **Restart recovery.** On worker start, runs in `running` whose lease has expired are marked `partial` (if any results were persisted) or `failed`, with reason `worker_lost`. They are **not** automatically re-run; the user can start a new run.

## Results model

- A **rule** (`RuleDefinition`) is a unique check in the catalog.
- A **check result** (`CheckResult`) is one execution of a rule against one state × viewport × frame. Totals report unique rules and executions separately.
- A **finding** (`Finding`) groups failed / needs-review executions that share a **fingerprint** and lists every occurrence (state, viewport, element).
- **Evidence** (`Evidence`) is stored once and referenced by ID from findings and check results.
- Fingerprint = SHA-256 of `ruleId | normalized origin+path | state key | target key` (no query string, no viewport, no run ID). Retests (Phase 5) match findings by fingerprint.
- Severity mapping and reviewer overrides are documented in [`docs/QA_RULE_CATALOG.md`](docs/QA_RULE_CATALOG.md).

## Artifact storage

- Root: `data/artifacts/` (configurable). Files are stored as `data/artifacts/<runId>/<artifactId>.<ext>` where both IDs are server-generated random identifiers (UUIDv7 / random). User input never forms a path.
- The DB maps `artifactId → runId, kind, mime, bytes, sha256, path`. The server serves artifacts only via `GET /api/artifacts/:artifactId`, after checking the artifact belongs to a run in a project the caller can access (single local owner in V1).
- Paths are resolved and verified to stay inside the artifact root.
- Retention: per-project setting (default keep). Deleting a run deletes its DB rows and artifact directory. Temp files live under `data/tmp/<runId>/` and are removed at run end or cancellation.

## Providers (engine plug-in points)

Defined in `packages/shared/src/providers.ts`. Each provider receives a `ProviderContext` (run, state, viewport, budget, cancel signal, evidence sink) and returns an `EngineResult` (check results, findings, evidence, coverage notes, errors).

| Provider | Phase |
| --- | --- |
| `CaptureProvider` (initial state, console, network, timing) | 1 |
| `NavigationProvider` / `CourseAdapter` (traversal) | 2 |
| `ContentCheckProvider` (links, media, placeholder, terminology) | 2 |
| `AccessibilityProvider` (axe-core, keyboard) | 3 |
| `LayoutProvider` (responsive, geometry, performance) | 4 |
| `PackageAnalysisProvider` (ZIP/SCORM static) | 6 |
| `ContentComparisonProvider` (storyboard fidelity) | 9 |
| `AdvisoryProvider` (optional AI; default `none`) | 8 |

Only interfaces exist in Phase 0. Advisory providers run outside the critical scan path: their failure never changes run status or check results.

## Deployment model

- **V1: local single user.** `npm run dev` / `npm start` launches server (127.0.0.1), worker, and web. Data in `./data`.
- Server rejects requests whose `Host`/`Origin` is not the configured local origin; state-changing requests require JSON content type and a custom header (CSRF defence).
- Worker Mode B (Docker) runs the worker in a container with read-only root filesystem, mounted `data/` subpaths only, dropped capabilities, and egress restricted to the proxy policy.
- **IIS or shared hosting** would require: a separately running server and worker (e.g. Windows services), IIS as reverse proxy (ARR/URL Rewrite) to the server only, authentication and authorization added first, and the worker never exposed. Static hosting alone is insufficient. Not part of V1.

## No-AI guarantee

No package in the scan path imports an AI SDK. The `AdvisoryProvider` default is `none`; Phase 8 adds a provider only on explicit request. Tests in Phase 8 assert no provider request occurs when disabled.
