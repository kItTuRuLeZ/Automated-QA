# Setup

Course QA Automation runs on one computer for one person. It needs no account, no cloud service, and no AI key.

## What you need

- Windows, macOS, or Linux.
- **Node.js 24** (the "LTS" download from nodejs.org; `.nvmrc` names the version).
- About 1 GB of free disk space for the browser, plus space for screenshots (a typical scan is a few tens of MB).
- Internet access **only** for the install steps below and for scanning public course URLs.

## Install (once, while online)

```bash
npm install
npm run browsers:install
```

`browsers:install` downloads the Chromium build the scanner uses. Without it, scans and PDF reports cannot run (Help → System status shows this as "Not ready to scan"). Do it before going offline.

## Start

```bash
npm start
```

Open <http://127.0.0.1:4317>. Use `127.0.0.1`, not `localhost`. The app listens on this computer only. Data (database and screenshots) is stored in `./data`; set `CQA_DATA_DIR` to put it elsewhere.

**Help → System status** (link at the top of the app) says whether this computer is ready to scan, and lists what works, what is blocked, and what is not included in this version.

## Scanning without the internet: the sample course pack

The `fixtures/` folder is a small pack of local sample courses with known problems (see `fixtures/README.md`). Because private and local addresses are blocked by default, scanning them needs an administrator to allow exact local ports:

1. In one terminal, start the sample server: `npm run fixtures:serve` (serves on 127.0.0.1 ports 4400 and 4401).
2. Stop the app if it is running, then start it with the allow-list set.

   Windows (PowerShell):

   ```powershell
   $env:CQA_ALLOW_LOCAL_TARGETS = "127.0.0.1:4400,127.0.0.1:4401"; npm start
   ```

   macOS / Linux:

   ```bash
   CQA_ALLOW_LOCAL_TARGETS=127.0.0.1:4400,127.0.0.1:4401 npm start
   ```

3. Create a project and scan `http://127.0.0.1:4400/healthy/` (or any folder name in `fixtures/`).

The setting accepts only loopback address and port pairs. Anything else, including other private addresses and cloud metadata addresses, is ignored with a warning in the server log. It is read once at start-up and cannot be changed from the app. Leave it unset for normal use.

## Verified commands and where each part runs

Verified on Windows 11 with Node 24 and Playwright 1.64.1 on 13 November 2026. **Not verified on Linux or macOS**; the same commands are expected to work there, but nothing in this section has been run on them.

| Purpose | Command | Notes |
| --- | --- | --- |
| Install once | `npm install`, then `npm run browsers:install` | Downloads the headless Chromium build scans use (about 1 GB of disk) |
| Start | `npm start` | Builds the web app, then runs the server (127.0.0.1:4317, packages on 4318) and the worker |
| Stop | Ctrl+C in the window running it | A scan that was running stays shown as running until the next start, which marks it partial or failed ("the worker stopped before this scan finished") and clears temp folders |
| Type-check | `npm run typecheck` | |
| Tests | `npm test` | About 45 to 60 minutes; unit and browser integration tests |
| Tool UI tests | `npm run test:ui` | Uses ports 4417 and 4418 and an empty data folder. It rebuilds the web app first, so reload any open copy of the tool afterwards |
| Detection scorecard | `npm run test:scorecard` | About 15 minutes |

- **Writable folders:** `data/` (database, evidence) and `data/tmp` (scan temp files); set `CQA_DATA_DIR` to move them. Backups go to `backups/` in the folder you run the command from, unless you name a path: `npm run backup -- <file.zip>`.
- **Ports:** `CQA_PORT` and `CQA_PACKAGE_PORT`.
- **Concurrency:** `CQA_WORKER_CONCURRENCY`, 1 to 4, default 1. Each scan runs a full Chromium.
- **Evidence retention:** `npm run retention -- --days 90` (add `--dry-run` to see what would go).
- **Where each part runs:** all three parts run on one computer. The web app (`apps/web/dist`) is static files, but the server accepts requests only for 127.0.0.1 or localhost on its own port and from its own pages, so it is served by the tool's server, not hosted separately. Hosting it elsewhere would need that allow-list changed in code. The worker needs Chromium and runs beside the database. The tool has no login: do not expose it on a network. A shared pilot needs the organisation's existing access controls in front of it. A container is not required.
- **Run one copy only.** A second `npm start` is refused by the worker, but before that it rebuilds the web app, which breaks an open copy's pages until reloaded, and its server then stops because the port is taken.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `CQA_DATA_DIR` | `./data` | Where the database and screenshots are stored |
| `CQA_PORT` | `4317` | Port for the app (loopback only) |
| `CQA_ALLOW_LOCAL_TARGETS` | unset | Comma-separated `127.0.0.1:port` pairs that may be scanned (offline sample pack) |
| `CQA_PACKAGE_PORT` | `4318` | Port of the separate local address that serves uploaded course packages |
| `CQA_RETENTION_DAYS` | unset | If set, scans older than this many days are deleted at start-up |
| `CQA_WORKER_CONCURRENCY` | `1` | How many scans run at the same time (1 to 4). Each scan uses its own Chromium, so raise it only on a machine with memory to spare |

## Course packages (ZIP uploads)

On a project page, **Course packages** accepts a ZIP (SCORM 1.2, SCORM 2004, or plain HTML5). It is checked and inspected without running anything. If it has several lessons, you choose which to scan; lessons you do not choose are reported as not scanned. A scan opens the package from `http://127.0.0.1:4318` (a different address from the app), blocks requests to other websites unless you allow them, and asks you to confirm because the package's own JavaScript runs in a browser on this computer. Upload a fixed version as a replacement to keep issue history lining up.

Limits: 250 MB upload, 1 GB expanded, 20,000 files, 100:1 expansion. Backups include the database and screenshots but **not** uploaded packages; upload them again after a restore.

## Backup and restore

```bash
npm run backup                      # writes backups/course-qa-backup-<date>.zip
npm run backup -- D:\safe\qa.zip    # or choose the file
npm run restore -- D:\safe\qa.zip   # stop the app first
```

A backup is one zip: a consistent copy of the database, every screenshot and evidence file, and a checksum list. It contains screenshots of the courses you scanned, so store it like the courses themselves.

Restore checks every checksum and the database's own integrity check before changing anything, refuses files it does not recognize, and **moves your current data aside** (into `before-restore-<time>` inside the data folder) instead of deleting it. Delete that folder once you are sure.

## Clean-up and deletion

- Delete one scan from its page, or a project from the project list. A scan that holds the stored visual baseline for its course asks you to confirm, because deleting it removes the baseline.
- To delete old scans in bulk: `npm run retention -- --days 90 --dry-run` shows what would go; drop `--dry-run` to do it. The latest scan of each course and any scan holding a baseline are always kept. Issue status history is kept.
- Set `CQA_RETENTION_DAYS` to run the same clean-up each time the app starts.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| "Not ready to scan" in Help → System status (scanning browser blocked) | Run `npm run browsers:install`, then restart |
| A scan of a local or intranet address is refused (NET-001) | Local and private addresses are blocked by design; see the sample pack section for the offline exception |
| PDF download fails but HTML and Excel work | The scanning browser is missing (see above) |
| `npm run restore` says the app is running | Stop `npm start` first |
| A scan fails with "The scan browser (Chromium) was not found at …" | The browser is not where Playwright looks. Run `npm run browsers:install`. If the `PLAYWRIGHT_BROWSERS_PATH` environment variable is set, it must point at the folder that holds the browsers (by default `%LOCALAPPDATA%\ms-playwright` on Windows), or be removed |
| A scan fails with "The scan browser closed or crashed during the scan" | Chromium stopped part-way (out of memory, killed process). Results up to that point are kept; run the scan again, with fewer scans at once if `CQA_WORKER_CONCURRENCY` is above 1 |
| "Another copy of the tool is already running (process …). This copy was not started" | A second `npm start` was run. Use the copy already open, or close it first. A copy that crashed releases its lock when its process is gone, or after 5 minutes |
| Help → System status: "Installed, but it could not start the way scans start it: …" | The headless browser scans use is missing or blocked (for example by antivirus). Run `npm run browsers:install`; the status is rechecked after 30 seconds |
| "Unexpected Host header." (HTTP 421) | The app was opened by a name it does not expect (for example a tunnel or `localhost` on another port). Open http://127.0.0.1:4317 |
| "Cross-origin requests are not allowed." or "Missing X-QA-Request header." (HTTP 403) | Something other than the app's own page sent a request. Use the app in the browser; scripts must send `X-QA-Request: 1` |
| Log: "could not remove the scan temp folder; it is cleared at the next start" | Windows still held a file from the closed browser. Harmless; it is retried at the next start |
