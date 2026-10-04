import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { CheckResultId, FindingId, Finding, ProjectId, RuleId, ScanRun } from '@cqa/shared';
import {
  ArchiveError,
  type CoursePackage,
  type LaunchChoice,
  type NetworkPolicy,
  type PackageInspection,
  type Store,
  buildScanConfig,
  defaultScopeFor,
  extractArchive,
  fingerprint,
  getRule,
  inspectPackage,
  isOpaqueId,
  newId,
  nowIso,
  viewportsByName,
} from '@cqa/core';

export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const MAX_LAUNCHES = 25;

const Step = z.object({
  action: z.enum(['click', 'fill', 'select', 'press', 'wait']),
  target: z.string().trim().max(300).optional(),
  value: z.string().max(300).optional(),
  ms: z.number().int().min(0).max(10_000).optional(),
});
const Expectation = z.object({
  status: z.enum(['passed', 'completed', 'failed', 'incomplete', 'browsed', 'not attempted']).optional(),
  completion: z.enum(['completed', 'incomplete', 'not attempted', 'unknown']).optional(),
  success: z.enum(['passed', 'failed', 'unknown']).optional(),
  scoreMin: z.number().min(-1000).max(1000).optional(),
  scoreMax: z.number().min(-1000).max(1000).optional(),
  mustReportScore: z.boolean().optional(),
});
const ScormInput = z.object({
  /** Run the SCORM test harness. On by default for SCORM 1.2 and 2004 packages. */
  enabled: z.boolean().optional(),
  checkResume: z.boolean().optional(),
  observeSeconds: z.number().min(0).max(15).optional(),
  journeys: z.array(z.object({ name: z.string().trim().min(1).max(80), steps: z.array(Step).max(60), expect: Expectation.optional() })).max(6).optional(),
});

const PackageScanInput = z.object({
  scorm: ScormInput.optional(),
  /** Launch keys from the package's list, or "all". Required when the package has more than one. */
  launch: z.union([z.literal('all'), z.array(z.string().max(512)).min(1).max(MAX_LAUNCHES)]).optional(),
  /** The scan runs the package's own JavaScript in a browser on this computer; the person must say they understand. */
  acknowledgeLocalExecution: z.boolean().optional(),
  /** Outside websites the package may load from. Everything else outside the package is blocked and listed. */
  allowedExternalOrigins: z.array(z.string().url().max(300)).max(20).optional(),
  navigationTimeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  explore: z.boolean().optional(),
  accessibility: z.boolean().optional(),
  layout: z.boolean().optional(),
  viewports: z.array(z.enum(['desktop', 'laptop', 'tablet', 'mobile'])).min(1).max(4).optional(),
  maxStates: z.number().int().min(1).max(200).optional(),
  maxDepth: z.number().int().min(0).max(10).optional(),
});

export interface PackageRouteDeps {
  store: Store;
  policy: NetworkPolicy;
  /** Folder holding one folder per package. */
  packagesDir: string;
  packagePort: number;
}

const bad = (reply: FastifyReply, error: string, extra: Record<string, unknown> = {}) => reply.code(422).send({ error, ...extra });
const missing = (reply: FastifyReply, error = 'Not found.') => reply.code(404).send({ error });

function view(p: CoursePackage) {
  return { id: p.id, projectId: p.projectId, name: p.name, originalFilename: p.originalFilename, sizeBytes: p.sizeBytes, sha256: p.sha256, createdAt: p.createdAt, inspection: p.inspection };
}

function launchUrl(deps: PackageRouteDeps, id: string, choice: { path: string; suffix?: string }): string {
  const encoded = choice.path.split('/').map(encodeURIComponent).join('/');
  return `http://127.0.0.1:${deps.packagePort}/p/${id}/${encoded}${choice.suffix ?? ''}`;
}

const NEEDS_REVIEW_TYPE: Record<string, Finding['type']> = { 'PKG-003': 'standards_warning', 'PKG-007': 'manual_review' };

/** Writes the static inspection results into a scan, so they sit in the same report as the runtime results. */
function recordStaticResults(deps: PackageRouteDeps, run: ScanRun, pkg: CoursePackage, launchTitle: string, chosen: LaunchChoice[], all: LaunchChoice[]): void {
  const { store } = deps;
  const url = run.config.target.url as never;
  const issues = pkg.inspection.issues.filter((i) => i.ruleId !== 'PKG-007');
  const unscanned = all.filter((c) => !chosen.some((x) => x.key === c.key));
  if (all.length > 1 || pkg.inspection.organizations.length > 1) {
    issues.push(
      unscanned.length
        ? { ruleId: 'PKG-007', outcome: 'needs_review', title: `Scanned ${chosen.length} of ${all.length} lessons; ${unscanned.length} were not scanned`, detail: `This scan covers: ${chosen.map((c) => c.title).join('; ')}. Not scanned: ${unscanned.map((c) => c.title).join('; ')}. Results here say nothing about the lessons that were not scanned.` }
        : { ruleId: 'PKG-007', outcome: 'passed', detail: `All ${all.length} launch points were selected for scanning (each in its own scan). Sequencing rules in the manifest are not evaluated.` },
    );
  } else issues.push({ ruleId: 'PKG-007', outcome: 'not_applicable', detail: 'One launch point; it is scanned.' });

  const perRule = new Map<string, typeof issues>();
  for (const i of issues) perRule.set(i.ruleId, [...(perRule.get(i.ruleId) ?? []), i]);
  for (const [ruleId, list] of perRule) {
    // One result per rule: failed beats needs_review beats passed.
    const order = ['failed', 'needs_review', 'not_tested', 'passed', 'not_applicable'];
    const worst = [...list].sort((a, b) => order.indexOf(a.outcome) - order.indexOf(b.outcome))[0]!;
    store.insertCheckResult({
      id: newId<CheckResultId>(),
      runId: run.id,
      ruleId: ruleId as RuleId,
      outcome: worst.outcome,
      reason: worst.outcome === 'not_tested' ? 'state_unreachable' : undefined,
      reasonDetail: worst.outcome === 'not_tested' || worst.outcome === 'not_applicable' ? worst.detail : undefined,
      durationMs: 0,
      itemsEvaluated: list.length,
      evidenceIds: [],
      executedAt: nowIso(),
    });
  }
  for (const i of issues) {
    if (i.outcome !== 'failed' && i.outcome !== 'needs_review') continue;
    const rule = getRule(i.ruleId);
    const title = i.title ?? rule.name;
    const type = i.outcome === 'failed' ? rule.defaultFindingType : (NEEDS_REVIEW_TYPE[i.ruleId] ?? 'heuristic_warning');
    const loc = { url, screenLabel: launchTitle, elementDescription: i.paths?.join(', ') };
    const f: Finding = {
      id: newId<FindingId>(),
      runId: run.id,
      ruleId: i.ruleId,
      category: 'package',
      type,
      severity: rule.defaultSeverity,
      confidence: rule.defaultConfidence,
      title,
      location: loc,
      occurrences: [{ location: loc, checkResultIds: [], evidenceIds: [], observed: i.detail }],
      observed: i.detail,
      expected: rule.name,
      evidenceIds: [],
      reproductionSteps: ['Unzip the package (this finding comes from its files, not from running it).', ...(i.paths?.length ? [`Look at: ${i.paths.join(', ')}.`] : []), 'Compare with what the manifest and pages say.'],
      remediation: REMEDIATION[i.ruleId] ?? 'Fix the package and upload it again.',
      standards: [],
      reviewer: { status: 'open', updatedAt: nowIso() },
      fingerprint: fingerprint({ ruleId: i.ruleId, targetKey: `${pkg.name}|${title}|${(i.paths ?? []).join(',')}` }),
      createdAt: nowIso(),
    };
    store.upsertFinding(f);
  }
}

const REMEDIATION: Record<string, string> = {
  'PKG-001': 'Re-create the ZIP with your authoring tool using standard options (no encryption, no links), then upload it again.',
  'PKG-002': 'Re-publish the course from the authoring tool; do not edit imsmanifest.xml by hand unless you know the format.',
  'PKG-003': 'Check the SCORM version chosen when publishing matches what the LMS expects.',
  'PKG-004': 'Make sure the launch file named in the manifest is in the ZIP at that path, then re-publish.',
  'PKG-005': 'Fix the file name or letter case so the reference and the file match exactly, or add the missing file, then re-publish.',
  'PKG-006': 'Host the file inside the package, or confirm the outside site is meant to be used and allow it when scanning.',
  'PKG-007': 'Scan the remaining lessons too, or note that they were not covered.',
};

export function registerPackageRoutes(app: FastifyInstance, deps: PackageRouteDeps): void {
  const { store, policy, packagesDir } = deps;
  const pkgDir = (id: string) => path.join(packagesDir, id);

  // Raw ZIP bytes. The global body limit stays small for every other route.
  app.addContentTypeParser('application/zip', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));

  app.post<{ Params: { id: string }; Querystring: { filename?: string; replace?: string } }>('/api/projects/:id/packages', { bodyLimit: MAX_UPLOAD_BYTES }, async (req, reply) => {
    const project = isOpaqueId(req.params.id) ? store.getProject(req.params.id) : undefined;
    if (!project) return missing(reply, 'Project not found.');
    const bytes = req.body as Buffer;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) return bad(reply, 'Send the ZIP file as the request body.', { ruleId: 'PKG-001' });
    const filename = (req.query.filename ?? 'package.zip').replace(/[^\w. -]/g, '_').slice(0, 120) || 'package.zip';
    let id = newId<string>();
    let replaced: CoursePackage | undefined;
    if (req.query.replace) {
      replaced = isOpaqueId(req.query.replace) ? store.getPackage(req.query.replace) : undefined;
      if (!replaced || replaced.projectId !== project.id) return missing(reply, 'The package to replace was not found in this project.');
      id = replaced.id;
    }
    // Extract into a new folder first; the live one is swapped only after everything passed.
    const staging = path.join(packagesDir, `.staging-${newId<string>()}`);
    try {
      mkdirSync(staging, { recursive: true });
      extractArchive(bytes, path.join(staging, 'content'));
      writeFileSync(path.join(staging, 'upload.zip'), bytes);
      const inspection: PackageInspection = inspectPackage(path.join(staging, 'content'));
      const finalDir = pkgDir(id);
      rmSync(finalDir, { recursive: true, force: true });
      mkdirSync(path.dirname(finalDir), { recursive: true });
      renameSync(staging, finalDir);
      const pkg: CoursePackage = {
        id,
        projectId: project.id,
        name: (inspection.title || filename.replace(/\.zip$/i, '')).slice(0, 120),
        originalFilename: filename,
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        inspection,
        createdAt: nowIso(),
      };
      if (replaced) store.deletePackage(id);
      store.insertPackage(pkg);
      return reply.code(replaced ? 200 : 201).send(view(pkg));
    } catch (err) {
      rmSync(staging, { recursive: true, force: true });
      if (err instanceof ArchiveError) return bad(reply, err.message, { code: err.code, ruleId: 'PKG-001' });
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/packages', async (req, reply) => {
    if (!isOpaqueId(req.params.id) || !store.getProject(req.params.id)) return missing(reply, 'Project not found.');
    return store.listPackages(req.params.id).map(view);
  });

  app.get<{ Params: { id: string } }>('/api/packages/:id', async (req, reply) => {
    const p = isOpaqueId(req.params.id) ? store.getPackage(req.params.id) : undefined;
    return p ? view(p) : missing(reply, 'Package not found.');
  });

  app.delete<{ Params: { id: string } }>('/api/packages/:id', async (req, reply) => {
    const p = isOpaqueId(req.params.id) ? store.getPackage(req.params.id) : undefined;
    if (!p) return missing(reply, 'Package not found.');
    store.deletePackage(p.id);
    rmSync(pkgDir(p.id), { recursive: true, force: true });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/api/packages/:id/scans', async (req, reply) => {
    const pkg = isOpaqueId(req.params.id) ? store.getPackage(req.params.id) : undefined;
    if (!pkg) return missing(reply, 'Package not found.');
    const parsed = PackageScanInput.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid scan configuration.', issues: parsed.error.issues });
    const input = parsed.data;
    const choices = pkg.inspection.launchChoices;
    if (choices.length === 0) return bad(reply, 'This package has no launch file to scan. See the inspection results.', { ruleId: 'PKG-004' });
    if (!input.acknowledgeLocalExecution) {
      return bad(reply, 'Scanning runs this package\'s own JavaScript in a browser on this computer, behind the network limits, but without a container. Confirm that you trust the package or accept that risk.', { needsAcknowledgement: true });
    }
    let chosen: LaunchChoice[];
    if (input.launch === 'all') chosen = choices;
    else if (input.launch) {
      chosen = input.launch.map((k) => choices.find((c) => c.key === k)).filter((c): c is LaunchChoice => Boolean(c));
      if (chosen.length !== input.launch.length) return bad(reply, 'One of the chosen lessons is not in this package.');
    } else if (choices.length === 1) chosen = choices;
    else return bad(reply, `This package has ${choices.length} launch points. Choose which to scan, or choose all. Lessons you do not choose are reported as not scanned.`, { ruleId: 'PKG-007', choices });
    if (chosen.length > MAX_LAUNCHES) return bad(reply, `At most ${MAX_LAUNCHES} lessons can be scanned at once.`, { ruleId: 'PKG-007' });

    const kind = pkg.inspection.kind;
    const wantsScorm = input.scorm?.enabled ?? (kind === 'scorm12' || kind === 'scorm2004');
    if (wantsScorm && kind !== 'scorm12' && kind !== 'scorm2004') {
      return bad(reply, kind === 'html5' ? 'This is a plain HTML5 package, so there is no SCORM API to test.' : 'The SCORM version of this package could not be determined, so the matching test API is unknown. Fix the manifest, or scan without the SCORM test.', { ruleId: 'PKG-003' });
    }
    const scormVersion: '1.2' | '2004' | undefined = wantsScorm ? (kind === 'scorm12' ? '1.2' : '2004') : undefined;
    const origin = `http://127.0.0.1:${deps.packagePort}`;
    const runs: ScanRun[] = [];
    for (const c of chosen) {
      const url = launchUrl(deps, pkg.id, c);
      const scope = {
        ...defaultScopeFor(new URL(url)),
        allowedOrigins: [origin, ...new Set((input.allowedExternalOrigins ?? []).map((o) => new URL(o).origin))],
        allowedPathPrefixes: [`/p/${pkg.id}/`],
        // Anything outside the package and the allowed sites is blocked and listed, never silently fetched.
        subrequestPolicy: 'same_scope_only' as const,
        allowedPorts: [deps.packagePort],
      };
      const config = buildScanConfig({
        projectId: pkg.projectId as ProjectId,
        url: new URL(url),
        scope,
        navigationTimeoutMs: input.navigationTimeoutMs,
        explore: input.explore,
        accessibility: input.accessibility,
        layout: input.layout,
        viewports: input.viewports ? viewportsByName(input.viewports) : undefined,
        maxStates: input.maxStates,
        maxDepth: input.maxDepth,
      });
      config.target = { kind: 'package', url, packageId: pkg.id, launchEntry: c.key, packageName: pkg.name };
      if (scormVersion) {
        config.engines.scorm = scormVersion;
        config.scorm = {
          version: scormVersion,
          journeys: input.scorm?.journeys ?? [],
          checkResume: input.scorm?.checkResume ?? true,
          observeSeconds: input.scorm?.observeSeconds ?? 4,
          launchData: c.dataFromLms,
          masteryScore: c.masteryScore,
          hasSequencing: pkg.inspection.hasSequencing,
        };
      }
      config.skipExternalLinks = true;
      const decision = await policy.validateTarget(url, config.scope);
      if (!decision.ok) return reply.code(422).send({ error: decision.detail, reason: decision.reason, ruleId: 'NET-001' });
      runs.push(store.createRun(config, url));
    }
    runs.forEach((run, i) => recordStaticResults(deps, run, pkg, chosen[i]!.title, chosen, choices));
    return reply.code(201).send({ runs, scanned: chosen.map((c) => c.title), notScanned: choices.filter((c) => !chosen.includes(c)).map((c) => c.title) });
  });
}
