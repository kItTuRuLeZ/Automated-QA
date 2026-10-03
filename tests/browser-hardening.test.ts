import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '@cqa/worker';

describe('scan browser hardening', () => {
  it('launches Chromium with the sandbox enabled and all traffic forced through the proxy', async () => {
    const opts = chromiumLaunchOptions({ port: 1, username: 'u', password: 'p' }, '.');
    // launchServer exposes the real process so the actual command line can be inspected.
    const server = await chromium.launchServer({ headless: opts.headless, chromiumSandbox: opts.chromiumSandbox, args: opts.args, proxy: opts.proxy });
    try {
      const argv = server.process().spawnargs.join(' ');
      expect(argv).not.toContain('--no-sandbox');
      expect(argv).toContain('--proxy-server=http://127.0.0.1:1');
      expect(argv).toContain('<-loopback>');
      expect(argv).toContain('--disable-quic');
    } finally {
      await server.close();
    }
  });
});
