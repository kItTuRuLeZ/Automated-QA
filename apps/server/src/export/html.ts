import { ACCESSIBILITY_DISCLAIMER, ACTION_LABEL, MANUAL_REVIEW_CHECKLIST, type ReportIssue, type RunReport } from '@cqa/core';
import type { Severity } from '@cqa/shared';
import { REASON_PLAIN } from './xlsx.js';

/** Escapes text from the course (titles, selectors, page text) before it goes into HTML. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface HtmlReportOptions {
  /** PNG bytes for an artifact id, or undefined when the file is missing. */
  loadImage?: (artifactId: string) => Buffer | undefined;
  generatedAt?: string;
}

const PRIORITY: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', informational: 'Info' };
const STATUS: Record<string, string> = {
  open: 'Open',
  assigned: 'Assigned',
  fixed: 'Fixed',
  retest: 'Retest',
  verified: 'Verified',
  accepted_risk: 'Accepted risk',
  false_positive: 'False positive',
  not_reproduced: 'Not reproduced',
  not_retested: 'Not retested',
};

const CSS = `
:root { --text:#1a2230; --muted:#566176; --border:#d5dbe5; --bg:#f5f7fa; --primary:#1f4fbf; }
* { box-sizing: border-box; }
body { font-family: 'Segoe UI', system-ui, Arial, sans-serif; color: var(--text); background: var(--bg); margin: 0; line-height: 1.5; }
main { max-width: 960px; margin: 0 auto; padding: 24px 20px 48px; }
h1 { font-size: 1.7rem; margin: 0 0 4px; } h2 { font-size: 1.25rem; margin: 2rem 0 .6rem; border-bottom: 2px solid var(--border); padding-bottom: .25rem; } h3 { font-size: 1.05rem; margin: 0 0 .3rem; }
.meta, .muted { color: var(--muted); } .small { font-size: .85rem; }
.note { background: #eef3ff; border: 1px solid #b8c9f2; border-radius: 6px; padding: .6rem .9rem; margin: .8rem 0; }
.counts { display: flex; gap: .75rem; flex-wrap: wrap; margin: 1rem 0; }
.count { flex: 1 1 150px; border: 1px solid var(--border); border-radius: 8px; padding: .6rem .9rem; background: #fff; }
.count b { display: block; font-size: 2rem; line-height: 1.1; } .count.fix { background: #fdecea; border-color: #f2b8b5; } .count.check { background: #fff4dc; border-color: #ecd59c; } .count.not { background: #eef0f3; }
.issue { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: .8rem 1rem; margin: .7rem 0; break-inside: avoid; }
.badge { display: inline-block; font-size: .75rem; font-weight: 600; padding: 0 .5rem; border-radius: 999px; border: 1px solid var(--border); background: #eef0f3; margin-right: .4rem; }
.p-critical { background:#7a1010; color:#fff; border-color:#7a1010; } .p-high { background:#fdecea; color:#8f1d14; } .p-medium { background:#fff4dc; color:#6e4700; } .p-low { background:#e8efff; color:#183f99; }
.id { font-family: Consolas, monospace; color: var(--muted); font-size: .85rem; }
.label { color: var(--muted); font-weight: 600; }
.shot { width: 100%; max-width: 520px; background-size: contain; background-repeat: no-repeat; border: 1px solid var(--border); border-radius: 4px; margin: .5rem 0; }
table { border-collapse: collapse; width: 100%; background: #fff; margin: .5rem 0; font-size: .92rem; }
th, td { text-align: left; border: 1px solid var(--border); padding: .35rem .55rem; vertical-align: top; } th { background: #f0f3f8; color: var(--muted); }
ol, ul { margin: .3rem 0 .3rem 1.2rem; padding: 0; }
code, .mono { font-family: Consolas, monospace; font-size: .88em; word-break: break-word; }
footer { margin-top: 2.5rem; color: var(--muted); font-size: .85rem; }
@media print { body { background: #fff; } main { max-width: none; padding: 0; } .issue { box-shadow: none; } h2 { break-after: avoid; } }
`;

function dimensions(png: Buffer): { w: number; h: number } | undefined {
  if (png.length < 24 || png.subarray(1, 4).toString() !== 'PNG') return undefined;
  return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
}

/** One self-contained HTML file: no scripts, no external requests, each screenshot embedded once. */
export function buildHtmlReport(r: RunReport, opts: HtmlReportOptions = {}): string {
  const images = new Map<string, { cls: string; w: number; h: number; data: string }>();
  const imageClass = (artifactId?: string) => {
    if (!artifactId || !opts.loadImage) return undefined;
    const known = images.get(artifactId);
    if (known) return known;
    const bytes = opts.loadImage(artifactId);
    const dim = bytes ? dimensions(bytes) : undefined;
    if (!bytes || !dim) return undefined;
    const entry = { cls: `im${images.size + 1}`, w: dim.w, h: dim.h, data: bytes.toString('base64') };
    images.set(artifactId, entry);
    return entry;
  };
  const shot = (artifactId: string | undefined, label: string) => {
    const im = imageClass(artifactId);
    return im ? `<div class="shot ${im.cls}" role="img" aria-label="${esc(label)}" style="aspect-ratio:${im.w}/${im.h};max-width:min(100%,${Math.min(im.w, 520)}px)"></div>` : '';
  };

  const host = (() => {
    try {
      return new URL(r.run.targetUrl).hostname;
    } catch {
      return r.run.targetUrl;
    }
  })();
  const when = (iso?: string) => (iso ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : '—');
  const t = r.checkTotals;

  const issueHtml = (i: ReportIssue) => `
<article class="issue" id="${esc(i.id)}">
  <h3><span class="badge p-${esc(i.priority)}">${esc(PRIORITY[i.priority])}</span>${esc(i.issue)} <span class="id">${esc(i.id)}</span>${i.source === 'static' ? ' <span class="muted small">Static package check</span>' : ''}</h3>
  ${shot(i.screenshotId, i.screenshotKind === 'element' ? `Screenshot with the affected element outlined: ${i.issue}` : `Screenshot of the screen where this was found: ${i.issue}`)}
  <p><span class="label">What to change:</span> ${esc(i.change)}</p>
  <p><span class="label">Where:</span> ${i.screens.length ? `screen${i.screens.length > 1 ? 's' : ''} ${esc(i.screens.join(', '))}` : 'this scan'}${i.viewports.length ? ` at ${esc(i.viewports.join(', '))}` : ''}${i.elements.length ? ` · ${esc(i.elements.join('; '))}${i.moreElements ? ` (+${i.moreElements} more)` : ''}` : ''}</p>
  <p><span class="label">Status:</span> ${esc(STATUS[i.status] ?? i.status)}${i.assignee ? ` · owner ${esc(i.assignee)}` : ''}${i.statusReason ? ` · ${esc(i.statusReason)}` : ''}</p>
  <details open><summary class="label">How to see it</summary><ol>${i.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></details>
  <p class="small muted">Technical details: ${esc(i.technical.ruleId)}${i.technical.standards.length ? ` · ${esc(i.technical.standards.join(', '))} (relevant to, not proof of failure)` : ''} · confidence ${esc(i.technical.confidence)} · ${esc(i.technical.type.replace(/_/g, ' '))}<br>${esc(i.technical.observed)}</p>
</article>`;

  const group = (action: 'fix' | 'check' | 'not_checked', help: string) => {
    const items = r.issues.filter((i) => i.action === action);
    if (!items.length) return '';
    return `<h3 style="margin-top:1.2rem">${esc(ACTION_LABEL[action])} (${items.length})</h3><p class="muted small">${esc(help)}</p>${items.map(issueHtml).join('')}`;
  };

  const sizes = r.viewports?.length
    ? `<h3>Screen sizes</h3><p class="muted small">Simulated in ${esc(r.run.browser ?? 'a desktop browser')}; not tests on real phones or tablets.</p>
<table><caption class="muted small" style="text-align:left">Screen sizes tested</caption><thead><tr><th>Size</th><th>Device settings</th><th>Screens checked</th><th>Not reached</th><th>Layout issues</th></tr></thead><tbody>${r.viewports
        .map(
          (v) =>
            `<tr><td>${esc(v.name)} ${v.width}×${v.height}</td><td>scale ${v.deviceScaleFactor}${v.isMobile ? ', mobile emulation' : ''}${v.hasTouch ? ', touch' : ''}</td>${
              v.skipped ? `<td colspan="3"><b>Not tested.</b> ${esc(v.skipped)}</td>` : `<td>${v.screensChecked}</td><td>${v.screensNotReached}</td><td>${v.layoutIssues}</td>`
            }</tr>`,
        )
        .join('')}</tbody></table>`
    : '';

  const perf = r.performance
    ? `<h3>Page load (first page, one sample)</h3>
<p>Load time ${r.performance.loadMs === null ? 'not available' : `${(r.performance.loadMs / 1000).toFixed(1)} s`} (warning above ${(r.performance.thresholds.loadMs / 1000).toFixed(1)} s) · ${r.performance.unavailable.some((u) => u.includes('resource size')) ? 'at least ' : ''}${(r.performance.transferredBytes / 1e6).toFixed(1)} MB transferred (above ${(r.performance.thresholds.totalBytes / 1e6).toFixed(1)} MB) · ${r.performance.requests} requests (above ${r.performance.thresholds.requestCount}).${r.performance.unavailable.length ? ` Not available: ${esc(r.performance.unavailable.join(', '))}.` : ''}</p>
<p class="small muted">Conditions: ${esc(r.performance.conditions.join(' '))} Thresholds: ${esc(r.performance.thresholds.provenance)}</p>`
    : '';

  const body = `
<header>
  <h1>Course QA report</h1>
  <p class="meta">${esc(r.run.targetUrl)}<br>Scanned ${esc(when(r.scan.startedAt ?? r.run.queuedAt))} · ${esc(r.run.statusPlain)}${r.run.statusDetail ? ` (${esc(r.run.statusDetail)})` : ''}</p>
</header>
<section id="summary" aria-labelledby="h-summary">
  <h2 id="h-summary">What to do</h2>
  <div class="counts">
    <div class="count fix"><b data-count="fix">${r.counts.fix}</b>To fix</div>
    <div class="count check"><b data-count="check">${r.counts.check}</b>Check by hand</div>
    <div class="count not"><b data-count="not_checked">${r.counts.notChecked}</b>Not checked</div>
  </div>
  <p>${r.coverage.screensScanned} screen${r.coverage.screensScanned === 1 ? '' : 's'} scanned${r.coverage.budgetsReached.length ? ', and the scan stopped at a limit so other screens were not looked at' : ''}. Fix by priority: ${(['critical', 'high', 'medium', 'low', 'informational'] as Severity[]).filter((s) => r.counts.bySeverity[s] > 0).map((s) => `${r.counts.bySeverity[s]} ${PRIORITY[s].toLowerCase()}`).join(', ') || 'none'}.</p>
  <p class="note">${esc(ACCESSIBILITY_DISCLAIMER)} A scan only covers the screens it reached; anything it did not reach is unverified, not passed.</p>
</section>
<section id="issues" aria-labelledby="h-issues">
  <h2 id="h-issues">Issues</h2>
  ${r.issues.length === 0 ? '<p><b>No issues were recorded.</b> That does not mean the course passed QA: see Coverage and the manual review checklist.</p>' : ''}
  ${group('fix', 'Confirmed problems that need a change.')}
  ${group('check', 'The scanner could not decide. A person needs to look.')}
  ${group('not_checked', 'Areas the scanner could not inspect. These are not passes.')}
</section>
<section id="coverage" aria-labelledby="h-cov">
  <h2 id="h-cov">Coverage</h2>
  <table><caption class="muted small" style="text-align:left">Screens reached</caption><thead><tr><th>Screen</th><th>Title</th><th>How the scanner got here</th><th>Address</th></tr></thead><tbody>${r.screens
    .map((s) => `<tr><td>${esc(s.label)}</td><td>${esc(s.title)}</td><td>${esc(s.reachedBy)}</td><td class="mono">${esc(s.url)}</td></tr>`)
    .join('')}</tbody></table>
  ${sizes}
  ${perf}
  <h3>Skipped controls (${r.skippedActions.length})</h3>
  ${r.skippedActions.length ? `<table><thead><tr><th>Control</th><th>Why it was skipped</th></tr></thead><tbody>${r.skippedActions.slice(0, 60).map((a) => `<tr><td>${esc(a.what)}</td><td>${esc(REASON_PLAIN[a.reason] ?? a.reason)}${a.detail ? ` — ${esc(a.detail)}` : ''}</td></tr>`).join('')}</tbody></table>${r.skippedActions.length > 60 ? `<p class="small muted">${r.skippedActions.length - 60} more not shown.</p>` : ''}` : '<p class="muted">None.</p>'}
  <h3>Checks that did not run</h3>
  ${r.untested.length ? `<ul>${r.untested.map((u) => `<li>${u.count} × ${esc(REASON_PLAIN[u.reason] ?? u.reason)}</li>`).join('')}</ul><p class="small muted">These are never counted as passed.</p>` : '<p class="muted">Everything the scan was set to check ran.</p>'}
  ${r.errors.length ? `<h3>Checks that hit an error</h3><ul>${r.errors.map((e) => `<li>${esc(e.rule)}: ${esc(e.detail)}</li>`).join('')}</ul>` : ''}
</section>
<section id="manual" aria-labelledby="h-man">
  <h2 id="h-man">Manual review checklist</h2>
  <p class="muted">These always need a person. They are never counted as tested or passed.</p>
  <ol>${MANUAL_REVIEW_CHECKLIST.map((m) => `<li><b>${esc(m.title)}</b> (${esc(m.id)})<br>${esc(m.howToCheck)}<br><span class="small muted">Why manual: ${esc(m.whyManual)}</span></li>`).join('')}</ol>
</section>
${r.package ? packageHtml(r.package) : ''}
${r.scorm ? scormHtml(r.scorm) : ''}
<section id="details" aria-labelledby="h-det">
  <h2 id="h-det">Scan details and totals</h2>
  <p><span class="label">Scope:</span> ${esc(r.scan.scope.origins.join(', '))}${r.scan.scope.pathPrefixes.length ? ` under ${esc(r.scan.scope.pathPrefixes.join(', '))}` : ''}. <span class="label">Limits:</span> up to ${r.scan.budgets.maxStates} screens, ${r.scan.budgets.maxDepth} clicks deep, ${r.scan.budgets.maxRuntimeSeconds} s. <span class="label">Checks on:</span> ${esc(r.scan.checksEnabled.join(', '))}. <span class="label">Screen sizes:</span> ${esc(r.scan.screenSizes.join(', '))}.${r.scan.platform === 'storyline' ? ' Storyline output was recognized (fixed-size stage).' : ''}</p>
  ${r.scan.profile ? `<p><span class="label">Client profile:</span> ${esc(r.scan.profile.name)}.${r.scan.profile.brandSource ? ` Brand values were supplied by a person (${esc(r.scan.profile.brandSource)}); the scanner has no brand rules of its own.` : ''}${r.scan.profile.rulesSwitchedOff.length ? ` Rules switched off: ${r.scan.profile.rulesSwitchedOff.map((x) => `${esc(x.ruleId)} (${esc(x.reason)})`).join('; ')}.` : ''}${r.scan.profile.severityChanges.length ? ` Priority changed by the profile: ${r.scan.profile.severityChanges.map((x) => `${esc(x.ruleId)} to ${esc(x.severity)} (${esc(x.reason)})`).join('; ')}.` : ''}</p>` : ''}
  <p><span class="label">Tools:</span> ${esc(r.scan.toolVersions.map((v) => `${v.name} ${v.version}`).join(', ') || '—')}. AI was not used for any result in this report.</p>
  <p><span class="label">How the numbers are counted:</span> <b data-total="rules">${t.uniqueRules}</b> distinct rules were evaluated in <b data-total="executions">${t.executions}</b> check executions (one rule on one screen at one size is one execution). Outcomes: ${t.passed} passed, ${t.failed} failed, ${t.needsReview} need review, ${t.notApplicable} not applicable, ${t.notTested} not tested, ${t.errors} errored. Not tested and errored checks are never counted as passed. The counts at the top of this report are findings (grouped problems), not executions.</p>
  <table><caption class="muted small" style="text-align:left">Findings by category</caption><thead><tr><th>Category</th><th>To fix</th><th>Check by hand</th><th>Not checked</th></tr></thead><tbody>${r.byCategory.map((c) => `<tr><td>${esc(c.category)}</td><td>${c.fix}</td><td>${c.check}</td><td>${c.notChecked}</td></tr>`).join('')}</tbody></table>
  <h3>AI recommendations</h3>
  ${r.advisory.length ? `<p class="muted small">Advisory only; never counted with the results above.</p>${r.advisory.map(issueHtml).join('')}` : '<p class="muted">None. AI is not part of core scanning.</p>'}
</section>
<footer>Generated ${esc(when(opts.generatedAt))} by Course QA Automation. Screenshots are embedded in this file. Issue IDs (QA-xxxxxx) stay the same when the same problem is found in a later scan.</footer>`;

  // Built after the body, because images are registered while the issues are rendered.
  const css = [...images.values()].map((im) => `.${im.cls}{background-image:url(data:image/png;base64,${im.data})}`).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${esc(`Course QA report: ${host}`)}</title>
<style>${CSS}
${css}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Static package facts, kept apart from what the browser observed. */
function packageHtml(p: NonNullable<RunReport['package']>): string {
  const inv = p.inventory;
  return `<section id="package" aria-labelledby="h-pkg">
  <h2 id="h-pkg">Package</h2>
  <p><span class="label">Package:</span> ${esc(p.name)}${p.kind ? ` (${esc(p.kind === 'scorm12' ? 'SCORM 1.2' : p.kind === 'scorm2004' ? 'SCORM 2004' : p.kind === 'html5' ? 'plain HTML5' : 'unrecognized SCORM')}${p.scormVersionDeclared ? `, schema version ${esc(p.scormVersionDeclared)}` : ''})` : ''}. <span class="label">Lesson scanned:</span> ${esc(p.launchTitle ?? 'unknown')}${p.launchPoints > 1 ? ` (one of ${p.launchPoints} launch points; see the package checks for which others were not scanned)` : ''}.</p>
  ${inv ? `<p><span class="label">Contents:</span> ${inv.files} files, ${mb(inv.bytes)}. Largest: ${inv.largest.slice(0, 4).map((l) => `${esc(l.path)} (${mb(l.bytes)})`).join(', ')}.</p>` : '<p class="muted">The uploaded package has since been deleted, so its contents are not listed.</p>'}
  <p><span class="label">Outside websites referenced:</span> ${p.externalDependencies.length ? esc(p.externalDependencies.map((d) => d.host).join(', ')) : 'none found in the package text'}. A scan blocks outside requests unless they were allowed, and lists what was blocked. Items marked "Static package check" came from the package's files; no code was run for them.</p>
</section>`;
}

function scormHtml(sc: NonNullable<RunReport['scorm']>): string {
  return `<section id="scorm" aria-labelledby="h-scorm">
  <h2 id="h-scorm">SCORM ${esc(sc.version)} test harness results</h2>
  <p><b>${esc(sc.source)}.</b> ${esc(sc.limitations[0] ?? '')}</p>
  <table><caption class="muted small" style="text-align:left">Sessions run</caption><thead><tr><th>Session</th><th>Steps</th><th>API calls</th><th>Recorded at the end</th></tr></thead><tbody>${sc.sessions.map((x) => `<tr><td>${esc(x.name)}</td><td>${x.stepsRun} of ${x.stepsTotal}${x.stepFailure ? ` (${esc(x.stepFailure)})` : ''}</td><td>${x.callCount}</td><td>${esc(x.finalStatus)}</td></tr>`).join('')}</tbody></table>
  <ul class="small">${sc.limitations.slice(1).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
  <h3>Only your LMS can show</h3>
  <ol>${sc.lmsChecklist.map((i) => `<li><b>${esc(i.title)}</b> (${esc(i.id)})<br>${esc(i.howToCheck)}</li>`).join('')}</ol>
</section>`;
}
