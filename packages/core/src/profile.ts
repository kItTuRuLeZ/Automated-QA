import { z } from 'zod';
import type { ClientProfile, ProfileId, ProfileSnapshot } from '@cqa/shared';
import { SEVERITIES } from '@cqa/shared';
import { nowIso } from './fingerprint.js';
import { getRule } from './rules.js';

const hex = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour like #1a2b3c');
const short = (max: number) => z.string().trim().min(1).max(max);

/**
 * What a person can set on a client profile. Brand values are never invented:
 * if any are supplied, a note saying where they came from is required.
 */
export const ProfileInput = z
  .object({
    name: short(80),
    brand: z
      .object({
        approvedFonts: z.array(short(80)).max(30).default([]),
        approvedColors: z.array(z.object({ name: short(60), value: hex })).max(60).default([]),
        colorTolerance: z.number().min(0.5).max(30).optional(),
        minTextSizePx: z.number().min(6).max(48).optional(),
        source: z.string().trim().max(300).default(''),
      })
      .default({ approvedFonts: [], approvedColors: [], source: '' }),
    terminology: z.array(z.object({ term: short(100), preferred: z.string().trim().max(100).optional() })).max(200).default([]),
    textExclusions: z.array(short(200)).max(200).default([]),
    linkPolicy: z.object({ checkExternalLinks: z.boolean().default(true), excludedUrlPatterns: z.array(short(200)).max(100).default([]) }).default({ checkExternalLinks: true, excludedUrlPatterns: [] }),
    viewports: z.array(z.enum(['desktop', 'laptop', 'tablet', 'mobile'])).max(4).default([]),
    thresholds: z.object({ loadMs: z.number().int().min(500).max(120000).optional(), totalBytes: z.number().int().min(10000).optional(), requestCount: z.number().int().min(1).max(5000).optional() }).default({}),
    scopeRules: z.object({ allowedOrigins: z.array(short(200)).max(20).default([]), allowedPathPrefixes: z.array(short(512).startsWith('/', 'Path prefixes must start with /')).max(20).default([]) }).default({ allowedOrigins: [], allowedPathPrefixes: [] }),
    ruleExclusions: z.array(z.object({ ruleId: short(20), reason: short(300) })).max(100).default([]),
    severityOverrides: z.array(z.object({ ruleId: short(20), severity: z.enum(SEVERITIES), reason: short(300) })).max(100).default([]),
  })
  .superRefine((v, ctx) => {
    const hasBrand = v.brand.approvedFonts.length > 0 || v.brand.approvedColors.length > 0 || v.brand.minTextSizePx !== undefined;
    if (hasBrand && !v.brand.source) ctx.addIssue({ code: 'custom', path: ['brand', 'source'], message: 'Say where the brand values came from (for example the brand guide and its version). The scanner never invents brand rules.' });
    for (const [i, x] of v.ruleExclusions.entries()) {
      try {
        getRule(x.ruleId);
      } catch {
        ctx.addIssue({ code: 'custom', path: ['ruleExclusions', i, 'ruleId'], message: `Unknown rule ${x.ruleId}` });
      }
    }
    for (const [i, x] of v.severityOverrides.entries()) {
      try {
        getRule(x.ruleId);
      } catch {
        ctx.addIssue({ code: 'custom', path: ['severityOverrides', i, 'ruleId'], message: `Unknown rule ${x.ruleId}` });
      }
    }
  });
export type ProfileInput = z.infer<typeof ProfileInput>;

export function toClientProfile(id: ProfileId, input: ProfileInput, prev?: ClientProfile): ClientProfile {
  const now = nowIso();
  const hasBrand = input.brand.approvedFonts.length > 0 || input.brand.approvedColors.length > 0 || input.brand.minTextSizePx !== undefined;
  return {
    id,
    name: input.name,
    isDefault: false,
    brand: {
      approvedFonts: input.brand.approvedFonts,
      approvedColors: input.brand.approvedColors.map((c) => ({ name: c.name, value: c.value.toLowerCase() })),
      colorTolerance: input.brand.colorTolerance,
      minTextSizePx: input.brand.minTextSizePx,
      provenance: hasBrand ? { source: 'user_supplied', note: input.brand.source, updatedAt: now } : undefined,
    },
    terminology: input.terminology,
    placeholderPatterns: [],
    textExclusions: input.textExclusions,
    linkPolicy: input.linkPolicy,
    viewports: [],
    thresholds: {},
    scopeRules: input.scopeRules,
    ruleExclusions: input.ruleExclusions,
    severityOverrides: input.severityOverrides,
    createdAt: prev?.createdAt ?? now,
    presets: { viewports: input.viewports, thresholds: input.thresholds },
    updatedAt: now,
  };
}

/** Scan settings a profile contributes. Anything the person types on the scan form wins over these. */
export function profileScanOptions(profile: ClientProfile): {
  viewportNames: string[];
  perf: { loadMs?: number; totalBytes?: number; requestCount?: number; provenance?: string };
  terminology: ClientProfile['terminology'];
  textExclusions: string[];
  scope: { allowedOrigins: string[]; allowedPathPrefixes: string[] };
  snapshot: ProfileSnapshot;
} {
  const presets = profile.presets;
  const t = presets?.thresholds ?? {};
  const set = Boolean(t.loadMs || t.totalBytes || t.requestCount);
  return {
    viewportNames: presets?.viewports ?? [],
    perf: { ...t, ...(set ? { provenance: `Client profile "${profile.name}" (set by a person)` } : {}) },
    terminology: profile.terminology,
    textExclusions: profile.textExclusions,
    scope: profile.scopeRules,
    snapshot: { id: profile.id, name: profile.name, brand: profile.brand, linkPolicy: profile.linkPolicy, ruleExclusions: profile.ruleExclusions, severityOverrides: profile.severityOverrides, updatedAt: profile.updatedAt },
  };
}
