/**
 * Seeds a throwaway demo data folder through the app's own API, using the sample course pack,
 * so the interface can be reviewed (and screenshotted) without touching real projects.
 *
 *   CQA_DATA_DIR=data/tmp/ui-demo CQA_PORT=4327 CQA_ALLOW_LOCAL_TARGETS=127.0.0.1:4400,127.0.0.1:4401 npm start   (app + worker)
 *   npm run fixtures:serve                                                                                       (sample pack)
 *   npx tsx scripts/ui-demo.ts http://127.0.0.1:4327
 */
const base = process.argv[2] ?? 'http://127.0.0.1:4327';
const host = new URL(base).host;

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(base + url, { method, headers: { Host: host, Origin: base, 'X-QA-Request': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${data.error ?? ''}`);
  return data;
}

const finished = new Set(['completed', 'partial', 'failed', 'cancelled']);
async function wait(runId: string): Promise<void> {
  for (let i = 0; i < 240; i++) {
    const r = await call<{ status: string }>('GET', `/api/runs/${runId}`);
    if (finished.has(r.status)) return;
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  throw new Error(`scan ${runId} did not finish`);
}

const courses = [
  { name: 'Demo: healthy course', desc: 'A clean sample course.', url: 'http://127.0.0.1:4400/healthy/', explore: false },
  { name: 'Demo: lessons with problems', desc: 'Missing assets, a script error and placeholder text.', url: 'http://127.0.0.1:4400/missing-asset/', explore: false },
  { name: 'Demo: accordion and tabs', desc: 'Interactive sample for coverage review.', url: 'http://127.0.0.1:4400/accordion/', explore: true },
];
for (const c of courses) {
  const p = await call<{ id: string }>('POST', '/api/projects', { name: c.name, description: c.desc, courseUrl: c.url });
  const run = await call<{ id: string }>('POST', `/api/projects/${p.id}/scans`, { url: c.url, explore: c.explore, accessibility: true, layout: true, viewports: ['desktop', 'mobile'], maxStates: 10, maxDepth: 2 });
  await wait(run.id);
  console.log(`${c.name}: project ${p.id}, run ${run.id}`);
}
await call('POST', '/api/projects', { name: 'Demo: not scanned yet', description: 'A project with no scans.' });
console.log('Demo data ready.');
