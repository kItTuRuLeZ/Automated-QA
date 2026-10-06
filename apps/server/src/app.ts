import { createReadStream, existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { ProfileId, ProjectId } from '@cqa/shared';
import { buildProjectReport, buildRunReport, recordBaselineFromRun, reportForCourse, runReportAsProject, ProfileInput, newId, profileScanOptions, toClientProfile, validateWorkflowChange, viewportsByName } from '@cqa/core';
import { readFileSync } from 'node:fs';
import { buildWorkbook } from './export/xlsx.js';
import { type CapabilityOptions, buildCapabilities } from './capabilities.js';
import { registerPackageRoutes } from './packages.js';
import { type AuthGate, SESSION_COOKIE, clearedSessionCookie, loginPage, readCookie, sessionCookie } from './auth.js';
import { buildHtmlReport } from './export/html.js';
import { renderPdf } from './export/pdf.js';
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
  /** What the About page reports; the server entry point fills these from its settings. */
  capabilities?: CapabilityOptions;
  /** Where uploaded packages live and the port of the separate origin that serves them. Package routes are off without it. */
  packages?: { dir: string; port: number };
  /** LAN demo mode only: sign-in required for everything except the sign-in page. Absent in the default local mode. */
  auth?: AuthGate;
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
    if (opts.auth) {
      const urlPath = req.url.split('?')[0] ?? '/';
      const signInPage = urlPath === '/login' && (req.method === 'GET' || req.method === 'POST' || req.method === 'HEAD');
      if (!signInPage && !opts.auth.validate(readCookie(req.headers.cookie, SESSION_COOKIE))) {
        // Nothing (UI files, APIs, uploads, screenshots, reports) is served before sign-in. Checked before any body is read.
        if (urlPath.startsWith('/api/')) return reply.code(401).send({ error: 'Sign in first.' });
        return reply.code(302).header('Location', '/login').send();
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.url.startsWith('/api/')) {
      if (req.headers['x-qa-request'] !== '1') return reply.code(403).send({ error: 'Missing X-QA-Request header.' });
      const ct = req.headers['content-type'] ?? '';
      const isUpload = req.method === 'POST' && /^\/api\/projects\/[^/]+\/packages(\?|$)/.test(req.url) && ct.startsWith('application/zip');
      if (req.method !== 'DELETE' && !isUpload && !ct.startsWith('application/json')) return reply.code(415).send({ error: 'Content-Type must be application/json.' });
    }
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    // Shared demo machines: never let a browser or proxy keep reports, screenshots or API data.
    if (opts.auth) reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
    return payload;
  });

  const notFound = (reply: FastifyReply, what = 'Not found') => reply.code(404).send({ error: what });
  const badRequest = (reply: FastifyReply, error: string, issues?: unknown) => reply.code(400).send({ error, issues });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/session', async () => (opts.auth ? { lan: true, user: opts.auth.user } : { lan: false }));

  if (opts.auth) {
    const auth = opts.auth;
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))));
    const page = (reply: FastifyReply, code: number, html: string) => reply.code(code).header('Content-Type', 'text/html; charset=utf-8').send(html);
    app.get('/login', async (_req, reply) => page(reply, 200, loginPage({})));
    app.post<{ Body: { user?: string; password?: string } }>('/login', async (req, reply) => {
      const user = typeof req.body?.user === 'string' ? req.body.user.slice(0, 64) : '';
      const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 256) : '';
      const result = auth.login(user, password, req.ip);
      if (result.ok) return reply.code(303).header('Set-Cookie', sessionCookie(result.token, result.maxAgeSec)).header('Location', '/').send();
      req.log.warn({ remote: req.ip, status: result.status }, 'LAN sign-in failed');
      if (result.status === 429) {
        reply.header('Retry-After', String(result.retryAfterSec ?? 300));
        return page(reply, 429, loginPage({ user, message: `Too many failed sign-ins from this device. Try again in ${Math.ceil((result.retryAfterSec ?? 300) / 60)} minutes.` }));
      }
      return page(reply, 401, loginPage({ user, message: 'Sign-in failed. Check the user name and password.' }));
    });
    app.post('/api/auth/logout', async (req, reply) => {
      auth.logout(readCookie(req.headers.cookie, SESSION_COOKIE));
      return reply.header('Set-Cookie', clearedSessionCookie).send({ ok: true });
    });
  }
  app.get('/api/rules', async () => allRules());
  app.get('/api/capabilities', async () => buildCapabilities(opts.capabilities));
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
    const packageIds = store.listPackageIds(req.params.id);
    if (!store.deleteProject(req.params.id)) return notFound(reply);
    for (const r of runs) artifacts.deleteRunArtifacts(r.id);
    if (opts.packages) for (const id of packageIds) rmSync(path.join(opts.packages.dir, id), { recursive: true, force: true });
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/runs', async (req, reply) => {
    if (!isOpaqueId(req.params.id) || !store.getProject(req.params.id)) return notFound(reply, 'Project not found.');
    return store.listRuns(req.params.id).map((run) => ({ ...run, summary: store.summarizeRun(run.id) }));
  });

  // ---- client profiles: settings a person supplies per client; nothing here is a built-in brand rule ----
  app.get('/api/profiles', async () => store.listProfiles());
  app.get<{ Params: { id: string } }>('/api/profiles/:id', async (req, reply) => {
    const p = isOpaqueId(req.params.id) ? store.getProfile(req.params.id) : undefined;
    return p ?? notFound(reply, 'Client profile not found.');
  });
  app.post('/api/profiles', async (req, reply) => {
    const parsed = ProfileInput.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, 'Invalid client profile.', parsed.error.issues);
    const profile = toClientProfile(newId<ProfileId>(), parsed.data);
    store.saveProfile(profile);
    return reply.code(201).send(profile);
  });
  app.put<{ Params: { id: string } }>('/api/profiles/:id', async (req, reply) => {
    const prev = isOpaqueId(req.params.id) ? store.getProfile(req.params.id) : undefined;
    if (!prev) return notFound(reply, 'Client profile not found.');
    const parsed = ProfileInput.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, 'Invalid client profile.', parsed.error.issues);
    const profile = toClientProfile(prev.id, parsed.data, prev);
    store.saveProfile(profile);
    return profile;
  });
  app.delete<{ Params: { id: string } }>('/api/profiles/:id', async (req, reply) => {
    if (!isOpaqueId(req.params.id) || !store.deleteProfile(req.params.id)) return notFound(reply, 'Client profile not found.');
    return reply.code(204).send();
  });

  if (opts.packages) registerPackageRoutes(app, { store, policy, packagesDir: opts.packages.dir, packagePort: opts.packages.port });

  // ---- scans ----
  app.post<{ Params: { id: string } }>('/api/projects/:id/scans', async (req, reply) => {
    const project = isOpaqueId(req.params.id) ? store.getProject(req.params.id) : undefined;
    if (!project) return notFound(reply, 'Project not found.');
    const parsed = CreateScanInput.safeParse(req.body);
    if (!parsed.success) return badRequest(reply, 'Invalid scan configuration.', parsed.error.issues);
    const input = parsed.data;
    const target = policy.parseTarget(input.url);
    if (!target.ok) return reply.code(422).send({ error: target.detail, reason: target.reason, ruleId: 'NET-001' });
    const profile = input.profileId ? (isOpaqueId(input.profileId) ? store.getProfile(input.profileId) : undefined) : undefined;
    if (input.profileId && !profile) return notFound(reply, 'Client profile not found.');
    const fromProfile = profile ? profileScanOptions(profile) : undefined;
    const scope = { ...defaultScopeFor(target.url) };
    const origins = input.allowedOrigins?.length ? input.allowedOrigins : fromProfile?.scope.allowedOrigins ?? [];
    const prefixes = input.allowedPathPrefixes?.length ? input.allowedPathPrefixes : fromProfile?.scope.allowedPathPrefixes ?? [];
    if (origins.length) scope.allowedOrigins = [...new Set([target.url.origin, ...origins])];
    if (prefixes.length) scope.allowedPathPrefixes = prefixes;
    const viewport = input.viewport ? { ...input.viewport, deviceScaleFactor: 1, isMobile: input.viewport.width < 768, hasTouch: input.viewport.width < 768 } : undefined;
    const config = buildScanConfig({
      projectId: project.id as ProjectId,
      url: target.url,
      scope,
      navigationTimeoutMs: input.navigationTimeoutMs,
      viewport,
      explore: input.explore,
      accessibility: input.accessibility,
      layout: input.layout,
      compareBaseline: input.compareBaseline,
      testNonResponsive: input.testNonResponsive,
      viewports: input.viewports ? viewportsByName(input.viewports) : fromProfile?.viewportNames.length ? viewportsByName(fromProfile.viewportNames) : undefined,
      perf: fromProfile && Object.keys(fromProfile.perf).length ? fromProfile.perf : undefined,
      profile: fromProfile?.snapshot,
      maxStates: input.maxStates,
      maxDepth: input.maxDepth,
      terminology: input.terminology?.length ? input.terminology : fromProfile?.terminology,
      textExclusions: input.textExclusions?.length ? input.textExclusions : fromProfile?.textExclusions,
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
    // Deleting a scan that holds the stored visual baseline would silently remove that baseline.
    if (store.runHoldsBaselines(run.id) && (req.query as { discardBaselines?: string }).discardBaselines !== '1') {
      return reply.code(409).send({ error: 'This scan holds the stored visual baseline for its course. Deleting it removes the baseline. Set a newer baseline first, or confirm deleting the baseline too.', baseline: true });
    }
    store.deleteRun(run.id);
    artifacts.deleteRunArtifacts(run.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/findings', async (req, reply) => {
    if (!isOpaqueId(req.params.id) || !store.getRun(req.params.id)) return notFound(reply);
    return store.listFindings(req.params.id);
  });

  const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  // Screenshots are read from the artifact store by opaque id; a missing file is simply left out.
  const loadImage = (artifactId: string): Buffer | undefined => {
    const rec = store.getArtifact(artifactId);
    if (!rec || rec.mime !== 'image/png') return undefined;
    try {
      return readFileSync(artifacts.absolutePath(rec));
    } catch {
      return undefined;
    }
  };
  const hostSlug = (url: string) => {
    try {
      const u = new URL(url);
      return fileSlug(`${u.hostname}${u.pathname}`).slice(0, 40);
    } catch {
      return 'course';
    }
  };
  const fileSlug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'report';

  // Plain-language report model for one scan (the run page summary and the Excel export share it).
  app.get<{ Params: { id: string } }>('/api/runs/:id/report', async (req, reply) => {
    if (!isOpaqueId(req.params.id) || !store.getRun(req.params.id)) return notFound(reply, 'Scan not found.');
    return buildRunReport(store, req.params.id);
  });

  // One report model, four formats: JSON, self-contained HTML, PDF, and Excel all come from buildRunReport.
  const reportName = (run: { queuedAt: string; config: { target: { url?: string } } }, ext: string) => `course-qa-${hostSlug(run.config.target.url ?? '')}-${run.queuedAt.slice(0, 10)}.${ext}`;

  app.get<{ Params: { id: string } }>('/api/runs/:id/export.json', async (req, reply) => {
    const run = isOpaqueId(req.params.id) ? store.getRun(req.params.id) : undefined;
    if (!run) return notFound(reply, 'Scan not found.');
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${reportName(run, 'json')}"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), tool: 'Course QA Automation', report: buildRunReport(store, run.id) }, null, 2));
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/export.html', async (req, reply) => {
    const run = isOpaqueId(req.params.id) ? store.getRun(req.params.id) : undefined;
    if (!run) return notFound(reply, 'Scan not found.');
    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${reportName(run, 'html')}"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(buildHtmlReport(buildRunReport(store, run.id), { loadImage, generatedAt: new Date().toISOString() }));
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/export.pdf', async (req, reply) => {
    const run = isOpaqueId(req.params.id) ? store.getRun(req.params.id) : undefined;
    if (!run) return notFound(reply, 'Scan not found.');
    const pdf = await renderPdf(buildHtmlReport(buildRunReport(store, run.id), { loadImage, generatedAt: new Date().toISOString() }));
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="${reportName(run, 'pdf')}"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(pdf);
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/export.xlsx', async (req, reply) => {
    const run = isOpaqueId(req.params.id) ? store.getRun(req.params.id) : undefined;
    if (!run) return notFound(reply, 'Scan not found.');
    const project = store.getProject(run.projectId);
    const buf = await buildWorkbook(runReportAsProject(buildRunReport(store, run.id), project?.name ?? 'Course QA', run.projectId), { loadImage });
    reply.header('Content-Type', XLSX_TYPE);
    reply.header('Content-Disposition', `attachment; filename="course-qa-${fileSlug(project?.name ?? 'scan')}-scan-${run.queuedAt.slice(0, 10)}.xlsx"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(buf);
  });

  // Consolidated, trackable workbook across every finished scan in a project.
  // Optional ?course=<exact course address> exports one course; without it, all courses in the project share one workbook.
  app.get<{ Params: { id: string }; Querystring: { course?: string } }>('/api/projects/:id/export.xlsx', async (req, reply) => {
    const project = isOpaqueId(req.params.id) ? store.getProject(req.params.id) : undefined;
    if (!project) return notFound(reply, 'Project not found.');
    let report = buildProjectReport(store, project.id);
    let suffix = '';
    if (typeof req.query.course === 'string' && req.query.course) {
      const one = reportForCourse(report, req.query.course);
      if (!one) return notFound(reply, 'That course has no finished scans in this project.');
      report = one;
      suffix = `-${hostSlug(req.query.course)}`;
    }
    const buf = await buildWorkbook(report, { loadImage });
    reply.header('Content-Type', XLSX_TYPE);
    reply.header('Content-Disposition', `attachment; filename="course-qa-${fileSlug(project.name)}${suffix}-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(buf);
  });

  // Makes a finished scan the visual baseline for its course. Later scans compare only against identical settings.
  app.post<{ Params: { id: string } }>('/api/runs/:id/baseline', async (req, reply) => {
    const run = isOpaqueId(req.params.id) ? store.getRun(req.params.id) : undefined;
    if (!run) return notFound(reply, 'Scan not found.');
    if (run.status === 'queued' || run.status === 'running') return reply.code(409).send({ error: 'Wait for the scan to finish first.' });
    const result = recordBaselineFromRun(store, run.id);
    if (!result || result.recorded === 0) return reply.code(422).send({ error: 'This scan has no layout screenshots. Run it with screen-size checks turned on.' });
    return result;
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/actions', async (req, reply) => {
    if (!isOpaqueId(req.params.id) || !store.getRun(req.params.id)) return notFound(reply);
    return store.listActions(req.params.id);
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/checks', async (req, reply) => {
    if (!isOpaqueId(req.params.id) || !store.getRun(req.params.id)) return notFound(reply);
    return store.listCheckResults(req.params.id);
  });

  // ---- finding workflow and retest ----
  // Status follows the issue (by fingerprint) across scans of the project.
  app.patch<{ Params: { id: string } }>('/api/findings/:id/workflow', async (req, reply) => {
    const finding = isOpaqueId(req.params.id) ? store.getFinding(req.params.id) : undefined;
    const run = finding ? store.getRun(finding.runId) : undefined;
    if (!finding || !run) return notFound(reply);
    const body = (req.body ?? {}) as { status?: unknown; assignee?: unknown; reason?: unknown };
    const input = {
      status: typeof body.status === 'string' ? body.status : undefined,
      assignee: typeof body.assignee === 'string' ? body.assignee : body.assignee === null ? null : undefined,
      reason: typeof body.reason === 'string' ? body.reason : body.reason === null ? null : undefined,
    };
    const checked = validateWorkflowChange(store.getWorkflow(run.projectId, finding.fingerprint) ?? { status: finding.reviewer.status }, input);
    if (!checked.ok) return badRequest(reply, checked.error);
    store.setWorkflow(run.projectId, finding.fingerprint, checked.value, { actor: 'local user', runId: run.id });
    return store.getFinding(finding.id);
  });

  app.get<{ Params: { id: string } }>('/api/findings/:id/history', async (req, reply) => {
    const finding = isOpaqueId(req.params.id) ? store.getFinding(req.params.id) : undefined;
    const run = finding ? store.getRun(finding.runId) : undefined;
    if (!finding || !run) return notFound(reply);
    return store.listHistory(run.projectId, finding.fingerprint);
  });

  // A retest is a new, separate scan of the same course with the same settings; the earlier scan is never changed.
  app.post<{ Params: { id: string } }>('/api/runs/:id/retest', async (req, reply) => {
    const prior = isOpaqueId(req.params.id) ? store.getRun(req.params.id) : undefined;
    if (!prior) return notFound(reply, 'Scan not found.');
    if (prior.status !== 'completed' && prior.status !== 'partial') return reply.code(409).send({ error: 'Only a finished scan can be retested.' });
    const url = store.getRunTargetUrl(prior.id)!;
    const decision = await policy.validateTarget(url, prior.config.scope);
    if (!decision.ok) return reply.code(422).send({ error: decision.detail, reason: decision.reason, ruleId: 'NET-001' });
    return reply.code(201).send(store.createRun(prior.config, url, prior.id));
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
