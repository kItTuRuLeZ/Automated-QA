import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures');
const TYPES: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

export interface FixtureServer {
  /** Chooses which visual variant /baseline/ serves (v1 blue, v2 red). */
  setBaselineVariant(v: 'v1' | 'v2'): void;
  origin: string;
  port: number;
  /** Second origin (different port) used as an out-of-scope redirect destination. */
  otherOrigin: string;
  otherPort: number;
  close(): Promise<void>;
}

function listen(handler: http.RequestListener, port = 0): Promise<http.Server> {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/** Test-only static server for fixtures. Never used in production code paths. */
export async function startFixtureServer(ports: { port?: number; otherPort?: number } = {}): Promise<FixtureServer> {
  const pending = new Set<http.ServerResponse>();
  let baselineVariant: 'v1' | 'v2' = 'v1';
  let otherOrigin = '';
  const other = await listen((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Other origin</title><p>Outside scope</p>');
  }, ports.otherPort);
  const otherPort = (other.address() as AddressInfo).port;
  otherOrigin = `http://127.0.0.1:${otherPort}`;

  const main = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    if (url.pathname === '/redirect/in') return void res.writeHead(302, { Location: '/healthy/' }).end();
    if (url.pathname === '/redirect/out') return void res.writeHead(302, { Location: `${otherOrigin}/landing` }).end();
    // ---- link-check targets ----
    if (url.pathname === '/links/') {
      const page = `<!doctype html><html lang="en"><title>Links Fixture</title><h1>Links</h1><ul>
        <li><a href="/links/ok">Working page</a></li>
        <li><a href="/links/ok#section">Working page (fragment)</a></li>
        <li><a href="/links/missing">Missing page</a></li>
        <li><a href="/links/gone">Removed page</a></li>
        <li><a href="/links/auth">Members area</a></li>
        <li><a href="/links/forbidden">Staff only</a></li>
        <li><a href="/links/slow">Slow server</a></li>
        <li><a href="/links/head-405">No HEAD support</a></li>
        <li><a href="/links/redirect">Moved page</a></li>
        <li><a href="/links/redirect-404">Moved then missing</a></li>
        <li><a href="/links/redirect-private">Redirects to a private address</a></li>
        <li><a href="${otherOrigin}/landing" target="_blank">External resource</a></li>
        <li><a href="http://169.254.169.254/latest/">Metadata address</a></li>
        <li><a href="mailto:help@example.com">Email us</a></li>
        <li><a href="javascript:void(0)">Script link</a></li>
        <li><a href="">Empty link</a></li>
      </ul></html>`;
      return void res.writeHead(200, { 'Content-Type': 'text/html' }).end(page);
    }
    if (url.pathname.startsWith('/links/')) {
      const name = url.pathname.slice('/links/'.length);
      const html = { 'Content-Type': 'text/html' };
      switch (name) {
        case 'ok':
          return void res.writeHead(200, html).end('<title>OK</title>');
        case 'missing':
          return void res.writeHead(404, html).end('not found');
        case 'gone':
          return void res.writeHead(410, html).end('gone');
        case 'auth':
          return void res.writeHead(401, { ...html, 'WWW-Authenticate': 'Basic realm="x"' }).end();
        case 'forbidden':
          return void res.writeHead(403, html).end();
        case 'head-405':
          return void res.writeHead(req.method === 'HEAD' ? 405 : 200, html).end(req.method === 'HEAD' ? undefined : '<title>GET only</title>');
        case 'redirect':
          return void res.writeHead(301, { Location: '/links/ok' }).end();
        case 'redirect-404':
          return void res.writeHead(302, { Location: '/links/missing' }).end();
        case 'redirect-private':
          return void res.writeHead(302, { Location: 'http://10.0.0.1/admin' }).end();
        case 'slow': {
          pending.add(res);
          const t = setTimeout(() => res.writeHead(200, html).end('late'), 20_000);
          res.on('close', () => {
            clearTimeout(t);
            pending.delete(res);
          });
          return;
        }
      }
    }
    // ---- media ----
    if (url.pathname === '/media/tone.wav') {
      // 0.25 s of 8 kHz mono 8-bit silence: a real, playable WAV file.
      const samples = 2000;
      const buf = Buffer.alloc(44 + samples, 0x80);
      buf.write('RIFF', 0);
      buf.writeUInt32LE(36 + samples, 4);
      buf.write('WAVEfmt ', 8);
      buf.writeUInt32LE(16, 16);
      buf.writeUInt16LE(1, 20);
      buf.writeUInt16LE(1, 22);
      buf.writeUInt32LE(8000, 24);
      buf.writeUInt32LE(8000, 28);
      buf.writeUInt16LE(1, 32);
      buf.writeUInt16LE(8, 34);
      buf.write('data', 36);
      buf.writeUInt32LE(samples, 40);
      return void res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': buf.length }).end(buf);
    }
    if (url.pathname === '/media/captions.vtt') {
      return void res.writeHead(200, { 'Content-Type': 'text/vtt' }).end('WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n');
    }
    if (url.pathname === '/media/large.png') {
      // Valid 1x1 PNG followed by padding so the transfer exceeds 1 MB.
      const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
      const body = Buffer.concat([png, Buffer.alloc(1_200_000)]);
      return void res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length }).end(body);
    }
    if (url.pathname === '/baseline/') {
      const color = baselineVariant === 'v1' ? '#1f4fbf' : '#b42318';
      return void res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Baseline Fixture</title></head><body style="margin:0"><main><h1 style="margin:16px">Controlled page</h1>` +
            `<div style="width:400px;height:200px;margin:16px;background:${color}"></div></main></body></html>`,
        );
    }
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
  }, ports.port);
  const port = (main.address() as AddressInfo).port;

  return {
    setBaselineVariant(v) {
      baselineVariant = v;
    },
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
