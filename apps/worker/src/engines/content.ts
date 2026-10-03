import type { Page } from 'playwright';
import type { CourseState, EngineResult, EvidenceId, FindingLocation, ProviderContext, StateId } from '@cqa/shared';
import { nowIso, sanitizeText, sanitizeUrl } from '@cqa/core';
import { type LinkInfo, collectPageContent, scrollThrough } from '../adapters/content-scripts.js';
import { type NewCheck, type NewFinding, check, dedupe, finding, truncate } from './helpers.js';

/** A link seen in a reached state, kept for run-level link checking. */
export interface LinkAppearance {
  link: LinkInfo;
  stateId: StateId;
  stateUrl: string;
  viewportName: string;
  reproductionSteps: string[];
}

export interface StateContentResult {
  checks: NewCheck[];
  findings: NewFinding[];
  links: LinkAppearance[];
}

const MEDIA_ERROR: Record<number, string> = { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'source not supported or not found' };
const NETWORK_NO_SOURCE = 3;

/**
 * Per-state checks for images, audio/video, and visible text, plus link
 * collection. Scrolls the state first so lazy content gets a chance to load.
 */
export class ContentChecks {
  readonly id = 'content-checks';
  readonly version = '1.0.0';

  async checkState(ctx: ProviderContext, state: CourseState, reproductionSteps: string[]): Promise<StateContentResult> {
    const page = ctx.page as Page;
    const { engines, textRules, mediaThresholds, redaction } = ctx.config;
    const viewportName = ctx.viewport.name;
    const san = (u: string) => sanitizeUrl(u, redaction);
    const checks: NewCheck[] = [];
    const findings: NewFinding[] = [];
    const t0 = Date.now();
    const base = { stateId: state.id, viewportName };
    const loc = (extra: Partial<FindingLocation> = {}): FindingLocation => ({ stateId: state.id, url: state.url, lessonId: state.lessonId, viewportName, browser: 'chromium', ...extra });

    if (engines.media) {
      await page.evaluate(scrollThrough).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => undefined);
    }
    const content = await page.evaluate(collectPageContent, {
      placeholderPatterns: engines.content ? textRules.placeholderPatterns : [],
      terminology: engines.content ? textRules.terminology : [],
      exclusions: textRules.exclusions,
    });
    const ms = Date.now() - t0;

    const evidence = async (kind: 'dom_snippet' | 'text_excerpt' | 'network_entry', caption: string, data: Record<string, unknown>): Promise<EvidenceId> =>
      (await ctx.evidence.addEvidence({ kind, caption, data, stateId: state.id, viewportName, capturedAt: nowIso(), redacted: true })).id;

    // ---- links (collected here, checked once per run) ----
    const links: LinkAppearance[] = [];
    if (engines.links) {
      for (const l of content.links) links.push({ link: l, stateId: state.id, stateUrl: state.url, viewportName, reproductionSteps });
      const bad = dedupe(
        content.links.filter((l) => l.kind === 'javascript' || l.kind === 'empty' || l.kind === 'malformed'),
        (l) => `${l.kind}|${l.href}|${l.text}`,
      );
      checks.push(check('LNK-005', bad.length ? 'failed' : content.links.length ? 'passed' : 'not_applicable', 0, [], { ...base, itemsEvaluated: content.links.length }));
      for (const l of bad) {
        const ev = await evidence('dom_snippet', 'Link markup', { href: truncate(l.href, 200), text: l.text, selector: l.locator });
        const what = l.kind === 'javascript' ? 'uses a javascript: URL' : l.kind === 'empty' ? 'has an empty href' : 'has an href that is not a valid URL';
        findings.push(
          finding('LNK-005', loc({ selector: l.locator, elementDescription: `link "${l.text}"` }), {
            title: `Link "${truncate(l.text || l.href, 60)}" ${what}`,
            observed: `The link "${l.text}" ${what} (href="${truncate(l.href, 120)}").`,
            expected: 'Links point to a real http(s) destination; actions use buttons.',
            evidenceIds: [ev],
            reproductionSteps: [...reproductionSteps, `Inspect the link "${l.text}".`],
            remediation: l.kind === 'javascript' ? 'Use a <button> for in-page actions, or a real URL for navigation.' : 'Fix or remove the link.',
            targetKey: `${l.kind}|${l.text}`,
            stateKey: '',
          }),
        );
      }
    }

    if (engines.media) {
      // ---- MED-001 images ----
      const evaluated = content.images.filter((i) => i.complete);
      const pending = content.images.length - evaluated.length;
      const broken = evaluated.filter((i) => i.naturalWidth === 0 && i.decodeFailed);
      const outcome = broken.length ? 'failed' : evaluated.length ? 'passed' : content.images.length ? 'not_tested' : 'not_applicable';
      checks.push(
        check('MED-001', outcome, ms, [], {
          ...base,
          itemsEvaluated: evaluated.length,
          reason: outcome === 'not_tested' ? 'timeout' : undefined,
          reasonDetail: pending ? `${pending} image(s) were still loading after scrolling and waiting and were not tested.` : undefined,
        }),
      );
      for (const img of dedupe(broken, (i) => i.src)) {
        const src = san(img.src);
        const ev = await evidence('dom_snippet', 'Broken image', { src, alt: img.alt, selector: img.locator, naturalWidth: img.naturalWidth, visible: img.visible });
        findings.push(
          finding('MED-001', loc({ selector: img.locator, elementDescription: `image ${src}` }), {
            title: `Broken image: ${truncate(src.split('/').pop() || src, 80)}`,
            observed: `The image ${src}${img.alt ? ` (alt "${truncate(img.alt, 80)}")` : ''} finished loading but could not be decoded or displayed.`,
            expected: 'Images load and display.',
            evidenceIds: [ev],
            reproductionSteps: [...reproductionSteps, 'Scroll through the page and look for the missing image.', `The image source is ${src}.`],
            remediation: 'Restore the image file or fix its path.',
            targetKey: src,
            stateKey: '',
          }),
        );
      }

      // ---- MED-002..004 audio/video ----
      const failing = content.media.filter((m) => m.errorCode !== null || (m.networkState === NETWORK_NO_SOURCE && m.readyState === 0));
      checks.push(check('MED-002', failing.length ? 'failed' : content.media.length ? 'passed' : 'not_applicable', 0, [], { ...base, itemsEvaluated: content.media.length }));
      for (const m of dedupe(failing, (x) => x.src || x.locator)) {
        const src = m.src ? san(m.src) : '(no source)';
        const why = m.errorCode !== null ? (MEDIA_ERROR[m.errorCode] ?? `error ${m.errorCode}`) : 'no playable source was found';
        const ev = await evidence('dom_snippet', `${m.tag} element`, { src, errorCode: m.errorCode, networkState: m.networkState, readyState: m.readyState, selector: m.locator });
        findings.push(
          finding('MED-002', loc({ selector: m.locator, elementDescription: `${m.tag} ${src}` }), {
            title: `${m.tag === 'video' ? 'Video' : 'Audio'} failed to load: ${truncate(src.split('/').pop() || src, 60)}`,
            observed: `The ${m.tag} element with source ${src} reported: ${why}.`,
            expected: 'Media sources load. (Loading does not by itself prove playback works.)',
            evidenceIds: [ev],
            reproductionSteps: [...reproductionSteps, `Find the ${m.tag} player and try to play it.`],
            remediation: 'Restore the media file, fix its path, or provide a supported format.',
            targetKey: m.src || m.locator,
            stateKey: '',
          }),
        );
      }

      // Inline data: media (for example Storyline's silent placeholder video) is not course content for caption/control checks.
      const realMedia = content.media.filter((m) => !m.src.startsWith('data:'));
      const videos = realMedia.filter((m) => m.tag === 'video');
      const uncaptioned = videos.filter((v) => !v.tracks.some((t) => t.kind === 'captions' || t.kind === 'subtitles'));
      checks.push(check('MED-003', uncaptioned.length ? 'failed' : videos.length ? 'passed' : 'not_applicable', 0, [], { ...base, itemsEvaluated: videos.length }));
      for (const v of dedupe(uncaptioned, (x) => x.src || x.locator)) {
        const src = v.src ? san(v.src) : '(no source)';
        findings.push(
          finding('MED-003', loc({ selector: v.locator, elementDescription: `video ${src}` }), {
            title: `Video has no caption track: ${truncate(src.split('/').pop() || src, 60)}`,
            observed: `The video ${src} has no <track kind="captions"> or <track kind="subtitles">.`,
            expected: 'Prerecorded video with audio has captions. Burned-in or player-provided captions need manual confirmation.',
            evidenceIds: [await evidence('dom_snippet', 'Video tracks', { src, tracks: v.tracks })],
            reproductionSteps: [...reproductionSteps, 'Open the video player and look for a captions option.'],
            remediation: 'Add a captions track (WebVTT), or confirm captions are burned in or provided by the player.',
            targetKey: v.src || v.locator,
            stateKey: '',
          }),
        );
      }

      // A visible play/pause/mute button means a custom player (for example Storyline) provides controls.
      const noControls = content.customMediaControls ? [] : realMedia.filter((m) => !m.controls);
      checks.push(check('MED-004', noControls.length ? 'needs_review' : realMedia.length ? 'passed' : 'not_applicable', 0, [], { ...base, itemsEvaluated: realMedia.length }));
      for (const m of dedupe(noControls, (x) => x.src || x.locator)) {
        const src = m.src ? san(m.src) : '(no source)';
        findings.push(
          finding('MED-004', loc({ selector: m.locator, elementDescription: `${m.tag} ${src}` }), {
            title: `${m.tag === 'video' ? 'Video' : 'Audio'} without native controls${m.autoplay ? ' (autoplays)' : ''}`,
            observed: `The ${m.tag} ${src} has no controls attribute${m.autoplay ? ` and autoplays${m.muted ? ' muted' : ''}` : ''}.`,
            expected: 'Learners can pause, stop, and adjust media. A custom player may provide this; check manually.',
            evidenceIds: [await evidence('dom_snippet', 'Media attributes', { src, controls: m.controls, autoplay: m.autoplay, muted: m.muted })],
            reproductionSteps: [...reproductionSteps, `Find the ${m.tag} and check whether it can be paused and its volume changed.`],
            remediation: 'Add native controls or confirm the custom player exposes accessible controls.',
            targetKey: m.src || m.locator,
            stateKey: '',
          }),
        );
      }

      // ---- MED-005 sizes ----
      const known = content.resources.filter((r) => r.encodedBodySize > 0);
      const isMedia = (r: { url: string; initiatorType: string }) => ['video', 'audio', 'media'].includes(r.initiatorType) || /\.(mp4|webm|mp3|m4a|wav|ogg)(\?|$)/i.test(r.url);
      const large = known.filter((r) => r.encodedBodySize > (isMedia(r) ? mediaThresholds.maxMediaBytes : mediaThresholds.maxImageBytes));
      checks.push(
        check('MED-005', large.length ? 'needs_review' : known.length ? 'passed' : content.resources.length ? 'not_tested' : 'not_applicable', 0, [], {
          ...base,
          itemsEvaluated: known.length,
          reason: !known.length && content.resources.length ? 'not_applicable_to_surface' : undefined,
          reasonDetail: content.resources.length - known.length ? `${content.resources.length - known.length} asset(s) did not expose a transfer size (cross-origin or cached).` : undefined,
        }),
      );
      for (const r of dedupe(large, (x) => x.url)) {
        const url = san(r.url);
        const limit = isMedia(r) ? mediaThresholds.maxMediaBytes : mediaThresholds.maxImageBytes;
        findings.push(
          finding('MED-005', loc({ elementDescription: url }), {
            title: `Large ${isMedia(r) ? 'media file' : 'image'}: ${truncate(url.split('/').pop() || url, 60)} (${formatBytes(r.encodedBodySize)})`,
            observed: `${url} transferred ${formatBytes(r.encodedBodySize)}, above the ${formatBytes(limit)} threshold.`,
            expected: `Assets stay under the configured threshold. Threshold source: ${mediaThresholds.provenance}`,
            evidenceIds: [await evidence('network_entry', 'Asset size', { url, encodedBodySize: r.encodedBodySize, threshold: limit, thresholdSource: mediaThresholds.provenance })],
            reproductionSteps: [...reproductionSteps, 'Open the developer tools Network panel and sort by size.'],
            remediation: 'Compress or resize the asset if the size is not justified.',
            targetKey: url,
            stateKey: '',
          }),
        );
      }
    }

    if (engines.content) {
      for (const ruleId of ['TXT-001', 'TXT-002'] as const) {
        const hits = content.text.filter((m) => m.ruleId === ruleId);
        if (ruleId === 'TXT-002' && textRules.terminology.length === 0) {
          checks.push(check('TXT-002', 'not_applicable', 0, [], { ...base, reasonDetail: 'No terminology list configured for this scan.' }));
          continue;
        }
        checks.push(check(ruleId, hits.length ? (ruleId === 'TXT-001' ? 'failed' : 'needs_review') : 'passed', 0, [], { ...base, itemsEvaluated: hits.length }));
        // One finding per element: lorem ipsum and dolor sit amet in the same paragraph are one problem.
        for (const m of dedupe(dedupe(hits, (x) => x.locator), (x) => `${x.match.toLowerCase()}|${x.context.toLowerCase()}`)) {
          const context = sanitizeText(m.context, redaction, 300);
          const ev = await evidence('text_excerpt', ruleId === 'TXT-001' ? 'Placeholder text' : 'Terminology match', { match: m.match, context, selector: m.locator, pattern: m.pattern });
          findings.push(
            finding(ruleId, loc({ selector: m.locator, elementDescription: `text "${truncate(m.match, 60)}"` }), {
              title: ruleId === 'TXT-001' ? `Placeholder or production note: "${truncate(m.match, 60)}"` : `Term "${m.match}"${m.preferred ? ` (preferred: "${m.preferred}")` : ''}`,
              observed: `Visible text: "…${context}…"`,
              expected:
                ruleId === 'TXT-001'
                  ? 'Learner-facing text contains no placeholders or notes to the production team. Add an exclusion if this text is intended.'
                  : m.preferred
                    ? `Use "${m.preferred}" per the terminology list, unless the context calls for this term.`
                    : 'This term is on the terminology list for review.',
              evidenceIds: [ev],
              reproductionSteps: [...reproductionSteps, `Find the text "${truncate(m.match, 80)}".`],
              remediation: ruleId === 'TXT-001' ? 'Replace or remove the placeholder text.' : 'Review the wording against the terminology list.',
              targetKey: `${m.match.toLowerCase()}|${m.context.toLowerCase()}`,
              stateKey: '',
            }),
          );
        }
      }
    }

    return { checks, findings, links };
  }
}

function formatBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} kB`;
  return `${n} B`;
}
