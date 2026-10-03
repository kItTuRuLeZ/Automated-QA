import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import type { ReasonCode, ScanScope } from '@cqa/shared';
import { type NetworkPolicy, sanitizeUrl } from '@cqa/core';

export interface BlockedConnection {
  url: string;
  host: string;
  port: number;
  reason: ReasonCode;
  detail: string;
}

export interface EgressProxyOptions {
  policy: NetworkPolicy;
  scope: ScanScope;
  maxTotalBytes: number;
  onBlocked: (b: BlockedConnection) => void;
}

/**
 * Per-run forward proxy bound to loopback. Every browser connection (HTTP
 * requests, HTTPS/WebSocket CONNECT tunnels) goes through `decide`, which
 * resolves DNS itself, rejects private/reserved destinations, and connects to
 * the validated IP so a DNS answer cannot change between check and use.
 */
export class EgressProxy {
  readonly username = 'cqa';
  readonly password = randomBytes(18).toString('base64url');
  private server?: http.Server;
  private readonly sockets = new Set<net.Socket>();
  private totalBytes = 0;
  private budgetExceeded = false;
  private readonly expectedAuth: string;

  constructor(private readonly opts: EgressProxyOptions) {
    this.expectedAuth = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`;
  }

  get bytesTransferred(): number {
    return this.totalBytes;
  }

  get byteBudgetExceeded(): boolean {
    return this.budgetExceeded;
  }

  async start(): Promise<number> {
    const server = http.createServer((req, res) => void this.handleRequest(req, res));
    server.on('connect', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void this.handleConnect(req, socket, head));
    // Plain WebSocket upgrades are not proxied this way by Chromium; refuse them.
    server.on('upgrade', (_req, socket: net.Socket) => socket.destroy());
    server.on('connection', (s: net.Socket) => this.track(s));
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return (server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private track(s: net.Socket): void {
    this.sockets.add(s);
    s.on('close', () => this.sockets.delete(s));
    s.on('error', () => s.destroy());
  }

  private count(n: number): void {
    this.totalBytes += n;
    if (!this.budgetExceeded && this.totalBytes > this.opts.maxTotalBytes) {
      this.budgetExceeded = true;
      this.opts.onBlocked({ url: '', host: '', port: 0, reason: 'budget_bytes', detail: `Total transfer exceeded ${this.opts.maxTotalBytes} bytes; further traffic was stopped.` });
      for (const s of this.sockets) s.destroy();
    }
  }

  private authorized(req: http.IncomingMessage): boolean {
    return req.headers['proxy-authorization'] === this.expectedAuth;
  }

  private async decide(host: string, port: number, displayUrl: string): Promise<{ ok: true; ip: string } | { ok: false }> {
    const block = (reason: ReasonCode, detail: string) => {
      this.opts.onBlocked({ url: sanitizeUrl(displayUrl), host, port, reason, detail });
      return { ok: false as const };
    };
    if (this.budgetExceeded) return block('budget_bytes', 'Transfer budget already exhausted.');
    if (this.opts.scope.subrequestPolicy === 'same_scope_only') {
      const inScope = this.opts.scope.allowedOrigins.some((o) => {
        const u = new URL(o);
        const p = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
        return u.hostname === host && p === port;
      });
      if (!inScope) return block('out_of_scope', 'Destination is outside the allowed origins (scope-only subrequest policy).');
    }
    const resolved = await this.opts.policy.resolveAllowed(host, port);
    if (!resolved.ok) return block(resolved.reason, resolved.detail);
    return { ok: true, ip: resolved.addresses[0]! };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.authorized(req)) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="cqa"' }).end();
      return;
    }
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(400).end();
      return;
    }
    const port = target.port ? Number(target.port) : 80;
    const decision = await this.decide(target.hostname, port, target.toString());
    if (!decision.ok) {
      res.writeHead(403, { 'Content-Type': 'text/plain', 'X-CQA-Blocked': '1' }).end('Blocked by scan network policy.');
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = http.request({ host: decision.ip, port, method: req.method, path: target.pathname + target.search, headers, setHost: false });
    upstream.on('response', (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.on('data', (chunk: Buffer) => this.count(chunk.length));
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    });
    req.on('data', (chunk: Buffer) => this.count(chunk.length));
    req.pipe(upstream);
  }

  private async handleConnect(req: http.IncomingMessage, client: net.Socket, head: Buffer): Promise<void> {
    this.track(client);
    if (!this.authorized(req)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="cqa"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const [hostPart, portPart] = splitHostPort(req.url ?? '');
    const port = Number(portPart);
    if (!hostPart || !Number.isInteger(port) || port <= 0 || port > 65535) {
      client.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const decision = await this.decide(hostPart, port, `https://${req.url}/`);
    if (!decision.ok) {
      client.end('HTTP/1.1 403 Forbidden\r\nX-CQA-Blocked: 1\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = net.connect(port, decision.ip);
    this.track(upstream);
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.on('data', (c: Buffer) => this.count(c.length));
      client.on('data', (c: Buffer) => this.count(c.length));
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  }
}

function splitHostPort(authority: string): [string, string] {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return [authority.slice(1, end), authority.slice(end + 2)];
  }
  const idx = authority.lastIndexOf(':');
  return [authority.slice(0, idx), authority.slice(idx + 1)];
}
