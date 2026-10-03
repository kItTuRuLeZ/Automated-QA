import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineSelection, ProjectId, ScanBudgets, ScanConfig, ScanScope, Viewport } from '@cqa/shared';
import { DEFAULT_REDACTION } from './redaction.js';

export interface DataPaths {
  root: string;
  dbFile: string;
  artifacts: string;
  tmp: string;
}

/** Repository root, derived from this file so every process (server, worker) shares one data directory. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Resolves and creates the data directory layout. `CQA_DATA_DIR` overrides the default `<repo>/data`. */
export function resolveDataPaths(root = process.env.CQA_DATA_DIR ?? path.join(REPO_ROOT, 'data')): DataPaths {
  const abs = path.resolve(root);
  const paths = { root: abs, dbFile: path.join(abs, 'qa.sqlite'), artifacts: path.join(abs, 'artifacts'), tmp: path.join(abs, 'tmp') };
  for (const dir of [paths.root, paths.artifacts, paths.tmp]) mkdirSync(dir, { recursive: true });
  return paths;
}

export const SERVER_HOST = '127.0.0.1';
export const SERVER_PORT = Number(process.env.CQA_PORT ?? 4317);
export const WEB_DEV_PORT = 5317;

export const DEFAULT_VIEWPORT: Viewport = { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false };

export const VIEWPORT_PRESETS: readonly Viewport[] = [
  DEFAULT_VIEWPORT,
  { name: 'laptop', width: 1366, height: 768, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  { name: 'tablet', width: 768, height: 1024, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
  { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
];

export const DEFAULT_BUDGETS: ScanBudgets = {
  maxPages: 1,
  maxStates: 1,
  maxDepth: 0,
  maxRuntimeMs: 120_000,
  navigationTimeoutMs: 30_000,
  actionTimeoutMs: 10_000,
  maxRedirects: 10,
  maxResponseBytes: 50 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxDownloads: 0,
  concurrency: 1,
};

/** Phase 1 runs capture only; other engines report `not_tested` once they exist. */
export const PHASE1_ENGINES: EngineSelection = {
  capture: true,
  traversal: false,
  links: false,
  media: false,
  content: false,
  accessibility: false,
  keyboard: false,
  layout: false,
  performance: false,
  visualBaseline: false,
  advisory: false,
};

export function defaultScopeFor(url: URL): ScanScope {
  const port = url.port ? [Number(url.port)] : [];
  return { allowedOrigins: [url.origin], allowedPathPrefixes: [], subrequestPolicy: 'public_allowed', allowedPorts: port };
}

export function buildScanConfig(input: {
  projectId: ProjectId;
  url: URL;
  scope?: Partial<ScanScope>;
  navigationTimeoutMs?: number;
  viewport?: Viewport;
}): ScanConfig {
  const scope = { ...defaultScopeFor(input.url), ...input.scope };
  return {
    projectId: input.projectId,
    target: { kind: 'url', url: input.url.toString() },
    scope,
    budgets: { ...DEFAULT_BUDGETS, navigationTimeoutMs: input.navigationTimeoutMs ?? DEFAULT_BUDGETS.navigationTimeoutMs },
    viewports: [input.viewport ?? DEFAULT_VIEWPORT],
    engines: PHASE1_ENGINES,
    actionPolicy: { allowedKinds: ['navigate'], deniedNamePatterns: [], allowFormSubmission: false, followExternalLinks: false },
    redaction: DEFAULT_REDACTION,
    configVersion: 1,
  };
}
