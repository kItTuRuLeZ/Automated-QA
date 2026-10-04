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

`browsers:install` downloads the Chromium build the scanner uses. Without it, scans and PDF reports cannot run (the About page shows this as "Blocked"). Do it before going offline.

## Start

```bash
npm start
```

Open <http://127.0.0.1:4317>. Use `127.0.0.1`, not `localhost`. The app listens on this computer only. Data (database and screenshots) is stored in `./data`; set `CQA_DATA_DIR` to put it elsewhere.

**About this installation** (link at the top of the app) lists what works, what is blocked, and what is not included in this version.

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

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `CQA_DATA_DIR` | `./data` | Where the database and screenshots are stored |
| `CQA_PORT` | `4317` | Port for the app (loopback only) |
| `CQA_ALLOW_LOCAL_TARGETS` | unset | Comma-separated `127.0.0.1:port` pairs that may be scanned (offline sample pack) |
| `CQA_PACKAGE_PORT` | `4318` | Port of the separate local address that serves uploaded course packages |
| `CQA_RETENTION_DAYS` | unset | If set, scans older than this many days are deleted at start-up |

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
| "Blocked" next to the scanning browser on the About page | Run `npm run browsers:install`, then restart |
| A scan of a local or intranet address is refused (NET-001) | Local and private addresses are blocked by design; see the sample pack section for the offline exception |
| PDF download fails but HTML and Excel work | The scanning browser is missing (see above) |
| `npm run restore` says the app is running | Stop `npm start` first |
