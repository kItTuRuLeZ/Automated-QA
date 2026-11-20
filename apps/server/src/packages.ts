import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { CheckResultId, FindingId, Finding, ProjectId, RuleId, ScanConfig, ScanRun } from '@cqa/shared';
import {
  ArchiveError,
  DEFAULT_ARCHIVE_LIMITS,
  DEFAULT_BUDGETS,
  FINGERPRINT_SCHEME,
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
  profileScanOptions,
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
  screenShows: z.string().trim().min(1).max(300).optional(),
  bookmark: z.string().trim().max(1000).optional(),
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
  functional: z.boolean().optional(),
  qaProfile: z.enum(['quick', 'functional', 'full', 'custom']).optional(),
  autoAnswer: z.boolean().optional(),
  traces: z.enum(['off', 'first_failure']).optional(),
  viewports: z.array(z.enum(['desktop', 'laptop', 'tablet', 'mobile'])).min(1).max(4).optional(),
  maxStates: z.number().int().min(1).max(200).optional(),
  maxDepth: z.number().int().min(0).max(60).optional(),
  /** The scan of an earlier version this one retests ("Scan a revised ZIP"). Its settings and lesson are carried forward where the input leaves them out. */
  baselineRunId: z.string().max(64).optional(),
  /** A client profile: screen sizes, text rules, performance limits and rule settings, as for a web address scan. */
  profileId: z.string().max(64).optional(),
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
  return { id: p.id, projectId: p.projectId, name: p.name, originalFilename: p.originalFilename, sizeBytes: p.sizeBytes, sha256: p.sha256, createdAt: p.createdAt, courseKey: p.courseKey, version: p.version, revisionOf: p.revisionOf, inspection: p.inspection };
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
      reason: worst.outcome === 'not_tested' ? (worst.reason ?? 'state_unreachable') : undefined,
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
      // The logical course and the files involved, so the same problem matches in the course's next version even if its
      // title or the measured size changes; the lesson-selection note is one item whatever the counts.
      fingerprint: fingerprint({ ruleId: i.ruleId, targetKey: `${pkg.courseKey}|${i.paths?.length ? i.paths.join(',') : i.ruleId === 'PKG-007' ? 'selection' : title}` }),
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
  'PKG-008': 'Export images at the size they are shown and compress them (JPEG quality about 80, or WebP); re-encode large video or stream it from a video service.',
  'PKG-009': 'Compress the largest media files, or host large video outside the package, then re-publish.',
  'PKG-010': 'Add a caption track to the video in the authoring tool, or confirm it has no speech.',
  'PKG-011': 'Rename the files using letters, digits, hyphens and underscores only, then re-publish.',
  'PKG-012': 'Correct the word in the authoring tool, or mark it "Not a real issue" if it is spelled as intended.',
  'PKG-013': 'Make the wording consistent in the authoring tool, then re-publish.',
};

/** Settings from the baseline scan, used where the request leaves them out, so a revised ZIP is scanned the same way. */
function carryForward(input: z.infer<typeof PackageScanInput>, baseline: ScanRun, basePkg?: CoursePackage): z.infer<typeof PackageScanInput> {
  const c = baseline.config;
  // A journey that was the old package's automatic one is not carried: the new version's own adapter journey applies.
  const auto = basePkg?.inspection.authoringTool?.defaultJourney?.name;
  const written = (c.scorm?.journeys ?? []).filter((j) => j.name !== auto);
  const names = c.viewports.map((v) => v.name).filter((n): n is 'desktop' | 'laptop' | 'tablet' | 'mobile' => ['desktop', 'laptop', 'tablet', 'mobile'].includes(n));
  return {
    ...input,
    acknowledgeLocalExecution: input.acknowledgeLocalExecution,
    qaProfile: input.qaProfile ?? c.qaProfile,
    explore: input.explore ?? c.engines.traversal,
    accessibility: input.accessibility ?? c.engines.accessibility,
    layout: input.layout ?? c.engines.layout,
    functional: input.functional ?? Boolean(c.engines.functional),
    autoAnswer: input.autoAnswer ?? Boolean(c.autoAnswer),
    traces: input.traces ?? c.traces,
    viewports: input.viewports ?? (names.length === c.viewports.length && names.length ? names : undefined),
    allowedExternalOrigins: input.allowedExternalOrigins ?? c.scope.allowedOrigins.filter((o) => !/^http:\/\/127\.0\.0\.1:/.test(o)),
    scorm: input.scorm ?? (c.scorm ? { enabled: true, ...(written.length ? { journeys: written } : {}), checkResume: c.scorm.checkResume, observeSeconds: c.scorm.observeSeconds } : undefined),
    maxStates: input.maxStates ?? c.budgets.maxStates,
    maxDepth: input.maxDepth ?? c.budgets.maxDepth,
    navigationTimeoutMs: input.navigationTimeoutMs ?? c.budgets.navigationTimeoutMs,
  };
}

/** The launch point in a new version that opens the same file the baseline scan opened. The same key on another file is a changed launch point. */
function sameLaunch(baseline: ScanRun, choices: LaunchChoice[]): LaunchChoice | undefined {
  const t = baseline.config.target;
  const path = (t.url ?? '').replace(/^https?:\/\/[^/]+\/p\/[^/]+\//, '').split(/[?#]/)[0];
  return choices.find((c) => c.key === t.launchEntry && c.path.split('/').map(encodeURIComponent).join('/') === path) ?? choices.find((c) => c.path.split('/').map(encodeURIComponent).join('/') === path);
}

/**
 * Retests an uploaded-package scan: the same upload, lesson and settings, linked to the earlier scan, with the package
 * file checks recorded again like any package scan. Undefined when the scan is not of an upload.
 */
export async function retestPackageRun(deps: PackageRouteDeps, prior: ScanRun): Promise<{ run: ScanRun } | { error: string; code: number } | undefined> {
  const t = prior.config.target;
  if (t.kind !== 'package' || !t.packageId) return undefined;
  const pkg = deps.store.getPackage(t.packageId);
  if (!pkg) return { code: 409, error: 'The uploaded course this scan used has been deleted, so it cannot be scanned again. Upload it again to scan it.' };
  const choices = pkg.inspection.launchChoices;
  const choice = choices.find((c) => c.key === t.launchEntry) ?? (choices.length === 1 ? choices[0] : undefined);
  if (!choice) return { code: 409, error: 'The lesson this scan opened is no longer listed in the package.' };
  const url = launchUrl(deps, pkg.id, choice);
  // Same settings; the fingerprint scheme is the current one, because that is how the new scan's findings are made.
  const config: ScanConfig = { ...prior.config, target: { ...t, url }, fingerprintScheme: FINGERPRINT_SCHEME };
  const decision = await deps.policy.validateTarget(url, config.scope);
  if (!decision.ok) return { code: 422, error: decision.detail };
  const run = deps.store.db.transaction(() => {
    const r = deps.store.createRun(config, url, prior.id);
    const selected = choices.filter((c) => t.batchKeys?.includes(c.key));
    recordStaticResults(deps, r, pkg, choice.title, selected.length ? selected : [choice], choices);
    return r;
  })();
  return { run };
}

export function registerPackageRoutes(app: FastifyInstance, deps: PackageRouteDeps): void {
  const { store, policy, packagesDir } = deps;
  const pkgDir = (id: string) => path.join(packagesDir, id);

  // The limits the upload form quotes, so the screen never states a number the server does not enforce.
  app.get('/api/package-limits', async () => ({ maxUploadBytes: MAX_UPLOAD_BYTES, maxEntries: DEFAULT_ARCHIVE_LIMITS.maxEntries, maxExpandedBytes: DEFAULT_ARCHIVE_LIMITS.maxExpandedBytes, maxLessonsPerScan: MAX_LAUNCHES, formats: ['SCORM 1.2', 'SCORM 2004', 'HTML5'] }));

  // Raw ZIP bytes. The global body limit stays small for every other route.
  app.addContentTypeParser('application/zip', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES }, (_req, body, done) => done(null, body));

  app.post<{ Params: { id: string }; Querystring: { filename?: string; replace?: string; revisionOf?: string } }>('/api/projects/:id/packages', { bodyLimit: MAX_UPLOAD_BYTES }, async (req, reply) => {
    const project = isOpaqueId(req.params.id) ? store.getProject(req.params.id) : undefined;
    if (!project) return missing(reply, 'Project not found.');
    const bytes = req.body as Buffer;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) return bad(reply, 'Send the ZIP file as the request body.', { ruleId: 'PKG-001' });
    const filename = (req.query.filename ?? 'package.zip').replace(/[^\w. -]/g, '_').slice(0, 120) || 'package.zip';
    // Every upload is a new, immutable version: earlier uploads, their reports and evidence are never overwritten.
    // "revisionOf" (or the older "replace") makes it the next version of that upload's course.
    const id = newId<string>();
    const revisionId = req.query.revisionOf ?? req.query.replace;
    let base: CoursePackage | undefined;
    if (revisionId) {
      base = isOpaqueId(revisionId) ? store.getPackage(revisionId) : undefined;
      if (!base || base.projectId !== project.id) return missing(reply, 'The upload this is a revision of was not found in this project.');
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
        courseKey: base?.courseKey ?? id,
        version: base ? store.nextPackageVersion(base.courseKey) : 1,
        ...(base ? { revisionOf: base.id } : {}),
      };
      store.insertPackage(pkg);
      return reply.code(201).send(view(pkg));
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
    const baseline = parsed.data.baselineRunId ? (isOpaqueId(parsed.data.baselineRunId) ? store.getRun(parsed.data.baselineRunId) : undefined) : undefined;
    if (parsed.data.baselineRunId) {
      if (!baseline) return missing(reply, 'The earlier scan was not found.');
      const basePkg = baseline.config.target.kind === 'package' && baseline.config.target.packageId ? store.getPackage(baseline.config.target.packageId) : undefined;
      if (!basePkg || basePkg.courseKey !== pkg.courseKey) return bad(reply, 'The earlier scan is not of a version of this course. Upload this ZIP as a revision of the earlier one first.');
    }
    const input = baseline ? carryForward(parsed.data, baseline, baseline.config.target.packageId ? store.getPackage(baseline.config.target.packageId) : undefined) : parsed.data;
    const choices = pkg.inspection.launchChoices;
    if (choices.length === 0) return bad(reply, 'This package has no launch file to scan. See the inspection results.', { ruleId: 'PKG-004' });
    if (!input.acknowledgeLocalExecution) {
      return bad(reply, 'Scanning runs this package\'s own JavaScript in a browser on this computer, behind the network limits, but without a container. Confirm that you trust the package or accept that risk.', { needsAcknowledgement: true });
    }
    let chosen: LaunchChoice[];
    // A revised ZIP rescans the lesson the earlier scan opened. If that lesson is not in this version, say so and ask.
    if (baseline && !parsed.data.launch) {
      const same = sameLaunch(baseline, choices);
      if (!same) return reply.code(409).send({ error: `The lesson the earlier scan opened (${baseline.config.target.launchEntry ?? 'unknown'}) is not in this version. Choose which lesson to scan; a different lesson will not be compared as the same.`, ruleId: 'PKG-007', choices, launchChanged: true });
      input.launch = [same.key];
    }
    const baselineSelection = baseline ? choices.filter((c) => baseline.config.target.batchKeys?.includes(c.key)) : [];
    if (input.launch === 'all') chosen = choices;
    else if (input.launch) {
      chosen = input.launch.map((k) => choices.find((c) => c.key === k)).filter((c): c is LaunchChoice => Boolean(c));
      if (chosen.length !== input.launch.length) return bad(reply, 'One of the chosen lessons is not in this package.');
    } else if (choices.length === 1) chosen = choices;
    else return bad(reply, `This package has ${choices.length} launch points. Choose which to scan, or choose all. Lessons you do not choose are reported as not scanned.`, { ruleId: 'PKG-007', choices });
    if (chosen.length > MAX_LAUNCHES) return bad(reply, `At most ${MAX_LAUNCHES} lessons can be scanned at once.`, { ruleId: 'PKG-007' });

    const profile = input.profileId ? (isOpaqueId(input.profileId) ? store.getProfile(input.profileId) : undefined) : undefined;
    if (input.profileId && !profile) return missing(reply, 'Client profile not found.');
    const fromProfile = profile ? profileScanOptions(profile) : undefined;
    const kind = pkg.inspection.kind;
    const wantsScorm = input.scorm?.enabled ?? (kind === 'scorm12' || kind === 'scorm2004');
    if (wantsScorm && kind !== 'scorm12' && kind !== 'scorm2004') {
      return bad(reply, kind === 'html5' ? 'This is a plain HTML5 package, so there is no SCORM API to test.' : 'The SCORM version of this package could not be determined, so the matching test API is unknown. Fix the manifest, or scan without the SCORM test.', { ruleId: 'PKG-003' });
    }
    const scormVersion: '1.2' | '2004' | undefined = wantsScorm ? (kind === 'scorm12' ? '1.2' : '2004') : undefined;
    const origin = `http://127.0.0.1:${deps.packagePort}`;
    // Build and check every scan first, then create them together, so a refusal leaves nothing half made.
    const planned: Array<{ config: ScanConfig; url: string; choice: LaunchChoice }> = [];
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
      const outline = pkg.inspection.authoringTool?.outline ?? [];
      const primaryUnitsCount = outline.filter((e) => e.kind === 'slide' || e.kind === 'lesson').length;
      const recommendedMaxStates = primaryUnitsCount > 0 ? Math.max(DEFAULT_BUDGETS.maxStates, Math.min(200, primaryUnitsCount * 2 + 10)) : DEFAULT_BUDGETS.maxStates;
      const recommendedMaxDepth = primaryUnitsCount > 0 ? Math.max(DEFAULT_BUDGETS.maxDepth, Math.min(60, primaryUnitsCount + 3)) : DEFAULT_BUDGETS.maxDepth;

      const config = buildScanConfig({
        projectId: pkg.projectId as ProjectId,
        url: new URL(url),
        scope,
        navigationTimeoutMs: input.navigationTimeoutMs,
        explore: input.explore,
        accessibility: input.accessibility,
        layout: input.layout,
        functional: input.functional,
        qaProfile: input.qaProfile,
        autoAnswer: input.autoAnswer,
        traces: input.traces,
        viewports: input.viewports ? viewportsByName(input.viewports) : fromProfile?.viewportNames.length ? viewportsByName(fromProfile.viewportNames) : undefined,
        perf: fromProfile && Object.keys(fromProfile.perf).length ? fromProfile.perf : undefined,
        profile: fromProfile?.snapshot ?? (baseline && !input.profileId ? baseline.config.profile : undefined),
        terminology: fromProfile?.terminology ?? (baseline && !input.profileId ? baseline.config.textRules.terminology : undefined),
        textExclusions: fromProfile?.textExclusions ?? (baseline && !input.profileId ? baseline.config.textRules.exclusions : undefined),
        maxStates: input.maxStates ?? recommendedMaxStates,
        maxDepth: input.maxDepth ?? recommendedMaxDepth,
      });
      config.target = { kind: 'package', url, packageId: pkg.id, launchEntry: c.key, packageName: pkg.name, batchKeys: chosen.map((x) => x.key) };
      // A course that lists many screens needs more than the default five minutes to open and test them. The limit grows with the list (about 45 s a screen, at most 45 minutes) so it is a safety net, not a cut-off.
      if (primaryUnitsCount > 0) config.budgets.maxRuntimeMs = Math.min(45 * 60_000, Math.max(DEFAULT_BUDGETS.maxRuntimeMs, 5 * 60_000 + primaryUnitsCount * 45_000));
      if (scormVersion) {
        config.engines.scorm = scormVersion;
        config.scorm = {
          version: scormVersion,
          // With no journey written by the person, use the authoring tool's adapter journey (if one is recognized) so resume is exercised.
          journeys: input.scorm?.journeys?.length ? input.scorm.journeys : pkg.inspection.authoringTool?.defaultJourney ? [pkg.inspection.authoringTool.defaultJourney] : [],
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
      planned.push({ config, url, choice: c });
    }
    const runs: ScanRun[] = store.db.transaction(() =>
      planned.map(({ config, url, choice }) => {
        const run = store.createRun(config, url, baseline?.id);
        recordStaticResults(deps, run, pkg, choice.title, baselineSelection.length > chosen.length && baselineSelection.some((b) => b.key === choice.key) ? baselineSelection : chosen, choices);
        return run;
      }),
    )();
    return reply.code(201).send({ runs, scanned: chosen.map((c) => c.title), notScanned: choices.filter((c) => !chosen.includes(c)).map((c) => c.title) });
  });
}
