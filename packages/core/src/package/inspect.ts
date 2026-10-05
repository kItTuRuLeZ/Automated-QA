import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { type AuthoringToolInfo, detectAuthoringTool } from './authoring.js';

/**
 * Static inspection of an extracted package. Nothing here runs course code.
 * XML is parsed with DTDs and entities refused outright, and the checks are
 * custom checks: they do not establish conformance with the SCORM schemas.
 */
export type PackageKind = 'scorm12' | 'scorm2004' | 'scorm_unknown' | 'html5';

export interface ManifestItem {
  id: string;
  title: string;
  resourceId?: string;
  children: ManifestItem[];
  dataFromLms?: string;
  masteryScore?: string;
}
export interface ManifestOrganization {
  id: string;
  title: string;
  isDefault: boolean;
  items: ManifestItem[];
}
export interface ManifestResource {
  id: string;
  type: string;
  scormType?: 'sco' | 'asset';
  href?: string;
  /** Package-relative path the launch file resolves to, when it does. */
  launchPath?: string;
  /** Query string and fragment from href, kept for launching. */
  launchSuffix?: string;
  files: string[];
  dependencies: string[];
}

export interface PackageIssue {
  ruleId: 'PKG-001' | 'PKG-002' | 'PKG-003' | 'PKG-004' | 'PKG-005' | 'PKG-006' | 'PKG-007';
  outcome: 'passed' | 'failed' | 'needs_review' | 'not_applicable' | 'not_tested';
  /** Plain description of what was found (or why nothing could be checked). */
  title?: string;
  detail: string;
  /** Package-relative paths involved. */
  paths?: string[];
}

export interface LaunchChoice {
  /** Stable key used to pick it: the resource identifier, or the file path for HTML5 packages. */
  key: string;
  title: string;
  path: string;
  suffix?: string;
  /** `adlcp:datafromlms` on the item, handed to the course as launch data. */
  dataFromLms?: string;
  /** SCORM 1.2 `adlcp:masteryscore` on the item. */
  masteryScore?: string;
}

export interface PackageInspection {
  kind: PackageKind;
  /** What the manifest declares, if anything. */
  scormVersionDeclared?: string;
  title?: string;
  inventory: { files: number; bytes: number; byType: Array<{ type: string; files: number; bytes: number }>; largest: Array<{ path: string; bytes: number }> };
  organizations: ManifestOrganization[];
  defaultOrganization?: string;
  resources: ManifestResource[];
  /** What a scan can start from. More than one means the person must choose. */
  launchChoices: LaunchChoice[];
  externalDependencies: Array<{ host: string; urls: string[]; referencedFrom: string[] }>;
  /** Addresses found only in a recognized authoring tool's own player/driver code, or on the tool vendor's domains. */
  runtimeReferences?: Array<{ host: string; urls: string[]; referencedFrom: string[] }>;
  /** The authoring tool that exported the package, when recognized. */
  authoringTool?: AuthoringToolInfo;
  /** The manifest contains sequencing rules. They are listed but never evaluated. */
  hasSequencing?: boolean;
  issues: PackageIssue[];
  /** Always printed with the results. */
  limits: string[];
}

const LIMITS = [
  'The manifest was checked for well-formed XML and for the structure this tool reads. It was not validated against the SCORM XML schemas, so this is not a conformance result.',
  'External dependencies come from scanning HTML, CSS, and JavaScript text for http(s) addresses. Addresses built at run time in code are not found statically.',
  'No course code was run during inspection.',
];

const MAX_TEXT_FILES = 800;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const TEXT_EXT = new Set(['.html', '.htm', '.js', '.css', '.xml', '.json', '.svg']);

function walk(dir: string, base = dir): Array<{ rel: string; bytes: number }> {
  const out: Array<{ rel: string; bytes: number }> = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, base));
    else if (e.isFile()) out.push({ rel: path.relative(base, full).split(path.sep).join('/'), bytes: statSync(full).size });
  }
  return out;
}

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const local = (name: string) => name.replace(/^.*:/, '');

/** Looks up a child by local name (namespace prefix ignored), as namespaces are resolved by version below. */
function kids(node: unknown, name: string): any[] {
  if (!node || typeof node !== 'object') return [];
  const out: any[] = [];
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) if (local(k) === name) out.push(...arr(v as any));
  return out;
}
function attr(node: any, name: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  for (const [k, v] of Object.entries(node)) if (k.startsWith('@_') && local(k.slice(2)).toLowerCase() === name.toLowerCase() && v !== undefined) return String(v);
  return undefined;
}
function text(node: any): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'object') return String(node['#text'] ?? '').trim();
  return String(node).trim();
}

/** Resolves a manifest reference against xml:base values; returns a package-relative path. */
function resolveHref(bases: string[], href: string): string {
  const joined = [...bases, href].filter(Boolean).join('/');
  const parts: string[] = [];
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function splitHref(href: string): { file: string; suffix: string } {
  const m = /^([^?#]*)([?#].*)?$/.exec(href);
  return { file: decodeURIComponent(m?.[1] ?? href), suffix: m?.[2] ?? '' };
}

export function inspectPackage(root: string): PackageInspection {
  const files = walk(root);
  const lower = new Map<string, string>();
  for (const f of files) lower.set(f.rel.toLowerCase(), f.rel);
  const exact = new Set(files.map((f) => f.rel));

  const byType = new Map<string, { files: number; bytes: number }>();
  for (const f of files) {
    const ext = path.extname(f.rel).toLowerCase() || '(none)';
    const cur = byType.get(ext) ?? { files: 0, bytes: 0 };
    cur.files++;
    cur.bytes += f.bytes;
    byType.set(ext, cur);
  }
  const inventory = {
    files: files.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    byType: [...byType.entries()].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.bytes - a.bytes),
    largest: [...files].sort((a, b) => b.bytes - a.bytes).slice(0, 8).map((f) => ({ path: f.rel, bytes: f.bytes })),
  };

  const result: PackageInspection = { kind: 'html5', inventory, organizations: [], resources: [], launchChoices: [], externalDependencies: [], runtimeReferences: [], issues: [], limits: LIMITS };
  result.authoringTool = detectAuthoringTool(root, files);
  result.issues.push({ ruleId: 'PKG-001', outcome: 'passed', detail: 'The archive passed the size, entry-count, path, symbolic-link, duplicate, and encryption checks.' });

  // Case-insensitive lookup of one file reference: exact, case-mismatch, or missing.
  const lookup = (rel: string): { state: 'ok' | 'case' | 'missing'; actual?: string } => {
    if (exact.has(rel)) return { state: 'ok', actual: rel };
    const hit = lower.get(rel.toLowerCase());
    return hit ? { state: 'case', actual: hit } : { state: 'missing' };
  };

  const manifestPath = lookup('imsmanifest.xml');
  const missingRefs: PackageIssue[] = [];

  if (manifestPath.state === 'missing') {
    result.issues.push({ ruleId: 'PKG-002', outcome: 'not_applicable', detail: 'There is no imsmanifest.xml at the top of the package, so this is treated as a plain HTML5 package. Pick the launch file.' });
    result.issues.push({ ruleId: 'PKG-003', outcome: 'not_applicable', detail: 'No manifest, so no SCORM version is declared.' });
    const htmls = files.filter((f) => /\.html?$/i.test(f.rel));
    const preferred = ['index.html', 'index.htm', 'story.html', 'story_html5.html', 'launch.html', 'start.html', 'default.html'];
    const sorted = [...htmls].sort((a, b) => {
      const ia = preferred.indexOf(path.posix.basename(a.rel).toLowerCase());
      const ib = preferred.indexOf(path.posix.basename(b.rel).toLowerCase());
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.rel.split('/').length - b.rel.split('/').length || a.rel.localeCompare(b.rel);
    });
    result.launchChoices = sorted.slice(0, 50).map((f) => ({ key: f.rel, title: f.rel, path: f.rel }));
    result.issues.push(
      htmls.length === 0
        ? { ruleId: 'PKG-004', outcome: 'failed', title: 'No HTML file found to launch', detail: 'The package has no .html or .htm file, so there is nothing to open.' }
        : { ruleId: 'PKG-004', outcome: 'needs_review', detail: `No manifest names a launch file. ${htmls.length} HTML file(s) were found; choose which one to scan.` },
    );
    result.issues.push({
      ruleId: 'PKG-007',
      outcome: htmls.length > 1 ? 'needs_review' : 'not_applicable',
      detail: htmls.length > 1 ? 'A plain HTML5 package has no list of lessons, so only the launch file you choose is scanned. Other pages are reached only by following links from it.' : 'Single launch file.',
    });
  } else {
    const raw = readFileSync(path.join(root, manifestPath.actual!), 'utf8');
    if (manifestPath.actual !== 'imsmanifest.xml') {
      result.issues.push({ ruleId: 'PKG-005', outcome: 'needs_review', title: 'imsmanifest.xml has the wrong letter case', detail: `The manifest is named "${manifestPath.actual}". LMSes on case-sensitive servers will not find it.`, paths: [manifestPath.actual!] });
    }
    if (/<!DOCTYPE|<!ENTITY/i.test(raw)) {
      result.issues.push({ ruleId: 'PKG-002', outcome: 'failed', title: 'Manifest contains a DTD or entity declaration', detail: 'The manifest has a DOCTYPE or ENTITY declaration. These are refused for safety and are not used by SCORM manifests, so the manifest was not read.' });
      result.kind = 'scorm_unknown';
    } else {
      const valid = XMLValidator.validate(raw, { allowBooleanAttributes: false });
      if (valid !== true) {
        result.issues.push({ ruleId: 'PKG-002', outcome: 'failed', title: 'imsmanifest.xml is not well-formed XML', detail: `${valid.err.msg} (line ${valid.err.line}).` });
        result.kind = 'scorm_unknown';
      } else {
        result.issues.push({ ruleId: 'PKG-002', outcome: 'passed', detail: 'imsmanifest.xml is well-formed XML. This does not mean it conforms to the SCORM schemas.' });
        parseManifest(raw, result, lookup, missingRefs);
      }
    }
    if (result.kind === 'scorm_unknown' && result.resources.length === 0 && !result.issues.some((i) => i.ruleId === 'PKG-004')) {
      result.issues.push({ ruleId: 'PKG-004', outcome: 'not_tested', detail: 'The manifest could not be read, so launch files could not be resolved.' });
    }
  }

  result.issues.push(...missingRefs);
  scanTextFiles(root, files, result, lookup);
  if (result.authoringTool) delete result.authoringTool.contentText;
  if (!result.issues.some((i) => i.ruleId === 'PKG-005')) result.issues.push({ ruleId: 'PKG-005', outcome: 'passed', detail: 'Every local file the manifest and launch pages refer to was found with matching letter case.' });
  const tool = result.authoringTool;
  const runtimeNote =
    tool && result.runtimeReferences?.length
      ? ` A further ${result.runtimeReferences?.length} address(es) appear only in ${tool.product}'s own player and SCORM driver code or on the vendor's domains (licence and help links, telemetry, media services); they are listed separately, still blocked during a scan, and reported then if the player actually requests them.`
      : '';
  result.issues.push(
    result.externalDependencies.length
      ? { ruleId: 'PKG-006', outcome: 'needs_review', title: `Package refers to ${result.externalDependencies.length} outside website(s)`, detail: `Found addresses on: ${result.externalDependencies.map((d) => d.host).join(', ')}. A scan blocks these unless you allow them, and says what was blocked.${runtimeNote}` }
      : { ruleId: 'PKG-006', outcome: 'passed', detail: `No outside web addresses were found in the course's own files.${runtimeNote} Addresses built in code at run time cannot be seen this way.` },
  );
  if (result.launchChoices.length === 0 && !result.issues.some((i) => i.ruleId === 'PKG-004')) {
    result.issues.push({ ruleId: 'PKG-004', outcome: 'failed', title: 'No launchable lesson found', detail: 'No resource in the manifest resolves to a file that can be opened.' });
  }
  return result;
}

function parseManifest(raw: string, result: PackageInspection, lookup: (rel: string) => { state: 'ok' | 'case' | 'missing'; actual?: string }, missingRefs: PackageIssue[]): void {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false, allowBooleanAttributes: false, trimValues: true, parseAttributeValue: false, parseTagValue: false });
  const doc = parser.parse(raw) as Record<string, any>;
  const rootKey = Object.keys(doc).find((k) => local(k) === 'manifest');
  const manifest = rootKey ? doc[rootKey] : undefined;
  if (!manifest || typeof manifest !== 'object') {
    result.issues.push({ ruleId: 'PKG-003', outcome: 'failed', title: 'Manifest has no <manifest> element', detail: 'The XML does not look like a content package manifest.' });
    result.kind = 'scorm_unknown';
    return;
  }

  // Version: read from the declared schema version and the namespaces actually used (prefixes are not trusted).
  const head = raw.slice(0, 4000);
  const metadata = kids(manifest, 'metadata')[0];
  const schemaVersion = text(kids(metadata, 'schemaversion')[0]);
  const ns12 = /adlcp_rootv1p2|imscp_rootv1p1p2/.test(head);
  const ns2004 = /adlcp_v1p3|imscp_v1p1|adlseq|imsss/.test(head);
  const declared = schemaVersion || undefined;
  result.scormVersionDeclared = declared;
  let kind: PackageKind = 'scorm_unknown';
  if (/^1\.2$/.test(schemaVersion) || (ns12 && !ns2004)) kind = 'scorm12';
  else if (/2004|CAM 1\.3/i.test(schemaVersion) || ns2004) kind = 'scorm2004';
  result.kind = kind;
  const contradiction = (kind === 'scorm12' && /2004|CAM 1\.3/i.test(schemaVersion)) || (kind === 'scorm2004' && /^1\.2$/.test(schemaVersion));
  result.issues.push(
    kind === 'scorm_unknown'
      ? { ruleId: 'PKG-003', outcome: 'needs_review', title: 'SCORM version could not be determined', detail: `The manifest declares schema version "${schemaVersion || 'none'}" and uses no recognized SCORM namespace. It may be a generic content package.` }
      : contradiction
        ? { ruleId: 'PKG-003', outcome: 'needs_review', title: 'Manifest declares conflicting SCORM versions', detail: `The schema version says "${schemaVersion}" but the namespaces point to ${kind === 'scorm12' ? 'SCORM 1.2' : 'SCORM 2004'}.` }
        : { ruleId: 'PKG-003', outcome: 'passed', detail: `Declared as ${kind === 'scorm12' ? 'SCORM 1.2' : 'SCORM 2004'}${schemaVersion ? ` (schema version "${schemaVersion}")` : ' by its namespaces'}. Declaring a version does not prove the content behaves that way at run time.` },
  );

  result.hasSequencing = /<(\w+:)?sequencing[\s>]/i.test(raw);
  const manifestBase = attr(manifest, 'base') ?? '';

  // Resources.
  const resourcesNode = kids(manifest, 'resources')[0];
  const resourcesBase = attr(resourcesNode, 'base') ?? '';
  const resources: ManifestResource[] = [];
  const ids = new Set<string>();
  for (const r of kids(resourcesNode, 'resource')) {
    const id = attr(r, 'identifier') ?? '';
    if (ids.has(id)) missingRefs.push({ ruleId: 'PKG-005', outcome: 'failed', title: `Resource id "${id}" is used twice`, detail: 'Two resources share one identifier, so items that point to it are ambiguous.' });
    ids.add(id);
    const scormTypeRaw = attr(r, 'scormtype')?.toLowerCase();
    const res: ManifestResource = {
      id,
      type: attr(r, 'type') ?? '',
      scormType: scormTypeRaw === 'sco' ? 'sco' : scormTypeRaw === 'asset' ? 'asset' : undefined,
      href: attr(r, 'href'),
      files: [],
      dependencies: [],
    };
    const rBase = attr(r, 'base') ?? '';
    const bases = [manifestBase, resourcesBase, rBase];
    if (res.href !== undefined) {
      const { file, suffix } = splitHref(res.href);
      if (/^https?:\/\//i.test(file)) {
        res.launchPath = undefined;
      } else {
        const rel = resolveHref(bases, file);
        const hit = lookup(rel);
        if (hit.state === 'missing') missingRefs.push({ ruleId: 'PKG-004', outcome: 'failed', title: `Launch file for "${id}" is missing`, detail: `Resource "${id}" launches "${rel}", which is not in the package.`, paths: [rel] });
        else {
          res.launchPath = hit.actual;
          res.launchSuffix = suffix || undefined;
          if (hit.state === 'case') missingRefs.push({ ruleId: 'PKG-005', outcome: 'needs_review', title: `Launch file letter case differs: ${rel}`, detail: `The manifest says "${rel}" but the file is "${hit.actual}". It works on Windows but fails on case-sensitive servers.`, paths: [rel, hit.actual!] });
        }
      }
    }
    for (const f of kids(r, 'file')) {
      const href = attr(f, 'href');
      if (!href) continue;
      const { file } = splitHref(href);
      if (/^https?:\/\//i.test(file)) continue;
      const rel = resolveHref(bases, file);
      res.files.push(rel);
      const hit = lookup(rel);
      if (hit.state === 'missing') missingRefs.push({ ruleId: 'PKG-005', outcome: 'failed', title: `Listed file is missing: ${rel}`, detail: `Resource "${id}" lists "${rel}", which is not in the package.`, paths: [rel] });
      else if (hit.state === 'case') missingRefs.push({ ruleId: 'PKG-005', outcome: 'needs_review', title: `Listed file letter case differs: ${rel}`, detail: `The manifest says "${rel}" but the file is "${hit.actual}".`, paths: [rel, hit.actual!] });
    }
    for (const d of kids(r, 'dependency')) {
      const ref = attr(d, 'identifierref');
      if (ref) res.dependencies.push(ref);
    }
    resources.push(res);
  }
  result.resources = resources;
  const known = new Set(resources.map((r) => r.id));
  for (const r of resources) for (const dep of r.dependencies) if (!known.has(dep)) missingRefs.push({ ruleId: 'PKG-005', outcome: 'failed', title: `Resource "${r.id}" depends on a missing resource`, detail: `It depends on "${dep}", which the manifest does not define.` });

  // Organizations and items.
  const orgsNode = kids(manifest, 'organizations')[0];
  const defaultOrg = attr(orgsNode, 'default');
  result.defaultOrganization = defaultOrg;
  const parseItems = (node: any): ManifestItem[] =>
    kids(node, 'item').map((it) => {
      const ref = attr(it, 'identifierref');
      if (ref && !known.has(ref)) missingRefs.push({ ruleId: 'PKG-005', outcome: 'failed', title: `Item "${text(kids(it, 'title')[0]) || attr(it, 'identifier')}" points to a missing resource`, detail: `identifierref "${ref}" is not defined in the manifest's resources.` });
      return { id: attr(it, 'identifier') ?? '', title: text(kids(it, 'title')[0]) || attr(it, 'identifier') || '(untitled)', resourceId: ref, children: parseItems(it), dataFromLms: text(kids(it, 'datafromlms')[0] ?? kids(it, 'dataFromLMS')[0]) || undefined, masteryScore: text(kids(it, 'masteryscore')[0]) || undefined };
    });
  for (const o of kids(orgsNode, 'organization')) {
    const id = attr(o, 'identifier') ?? '';
    result.organizations.push({ id, title: text(kids(o, 'title')[0]) || id, isDefault: id === defaultOrg, items: parseItems(o) });
  }
  result.title = result.organizations.find((o) => o.isDefault)?.title ?? result.organizations[0]?.title;

  // Launchable choices: every item (in every organization) that points at a resource with a launch file.
  const byId = new Map(resources.map((r) => [r.id, r]));
  const choices: LaunchChoice[] = [];
  const seenKeys = new Set<string>();
  const collect = (items: ManifestItem[], org: ManifestOrganization) => {
    for (const it of items) {
      const res = it.resourceId ? byId.get(it.resourceId) : undefined;
      if (res?.launchPath) {
        const key = res.id;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          choices.push({ key, title: result.organizations.length > 1 ? `${it.title} (${org.title})` : it.title, path: res.launchPath, suffix: res.launchSuffix, dataFromLms: it.dataFromLms, masteryScore: it.masteryScore });
        }
      }
      collect(it.children, org);
    }
  };
  for (const o of result.organizations) collect(o.items, o);
  // Resources not reachable from any item are listed too, so nothing launchable is hidden.
  for (const r of resources) if (r.launchPath && !seenKeys.has(r.id) && r.scormType !== 'asset') choices.push({ key: r.id, title: `${r.id} (not in any organization)`, path: r.launchPath, suffix: r.launchSuffix });
  result.launchChoices = choices;

  const orgNote = result.organizations.length > 1 ? `${result.organizations.length} organizations (default: ${defaultOrg ?? 'not set'}).` : '';
  if (choices.length === 0) {
    if (!missingRefs.some((m) => m.ruleId === 'PKG-004')) missingRefs.push({ ruleId: 'PKG-004', outcome: 'failed', title: 'No launchable lesson found', detail: 'No item in the manifest points to a resource with a launch file that exists.' });
  } else {
    if (!missingRefs.some((m) => m.ruleId === 'PKG-004')) result.issues.push({ ruleId: 'PKG-004', outcome: 'passed', detail: `${choices.length} launchable lesson(s) resolve to files in the package.` });
  }
  result.issues.push(
    choices.length > 1 || result.organizations.length > 1
      ? { ruleId: 'PKG-007', outcome: 'needs_review', title: `${choices.length} launch points${orgNote ? ` in ${result.organizations.length} organizations` : ''}`, detail: `${orgNote} Only the lessons you choose are scanned, and the report says which ones were not. Sequencing rules in the manifest are not evaluated.`.trim() }
      : { ruleId: 'PKG-007', outcome: 'not_applicable', detail: 'One launch point; it is scanned.' },
  );
}

/** Finds outside addresses and local references that point nowhere, in the package's own text files. */
function scanTextFiles(root: string, files: Array<{ rel: string; bytes: number }>, result: PackageInspection, lookup: (rel: string) => { state: 'ok' | 'case' | 'missing'; actual?: string }): void {
  const ext = new Map<string, { urls: Set<string>; from: Set<string> }>();
  const tool = result.authoringTool;
  const inRuntime = (rel: string) => !!tool?.runtimePaths.some((p) => (p.endsWith('/') ? rel.startsWith(p) : rel === p));
  const vendor = (host: string) => !!tool?.vendorHosts.some((v) => host === v || host.endsWith(`.${v}`));
  const addUrls = (body: string, from: string) => {
    for (const m of body.matchAll(/https?:\/\/([A-Za-z0-9.-]+)(?::\d+)?[^\s"'<>)\\]*/g)) {
      const host = m[1]!.toLowerCase();
      if (host === 'www.w3.org' || host === 'www.adlnet.org' || host === 'www.imsglobal.org' || host === 'www.imsproject.org' || host === 'purl.org' || host === 'ltsc.ieee.org') continue; // namespace and schema identifiers, not fetched
      if (/^(localhost|127\.|0\.0\.0\.0)/.test(host) || !host.includes('.')) continue;
      // Fragments of addresses assembled in code ("https://360.${domain}") and reserved example names are not destinations.
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host) || /^example\.(com|org|net)$|\.(invalid|test|example|localhost)$/.test(host)) continue;
      const cur = ext.get(host) ?? { urls: new Set<string>(), from: new Set<string>() };
      if (cur.urls.size < 5) cur.urls.add(m[0].slice(0, 160));
      cur.from.add(from);
      ext.set(host, cur);
    }
  };
  const missing = new Map<string, string[]>();
  const caseMismatch = new Map<string, { actual: string; from: string[] }>();
  let looked = 0;
  for (const f of files) {
    const e = path.extname(f.rel).toLowerCase();
    if (!TEXT_EXT.has(e) || f.bytes > MAX_TEXT_BYTES) continue;
    if (++looked > MAX_TEXT_FILES) break;
    let body: string;
    try {
      body = readFileSync(path.join(root, f.rel), 'utf8');
    } catch {
      continue;
    }
    addUrls(body, f.rel);
    // Local references: only plain src/href attributes in HTML (scripts and CSS build paths in ways that cannot be followed statically).
    if (e === '.html' || e === '.htm') {
      const dir = path.posix.dirname(f.rel);
      for (const m of body.matchAll(/\b(?:src|href)\s*=\s*["']([^"'#?]+)(?:[?#][^"']*)?["']/gi)) {
        const ref = m[1]!.trim();
        if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#|data:|javascript:|mailto:)/i.test(ref)) continue;
        let rel: string;
        try {
          rel = resolveHref([dir === '.' ? '' : dir], decodeURIComponent(ref));
        } catch {
          continue;
        }
        if (!rel || rel.startsWith('..')) continue;
        const hit = lookup(rel);
        if (hit.state === 'missing') missing.set(rel, [...(missing.get(rel) ?? []), f.rel]);
        else if (hit.state === 'case') caseMismatch.set(rel, { actual: hit.actual!, from: [...(caseMismatch.get(rel)?.from ?? []), f.rel] });
      }
    }
  }
  // Rise keeps lesson text, and so the author's links, base64-encoded in one data file; the adapter decoded it.
  if (tool?.contentText) addUrls(tool.contentText.text, tool.contentText.from);
  const all = [...ext.entries()].map(([host, v]) => ({ host, urls: [...v.urls], referencedFrom: [...v.from].slice(0, 5), runtime: vendor(host) || [...v.from].every(inRuntime) })).sort((a, b) => a.host.localeCompare(b.host));
  result.externalDependencies = all.filter((d) => !d.runtime).map(({ runtime: _, ...d }) => d);
  result.runtimeReferences = all.filter((d) => d.runtime).map(({ runtime: _, ...d }) => d);
  for (const [rel, from] of [...missing.entries()].slice(0, 100)) result.issues.push({ ruleId: 'PKG-005', outcome: 'failed', title: `Page refers to a missing file: ${rel}`, detail: `"${rel}" is referenced from ${[...new Set(from)].slice(0, 3).join(', ')} but is not in the package.`, paths: [rel] });
  for (const [rel, v] of [...caseMismatch.entries()].slice(0, 100)) result.issues.push({ ruleId: 'PKG-005', outcome: 'needs_review', title: `Letter case differs: ${rel}`, detail: `"${rel}" is referenced from ${[...new Set(v.from)].slice(0, 3).join(', ')} but the file is "${v.actual}". This fails on case-sensitive servers.`, paths: [rel, v.actual] });
  if (looked > MAX_TEXT_FILES) result.issues.push({ ruleId: 'PKG-005', outcome: 'needs_review', title: 'Not every page was checked for missing files', detail: `Only the first ${MAX_TEXT_FILES} text files were read; the rest were not.` });
}

export function packageFileExists(root: string, rel: string): boolean {
  return existsSync(path.join(root, ...rel.split('/')));
}
