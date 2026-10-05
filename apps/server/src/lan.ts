import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Optional LAN demo mode. Off unless CQA_LAN_HOST is set. When on, only the
 * app (API and UI) listens on that one private IPv4 address of this computer,
 * and every request needs a signed-in session first. The package server, the
 * worker, and the scan network policy are not affected and stay local.
 */
export interface LanMode {
  host: string;
  port: number;
  password: string;
}

export const MIN_PASSWORD_LENGTH = 12;

const PRIVATE_V4 = [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./];

/**
 * Reads LAN mode from the environment. Returns undefined when it is off.
 * Throws with a plain explanation when it is asked for but cannot be used
 * safely, so the server never falls back to a wider bind than asked.
 */
export function resolveLanMode(env: NodeJS.ProcessEnv, interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, port: number): LanMode | undefined {
  const host = env.CQA_LAN_HOST?.trim();
  if (!host) return undefined;
  if (net.isIP(host) !== 4) throw new Error(`CQA_LAN_HOST must be one IPv4 address of this computer, for example 192.168.1.50. Got "${host}".`);
  if (!PRIVATE_V4.some((r) => r.test(host))) throw new Error(`CQA_LAN_HOST ${host} is not a private LAN address (10.x, 172.16-31.x, or 192.168.x). LAN demo mode will not listen on public, loopback, or link-local addresses.`);
  const own = Object.values(interfaces).flatMap((list) => list ?? []).some((i) => i.family === 'IPv4' && !i.internal && i.address === host);
  if (!own) throw new Error(`CQA_LAN_HOST ${host} is not an address of this computer. Run "ipconfig" and use the IPv4 address of the network adapter the demo will use.`);
  const password = env.CQA_LAN_PASSWORD ?? '';
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`LAN demo mode needs CQA_LAN_PASSWORD of at least ${MIN_PASSWORD_LENGTH} characters. Nothing is exposed until it is set.`);
  return { host, port, password };
}

export interface LanAuthOptions {
  password: string;
  /** How long a sign-in lasts. Default 12 hours. */
  sessionTtlMs?: number;
  /** Failed sign-ins allowed per client address in one window before it is locked out. Default 10. */
  maxFailures?: number;
  /** Length of that window. Default 15 minutes. */
  failureWindowMs?: number;
  now?: () => number;
}

const COOKIE = 'cqa_session';
const MAX_SESSIONS = 200;
const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Only same-site paths are accepted as a place to return to after signing in. */
function safeNext(next: unknown): string {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') && !next.startsWith('/login') ? next : '/';
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Course QA Automation</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f5f7;color:#1d2330;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fff;padding:2rem;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.12);width:min(22rem,calc(100vw - 2rem))}h1{font-size:1.25rem;margin:0 0 1rem}label{display:block;margin-bottom:.35rem;font-weight:600}input{width:100%;box-sizing:border-box;padding:.55rem;font-size:1rem;border:1px solid #8a93a6;border-radius:4px}button{margin-top:1rem;width:100%;padding:.6rem;font-size:1rem;border:0;border-radius:4px;background:#1f5fbf;color:#fff;cursor:pointer}button:focus-visible,input:focus-visible{outline:3px solid #f0b400;outline-offset:2px}.err{color:#a3141c;margin:0 0 1rem}.note{color:#4a5263;font-size:.85rem;margin:1rem 0 0}</style></head>
<body><main>${body}</main></body></html>`;
}

function loginPage(next: string, error?: string): string {
  return page(
    'Sign in',
    `<h1>Sign in to Course QA Automation</h1>${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/login"><input type="hidden" name="next" value="${escapeHtml(next)}"><label for="password">Demo password</label><input id="password" name="password" type="password" autocomplete="current-password" required autofocus><button type="submit">Sign in</button></form>
<p class="note">LAN demo mode. The connection is plain HTTP, so use it only on a network you trust.</p>`,
  );
}

/**
 * Shared-password sign-in for LAN demo mode. Sessions live in memory only,
 * so restarting the server signs everyone out. The cookie is HttpOnly and
 * SameSite=Strict; the existing Host, Origin, Sec-Fetch-Site and CSRF-header
 * checks still run first on every request.
 */
export function registerLanAuth(app: FastifyInstance, opts: LanAuthOptions): void {
  const now = opts.now ?? Date.now;
  const ttl = opts.sessionTtlMs ?? 12 * 60 * 60 * 1000;
  const maxFailures = opts.maxFailures ?? 10;
  const windowMs = opts.failureWindowMs ?? 15 * 60 * 1000;
  const expected = digest(opts.password);
  /** Keyed by a hash of the token, so the raw token exists only in the browser's cookie. */
  const sessions = new Map<string, number>();
  const failures = new Map<string, { count: number; resetAt: number }>();

  const sessionKey = (req: FastifyRequest) => {
    const token = readCookie(req.headers.cookie, COOKIE);
    return token ? digest(token).toString('hex') : undefined;
  };
  const signedIn = (req: FastifyRequest) => {
    const key = sessionKey(req);
    const expires = key ? sessions.get(key) : undefined;
    if (!key || expires === undefined) return false;
    if (expires <= now()) return (sessions.delete(key), false);
    return true;
  };
  const html = (reply: FastifyReply, status: number, body: string) => reply.code(status).header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store').send(body);

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))));

  app.addHook('onRequest', async (req, reply) => {
    const pathOnly = req.url.split('?')[0] ?? '/';
    if (pathOnly === '/login' || pathOnly === '/logout') return;
    if (signedIn(req)) return;
    if (pathOnly.startsWith('/api/')) return reply.code(401).header('Cache-Control', 'no-store').send({ error: 'Not signed in, or your sign-in has expired. Reload the page to sign in again.' });
    if (req.method === 'GET' || req.method === 'HEAD') return reply.code(303).header('Location', `/login?next=${encodeURIComponent(safeNext(req.url))}`).send();
    return reply.code(401).send({ error: 'Not signed in.' });
  });

  app.get<{ Querystring: { next?: string } }>('/login', async (req, reply) => {
    if (signedIn(req)) return reply.code(303).header('Location', safeNext(req.query.next)).send();
    return html(reply, 200, loginPage(safeNext(req.query.next)));
  });

  app.post('/login', async (req, reply) => {
    const body = (req.body ?? {}) as { password?: unknown; next?: unknown };
    const next = safeNext(body.next);
    const t = now();
    const f = failures.get(req.ip);
    if (f && f.resetAt <= t) failures.delete(req.ip);
    const current = failures.get(req.ip);
    if (current && current.count >= maxFailures) return html(reply, 429, loginPage(next, 'Too many wrong passwords from this computer. Wait 15 minutes and try again.'));
    const given = typeof body.password === 'string' ? body.password : '';
    if (!timingSafeEqual(digest(given), expected)) {
      failures.set(req.ip, { count: (current?.count ?? 0) + 1, resetAt: current?.resetAt ?? t + windowMs });
      return html(reply, 401, loginPage(next, 'That password is not right.'));
    }
    failures.delete(req.ip);
    for (const [k, exp] of sessions) if (exp <= t) sessions.delete(k);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    const token = randomBytes(32).toString('base64url');
    sessions.set(digest(token).toString('hex'), t + ttl);
    reply.header('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttl / 1000)}`);
    return reply.code(303).header('Location', next).send();
  });

  app.get('/logout', async (_req, reply) =>
    html(reply, 200, page('Sign out', '<h1>Sign out of Course QA Automation</h1><form method="post" action="/logout"><button type="submit">Sign out</button></form>')),
  );

  app.post('/logout', async (req, reply) => {
    const key = sessionKey(req);
    if (key) sessions.delete(key);
    reply.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return reply.code(303).header('Location', '/login').send();
  });
}
