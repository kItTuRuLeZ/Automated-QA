# Test fixtures

Local course fixtures served by `tests/support/fixture-server.ts` on `127.0.0.1` during tests. They contain no client content or sensitive data.

| Fixture | Purpose |
| --- | --- |
| `healthy/` | Clean page: title, stylesheet, image. Expect no findings. |
| `missing-asset/` | 404 script and 404 image (RUN-004). |
| `js-exception/` | Console error (RUN-003) and uncaught exception on load (RUN-002). |
| `blocked-subrequest/` | Image from `169.254.169.254`; must be NET-002, not RUN-004. |
| `no-title/` | Missing `<title>` (RUN-005). |

Dynamic routes in the fixture server: `/redirect/in` (302 to `/healthy/`), `/redirect/out` (302 to a second origin, outside scope), `/slow` (responds after the navigation timeout), `/http-404` (404 document).
