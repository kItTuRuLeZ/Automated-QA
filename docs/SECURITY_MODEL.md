# Security Model

Inspected courses are untrusted code. The application scans user-supplied targets, so it must not become a tool for reaching internal services (SSRF), leaking secrets, or executing uploaded code with application privileges.

## Assets to protect

- The host machine and its local network (loopback services, intranet, cloud metadata endpoints).
- Application data: SQLite DB, artifacts, configuration, future API keys (Phase 8).
- Course session state, cookies, signed URLs, and learner data that appear during scans.
- Integrity of findings (no fabricated or silently altered results).

## Threats

| Threat | Example | Primary control |
| --- | --- | --- |
| SSRF via target URL | `http://169.254.169.254/`, `http://127.0.0.1:5432/` | Outbound policy at submission and worker run |
| SSRF via redirect/subrequest | Course page redirects or loads `http://10.0.0.5/admin` | Worker egress proxy validates every connection |
| DNS rebinding | Host resolves public at validation, private at connect | Proxy resolves once and connects to the validated IP |
| Alternate IP encodings | `http://2130706433/`, `0x7f.1`, `[::ffff:127.0.0.1]` | WHATWG URL normalization + `ipaddr.js` on resolved addresses, IPv4-mapped IPv6 unwrapped |
| Proxy bypass | WebRTC UDP, QUIC, service workers, Chromium's implicit loopback bypass | Browser flags and context options (below) |
| Course code attacking the app | Script calls `http://127.0.0.1:<server>/api/...` | Loopback denied by proxy; server Origin/Host checks; CSRF header |
| Hostile uploads (Phase 6) | ZIP bomb, `../../` paths, symlinks, XXE | Archive limits, path validation, safe XML parser, separate origin |
| Secret leakage | Tokens in query strings appear in reports/logs | Redaction policy before persistence |
| Path traversal on artifacts | `GET /api/artifacts/../../qa.sqlite` | Opaque IDs, DB lookup, root confinement |
| Resource exhaustion | Infinite SPA states, huge downloads | Budgets: states, depth, runtime, bytes, downloads, redirects, concurrency |
| Unsafe actions | Submit/delete/purchase/send buttons | Read-only exploration policy and action deny list |

## Outbound network policy

One policy module (`apps/worker/src/net/policy.ts`, Phase 1) is used for: target submission (server pre-check), initial navigation, redirects, all browser subrequests and WebSockets (via proxy), link checks (Phase 2), and package external dependencies (Phase 6).

### Target validation (submission and run start)

1. Parse with the WHATWG `URL` parser (normalizes numeric/hex/octal IPv4 host forms).
2. Allow only `http:` and `https:`. Reject `file:`, `data:`, `javascript:`, `ftp:`, `ws:` as targets, etc.
3. Reject embedded credentials (`user:pass@`).
4. Enforce configured scope: allowed origins and path prefixes from `ScanConfig.scope`.
5. Resolve the hostname (all A/AAAA records). Reject if **any** resolved address is in a denied range.
6. Ports: allow 80/443 by default; other ports require explicit scope configuration.

### Denied ranges (default)

Classified with `ipaddr.js`; anything not `unicast` (public) is denied, including:
IPv4 `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16` (incl. metadata `169.254.169.254`), `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`, `255.255.255.255`;
IPv6 `::/128`, `::1/128`, `::ffff:0:0/96` (checked after unwrapping), `64:ff9b::/96` (checked by embedded IPv4), `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`, and other reserved blocks. Hostnames `localhost`, `*.localhost`, and `*.internal`-style names resolve and are checked like any other.

### Enforcement at connection time (worker egress proxy)

- The worker starts a local HTTP/HTTPS forward proxy per run on `127.0.0.1:<random port>` with a per-run random credential.
- For every request/CONNECT the proxy: checks scheme and scope rules for the request class (navigation vs. subrequest), resolves DNS itself, validates **every** resolved IP, and opens the socket **to the validated IP** (pinning). This prevents DNS rebinding between check and use.
- Blocked connections are recorded (sanitized URL + reason) as NET-002 coverage evidence.
- Subrequests to other public origins (CDNs, fonts) are allowed by default for published courses and logged; a stricter "scope-only" mode denies them. Uploaded packages (Phase 6) default to deny external with an allowlist.
- Byte, redirect, and duration budgets are enforced in the proxy.

### Browser hardening

- Chromium launched with `--proxy-server=http://127.0.0.1:<port>` and `--proxy-bypass-list=<-loopback>` (removes Chromium's implicit loopback bypass so loopback also goes through the proxy, where it is denied).
- `--disable-quic`, WebRTC restricted with `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`.
- Browser context: `serviceWorkers: 'block'`, `acceptDownloads: false` (or bounded download dir), no persisted storage state, fresh context per run, `bypassCSP: false`.
- Playwright `route` handlers provide a second, logging-only layer and abort non-HTTP(S) schemes; they are not relied upon as the sole control because they do not cover every transport.
- Browser sandbox is never disabled (`--no-sandbox` forbidden). Verified in tests.

### Intranet scans (future)

An administrator-configured allowlist of hosts/CIDRs may be added later. It is explicit, logged, and narrow. The worker's own package server (Phase 6) is a single host:port exception served on a separate origin, not a blanket private-network permission.

## Worker isolation

A disposable browser context is **not** a security boundary.

| Mode | When | Controls | Limitations |
| --- | --- | --- | --- |
| A: local process | Default, Phases 1–5 (public/published URLs) | Chromium sandbox, egress proxy, no Node execution of course code, temp dirs per run, run under the user account | Shares the user's filesystem permissions and network namespace; a browser sandbox escape would not be contained. Documented in UI "About/Security". |
| B: Docker container | Required before scanning uploaded packages (Phase 6); optional earlier | Non-root user, read-only root FS, only `data/tmp/<run>` and `data/artifacts/<run>` mounted writable, dropped capabilities, no host network, egress allowed only through the policy (network namespace with proxy/firewall rules), CPU/memory limits | Requires Docker Desktop/WSL on Windows. |

Filesystem and network restrictions of each mode are tested (see TEST_STRATEGY).

## Unsafe actions (read-only exploration)

Default deny: form submission, `type=submit` buttons, elements whose name/label matches delete, remove, submit, send, purchase, buy, pay, checkout, sign out, log out, reset, unsubscribe, publish; links to `mailto:`, `tel:`, downloads; file inputs; elements opening new windows outside scope. Quiz answers are not brute-forced. Allowed: adapter-recognized tabs, accordions, dialog open/close, Next/Back, in-scope links. Skipped actions are recorded with reasons (COV-001).

## Application surface (V1)

- Server binds `127.0.0.1` only. Requests with unexpected `Host` or `Origin` are rejected.
- State-changing endpoints require `Content-Type: application/json` and a custom header (`X-QA-Request: 1`), which a cross-origin page cannot send without a CORS preflight; CORS is not enabled.
- No endpoint fetches or proxies arbitrary URLs for the UI.
- Shared or network deployment requires authentication and authorization first (future work).

## Uploads (Phase 6 summary)

Limits on compressed bytes, expanded bytes, entry count, compression ratio, and extraction time. Reject absolute paths, `..` segments, drive letters, symlinks, duplicate/case-ambiguous paths, encrypted entries. XML parsed with DTD/external entities/network disabled. Extracted content served from a separate origin (different port) with no access to app cookies or API; never executed by Node; no dependency installation.

## Data handling and redaction

- **Redaction policy** (configurable, default on): strip URL query strings and fragments in stored URLs except allowlisted parameter names; redact values of parameters matching `token|key|sig|signature|auth|session|password|code`; strip `Authorization`, `Cookie`, `Set-Cookie` headers; never store storage state.
- Applied before writing logs, DB rows, reports, and exports. Screenshots may contain visible sensitive data; evidence redaction regions are a Phase 5 option and demos use fixtures without sensitive data.
- Secrets (Phase 8 API keys) are stored server-side only, never in the DB in plaintext exports, never sent to the browser, never logged.
- No telemetry.

## Retention and deletion

- Retention (default: keep until deleted). `CQA_RETENTION_DAYS` or `npm run retention` deletes scans older than N days, always keeping the latest scan of each course and any scan holding a visual baseline. Deleting a run removes its rows and artifact directory (a run holding a baseline needs explicit confirmation); deleting a project cascades.
- Temp files are removed at run end, failure, and cancellation; orphaned temp dirs are cleaned on worker start.
- Backup/restore (Phase 5): `npm run backup` writes a zip with an online-consistent database copy, all artifacts, and SHA-256 checksums. Restore verifies the manifest and every checksum, accepts only the database and well-formed `artifacts/<run>/<file>` names (no `..`, absolute, or unlisted paths), checks the restored database with SQLite's integrity check, refuses backups from a newer schema, and moves existing data aside instead of deleting it.

## Local targets (administrator opt-in)

Production policy denies loopback and private addresses. For the offline sample pack, an administrator can set `CQA_ALLOW_LOCAL_TARGETS` to exact `127.0.0.1:port` / `[::1]:port` pairs before starting the app and worker. Only loopback pairs are accepted (anything else is ignored with a warning), the value is read once at start-up, and it cannot be set from the API or UI. The About page shows when it is on.

## Integrity

- Results are append-only per run; retests create new runs.
- Demo data is flagged `isDemo` and stored in a separate project namespace; it is never mixed into real totals.
