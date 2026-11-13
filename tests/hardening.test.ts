import { describe, expect, it } from 'vitest';
import { isAllowedContentFrameOrigin } from '../apps/worker/src/adapters/content-root.js';
import { buildCapabilities } from '../apps/server/src/capabilities.js';

describe('which frames count as the course', () => {
  const allowed = (frame: string, main: string) => isAllowedContentFrameOrigin(frame, main);

  it('the same origin, and content on the same organisation\'s other hosts', () => {
    expect(allowed('https://lms.company.com/a', 'https://lms.company.com/b')).toBe(true);
    expect(allowed('https://content.company.com/x', 'https://lms.company.com/')).toBe(true);
    expect(allowed('https://content.company.co.uk/x', 'https://lms.company.co.uk/')).toBe(true);
  });

  it('never an unrelated site that only shares a public suffix', () => {
    expect(allowed('https://evil.co.uk/x', 'https://lms.company.co.uk/')).toBe(false);
    expect(allowed('https://attacker.com.au/x', 'https://lms.school.com.au/')).toBe(false);
    expect(allowed('https://other.github.io/x', 'https://mine.github.io/')).toBe(false);
    // A two-label suffix whose second level is not a generic word (nhs.uk) is still a suffix.
    expect(allowed('https://evil.nhs.uk/x', 'https://trust.nhs.uk/')).toBe(false);
  });

  it('Articulate hosts only when the name really ends at a label boundary', () => {
    expect(allowed('https://abc.cloudfront.net/x', 'https://360.articulate.com/review')).toBe(true);
    expect(allowed('https://x.articulateusercontent.com/c', 'https://360.articulate.com/review')).toBe(true);
    expect(allowed('https://evilcloudfront.net/x', 'https://360.articulate.com/review')).toBe(false);
    expect(allowed('https://x.notarticulate.com/c', 'https://360.articulate.com/review')).toBe(false);
    expect(allowed('https://abc.cloudfront.net/x', 'https://fakearticulate.com/')).toBe(false);
  });

  it('IP addresses match only themselves, on any port', () => {
    expect(allowed('http://10.0.0.5/x', 'http://192.168.0.5/')).toBe(false);
    expect(allowed('http://192.168.0.5:8080/x', 'http://192.168.0.5/')).toBe(true);
  });

  it('country domains with a generic second level, and more shared hosting names, are never one organisation', () => {
    expect(allowed('https://evil.com.vn/x', 'https://lms.school.com.vn/')).toBe(false);
    expect(allowed('https://content.school.com.vn/x', 'https://lms.school.com.vn/')).toBe(true);
    expect(allowed('https://attacker.s3.eu-west-1.amazonaws.com/x', 'https://bucket.s3.us-east-1.amazonaws.com/')).toBe(false);
    expect(allowed('https://other.workers.dev/x', 'https://mine.workers.dev/')).toBe(false);
  });
});

describe('the browser check', () => {
  it('reports the browser as blocked when it is installed but cannot start the way scans start it', () => {
    const caps = buildCapabilities({ browserExecutable: () => process.execPath, browserStart: { ok: false, detail: 'chrome-headless-shell.exe is missing' } });
    const browser = caps.find((c) => c.id === 'browser')!;
    expect(browser.status).toBe('blocked');
    expect(browser.detail).toContain('chrome-headless-shell.exe is missing');
  });

  it('is available only when that start succeeded', () => {
    expect(buildCapabilities({ browserExecutable: () => process.execPath, browserStart: { ok: true } }).find((c) => c.id === 'browser')!.status).toBe('available');
  });
});
