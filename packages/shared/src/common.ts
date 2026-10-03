import type { BrowserEngine } from './enums.js';

/** Opaque, server-generated identifiers. Never derived from user input. */
export type Id<Brand extends string> = string & { readonly __brand: Brand };

export type ProjectId = Id<'Project'>;
export type ScanRunId = Id<'ScanRun'>;
export type StateId = Id<'CourseState'>;
export type ActionId = Id<'TraversalAction'>;
export type CheckResultId = Id<'CheckResult'>;
export type FindingId = Id<'Finding'>;
export type EvidenceId = Id<'Evidence'>;
export type ArtifactId = Id<'Artifact'>;
export type ProfileId = Id<'ClientProfile'>;

/** Stable catalog rule ID, e.g. `RUN-002`, `A11Y-AXE-image-alt`. */
export type RuleId = string;

/** ISO-8601 UTC timestamp. */
export type IsoTimestamp = string;

/** URL after the redaction policy has been applied. Only these are persisted. */
export type SanitizedUrl = string & { readonly __sanitized: true };

/** CSS-pixel viewport simulation (not real-device certification). */
export interface Viewport {
  name: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
}

export interface BrowserInfo {
  engine: BrowserEngine;
  /** Actual version reported by the launched browser. */
  version: string;
  userAgent: string;
  headless: boolean;
}

/** Version of a tool or engine used in a run (Playwright, axe-core, app). */
export interface ToolVersion {
  name: string;
  version: string;
}

/** Axis-aligned bounds in CSS pixels relative to the viewport. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
