import { createHash } from 'node:crypto';
import type { ContentUnit, CourseState, UnitKind } from '@cqa/shared';
import type { ManifestItem, PackageInspection } from '../package/inspect.js';

/**
 * Builds the course inventory from the strongest evidence available: the package manifest, the authoring tool's own
 * export data, the player menu, and finally what a browser actually shows. Each unit says where it came from and how
 * sure we are. Titles are never invented: a missing title becomes a readable fallback flagged as one.
 */

export type NewUnit = Omit<ContentUnit, 'runId' | 'revision' | 'discoveredAt' | 'visitedStateIds'> & { visitedAt?: string };

/** Same course content gets the same ID in every run, so a later run can tell what changed. */
export function unitId(kind: UnitKind, key: string): string {
  return `u-${createHash('sha1').update(`${kind}|${key}`).digest('hex').slice(0, 12)}`;
}

/** Units a visit can be recorded against: lessons, slides and screens, plus package items that contain nothing else. */
export function isPrimaryUnit(u: Pick<ContentUnit, 'id' | 'kind'>, all: ReadonlyArray<Pick<ContentUnit, 'id' | 'kind' | 'parentId'>>): boolean {
  if (u.kind === 'lesson' || u.kind === 'slide' || u.kind === 'screen') return true;
  if (u.kind === 'sco') return !all.some((x) => x.parentId === u.id);
  return false;
}

const flattenItems = (items: ManifestItem[], parent?: string): Array<{ item: ManifestItem; parent?: string }> => items.flatMap((i) => [{ item: i, parent }, ...flattenItems(i.children, i.id)]);

/** Units from a package, without running anything. `launchKey` is the manifest resource the scan opens. */
export function unitsFromPackage(inspection: PackageInspection, launchKey?: string): { units: NewUnit[]; launchUnitId?: string } {
  const out: NewUnit[] = [];
  let order = 0;
  const org = inspection.organizations.find((o) => o.isDefault) ?? inspection.organizations[0];
  let launchUnit: string | undefined;
  if (org) {
    for (const { item, parent } of flattenItems(org.items)) {
      // Only items that open something are listed as content; folders are listed too so the structure is kept.
      const launches = Boolean(item.resourceId);
      const id = unitId('sco', item.id);
      if (launches && (!launchKey || item.resourceId === launchKey)) launchUnit ??= id;
      out.push({
        id,
        kind: 'sco',
        title: item.title || `Item ${order + 1}`,
        titleIsFallback: !item.title,
        sourceId: item.id,
        parentId: parent ? unitId('sco', parent) : undefined,
        source: 'manifest',
        confidence: 'high',
        order: order++,
      });
    }
  }
  const tool = inspection.authoringTool;
  if (tool?.outline?.length) {
    const root = launchUnit;
    const sourceKind: 'authoring_export' = 'authoring_export';
    for (const e of tool.outline) {
      const kind: UnitKind = e.kind === 'lesson' ? 'lesson' : e.kind === 'block' ? 'block' : e.kind === 'scene' ? 'scene' : e.kind === 'slide' ? 'slide' : 'layer';
      out.push({
        id: unitId(kind, e.id),
        kind,
        title: e.title,
        titleIsFallback: e.titleIsFallback,
        sourceId: e.id,
        parentId: e.parentId ? unitId(parentKind(e.kind), e.parentId) : root,
        source: sourceKind,
        confidence: 'high',
        order: order++,
      });
    }
  }
  return { units: out, launchUnitId: launchUnit };
}

const parentKind = (k: 'lesson' | 'block' | 'scene' | 'slide' | 'layer'): UnitKind => (k === 'block' ? 'lesson' : k === 'slide' ? 'scene' : k === 'layer' ? 'slide' : 'lesson');

const pathAndHash = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.hash}`;
  } catch {
    return url;
  }
};

/**
 * The unit a reached state belongs to. A state with a lesson or slide identifier maps to the inventory unit with that
 * source ID when there is one. Otherwise a runtime unit is created, so a screen the course list did not show is
 * visible as an extra rather than silently merged.
 */
export function unitForState(state: Pick<CourseState, 'lessonId' | 'lessonTitle' | 'title' | 'url'>, known: ReadonlyArray<Pick<ContentUnit, 'id' | 'kind' | 'sourceId' | 'title'>>): { existingId?: string; unit?: NewUnit } {
  if (state.lessonId) {
    const hit = known.find((u) => u.sourceId === state.lessonId && (u.kind === 'lesson' || u.kind === 'slide'));
    if (hit) return { existingId: hit.id };
  }
  const key = state.lessonId ? `lesson:${state.lessonId}` : `page:${pathAndHash(state.url)}`;
  const id = unitId('screen', key);
  const existing = known.find((u) => u.id === id);
  if (existing) return { existingId: existing.id };
  const title = state.lessonTitle?.trim() || state.title?.trim();
  const where = pathAndHash(state.url) || '/';
  // Two screens that report the same page title stay distinguishable by where they are.
  const clash = title ? known.some((u) => u.title === title) : false;
  return {
    unit: {
      id,
      kind: 'screen',
      title: title ? (clash ? `${title} (${state.lessonId ? `lesson ${state.lessonId}` : where})` : title) : `Screen at ${where}`,
      titleIsFallback: !title,
      sourceId: state.lessonId,
      source: 'runtime',
      confidence: 'high',
      order: 10_000 + known.length,
    },
  };
}
