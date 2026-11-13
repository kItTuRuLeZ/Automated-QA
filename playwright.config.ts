import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright Test is only for testing this tool's own screens. Production scans use the `playwright` library in
 * apps/worker and never import @playwright/test. The app runs on its own ports with a fresh, empty data folder, so
 * these tests never touch real projects and can run beside a copy of the tool that is already open.
 */
const PORT = 4417;
// The app holds its database open until it stops, after the run ends, so folders from earlier runs are removed here
// instead: only ones more than a day old, so a run going on at the same time is never touched.
const DAY = 24 * 60 * 60 * 1000;
for (const name of readdirSync(tmpdir())) {
  const dir = path.join(tmpdir(), name);
  if (name.startsWith('cqa-ui-') && dir !== process.env.CQA_UI_DATA_DIR && Date.now() - statSync(dir).mtimeMs > DAY) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Still in use by a run that is going on: leave it.
    }
  }
}
const dataDir = process.env.CQA_UI_DATA_DIR ?? mkdtempSync(path.join(tmpdir(), 'cqa-ui-'));
process.env.CQA_UI_DATA_DIR = dataDir;

export default defineConfig({
  testDir: 'tests-ui',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build -w @cqa/web && npm run start -w @cqa/server',
    url: `http://127.0.0.1:${PORT}/api/projects`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: { CQA_PORT: String(PORT), CQA_PACKAGE_PORT: String(PORT + 1), CQA_DATA_DIR: dataDir },
  },
});
