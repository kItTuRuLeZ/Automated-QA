import { createReadStream, readdirSync, realpathSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/**
 * Serves extracted course packages from their own origin (a different port
 * from the app), so package code cannot read the app's pages, API, or storage.
 *
 * Rules: read-only (GET/HEAD), only /p/<package id>/<file>, no cookies are
 * ever set, paths must stay inside that package's content folder (also after
 * following links), and file names must match letter case exactly, so a
 * mismatch that would break on a case-sensitive LMS server breaks here too
 * instead of being hidden by a case-insensitive disk.
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};
const ID = /^[0-9a-f-]{36}$/;

export interface PackageServerOptions {
  /** Folder holding one folder per package (`<id>/content/...`). */
  root: string;
  port: number;
  host?: string;
}

/** Resolves a request path to a file, enforcing the rules above. Exported for tests. */
export function resolvePackageFile(root: string, urlPath: string): { ok: true; file: string } | { ok: false; status: number } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return { ok: false, status: 400 };
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return { ok: false, status: 400 };
  const m = /^\/p\/([0-9a-f-]{36})\/(.*)$/.exec(decoded);
  if (!m || !ID.test(m[1]!)) return { ok: false, status: 404 };
  const segments = m[2]!.split('/').filter((s, i, a) => !(s === '' && i === a.length - 1));
  if (segments.some((s) => s === '..' || s === '.' || s === '')) return { ok: false, status: 400 };
  const contentRoot = path.join(root, m[1]!, 'content');
  let current = contentRoot;
  try {
    for (const seg of segments) {
      // Exact letter case: the directory must list this name as written.
      if (!readdirSync(current).includes(seg)) return { ok: false, status: 404 };
      current = path.join(current, seg);
    }
    if (statSync(current).isDirectory()) {
      if (!readdirSync(current).includes('index.html')) return { ok: false, status: 404 };
      current = path.join(current, 'index.html');
    }
    const real = realpathSync(current);
    const realRoot = realpathSync(contentRoot);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { ok: false, status: 403 };
    if (!statSync(real).isFile()) return { ok: false, status: 404 };
    return { ok: true, file: real };
  } catch {
    return { ok: false, status: 404 };
  }
}

export function createPackageServer(opts: PackageServerOptions): http.Server {
  const host = opts.host ?? '127.0.0.1';
  const allowedHost = `${host}:${opts.port}`;
  return http.createServer((req, res) => {
    const common = {
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Frame-Options': 'SAMEORIGIN',
    };
    if (req.headers.host !== allowedHost) return void res.writeHead(421, common).end();
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405, { ...common, Allow: 'GET, HEAD' }).end();
    const url = new URL(req.url ?? '/', `http://${allowedHost}`);
    const found = resolvePackageFile(opts.root, url.pathname);
    if (!found.ok) return void res.writeHead(found.status, { ...common, 'Content-Type': 'text/plain' }).end(found.status === 404 ? 'not found' : 'refused');
    const size = statSync(found.file).size;
    const type = TYPES[path.extname(found.file).toLowerCase()] ?? 'application/octet-stream';
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) return void res.writeHead(416, { ...common, 'Content-Range': `bytes */${size}` }).end();
      res.writeHead(206, { ...common, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return void res.end();
      return void createReadStream(found.file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...common, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(found.file).pipe(res);
  });
}
