import { useState } from 'react';
import { ApiError, type PackageView, api } from '../api';
import { type JourneyDraft, ScormJourneys, journeysToApi, presetJourneys } from '../components/ScormJourneys';
import { Alert, Breadcrumb, ErrorBox, Loading, PageHeader, TableScroll, useLoader } from '../components/ui';

const KIND = { scorm12: 'SCORM 1.2', scorm2004: 'SCORM 2004', scorm_unknown: 'SCORM (version unclear)', html5: 'Plain HTML5' } as const;
const OUTCOME = { passed: 'Passed', failed: 'Problem', needs_review: 'Check by hand', not_applicable: 'Not applicable', not_tested: 'Not checked' } as const;
const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Plain-language summary of what the package says it contains, and how sure that is, before anything is run. */
function ReadinessCard({ ins }: { ins: PackageView['inspection'] }) {
  const outline = ins.authoringTool?.outline ?? [];
  const count = (k: string) => outline.filter((e) => e.kind === k).length;
  const kind = KIND[ins.kind];
  let listed: string;
  let discovery: string;
  if (ins.authoringTool?.tool === 'rise' && outline.length) {
    listed = `${count('lesson')} lessons and ${count('block')} blocks`;
    discovery = 'Complete as far as the Rise export shows. The scan opens lessons and shows which were reached; blocks are listed, not tracked one by one.';
  } else if (ins.authoringTool?.tool === 'storyline' && outline.length) {
    listed = `${count('scene')} scene${count('scene') === 1 ? '' : 's'}, ${count('slide')} slides${count('layer') ? ` and ${count('layer')} layers` : ''}`;
    discovery = 'Complete as far as the Storyline export shows. The scan follows the player’s own menu and records each slide it opens.';
  } else if (ins.kind === 'html5') {
    listed = 'no list of lessons (a plain HTML5 package has no manifest)';
    discovery = 'Unknown. The scan can only report what it reaches from the launch file.';
  } else {
    listed = `${ins.launchChoices.length} launchable item${ins.launchChoices.length === 1 ? '' : 's'} in the manifest`;
    discovery = 'Partial. The manifest lists items, but the screens inside each item are only known once a browser opens them.';
  }
  return (
    <div className="card" aria-labelledby="ready-h">
      <h2 id="ready-h">Ready to check?</h2>
      <dl className="kv">
        <div><dt>Made with</dt><dd>{ins.authoringTool ? `${ins.authoringTool.product}${ins.authoringTool.version ? ` (build ${ins.authoringTool.version})` : ''}` : 'Not recognized as Rise or Storyline'} · {kind}</dd></div>
        <div><dt>The package lists</dt><dd>{listed}</dd></div>
        <div><dt>Discovery</dt><dd>{discovery}</dd></div>
      </dl>
      <p className="help">This is read from the files. Nothing has been opened in a browser, so it says nothing about which screens work. Whatever the scan cannot reach is listed as not reached, never as passed.</p>
    </div>
  );
}

export function PackagePage({ id }: { id: string }) {
  const { data, error, reload } = useLoader(() => api.getPackage(id), [id]);
  const project = useLoader(() => (data ? api.getProject(data.projectId) : Promise.resolve(undefined)), [data?.projectId]);
  const [picked, setPicked] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  const [allowed, setAllowed] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [harness, setHarness] = useState(true);
  const [journeys, setJourneys] = useState<JourneyDraft[]>(presetJourneys('2004'));
  const [interactions, setInteractions] = useState(true);
  const [autoAnswer, setAutoAnswer] = useState(true);
  const [traces, setTraces] = useState(true);
  const [maxScreens, setMaxScreens] = useState(100);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const p = data;
  const ins = p.inspection;
  const choices = ins.launchChoices;
  const effective = choices.length === 1 ? [choices[0]!.key] : picked;

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(undefined);
    const scormVersion = ins.kind === 'scorm12' ? '1.2' : ins.kind === 'scorm2004' ? '2004' : undefined;
    const parsed = scormVersion && harness ? journeysToApi(journeys, scormVersion) : { journeys: [], problems: [] as string[] };
    if (parsed.problems.length) {
      setProblem(parsed.problems.join(' '));
      setBusy(false);
      return;
    }
    try {
      const res = await api.scanPackage(p.id, {
        scorm: scormVersion ? { enabled: harness, journeys: parsed.journeys } : undefined,
        launch: effective.length === choices.length && choices.length > 1 ? 'all' : effective,
        acknowledgeLocalExecution: ack,
        allowedExternalOrigins: allowed.split('\n').map((x) => x.trim()).filter(Boolean),
        ...(interactions ? { qaProfile: 'full' as const, functional: true, autoAnswer, traces: traces ? ('first_failure' as const) : ('off' as const) } : {}),
        maxStates: Math.min(200, Math.max(1, Math.round(maxScreens) || 100)),
      });
      window.location.hash = `/runs/${res.runs[0]!.id}`;
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const failedCount = ins.issues.filter((i) => i.outcome === 'failed').length;

  return (
    <section aria-labelledby="pkg-heading">
      <Breadcrumb items={[{ label: 'Projects', to: '/' }, { label: project.data?.name ?? 'Project', to: `/projects/${p.projectId}` }, { label: p.name }]} />
      <PageHeader
        title={p.name}
        titleId="pkg-heading"
        subtitle={
          <>
            {ins.authoringTool ? `${ins.authoringTool.product} · ` : ''}
            {KIND[ins.kind]}
            {ins.scormVersionDeclared ? ` (schema version ${ins.scormVersionDeclared})` : ''} · {ins.inventory.files} files · {mb(ins.inventory.bytes)} · uploaded as {p.originalFilename}
          </>
        }
      />
      <Alert tone="ok" title="Upload inspected. Nothing has been run yet.">
        The checks below were read from the files only. {choices.length > 1 ? 'Choose the lessons to scan, then' : 'When you are ready,'} confirm that you want the course’s own JavaScript to run in a browser on this computer. That is what “Scan this package” does.
      </Alert>

      {/* Primary Action Card: Scan this package */}
      <div className="card form" style={{ borderLeft: '4px solid var(--primary, #1d4ed8)', background: '#fff' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <h2 style={{ margin: 0 }}>Scan this package</h2>
          <span className="badge" style={{ fontSize: '0.85rem' }}>
            {effective.length} lesson{effective.length === 1 ? '' : 's'} selected
          </span>
        </div>

        {choices.length === 0 ? (
          <p>There is nothing to scan: no launch file was found. Fix the package and upload it again.</p>
        ) : (
          <>
            {choices.length > 1 && (
              <fieldset className="fieldset" style={{ marginBottom: '1rem' }}>
                <legend>Which lessons to scan (each is scanned separately)</legend>
                <p className="help">Lessons you do not pick are listed as not scanned in the results. Nothing is picked for you.</p>
                <div style={{ maxHeight: '200px', overflowY: 'auto', padding: '0.4rem 0' }}>
                  {choices.map((c) => (
                    <label key={c.key} className="checkbox" style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.35rem' }}>
                      <input type="checkbox" checked={picked.includes(c.key)} onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, c.key] : cur.filter((k) => k !== c.key)))} />
                      <span>{c.title} <span className="muted mono" style={{ fontSize: '0.82rem' }}>({c.path})</span></span>
                    </label>
                  ))}
                </div>
                <div style={{ marginTop: '0.4rem' }}>
                  <button type="button" className="btn btn-small" onClick={() => setPicked(choices.slice(0, 25).map((c) => c.key))}>
                    Pick all
                  </button>
                </div>
              </fieldset>
            )}

            <fieldset className="fieldset" style={{ marginBottom: '1rem' }}>
              <legend>What to check</legend>
              <p className="help">Content, accessibility, layout and broken files are always checked.</p>
              <label className="checkbox" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                <input type="checkbox" checked={interactions} onChange={(e) => setInteractions(e.target.checked)} style={{ marginTop: '0.2rem' }} />
                <span>
                  <strong>Test interactions</strong>
                  <span className="help" style={{ display: 'block' }}>Clicks tabs, accordions, pop-ups, menus and Next/Back buttons and checks that each one works. Takes longer.</span>
                </span>
              </label>
              <label className="checkbox" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', marginTop: '0.5rem' }}>
                <input type="checkbox" checked={interactions && traces} disabled={!interactions} onChange={(e) => setTraces(e.target.checked)} style={{ marginTop: '0.2rem' }} />
                <span>
                  <strong>Keep a browser trace when a check fails</strong>
                  <span className="help" style={{ display: 'block' }}>If a check fails, a step-by-step browser recording is kept for it. It can include page content and network data, so turn this off for courses with sensitive information.</span>
                </span>
              </label>
              <label className="checkbox" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', marginTop: '0.5rem' }}>
                <input type="checkbox" checked={interactions && autoAnswer} disabled={!interactions} onChange={(e) => setAutoAnswer(e.target.checked)} style={{ marginTop: '0.2rem' }} />
                <span>
                  <strong>Answer quiz questions automatically</strong>
                  <span className="help" style={{ display: 'block' }}>
                    When a question blocks the way forward, the scan picks an answer and presses Submit (and tries other answers if the course wants the right one), so it can reach the screens after the quiz. Answers are not marked right or wrong in the results.{!interactions && ' Turn on “Test interactions” to use this.'}
                  </span>
                </span>
              </label>
              <div className="field" style={{ marginTop: '0.75rem', maxWidth: '22rem' }}>
                <label htmlFor="pkg-max">Most screens to visit</label>
                <input id="pkg-max" type="number" min={1} max={200} value={maxScreens} onChange={(e) => setMaxScreens(Number(e.target.value))} aria-describedby="pkg-max-help" />
                <p id="pkg-max-help" className="help">
                  The scan stops after this many screens and marks the result “partial”. Each screen, and each tab or pop-up it opens, counts as one. 100 suits most courses; raise it (up to 200) if the result says the limit was reached.
                </p>
              </div>
            </fieldset>

            {(ins.kind === 'scorm12' || ins.kind === 'scorm2004') && (
              <div style={{ marginBottom: '0.85rem' }}>
                <label className="checkbox" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontWeight: 600 }}>
                  <input type="checkbox" checked={harness} onChange={(e) => setHarness(e.target.checked)} />
                  <span>Also run the {ins.kind === 'scorm12' ? 'SCORM 1.2' : 'SCORM 2004'} test harness</span>
                </label>
                <p className="help" style={{ marginLeft: '1.5rem', marginTop: '0.2rem' }}>
                  A built-in stand-in for the LMS side of SCORM: it checks what the course sends (start, saving, errors, status, bookmark) and records every call.
                </p>
                {harness && (
                  <details className="advanced" style={{ marginTop: '0.5rem', marginBottom: '0.5rem' }}>
                    <summary>Optional: check that a path through the course ends with Passed or Failed{journeys.length ? ` (${journeys.length} added)` : ''}</summary>
                    <div style={{ marginTop: '0.5rem' }}>
                      <ScormJourneys version={ins.kind === 'scorm12' ? '1.2' : '2004'} value={journeys} onChange={setJourneys} />
                    </div>
                  </details>
                )}
              </div>
            )}

            <details className="advanced" style={{ marginTop: '0.5rem', marginBottom: '1rem' }}>
              <summary>Outside websites whitelist (optional)</summary>
              <div className="field" style={{ marginTop: '0.5rem' }}>
                <label htmlFor="pkg-allowed">Outside websites the package may load from (optional, one per line)</label>
                <textarea id="pkg-allowed" rows={2} placeholder="https://fonts.example.com" value={allowed} onChange={(e) => setAllowed(e.target.value)} />
                <p className="help">Anything else outside the package is blocked and listed in the results.</p>
              </div>
            </details>

            <div style={{ background: '#f8fafc', padding: '0.75rem', borderRadius: '6px', border: '1px solid #e2e8f0', marginBottom: '1rem' }}>
              <label className="checkbox" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', cursor: 'pointer' }}>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} style={{ marginTop: '0.2rem' }} />
                <span style={{ fontSize: '0.9rem', color: '#1e293b' }}>
                  I understand a scan runs this package's own JavaScript in a browser on this computer. It is limited to the package's own address and the sites above, but it does not run in a container.
                </span>
              </label>
            </div>

            {problem && (
              <p role="alert" className="error-text" style={{ marginBottom: '1rem' }}>
                {problem}
              </p>
            )}

            <div>
              <button
                type="button"
                className="btn btn-primary"
                style={{ fontSize: '1rem', padding: '0.65rem 1.4rem' }}
                disabled={busy || !ack || effective.length === 0}
                onClick={start}
              >
                {busy ? 'Starting…' : `Scan ${effective.length || ''} lesson${effective.length === 1 ? '' : 's'}`}
              </button>
            </div>
          </>
        )}
      </div>

      <ReadinessCard ins={ins} />

      {/* Collapsible Inspection Details */}
      <details className="card">
        <summary style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Checks on the package files ({ins.issues.length} checks)</span>
          <span className={`badge ${failedCount > 0 ? 'status-failed' : 'status-completed'}`}>
            {failedCount > 0 ? `${failedCount} problem${failedCount === 1 ? '' : 's'}` : 'All passed'}
          </span>
        </summary>
        <div style={{ marginTop: '1rem' }}>
          <p className="help">Read from the files only. No course code was run for these.</p>
          <TableScroll label="Static package checks">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Check</th>
                  <th scope="col">Result</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {ins.issues.map((i, n) => (
                  <tr key={n}>
                    <th scope="row">{i.ruleId}</th>
                    <td>
                      <strong>{OUTCOME[i.outcome]}</strong>
                    </td>
                    <td>
                      {i.title && <strong>{i.title}. </strong>}
                      {i.detail}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          <ul className="help">
            {ins.limits.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      </details>

      <details className="card">
        <summary style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Contents and outside websites ({ins.inventory.files} files · {mb(ins.inventory.bytes)})</span>
          <span className="badge">
            {ins.externalDependencies.length} external dependenc{ins.externalDependencies.length === 1 ? 'y' : 'ies'}
          </span>
        </summary>
        <div style={{ marginTop: '1rem' }}>
          <TableScroll label="Package contents by file type">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">File type</th>
                  <th scope="col">Files</th>
                  <th scope="col">Size</th>
                </tr>
              </thead>
              <tbody>
                {ins.inventory.byType.slice(0, 12).map((t) => (
                  <tr key={t.type}>
                    <th scope="row">{t.type}</th>
                    <td>{t.files}</td>
                    <td>{mb(t.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          {ins.authoringTool && (
            <div>
              <p>
                <strong>Made with:</strong> {ins.authoringTool.product}
                {ins.authoringTool.version ? ` (build ${ins.authoringTool.version})` : ''}. {ins.authoringTool.facts.map((f) => `${f.label}: ${f.value}`).join(' · ')}
              </p>
              <p className="help">
                Recognized by the {ins.authoringTool.tool === 'rise' ? 'Rise' : 'Storyline'} adapter (version {ins.authoringTool.adapterVersion}). With no journey written, a scan runs: {ins.authoringTool.scenarios.join('; ')}. The adapter does not reach inside canvas or script-drawn content, and the settings above are what the export file states, not what an LMS will do.
              </p>
            </div>
          )}
          <p>
            <strong>Outside websites referenced:</strong>{' '}
            {ins.externalDependencies.length ? ins.externalDependencies.map((d) => d.host).join(', ') : "none found in the course's own files"}
            {ins.runtimeReferences?.length ? ` (plus ${ins.runtimeReferences.length} in ${ins.authoringTool?.product ?? 'the authoring tool'}'s own player code, listed in the inspection data)` : ''}
          </p>
        </div>
      </details>
    </section>
  );
}
