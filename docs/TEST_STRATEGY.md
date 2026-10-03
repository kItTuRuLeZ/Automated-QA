# Test Strategy

Tests prove behavior, false-positive resistance, failure paths, and security boundaries. They do not restate implementation details. Public websites are never required for the test suite.

## Layers

| Layer | Tool | Scope |
| --- | --- | --- |
| Type contracts | `tsc --noEmit` across workspaces | Shared types compile; apps conform to contracts. |
| Unit | `vitest` | Pure logic: URL/IP policy, redaction, fingerprints, severity mapping, state signatures, link classification, heuristics math. |
| Integration (worker) | `vitest` + real Playwright Chromium + local fixture server | Engines against fixtures produce expected check results/findings/coverage. |
| Integration (server) | `vitest` + Fastify `inject` + temp SQLite | API validation, job lifecycle, cancellation, restart recovery, artifact access control. |
| End-to-end | Playwright driving the web UI | Create project → scan fixture → view finding/evidence → export. |
| Security | Unit + integration | SSRF, rebinding, encodings, path traversal, CSRF/Origin, uploads, sandbox flags. |
| Manual verification | Checklist in this file | Things automation cannot judge (UI accessibility with a screen reader, real Rise/Storyline exports). |

## Fixture server

`fixtures/` contains static course fixtures served by a test-only HTTP server on `127.0.0.1`. Because loopback is denied by default, tests run the worker with a **test-only policy override** that allows exactly the fixture server's host:port. The override is constructed in test code, cannot be set via the API, and a dedicated test asserts that the production default still denies loopback.

To test DNS behavior, the policy accepts an injected resolver so tests can simulate public→private rebinding and multi-record answers without real DNS.

## Fixtures by phase

| Phase | Fixtures |
| --- | --- |
| 1 | `healthy/` (clean page), `missing-asset/` (404 image + 404 script), `js-exception/` (throws on load), `redirect/` (302 in-scope, 302 out-of-scope), `timeout/` (server delays beyond config), `disallowed/` (targets: `http://127.0.0.1:<other>`, `http://169.254.169.254/`, `http://user:pw@host/`, `file:///`, `http://2130706433/`, `http://[::ffff:127.0.0.1]/`) |
| 2 | `spa-lessons/` (hash/history routing), `accordion/`, `tabs/`, `modal/`, `nav-loop/` (Next cycles), `iframe-inaccessible/` (cross-origin + sandboxed), `links/` (200, 404, 401, 403, timeout, HEAD-405-then-GET, redirect chain), `lazy-image/`, `broken-media/`, `placeholder-text/`, `unsafe-actions/` (submit, delete, purchase buttons) |
| 3 | `a11y-known/` (missing alt, decorative empty alt, unlabeled input, missing lang, heading jump), `dialog-good/`, `dialog-broken/` (no focus move, no return), `keyboard-trap/`, `canvas/` |
| 4 | `overlay-intentional/` (tooltip, badge, slider, scroll container), `overflow/`, `clipped-text/`, `offscreen-dialog/`, `font-fail/`, `baseline-v1/` + `baseline-v2/` |
| 5 | Sample course pack combining the above; report-injection strings (`<script>`, `=HYPERLINK(...)`, `+cmd`, `@SUM`) in titles and text |
| 6 | Valid SCORM 1.2/2004 ZIPs, malformed XML, missing launch, missing dependency, multi-SCO, case mismatch, `../` traversal, symlink entry, oversized/high-ratio archive, XXE manifest |
| 7 | SCORM 1.2 and 2004 test SCOs with valid and invalid lifecycles, commit/resume, pass/fail |
| 9 | DOCX/XLSX storyboards: exact, normalized, edited, duplicate titles, reordered, ambiguous, unreachable feedback, unsupported layout |

Fixtures contain no real client content or sensitive data.

## False-positive cases (must stay clean)

- Decorative `img alt=""` → no A11Y-001 finding.
- Heading jump → warning only, never `automated_defect`.
- 401/403/timeout links → not LNK-001.
- Lazy images not yet in view → not MED-001 until scrolled/waited.
- Click with no observable change on an unrecognized element → NAV-002 inconclusive, not NAV-001.
- Intentional overlays, tooltips, badges, sliders, scroll containers → no LAY-001/LAY-003.
- Requests blocked by our policy → NET-002, not RUN-004 course defect.
- Unreached states / skipped checks → `not_tested`, never `passed`; totals exclude them from pass counts.
- Baseline comparison across different viewport/browser/config → refused, not "diff".

## Lifecycle and failure-path tests

- Queued → running → completed with real artifacts on disk whose hashes match DB rows.
- Target timeout → `failed` with reason; partial evidence retained.
- Cancellation mid-run → browser process gone, temp dir removed, run `cancelled`, unexecuted checks `not_tested` (reason `cancelled`).
- Worker killed mid-run → on restart, run marked `partial`/`failed` with `worker_lost`.
- Engine throws → that engine's checks `error` with reason; run `partial`; other engines continue.

## Security tests

- Each disallowed fixture target is rejected at submission and never launches a browser (assert no browser process / no proxy connection).
- Redirect to private IP and subrequest to loopback are blocked by the proxy and recorded.
- Rebinding: resolver returns public then private → connection refused.
- Production policy denies the fixture server host (override cannot leak).
- Artifact endpoint rejects unknown IDs, traversal strings, and artifacts of other projects.
- Server rejects foreign `Origin`, missing CSRF header, and non-JSON state-changing requests.
- Chromium launch args never include `--no-sandbox`.
- Logs and DB contain no query-string secrets from a fixture URL with `?token=SECRET`.
- (Phase 5) HTML report escapes course text; XLSX cells starting with `= + - @` are neutralized.
- (Phase 6) Upload attacks cannot write outside extraction root or reach app endpoints.
- (Phase 8) With AI disabled, zero provider requests.

## Manual verification checklist (per release)

- [ ] App UI keyboard-only walkthrough; visible focus throughout.
- [ ] App UI with a screen reader (NVDA on Windows) for main flows.
- [ ] Scan a user-provided Rise export, Storyline export, and custom HTML sample; record results or mark "pending — no sample supplied".
- [ ] Fresh install on a clean machine; scan and export with internet disabled against local fixtures.
- [ ] Review a generated report for readability and matching dashboard totals.

## Commands (from Phase 1 onward)

- `npm run typecheck` — all workspaces.
- `npm test` — unit + integration.
- `npm run test:e2e` — UI end-to-end.
