import type { Page } from 'playwright';
import type { CourseState, EvidenceId, FindingLocation, ProfileSnapshot, ProviderContext } from '@cqa/shared';
import { nearestApproved, nowIso, parseCssColor } from '@cqa/core';
import { type BrandGroup, collectBrandStyles } from '../adapters/brand-scripts.js';
import { type NewCheck, type NewFinding, check, finding, truncate } from './helpers.js';

const DEFAULT_TOLERANCE = 10;
const ICON_FONT = /icon|awesome|symbol|material|glyph|dingbat|wingding/i;

/**
 * Brand checks (BRD-001..003). They compare what the page draws with values a
 * person put in the client profile. The scanner has no brand rules of its own,
 * and results are heuristic warnings for a person to review.
 */
export class BrandChecks {
  constructor(private readonly profile: ProfileSnapshot) {}

  async checkState(ctx: ProviderContext, state: CourseState, repro: string[]): Promise<{ checks: NewCheck[]; findings: NewFinding[] }> {
    const page = ctx.page as Page;
    const brand = this.profile.brand;
    const base = { stateId: state.id, viewportName: ctx.viewport.name };
    const checks: NewCheck[] = [];
    const findings: NewFinding[] = [];
    const t0 = Date.now();
    let data: { groups: BrandGroup[]; elements: number };
    try {
      data = await page.evaluate(collectBrandStyles);
    } catch (err) {
      for (const id of ['BRD-001', 'BRD-002', 'BRD-003']) checks.push(check(id, 'error', Date.now() - t0, [], { ...base, reason: 'engine_error', reasonDetail: truncate((err as Error).message, 200) }));
      return { checks, findings };
    }
    const ms = Date.now() - t0;
    const source = brand.provenance?.note ? ` (values from: ${brand.provenance.note})` : '';
    const where = (g: BrandGroup, extra: Partial<FindingLocation> = {}): FindingLocation => ({
      stateId: state.id,
      url: state.url,
      viewportName: ctx.viewport.name,
      browser: 'chromium',
      selector: g.samples[0]?.selector,
      elementDescription: g.samples[0] ? `"${g.samples[0].text}"` : undefined,
      ...extra,
    });
    const evidence = async (caption: string, payload: Record<string, unknown>): Promise<EvidenceId> =>
      (await ctx.evidence.addEvidence({ kind: 'dom_snippet', caption, data: payload, stateId: state.id, viewportName: ctx.viewport.name, capturedAt: nowIso(), redacted: false })).id;
    const occ = (g: BrandGroup, ev: EvidenceId, what: string) =>
      g.samples.map((s) => ({ location: where(g, { selector: s.selector, bounds: s.bounds, elementDescription: `"${s.text}"` }), checkResultIds: [], evidenceIds: [ev], observed: `${what}: "${s.text}"` }));
    const steps = (extra: string) => [...repro, extra];

    // ---- BRD-001 fonts ----
    if (brand.approvedFonts.length) {
      const approved = new Set(brand.approvedFonts.map((f) => f.toLowerCase()));
      const bad = new Map<string, BrandGroup[]>();
      for (const g of data.groups) if (g.font && !ICON_FONT.test(g.font) && !approved.has(g.font.toLowerCase())) bad.set(g.font, [...(bad.get(g.font) ?? []), g]);
      checks.push(check('BRD-001', bad.size ? 'needs_review' : data.elements ? 'passed' : 'not_applicable', ms, [], { ...base, itemsEvaluated: data.elements }));
      for (const [font, gs] of bad) {
        const merged = mergeGroups(gs);
        const ev = await evidence(`Font ${font}`, { font, approved: brand.approvedFonts, count: merged.count, samples: merged.samples });
        findings.push(
          finding('BRD-001', where(merged), {
            title: `Text uses "${truncate(font, 40)}", which is not an approved font`,
            observed: `${merged.count} piece(s) of text on this screen are set in "${font}". The client profile approves: ${brand.approvedFonts.join(', ')}${source}.`,
            expected: 'Text uses one of the approved fonts.',
            evidenceIds: [ev],
            reproductionSteps: steps(`Inspect the text "${merged.samples[0]?.text ?? ''}" and check its font.`),
            remediation: `Change the font to an approved one, or add "${font}" to the profile if it is allowed. If the approved font failed to load, the browser may be showing a fallback; check that the font file loads.`,
            targetKey: font,
            stateKey: '',
            occurrences: occ(merged, ev, `font ${font}`),
          }),
        );
      }
    } else checks.push(check('BRD-001', 'not_applicable', 0, [], { ...base, reasonDetail: 'The client profile has no approved fonts.' }));

    // ---- BRD-002 colours ----
    if (brand.approvedColors.length) {
      const tol = brand.colorTolerance ?? DEFAULT_TOLERANCE;
      const bad = new Map<string, { groups: BrandGroup[]; nearest: string; distance: number }>();
      for (const g of data.groups) {
        const rgb = parseCssColor(g.color);
        if (!rgb || Math.max(...rgb) - Math.min(...rgb) <= 8) continue; // black, white, grey: neutral
        const near = nearestApproved(rgb, brand.approvedColors);
        if (near && near.distance > tol) {
          const prev = bad.get(g.color);
          bad.set(g.color, { groups: [...(prev?.groups ?? []), g], nearest: near.name, distance: Math.round(near.distance * 10) / 10 });
        }
      }
      checks.push(check('BRD-002', bad.size ? 'needs_review' : data.elements ? 'passed' : 'not_applicable', ms, [], { ...base, itemsEvaluated: data.elements }));
      for (const [color, info] of bad) {
        const merged = mergeGroups(info.groups);
        const ev = await evidence(`Text colour ${color}`, { color, nearestApproved: info.nearest, deltaE2000: info.distance, tolerance: tol, count: merged.count, samples: merged.samples });
        findings.push(
          finding('BRD-002', where(merged), {
            title: `Text colour ${color} is not close to an approved colour`,
            observed: `${merged.count} piece(s) of text use ${color}. The closest approved colour is "${info.nearest}" at a CIEDE2000 distance of ${info.distance} (allowed up to ${tol})${source}.`,
            expected: 'Text colours match the approved palette within the profile tolerance.',
            evidenceIds: [ev],
            reproductionSteps: steps(`Inspect the colour of the text "${merged.samples[0]?.text ?? ''}".`),
            remediation: 'Use an approved colour, or add this colour to the profile if it is allowed.',
            targetKey: color,
            stateKey: '',
            occurrences: occ(merged, ev, `colour ${color}`),
          }),
        );
      }
    } else checks.push(check('BRD-002', 'not_applicable', 0, [], { ...base, reasonDetail: 'The client profile has no approved colours.' }));

    // ---- BRD-003 minimum text size ----
    if (brand.minTextSizePx) {
      const min = brand.minTextSizePx;
      const small = data.groups.filter((g) => g.sizePx < min);
      checks.push(check('BRD-003', small.length ? 'needs_review' : data.elements ? 'passed' : 'not_applicable', ms, [], { ...base, itemsEvaluated: data.elements }));
      const sizes = [...new Set(small.map((g) => g.sizePx))].sort((a, b) => a - b);
      for (const size of sizes) {
        const merged = mergeGroups(small.filter((g) => g.sizePx === size));
        const ev = await evidence(`Text size ${size}px`, { sizePx: size, minimumPx: min, count: merged.count, samples: merged.samples });
        findings.push(
          finding('BRD-003', where(merged), {
            title: `Text is ${size} px, below the ${min} px minimum`,
            observed: `${merged.count} piece(s) of text are ${size} px; the client profile sets a ${min} px minimum${source}.`,
            expected: `Text is at least ${min} px.`,
            evidenceIds: [ev],
            reproductionSteps: steps(`Inspect the size of the text "${merged.samples[0]?.text ?? ''}".`),
            remediation: `Increase the text to at least ${min} px.`,
            targetKey: String(size),
            stateKey: '',
            occurrences: occ(merged, ev, `${size}px text`),
          }),
        );
      }
    } else checks.push(check('BRD-003', 'not_applicable', 0, [], { ...base, reasonDetail: 'The client profile has no minimum text size.' }));

    return { checks, findings };
  }
}

function mergeGroups(gs: BrandGroup[]): BrandGroup {
  const first = gs[0]!;
  return { ...first, count: gs.reduce((n, g) => n + g.count, 0), samples: gs.flatMap((g) => g.samples).slice(0, 4) };
}
