import type { IsoTimestamp, ProfileId, RuleId, Viewport } from './common.js';
import type { Severity } from './enums.js';

/** Where a configured value came from. Brand values must be user-supplied, never invented. */
export interface Provenance {
  source: 'user_supplied' | 'application_default';
  note?: string;
  updatedAt: IsoTimestamp;
}

export interface ApprovedColor {
  name: string;
  /** Hex `#rrggbb`. */
  value: string;
}

export interface TerminologyRule {
  /** Term to flag (case-insensitive whole word unless `pattern` is true). */
  term: string;
  preferred?: string;
  pattern?: boolean;
  note?: string;
}

export interface ThresholdSetting {
  value: number;
  unit: 'ms' | 'bytes' | 'px' | 'ratio' | 'count';
  provenance: Provenance;
}

/**
 * Per-client settings applied without forking the application. Empty brand
 * lists mean "no brand rules", not "everything passes".
 */
export interface ClientProfile {
  id: ProfileId;
  name: string;
  /** Neutral default profile ships with the app and has no brand rules. */
  isDefault: boolean;
  brand: {
    approvedFonts: string[];
    approvedColors: ApprovedColor[];
    /** Maximum CIEDE2000 distance treated as a match. */
    colorTolerance?: number;
    minTextSizePx?: number;
    provenance?: Provenance;
  };
  terminology: TerminologyRule[];
  placeholderPatterns: string[];
  /** Text that must not be flagged as placeholder or terminology issues. */
  textExclusions: string[];
  linkPolicy: {
    checkExternalLinks: boolean;
    excludedUrlPatterns: string[];
  };
  viewports: Viewport[];
  thresholds: Record<string, ThresholdSetting>;
  scopeRules: {
    allowedOrigins: string[];
    allowedPathPrefixes: string[];
  };
  /** Rules disabled for this profile, with reasons. */
  ruleExclusions: Array<{ ruleId: RuleId; reason: string }>;
  severityOverrides: Array<{ ruleId: RuleId; severity: Severity; reason: string }>;
  /** Screen-size presets and performance thresholds a person chose for this client. */
  presets?: {
    viewports: string[];
    thresholds: { loadMs?: number; totalBytes?: number; requestCount?: number };
  };
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/** The parts of a profile that travel with a scan. */
export interface ProfileSnapshot {
  id: ProfileId;
  name: string;
  brand: ClientProfile['brand'];
  linkPolicy: ClientProfile['linkPolicy'];
  ruleExclusions: ClientProfile['ruleExclusions'];
  severityOverrides: ClientProfile['severityOverrides'];
  updatedAt: IsoTimestamp;
}
