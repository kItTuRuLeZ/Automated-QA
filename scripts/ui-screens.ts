/**
 * Captures screenshots of the demo data (see scripts/ui-demo.ts) for before/after review.
 *   npx tsx scripts/ui-screens.ts <outDir> <before|after> [baseUrl]
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const [out = 'docs/ui-ux/screens', set = 'after', base = 'http://127.0.0.1:4327'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const get = async <T>(p: string): Promise<T> => (await fetch(base + p)).json() as Promise<T>;
const projects = await get<Array<{ id: string; name: string; lastRun?: { id: string } }>>('/api/projects');
const problems = projects.find((p) => p.name.includes('lessons with problems'))!;
const interactive = projects.find((p) => p.name.includes('accordion'))!;
const findings = await get<Array<{ id: string }>>(`/api/runs/${problems.lastRun!.id}/findings`);

type Shot = { name: string; hash: string; full?: boolean; width?: number; height?: number; act?: (page: import('playwright').Page) => Promise<void> };
const shots: Shot[] = [
  { name: '01-projects', hash: '/', full: true },
  { name: '02-project', hash: `/projects/${problems.id}`, full: true },
  { name: '03-results', hash: `/runs/${problems.lastRun!.id}`, full: true },
  { name: '04-coverage', hash: `/runs/${interactive.lastRun!.id}${set === 'after' ? '/coverage' : ''}`, full: true },
  { name: '05-finding', hash: `/findings/${findings[0]!.id}`, full: true },
  { name: '06-projects-mobile', hash: '/', full: true, width: 390, height: 844 },
  { name: '07-results-mobile', hash: `/runs/${problems.lastRun!.id}`, full: false, width: 390, height: 844 },
];
if (set === 'after') shots.push(
  {
    name: '12-new-scan-checks',
    hash: `/projects/${problems.id}/new-scan`,
    full: true,
    act: async (p) => {
      await p.getByRole('button', { name: 'Next' }).click();
      await p.getByText('Advanced settings').click();
    },
  },
  {
    name: '13-new-scan-review',
    hash: `/projects/${problems.id}/new-scan`,
    full: true,
    act: async (p) => {
      await p.getByRole('button', { name: 'Next' }).click();
      await p.getByRole('button', { name: 'Next' }).click();
    },
  },
  {
    name: '14-evidence-viewer',
    hash: `/runs/${problems.lastRun!.id}/issues`,
    act: async (p) => {
      await p.locator('.shot-thumb').first().click();
    },
  },
  {
    name: '15-download-menu',
    hash: `/runs/${problems.lastRun!.id}`,
    act: async (p) => {
      await p.getByRole('button', { name: /Download report/ }).click();
    },
  },
  { name: '16-results-200-percent-zoom', hash: `/runs/${problems.lastRun!.id}`, full: true, width: 720, height: 450 },
  { name: '17-results-1366', hash: `/runs/${problems.lastRun!.id}`, width: 1366, height: 768 },
  { name: '08-new-scan', hash: `/projects/${problems.id}/new-scan`, full: true }, { name: '09-issues', hash: `/runs/${problems.lastRun!.id}/issues`, full: true }, { name: '10-technical', hash: `/runs/${problems.lastRun!.id}/technical`, full: true }, { name: '11-help', hash: '/help', full: true });
const browser = await chromium.launch();
for (const s of shots) {
  const ctx = await browser.newContext({ viewport: { width: s.width ?? 1440, height: s.height ?? 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/#${s.hash}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await s.act?.(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, `${set}-${s.name}.png`), fullPage: s.full ?? false });
  await ctx.close();
}
await browser.close();
console.log(`wrote ${shots.length} screenshots to ${out}`);
