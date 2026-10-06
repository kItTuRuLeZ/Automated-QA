import { describe, expect, it } from 'vitest';
import { NetworkPolicy, defaultScopeFor, isPublicAddress, sanitizeText, sanitizeUrl } from '@cqa/core';

const publicResolver = async () => ['93.184.215.14'];
const scopeFor = (u: string) => defaultScopeFor(new URL(u));

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe', // NAT64-embedded 169.254.169.254
    '2001:db8::1',
    'ff02::1',
  ])('denies reserved address %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(['93.184.215.14', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows public address %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
});

describe('NetworkPolicy.validateTarget', () => {
  const policy = new NetworkPolicy({ resolver: publicResolver });

  it.each([
    ['file:///etc/passwd', /Scheme/],
    ['ftp://example.com/', /Scheme/],
    ['javascript:alert(1)', /Scheme/],
    ['http://user:pw@example.com/', /credentials/],
    ['not a url', /valid absolute URL/],
  ])('rejects %s syntactically', async (url, detail) => {
    const d = await policy.validateTarget(url, scopeFor('http://example.com'));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.detail).toMatch(detail);
  });

  it.each(['http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data/'])(
    'rejects literal or alternately encoded reserved IP %s',
    async (url) => {
      const d = await policy.validateTarget(url, scopeFor(url));
      expect(d).toMatchObject({ ok: false, reason: 'blocked_by_policy' });
    },
  );

  it('rejects hostnames that resolve to any private address (multi-record answer)', async () => {
    const p = new NetworkPolicy({ resolver: async () => ['93.184.215.14', '10.0.0.5'] });
    const d = await p.validateTarget('https://course.example.com/', scopeFor('https://course.example.com/'));
    expect(d).toMatchObject({ ok: false, reason: 'blocked_by_policy' });
  });

  it('rejects localhost names by resolution, not by string matching', async () => {
    const p = new NetworkPolicy({ resolver: async () => ['127.0.0.1'] });
    const d = await p.validateTarget('http://localhost/', scopeFor('http://localhost/'));
    expect(d.ok).toBe(false);
  });

  it('returns validated addresses for public hosts so callers can pin connections', async () => {
    const d = await policy.validateTarget('https://course.example.com/lesson', scopeFor('https://course.example.com/'));
    expect(d).toMatchObject({ ok: true, addresses: ['93.184.215.14'] });
  });

  it('detects DNS rebinding: a later resolution to a private address is denied', async () => {
    const answers = [['93.184.215.14'], ['127.0.0.1']];
    const p = new NetworkPolicy({ resolver: async () => answers.shift() ?? [] });
    expect((await p.resolveAllowed('rebind.example.com', 80)).ok).toBe(true);
    expect((await p.resolveAllowed('rebind.example.com', 80)).ok).toBe(false);
  });

  it('enforces origin, port, and path scope', async () => {
    const scope = { ...scopeFor('https://course.example.com/'), allowedPathPrefixes: ['/course-a/'] };
    expect(await policy.validateTarget('https://other.example.com/course-a/', scope)).toMatchObject({ ok: false, reason: 'out_of_scope' });
    expect(await policy.validateTarget('https://course.example.com/course-b/', scope)).toMatchObject({ ok: false, reason: 'out_of_scope' });
    expect(await policy.validateTarget('https://course.example.com/course-a/index.html', scope)).toMatchObject({ ok: true });
  });

  it('exempts only the exact ip:port configured in code, and the default policy exempts nothing', async () => {
    const exempt = new NetworkPolicy({ exemptAddresses: [{ ip: '127.0.0.1', port: 5555 }] });
    expect(exempt.isAddressAllowed('127.0.0.1', 5555)).toBe(true);
    expect(exempt.isAddressAllowed('::ffff:127.0.0.1', 5555)).toBe(false);
    expect(exempt.isAddressAllowed('127.0.0.1', 5556)).toBe(false);
    expect(new NetworkPolicy().isAddressAllowed('127.0.0.1', 5555)).toBe(false);
  });

  it('allows RFC 1918 private addresses when allowPrivateAddresses is enabled', async () => {
    const defaultPolicy = new NetworkPolicy();
    expect(defaultPolicy.isAddressAllowed('192.168.57.169', 443)).toBe(false);
    expect(defaultPolicy.isAddressAllowed('10.0.1.5', 80)).toBe(false);
    expect(defaultPolicy.isAddressAllowed('172.16.0.10', 443)).toBe(false);

    const intranetPolicy = new NetworkPolicy({ allowPrivateAddresses: true });
    expect(intranetPolicy.isAddressAllowed('192.168.57.169', 443)).toBe(true);
    expect(intranetPolicy.isAddressAllowed('10.0.1.5', 80)).toBe(true);
    expect(intranetPolicy.isAddressAllowed('172.16.0.10', 443)).toBe(true);

    // Reserved addresses like cloud metadata, loopback and broadcast remain blocked
    expect(intranetPolicy.isAddressAllowed('169.254.169.254', 80)).toBe(false);
    expect(intranetPolicy.isAddressAllowed('127.0.0.1', 80)).toBe(false);
    expect(intranetPolicy.isAddressAllowed('0.0.0.0', 80)).toBe(false);
  });
});

describe('redaction', () => {
  it('removes query strings, credentials, and fragments by default', () => {
    expect(sanitizeUrl('https://u:p@cdn.example.com/a.png?token=SECRET&v=2#x')).toBe('https://cdn.example.com/a.png?[query-removed]');
  });

  it('redacts sensitive values even for preserved parameters', () => {
    const url = sanitizeUrl('https://x.example/a?v=2&sig=SECRET', {
      stripQueryStrings: true,
      preservedQueryParams: ['v', 'sig'],
      sensitiveParamPatterns: ['sig'],
      stripFragments: true,
    });
    expect(url).toBe('https://x.example/a?v=2&sig=REDACTED');
  });

  it('sanitizes URLs embedded in free text such as stack traces', () => {
    const text = sanitizeText('Error at https://cdn.example.com/app.js?session=SECRET:10:5');
    expect(text).not.toContain('SECRET');
  });
});
