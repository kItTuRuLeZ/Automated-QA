# Test fixtures

Local course fixtures served by `tests/support/fixture-server.ts` on `127.0.0.1` during tests. They contain no client content or sensitive data.

| Fixture | Purpose |
| --- | --- |
| `healthy/` | Clean page: title, stylesheet, image. Expect no findings. |
| `missing-asset/` | 404 script and 404 image (RUN-004). |
| `js-exception/` | Console error (RUN-003) and uncaught exception on load (RUN-002). |
| `blocked-subrequest/` | Image from `169.254.169.254`; must be NET-002, not RUN-004. |
| `no-title/` | Missing `<title>` (RUN-005). |
| `late-title/` | Title set 1.5 s after load; must not be RUN-005. |
| `aborted-fetch/` | Page aborts its own fetch; must not be RUN-004. |
| `spa-lessons/`, `tabs/`, `accordion/`, `modal/`, `nav-loop/` | Traversal: hash-routed lessons, working and broken tabs/sections/dialogs, a cycling Next. |
| `canvas/`, `unsafe-actions/` | Canvas disclosure (COV-003); unsafe and ambiguous controls skipped (COV-001). |

Dynamic routes in the fixture server: `/iframe/` (out-of-scope, blocked, and in-scope frames), `/redirect/in` (302 to `/healthy/`), `/redirect/out` (302 to a second origin, outside scope), `/slow` (responds after the navigation timeout), `/http-404` (404 document).
