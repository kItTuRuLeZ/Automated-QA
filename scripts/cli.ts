import net from 'node:net';
import path from 'node:path';
import { ArtifactStore, BackupError, SERVER_HOST, SERVER_PORT, Store, createBackup, describeBackupSize, openDatabase, restoreBackup, resolveDataPaths, sweepRetention } from '@cqa/core';

const [command, ...rest] = process.argv.slice(2);

function appIsRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: SERVER_HOST, port: SERVER_PORT });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
    s.setTimeout(800, () => (s.destroy(), resolve(false)));
  });
}

async function main(): Promise<number> {
  if (command === 'backup') {
    const paths = resolveDataPaths();
    const out = rest[0] ?? path.join('backups', `course-qa-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`);
    const m = await createBackup(paths, out);
    console.log(`Backup written to ${out} (${describeBackupSize(out)}): the database and ${m.files.length - 1} evidence file(s), with checksums.`);
    console.log('Keep it somewhere safe. It contains screenshots of the courses you scanned.');
    return 0;
  }
  if (command === 'restore') {
    const file = rest[0];
    if (!file) {
      console.error('Usage: npm run restore -- <backup.zip>');
      return 2;
    }
    if (await appIsRunning()) {
      console.error(`The app appears to be running on ${SERVER_HOST}:${SERVER_PORT}. Stop it first, then restore.`);
      return 1;
    }
    const r = restoreBackup(file);
    console.log(`Restored the backup made ${r.manifest.createdAt}.`);
    if (r.keptPreviousAt) console.log(`Your previous data was kept in ${r.keptPreviousAt}. Delete that folder once you are sure the restore is right.`);
    return 0;
  }
  if (command === 'retention') {
    const i = rest.indexOf('--days');
    const days = Number(i >= 0 ? rest[i + 1] : process.env.CQA_RETENTION_DAYS);
    if (!Number.isFinite(days) || days < 1) {
      console.error('Usage: npm run retention -- --days <number> [--dry-run]');
      return 2;
    }
    const paths = resolveDataPaths();
    const store = new Store(openDatabase(paths.dbFile));
    const result = sweepRetention(store, new ArtifactStore(paths.artifacts, store), { days, dryRun: rest.includes('--dry-run') });
    const verb = rest.includes('--dry-run') ? 'Would delete' : 'Deleted';
    console.log(`${verb} ${result.deleted.length} scan(s) finished more than ${days} days ago. Kept ${result.kept.latestForCourse} as the latest scan of their course and ${result.kept.holdsBaseline} that hold a visual baseline.`);
    store.db.close();
    return 0;
  }
  console.error('Commands: backup [file] | restore <file> | retention --days <n> [--dry-run]');
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof BackupError ? `Problem with the backup: ${err.message}` : err);
    process.exit(1);
  },
);
