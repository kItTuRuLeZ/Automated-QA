import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'cqa_session';

export interface AuthOptions {
  user: string;
  password: string;
  /** Injectable clock for tests. */
  now?: () => number;
  /** A session ends after this long without a request. */
  idleMs?: number;
  /** A session ends this long after sign-in whatever it does. */
  maxMs?: number;
  /** Failed sign-ins from one address before it is locked out. */
  maxFailures?: number;
  lockoutMs?: number;
}

export type LoginResult = { ok: true; token: string; maxAgeSec: number } | { ok: false; status: 401 | 429; retryAfterSec?: number };

/**
 * One shared account for the LAN demo. Sessions are random tokens kept in memory only (a restart signs everyone out),
 * and only a hash of each token is stored. Failed sign-ins are counted per remote address and lock that address out
 * for a while. Credentials are compared in constant time and never written to logs.
 */
export class AuthGate {
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly maxMs: number;
  private readonly maxFailures: number;
  private readonly lockoutMs: number;
  private readonly key = randomBytes(32);
  private readonly userMac: Buffer;
  private readonly passwordMac: Buffer;
  private readonly sessions = new Map<string, { created: number; seen: number }>();
  private readonly failures = new Map<string, { count: number; first: number; lockedUntil: number }>();

  constructor(private readonly opts: AuthOptions) {
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? 60 * 60 * 1000;
    this.maxMs = opts.maxMs ?? 8 * 60 * 60 * 1000;
    this.maxFailures = opts.maxFailures ?? 5;
    this.lockoutMs = opts.lockoutMs ?? 5 * 60 * 1000;
    this.userMac = this.mac(opts.user);
    this.passwordMac = this.mac(opts.password);
  }

  get user(): string {
    return this.opts.user;
  }

  private mac(value: string): Buffer {
    return createHmac('sha256', this.key).update(value).digest();
  }
  private static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  login(user: string, password: string, remote: string): LoginResult {
    const t = this.now();
    this.prune(t);
    const f = this.failures.get(remote);
    if (f && f.lockedUntil > t) return { ok: false, status: 429, retryAfterSec: Math.ceil((f.lockedUntil - t) / 1000) };

    // Both comparisons always run, so timing does not reveal which one was wrong.
    const userOk = timingSafeEqual(this.mac(user), this.userMac);
    const passOk = timingSafeEqual(this.mac(password), this.passwordMac);
    if (!(userOk && passOk)) {
      const cur = f && t - f.first < this.lockoutMs ? f : { count: 0, first: t, lockedUntil: 0 };
      cur.count += 1;
      if (cur.count >= this.maxFailures) cur.lockedUntil = t + this.lockoutMs;
      this.failures.set(remote, cur);
      return cur.lockedUntil > t ? { ok: false, status: 429, retryAfterSec: Math.ceil(this.lockoutMs / 1000) } : { ok: false, status: 401 };
    }
    this.failures.delete(remote);
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(AuthGate.hashToken(token), { created: t, seen: t });
    return { ok: true, token, maxAgeSec: Math.floor(this.maxMs / 1000) };
  }

  /** True for a live session; also refreshes its idle timer. */
  validate(token: string | undefined): boolean {
    if (!token) return false;
    const key = AuthGate.hashToken(token);
    const s = this.sessions.get(key);
    if (!s) return false;
    const t = this.now();
    if (t - s.seen > this.idleMs || t - s.created > this.maxMs) {
      this.sessions.delete(key);
      return false;
    }
    s.seen = t;
    return true;
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(AuthGate.hashToken(token));
  }

  private prune(t: number): void {
    for (const [k, v] of this.failures) if (v.lockedUntil <= t && t - v.first >= this.lockoutMs) this.failures.delete(k);
    for (const [k, s] of this.sessions) if (t - s.seen > this.idleMs || t - s.created > this.maxMs) this.sessions.delete(k);
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function sessionCookie(token: string, maxAgeSec: number): string {
  // No Secure flag: LAN demo mode is plain HTTP, and a Secure cookie would never be sent back. See docs/LAN_DEMO.md.
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
}
export const clearedSessionCookie = `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Plain server-rendered sign-in page: no scripts, no outside resources. */
export function loginPage(opts: { message?: string; user?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Course QA</title>
<style>
  body { font-family: 'Segoe UI', system-ui, sans-serif; background: #f5f7fa; color: #1a2230; margin: 0; }
  header { background: #12233f; color: #fff; padding: 0.8rem 1.5rem; font-weight: 600; }
  main { max-width: 26rem; margin: 2.5rem auto; padding: 0 1rem; }
  form { background: #fff; border: 1px solid #d5dbe5; border-radius: 8px; padding: 1.5rem; }
  label { display: block; font-weight: 600; margin: 0.9rem 0 0.3rem; }
  input { width: 100%; box-sizing: border-box; font: inherit; padding: 0.55rem 0.6rem; border: 1px solid #8a94a6; border-radius: 6px; }
  button { margin-top: 1.2rem; font: inherit; font-weight: 600; padding: 0.55rem 1.2rem; border-radius: 6px; border: 1px solid #1f4fbf; background: #1f4fbf; color: #fff; cursor: pointer; }
  :focus-visible { outline: 3px solid #f5a524; outline-offset: 2px; }
  .error { background: #fdecea; border: 1px solid #f2b8b5; color: #7a1a12; padding: 0.6rem 0.8rem; border-radius: 6px; margin: 0 0 0.5rem; }
  .note { color: #566176; font-size: 0.9rem; }
</style>
</head>
<body>
<header>Course QA</header>
<main>
  <h1>Sign in</h1>
  <p class="note">This is a demo copy of the app shared on a local network. Ask the person running it for the sign-in details.</p>
  <form method="post" action="/login">
    ${opts.message ? `<p class="error" role="alert">${esc(opts.message)}</p>` : ''}
    <label for="user">User name</label>
    <input id="user" name="user" autocomplete="username" required value="${esc(opts.user ?? '')}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
  </form>
</main>
</body>
</html>`;
}
