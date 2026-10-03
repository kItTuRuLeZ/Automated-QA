import { chromium } from 'playwright';

let queue: Promise<unknown> = Promise.resolve();

/**
 * Renders trusted report HTML to PDF in a throwaway browser that is offline,
 * has JavaScript disabled, and aborts every request. The report embeds its own
 * images as data URIs, so nothing needs the network. One render at a time.
 */
export function renderPdf(html: string): Promise<Buffer> {
  const job = queue.then(() => render(html));
  queue = job.catch(() => undefined);
  return job;
}

async function render(html: string): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
  try {
    const context = await browser.newContext({ offline: true, javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false });
    const page = await context.newPage();
    // Belt and braces on top of offline mode: nothing leaves this page.
    await page.route('**/*', (route) => route.abort());
    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '12mm', right: '12mm' } });
    return Buffer.from(pdf);
  } finally {
    await browser.close().catch(() => undefined);
  }
}
