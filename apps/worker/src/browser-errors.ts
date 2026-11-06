import type { ReasonCode } from '@cqa/shared';

/**
 * Turns a Playwright or browser error into a reason code and a sentence a reviewer can act on. A missing browser,
 * a browser that died under the scan, and a timeout are different problems with different fixes.
 */
export function classifyBrowserError(err: unknown): { reason: ReasonCode; detail: string } {
  const message = err instanceof Error ? err.message : String(err);
  const first = message.split('\n')[0] ?? '';
  // Playwright words this "Executable doesn't exist at …" (installed browser missing) or "Failed to launch chromium because executable doesn't exist at …" (explicit path).
  const missing = /executable doesn't exist at (.+?)(?:\s*$|\n)/im.exec(message);
  if (missing) {
    return {
      reason: 'browser_unavailable',
      detail: `The scan browser (Chromium) was not found at ${missing[1]!.trim()}. Run "npm run browsers:install" in the tool folder while online, then restart the tool. If the PLAYWRIGHT_BROWSERS_PATH environment variable is set, it must point at the folder that holds the installed browsers.`,
    };
  }
  if (/Failed to launch|spawn .* (ENOENT|EACCES)/i.test(message)) {
    return { reason: 'browser_unavailable', detail: `The scan browser could not be started: ${first}` };
  }
  if (/Target page, context or browser has been closed|browser has disconnected|Browser closed|crashed/i.test(message)) {
    return { reason: 'browser_crashed', detail: `The scan browser closed or crashed during the scan: ${first}` };
  }
  if (/Timeout \d+ms exceeded/i.test(message)) return { reason: 'timeout', detail: first };
  return { reason: 'engine_error', detail: first };
}
