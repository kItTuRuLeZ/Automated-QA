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
  maxPages: 10,
  maxStates: 25,
  maxDepth: 4,
  maxRuntimeMs: 300_000,
  navigationTimeoutMs: 30_000,
  actionTimeoutMs: 10_000,
  maxRedirects: 10,
  maxResponseBytes: 50 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxDownloads: 0,
  concurrency: 1,
};

/** Engines available so far: initial capture and bounded traversal. */
export const DEFAULT_ENGINES: EngineSelection = {
  capture: true,
  traversal: true,
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

/** Accessible-name fragments that mark a control as unsafe to click during read-only exploration. */
export const DEFAULT_DENIED_NAME_PATTERNS = [
  'submit',
  'delete',
  'remove',
  'send',
  'purchase',
  'buy',
  'pay',
  'checkout',
  'order',
  'sign out',
  'log out',
  'logout',
  'sign off',
  'reset',
  'restart',
  'unsubscribe',
  'publish',
  'confirm',
  'save',
  'upload',
  'download',
  'print',
  'exit',
  'quit',
  'retake',
  'retry',
  'check answer',
];

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
  explore?: boolean;
  maxStates?: number;
  maxDepth?: number;
}): ScanConfig {
  const scope = { ...defaultScopeFor(input.url), ...input.scope };
  return {
    projectId: input.projectId,
    target: { kind: 'url', url: input.url.toString() },
    scope,
    budgets: {
      ...DEFAULT_BUDGETS,
      navigationTimeoutMs: input.navigationTimeoutMs ?? DEFAULT_BUDGETS.navigationTimeoutMs,
      maxStates: input.maxStates ?? DEFAULT_BUDGETS.maxStates,
      maxDepth: input.maxDepth ?? DEFAULT_BUDGETS.maxDepth,
    },
    viewports: [input.viewport ?? DEFAULT_VIEWPORT],
    engines: { ...DEFAULT_ENGINES, traversal: input.explore ?? true },
    actionPolicy: {
      allowedKinds: ['navigate', 'select_tab', 'expand', 'open_dialog', 'close_dialog', 'next', 'back'],
      deniedNamePatterns: DEFAULT_DENIED_NAME_PATTERNS,
      allowFormSubmission: false,
      followExternalLinks: false,
    },
    redaction: DEFAULT_REDACTION,
    configVersion: 1,
  };
}
