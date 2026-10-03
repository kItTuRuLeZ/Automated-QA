import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineSelection, ProjectId, ScanBudgets, ScanConfig, ScanScope, TerminologyRule, Viewport } from '@cqa/shared';
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
  maxLinkChecks: 200,
  linkCheckTimeoutMs: 10_000,
  linkCheckBudgetMs: 120_000,
};

/** Engines available so far: initial capture, bounded traversal, links, media, and text checks. */
export const DEFAULT_ENGINES: EngineSelection = {
  capture: true,
  traversal: true,
  links: true,
  media: true,
  content: true,
  accessibility: true,
  keyboard: true,
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

/**
 * Placeholder and production-note patterns: regular expressions, case-insensitive
 * unless prefixed with `cs:` (used for all-caps markers like TBD so "a todo item" is not flagged).
 * Matches are TXT-001 findings unless excluded.
 */
export const DEFAULT_PLACEHOLDER_PATTERNS = [
  String.raw`lorem ipsum`,
  String.raw`\bdolor sit amet\b`,
  String.raw`cs:\bTBD\b`,
  String.raw`cs:\bTBC\b`,
  String.raw`cs:\bTODO\b`,
  String.raw`cs:\bFIXME\b`,
  String.raw`cs:\bXXX+\b`,
  String.raw`\[\s*(insert|add|placeholder|image|graphic|audio|video|text|copy|link)\b[^\]]{0,80}\]`,
  String.raw`\bnote\s+to\s+(the\s+)?(gd|graphic\s+designer|designer|dev|developer|programmer|reviewer|sme|id|instructional\s+designer|editor|author)\b`,
  String.raw`\b(placeholder|dummy)\s+(text|copy|image|content)\b`,
  String.raw`\{\{[^}]{1,60}\}\}`,
];

/**
 * Size warning thresholds for MED-005. These are application defaults, not a
 * standard; set them per project when a client has its own limits.
 */
export const DEFAULT_MEDIA_THRESHOLDS = {
  maxImageBytes: 1_000_000,
  maxMediaBytes: 50_000_000,
  provenance: 'Application default (1 MB per image, 50 MB per audio/video file); not a published standard.',
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
  explore?: boolean;
  accessibility?: boolean;
  maxStates?: number;
  maxDepth?: number;
  terminology?: TerminologyRule[];
  textExclusions?: string[];
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
    engines: { ...DEFAULT_ENGINES, traversal: input.explore ?? true, accessibility: input.accessibility ?? true, keyboard: input.accessibility ?? true },
    actionPolicy: {
      allowedKinds: ['navigate', 'select_tab', 'expand', 'open_dialog', 'close_dialog', 'next', 'back'],
      deniedNamePatterns: DEFAULT_DENIED_NAME_PATTERNS,
      allowFormSubmission: false,
      followExternalLinks: false,
    },
    redaction: DEFAULT_REDACTION,
    textRules: { placeholderPatterns: DEFAULT_PLACEHOLDER_PATTERNS, terminology: input.terminology ?? [], exclusions: input.textExclusions ?? [] },
    mediaThresholds: DEFAULT_MEDIA_THRESHOLDS,
    configVersion: 1,
  };
}
