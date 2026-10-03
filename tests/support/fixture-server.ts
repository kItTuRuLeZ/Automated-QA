import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures');
const TYPES: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

export interface FixtureServer {
  origin: string;
  port: number;
  /** Second origin (different port) used as an out-of-scope redirect destination. */
  otherOrigin: string;
  otherPort: number;
  close(): Promise<void>;
}

function listen(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Test-only static server for fixtures. Never used in production code paths. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const pending = new Set<http.ServerResponse>();
  let otherOrigin = '';
  const other = await listen((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Other origin</title><p>Outside scope</p>');
  });
  const otherPort = (other.address() as AddressInfo).port;
  otherOrigin = `http://127.0.0.1:${otherPort}`;

  const main = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    if (url.pathname === '/redirect/in') return void res.writeHead(302, { Location: '/healthy/' }).end();
    if (url.pathname === '/redirect/out') return void res.writeHead(302, { Location: `${otherOrigin}/landing` }).end();
    if (url.pathname === '/iframe/') {
      return void res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end(
          `<!doctype html><html lang="en"><title>Iframe Fixture</title><h1>Embedded frames</h1>` +
            `<iframe id="external" title="External widget" src="${otherOrigin}/landing"></iframe>` +
            `<iframe id="blocked" title="Blocked widget" src="http://169.254.169.254/widget"></iframe>` +
            `<iframe id="local" title="Local frame" src="/healthy/"></iframe></html>`,
        );
    }
    if (url.pathname === '/http-404') return void res.writeHead(404, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Not found</title><h1>404</h1>');
    if (url.pathname === '/slow') {
      pending.add(res);
      const t = setTimeout(() => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Slow</title>'), 15_000);
      res.on('close', () => {
        clearTimeout(t);
        pending.delete(res);
      });
      return;
    }
    let file = path.resolve(FIXTURES, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(FIXTURES)) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file)) return void res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  const port = (main.address() as AddressInfo).port;

  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    otherOrigin,
    otherPort,
    async close() {
      for (const r of pending) r.destroy();
      main.closeAllConnections();
      other.closeAllConnections();
      await Promise.all([new Promise((r) => main.close(r)), new Promise((r) => other.close(r))]);
    },
  };
}
