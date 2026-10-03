# Course QA Automation

Local, evidence-backed QA scanning for published eLearning courses (Rise, Storyline, custom HTML). Core scanning needs no AI service, cloud account, or telemetry.

Status: Phase 5 complete (V1 release candidate for local use): URL scan, bounded click-through with coverage, links, images and media, placeholder text, accessibility and keyboard checks, screen sizes and layout heuristics, client profiles, finding workflow and retest, and JSON / HTML / PDF / Excel reports. See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

## Requirements

- Node.js 24 LTS (see `.nvmrc`)
- Windows, macOS, or Linux. Network access is needed only for installation and for scanning public URLs.

## Setup

```bash
npm install
npm run browsers:install
```

`browsers:install` downloads the Playwright Chromium build that matches the pinned Playwright version. Do this before working offline.

## Run

Full setup, offline use, backup and restore: [docs/SETUP.md](docs/SETUP.md). What V1 supports and what still needs manual QA: [docs/RELEASE_V1.md](docs/RELEASE_V1.md).

```bash
npm start
```

Open http://127.0.0.1:4317 (use `127.0.0.1`, not `localhost`). This builds the UI and starts two processes: the API server (bound to loopback only) and the scan worker. Data is stored in `./data` (SQLite + screenshots); set `CQA_DATA_DIR` to change it.

For UI development, `npm run dev` runs the server, worker, and Vite dev server at http://127.0.0.1:5317.

## Check

```bash
npm run typecheck
npm test
```

Tests run real Chromium scans against local fixtures in `fixtures/`; no public website is required.

## What a scan does today

Loads the course URL in an isolated Chromium context and records the screenshot, title, sanitized final URL, uncaught exceptions, console errors, failed requests, requests blocked by policy, redirect scope, and navigation timing. Private, loopback, link-local, and other reserved addresses are blocked at submission and again for every connection the browser makes.

With exploration on (the default), it then clicks through recognized tabs, accordions, dialogs, Next/Back controls, and in-scope links, within limits on states, depth, pages, and time. It never submits forms or clicks controls that look destructive, and it reports what it skipped, which frames and canvas areas it could not inspect, and which budgets stopped it.

With accessibility checks on (the default), every reached screen is also tested with axe-core, tabbed through with the keyboard (traps, visible focus), has its dialogs and recognized controls operated by keyboard, and is checked at a 320 px width. A manual review checklist is shown with every scan. Automated results never establish accessibility compliance.

Each scan page opens with a plain "What to do" summary (fix, check by hand, not checked) and offers an **Excel tracker** with one row per issue, a status dropdown, owner and notes columns, and issue IDs that stay the same across scans. The project page downloads one consolidated workbook for all its scans.

Reports download as Excel, a self-contained HTML file, PDF, or JSON, all from the same report model. Each issue has a status, owner, and reason that follow it across scans. **Retest this course** runs a new linked scan: an issue becomes *Verified* only if it was marked fixed, was not found again, and its check passed on the same screen at the same screen size; otherwise it is *Not reproduced* or *Not retested*. **Client profiles** hold a client's own brand values, terms, link policy, and rule settings (nothing is built in), and the **About** page shows what this installation can and cannot do.

A completed scan means the configured scan finished, not that the course passed QA.

## Documentation

- [PROJECT.md](PROJECT.md): scope and non-claims
- [ARCHITECTURE.md](ARCHITECTURE.md): components, lifecycle, decisions
- [docs/QA_RULE_CATALOG.md](docs/QA_RULE_CATALOG.md): rules and capability matrix
- [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md): network policy and isolation
- [docs/TEST_STRATEGY.md](docs/TEST_STRATEGY.md): fixtures and tests
