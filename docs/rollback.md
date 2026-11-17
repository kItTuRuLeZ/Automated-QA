# Rollback and switching features off

## Before upgrading

1. Stop the tool (close the window running `npm start`, or press Ctrl+C there).
2. Take a backup: `npm run backup`. It writes a .zip of the database and evidence to `./backups` and says where.
3. Note the current version: `git rev-parse --short HEAD`.

## Rolling back

1. Stop the tool.
2. Return to the noted version: `git checkout <version>`, then `npm install`.
3. Restore the backup taken before the upgrade: `npm run restore -- <backup.zip>`. This matters because the database is only ever upgraded forward, and an older version is not built to read a database that a newer version changed.
4. Start the tool and check Help → System status.

Without a backup from before the upgrade, roll back the code only if the newer version made no database changes. To check, run `git diff <old version> <new version> -- packages/core/src/db/migrations.ts`: any added migration means the database changed.

## Switching features off without a code change

| Feature | How to turn it off | Effect |
| --- | --- | --- |
| Browser traces of failed checks | Untick "Keep a browser trace when a check fails" on the scan page, or send `traces: "off"` | No trace files are kept; screenshots and steps still are |
| Automatic quiz answering during the walk | Untick "Answer quiz questions automatically" | The walk stops at question gates; answer-key rules still work |
| Interaction tests | Untick "Test interactions" on the upload page, or untick "Interaction cases and behavior rules" on New scan | Page, link, accessibility and layout checks still run. (The Quick profile is different: it also turns off accessibility, layout and exploration and checks only the first page.) |
| A behavior rule or quiz key | Set its Approval to Retired | It no longer runs; past results are kept |
| Parallel scans | Do not set `CQA_WORKER_CONCURRENCY` (default 1) | One scan at a time |
| Local or intranet targets | Leave `CQA_ALLOW_LOCAL_TARGETS` and `CQA_ALLOW_INTRANET` unset | Those addresses are refused |
