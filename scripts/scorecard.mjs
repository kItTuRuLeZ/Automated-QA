// Runs the detection scorecard (about 30 scans). Kept out of the normal test run because of its length.
import { spawnSync } from 'node:child_process';
const r = spawnSync('npx vitest run tests/detection-scorecard.integration.test.ts --disable-console-intercept --silent=false', { stdio: 'inherit', shell: true, env: { ...process.env, CQA_SCORECARD: '1' } });
process.exit(r.status ?? 1);
