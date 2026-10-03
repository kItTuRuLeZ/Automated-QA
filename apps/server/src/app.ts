import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { ProjectId } from '@cqa/shared';
import { ACCESSIBILITY_DISCLAIMER, MANUAL_REVIEW_CHECKLIST, type ArtifactStore, CreateProjectInput, CreateScanInput, type NetworkPolicy, type Store, buildScanConfig, defaultScopeFor, isOpaqueId, allRules } from '@cqa/core';

export interface AppOptions {
  store: Store;
  artifacts: ArtifactStore;
  policy: NetworkPolicy;
  /** Origins allowed to call the API (the server itself and the Vite dev server). */
  allowedOrigins: string[];
  /** Host header values accepted (e.g. 127.0.0.1:4317, localhost:4317). */
  allowedHosts: string[];
  /** Built web UI directory to serve, if present. */
  webDist?: string;
  logger?: boolean;
}

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 64 * 1024 });
  const { store, artifacts, policy } = opts;

  // ---- request guard: Host/Origin checks and CSRF defence for state changes ----
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host ?? '';
    if (!opts.allowedHosts.includes(host)) return reply.code(421).send({ error: 'Unexpected Host header.' });
    const origin = req.headers.origin;
    if (origin && !opts.allowedOrigins.includes(origin)) return reply.code(403).send({ error: 'Cross-origin requests are not allowed.' });
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite === 'cross-site') return reply.code(403).send({ error: 'Cross-site requests are not allowed.' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.url.startsWith('/api/')) {
      if (req.headers['x-qa-request'] !== '1') return reply.code(403).send({ error: 'Missing X-QA-Request header.' });
      const ct = req.headers['content-type'] ?? '';
      if (req.method !== 'DELETE' && !ct.startsWith('application/json')) return reply.code(415).send({ error: 'Content-Type must be application/json.' });
    }
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
    return payload;
  });

  const notFound = (reply: FastifyReply, what = 'Not found') => reply.code(404).send({ error: what });
  const badRequest = (reply: FastifyReply, error: string, issues?: unknown) => reply.code(400).send({ error, issues });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/rules', async () => allRules());
  app.get('/api/manual-checklist', async () => ({ disclaimer: ACCESSIBILITY_DISCLAIMER, items: MANUAL_REVIEW_CHECKLIST }));

  // ---- projects ----
  app.get('/api/projects', async () => store.listProjects());

  app.post('/api/projects', async (req, reply) => {
    const parsed = CreateProjectInput.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, 'Invalid project.', parsed.error.issues);
    if (parsed.data.courseUrl) {
      const t = policy.parseTarget(parsed.data.courseUrl);
      if (!t.ok) return badRequest(reply, t.detail);
    }
    return reply.code(201).send(store.createProject(parsed.data));
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const p = isOpaqueId(req.params.id) ? store.getProject(req.params.id) : undefined;
    return p ?? notFound(reply, 'Project not found.');
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    if (!isOpaqueId(req.params.id)) return notFound(reply);
    const runs = store.listRuns(req.params.id);
    if (runs.some((r) => r.status === 'running' || r.status === 'queued')) return reply.code(409).send({ error: 'Cancel active scans before deleting the project.' });
    if (!store.deleteProject(req.params.id)) return notFound(reply);
    for (const r of runs) artifacts.deleteRunArtifacts(r.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/runs', async (req, reply) => {
    if (!isOpaqueId(req.params.id) || !store.getProject(req.params.id)) return notFound(reply, 'Project not found.');
    return store.listRuns(req.params.id).map((run) => ({ ...run, summary: store.summarizeRun(run.id) }));
  });

  // ---- scans ----
  app.post<{ Params: { id: string } }>('/api/projects/:id/scans', async (req, reply) => {
    const project = isOpaqueId(req.params.id) ? store.getProject(req.params.id) : undefined;
    if (!project) return notFound(reply, 'Project not found.');
    const parsed = CreateScanInput.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, 'Invalid scan configuration.', parsed.error.issues);
    const input = parsed.data;
    const target = policy.parseTarget(input.url);
    if (!target.ok) return reply.code(422).send({ error: target.detail, reason: target.reason, ruleId: 'NET-001' });
    const scope = { ...defaultScopeFor(target.url) };
    if (input.allowedOrigins?.length) scope.allowedOrigins = [...new Set([target.url.origin, ...input.allowedOrigins])];
    if (input.allowedPathPrefixes?.length) scope.allowedPathPrefixes = input.allowedPathPrefixes;
    const viewport = input.viewport ? { ...input.viewport, deviceScaleFactor: 1, isMobile: input.viewport.width < 768, hasTouch: input.viewport.width < 768 } : undefined;
    const config = buildScanConfig({
      projectId: project.id as ProjectId,
      url: target.url,
      scope,
      navigationTimeoutMs: input.navigationTimeoutMs,
      viewport,
      explore: input.explore,
      accessibility: input.accessibility,
      maxStates: input.maxStates,
      maxDepth: input.maxDepth,
    });
    // Pre-check scope and resolved destination; denied targets are never queued.
    const decision = await policy.validateTarget(target.url.toString(), config.scope);
    if (!decision.ok) return reply.code(422).send({ error: decision.detail, reason: decision.reason, ruleId: 'NET-001' });
    return reply.code(201).send(store.createRun(config, target.url.toString()));
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const run = isOpaqueId(req.params.id) ? store.getRun(req.params.id) : undefined;
    if (!run) return notFound(reply, 'Scan not found.');
    const screenshots = store
      .listEvidenceByKind(run.id, 'screenshot')
      .filter((e) => e.artifactId)
      .map((e) => ({ artifactId: e.artifactId, caption: e.caption, viewportName: e.viewportName, stateId: e.stateId }));
    return { ...run, summary: store.summarizeRun(run.id), states: store.listStates(run.id), screenshots };
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (req, reply) => {
    if (!isOpaqueId(req.params.id)) return notFound(reply);
    const status = store.requestCancel(req.params.id);
    if (!status) return notFound(reply, 'Scan not found.');
    return { status, cancelRequested: status === 'running' || status === 'cancelled' };
  });

  app.delete<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const run = isOpaqueId(req.params.id) ? store.getRun(req.params.id) : undefined;
    if (!run) return notFound(reply);
    if (run.status === 'running' || run.status === 'queued') return reply.code(409).send({ error: 'Cancel the scan before deleting it.' });
    store.deleteRun(run.id);
    artifacts.deleteRunArtifacts(run.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/findings', async (req, reply) => {
    if (!isOpaqueId(req.params.id) || !store.getRun(req.params.id)) return notFound(reply);
    return store.listFindings(req.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/actions', async (req, reply) => {
    if (!isOpaqueId(req.params.id) || !store.getRun(req.params.id)) return notFound(reply);
    return store.listActions(req.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/checks', async (req, reply) => {
    if (!isOpaqueId(req.params.id) || !store.getRun(req.params.id)) return notFound(reply);
    return store.listCheckResults(req.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/findings/:id', async (req, reply) => {
    const f = isOpaqueId(req.params.id) ? store.getFinding(req.params.id) : undefined;
    if (!f) return notFound(reply, 'Finding not found.');
    const ids = new Set([...f.evidenceIds, ...f.occurrences.flatMap((o) => o.evidenceIds)]);
    return { finding: f, evidence: store.getEvidence([...ids]) };
  });

  // ---- artifacts: opaque IDs only, resolved through the DB ----
  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (req, reply) => {
    if (!isOpaqueId(req.params.id)) return notFound(reply);
    const rec = store.getArtifact(req.params.id);
    // V1 is single-owner: an artifact is accessible if its run (and so its project) exists.
    if (!rec || !store.getRun(rec.runId)) return notFound(reply);
    const abs = artifacts.absolutePath(rec);
    if (!existsSync(abs)) return notFound(reply, 'Artifact file missing.');
    reply.header('Content-Type', rec.mime);
    reply.header('Cache-Control', 'private, max-age=31536000, immutable');
    reply.header('Content-Disposition', 'inline');
    return reply.send(createReadStream(abs));
  });

  app.all('/api/*', async (_req, reply) => notFound(reply));

  // ---- built web UI ----
  if (opts.webDist && existsSync(opts.webDist)) {
    const root = path.resolve(opts.webDist);
    app.get('/*', async (req: FastifyRequest, reply: FastifyReply) => {
      const urlPath = decodeURIComponent((req.url.split('?')[0] ?? '/').replace(/^\/+/, ''));
      let file = path.resolve(root, urlPath || 'index.html');
      if (!file.startsWith(root + path.sep) && file !== root) return notFound(reply);
      if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(root, 'index.html');
      reply.header('Content-Type', STATIC_TYPES[path.extname(file)] ?? 'application/octet-stream');
      return reply.send(createReadStream(file));
    });
  }

  return app;
}
