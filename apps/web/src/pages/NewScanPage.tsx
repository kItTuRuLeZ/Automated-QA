import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { qaApi } from '../api-qa';
import { UploadBox } from '../components/Packages';
import { Alert, Breadcrumb, ErrorBox, Loading, PageHeader, hostPath, useLoader } from '../components/ui';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, label: 'Desktop' },
  { name: 'laptop', width: 1366, height: 768, label: 'Laptop' },
  { name: 'tablet', width: 768, height: 1024, label: 'Tablet' },
  { name: 'mobile', width: 390, height: 844, label: 'Mobile' },
] as const;
type VpName = (typeof VIEWPORTS)[number]['name'];
type Source = 'link' | 'zip';

const STEPS = ['Choose your course', 'Choose checks', 'Review and start'];

const lines = (s: string) =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Plain-language message for a failed scan request. Distinguishes a blocked address from an invalid form value or a stopped worker. */
export function explainScanError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'NET-001' || /private|loopback|reserved|blocked/i.test(err.message)) {
      return `This address cannot be scanned: ${err.message} Private, local and reserved network addresses are blocked on purpose. Use the published link that people outside your network can open.`;
    }
    if (err.issues?.length) return `Some settings are not valid: ${err.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; ')}. Fix them under the heading they belong to and try again.`;
    return `${err.message} Nothing was started.`;
  }
  if (err instanceof TypeError) return 'The app could not be reached. Check that it is still running on this computer, then try again. Your answers are kept.';
  return String(err);
}

/**
 * Guided three-stage scan setup. All values live in this component, so Back and Next never lose them, and values under
 * "Advanced settings" are sent even when that section is closed.
 */
export function NewScanPage({ projectId, presetUrl }: { projectId: string; presetUrl?: string }) {
  const project = useLoader(() => api.getProject(projectId), [projectId]);
  const profiles = useLoader(() => api.listProfiles(), []);
  const caps = useLoader(() => api.capabilities(), []);

  const [step, setStep] = useState(0);
  const [source, setSource] = useState<Source>('link');
  const [url, setUrl] = useState(presetUrl ?? '');
  const [urlTouched, setUrlTouched] = useState(false);
  const [seeded, setSeeded] = useState(Boolean(presetUrl));

  const [qaProfile, setQaProfile] = useState<'quick' | 'functional' | 'full' | 'custom'>('full');
  const [functional, setFunctional] = useState(true);
  const [autoAnswer, setAutoAnswer] = useState(true);
  const [traces, setTraces] = useState(true);
  const library = useLoader(() => qaApi.library(), []);
  const [explore, setExplore] = useState(true);
  const [accessibility, setAccessibility] = useState(true);
  // Choosing a preset sets the individual checks; changing one of them by hand makes it Custom.
  const choose = (p: 'quick' | 'functional' | 'full' | 'custom') => {
    setQaProfile(p);
    if (p === 'quick') (setExplore(false), setAccessibility(false), setLayout(false), setFunctional(false));
    if (p === 'functional') (setExplore(true), setAccessibility(false), setLayout(false), setFunctional(true));
    if (p === 'full') (setExplore(true), setAccessibility(true), setLayout(true), setFunctional(true));
  };
  const custom = <T,>(set: (v: T) => void) => (v: T) => (set(v), setQaProfile('custom'));
  const [layout, setLayout] = useState(true);
  const [sizes, setSizes] = useState<VpName[]>(['desktop']);
  const [sizesTouched, setSizesTouched] = useState(false);
  const [profileId, setProfileId] = useState('');

  // Advanced
  const [origins, setOrigins] = useState('');
  const [prefixes, setPrefixes] = useState('');
  const [timeoutSec, setTimeoutSec] = useState(30);
  const [maxStates, setMaxStates] = useState(25);
  const [maxDepth, setMaxDepth] = useState(4);
  const [compareBaseline, setCompareBaseline] = useState(false);
  const [testNonResponsive, setTestNonResponsive] = useState(false);
  const [terms, setTerms] = useState('');
  const [exclusions, setExclusions] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const busyRef = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);

  // Fill the course link from the project once, without overwriting what the person typed.
  useEffect(() => {
    if (!seeded && project.data) {
      setSeeded(true);
      if (project.data.courseUrl) setUrl(project.data.courseUrl);
    }
  }, [project.data, seeded]);
  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  if (project.error) return <ErrorBox error={project.error} onRetry={project.reload} />;
  if (!project.data) return <Loading />;
  const p = project.data;

  let urlProblem: string | undefined;
  if (!url.trim()) urlProblem = 'Enter the published link of the course.';
  else {
    try {
      const u = new URL(url.trim());
      if (u.protocol !== 'http:' && u.protocol !== 'https:') urlProblem = 'The link must start with http:// or https://.';
    } catch {
      urlProblem = 'That does not look like a web address. It should look like https://example.com/course/.';
    }
  }
  const browserBlocked = caps.data?.find((c) => c.id === 'browser')?.status === 'blocked';
  const profileName = profiles.data?.find((x) => x.id === profileId)?.name;
  const sizeList = VIEWPORTS.filter((v) => sizes.includes(v.name));

  const next = () => {
    setError(undefined);
    if (step === 0) {
      setUrlTouched(true);
      if (source === 'link' && urlProblem) return;
    }
    setStep((s) => Math.min(2, s + 1));
  };
  const back = () => (setError(undefined), setStep((s) => Math.max(0, s - 1)));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (step < 2) {
      // Enter in a field means "Next", never "Start".
      if (!(step === 0 && source === 'zip')) next();
      return;
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const run = await api.createScan(projectId, {
        url: url.trim(),
        allowedOrigins: lines(origins),
        allowedPathPrefixes: lines(prefixes),
        navigationTimeoutMs: timeoutSec * 1000,
        profileId: profileId || undefined,
        viewports: profileId && !sizesTouched ? undefined : (VIEWPORTS.map((v) => v.name).filter((n) => sizes.includes(n)) as VpName[]),
        layout,
        compareBaseline: layout && compareBaseline,
        testNonResponsive: layout && testNonResponsive,
        explore,
        accessibility,
        functional,
        autoAnswer: functional && autoAnswer,
        traces: traces ? 'first_failure' : 'off',
        qaProfile,
        maxStates,
        maxDepth,
        terminology:
          terms.trim() === ''
            ? undefined
            : terms
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .map((l) => {
                const [term, preferred] = l.split('=>').map((x) => x.trim());
                return preferred ? { term: term!, preferred } : { term: term! };
              }),
        textExclusions: exclusions
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      });
      window.location.hash = `/runs/${run.id}`;
    } catch (err) {
      setError(explainScanError(err));
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="scan-heading">
      <Breadcrumb items={[{ label: 'Projects', to: '/' }, { label: p.name, to: `/projects/${projectId}` }, { label: 'New scan' }]} />
      <PageHeader title="Start a new scan" titleId="scan-heading" subtitle={`For ${p.name}`} />

      <ol className="steps-bar" aria-label="Scan setup steps">
        {STEPS.map((label, i) => (
          <li key={label} aria-current={i === step ? 'step' : undefined} className={i === step ? 'current' : i < step ? 'done' : ''}>
            <span className="step-num" aria-hidden="true">
              {i + 1}
            </span>
            {label}
            {i < step && <span className="sr-only"> (completed)</span>}
          </li>
        ))}
      </ol>

      <form className="card form narrow-wide" onSubmit={submit} noValidate>
        {step === 0 && (
          <div>
            <h2 ref={heading} tabIndex={-1}>
              1. Choose your course
            </h2>
            <fieldset className="fieldset">
              <legend>Where is the course?</legend>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '0.75rem', marginTop: '0.5rem' }}>
                <label
                  className="choice"
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.75rem',
                    padding: '0.85rem',
                    borderRadius: '8px',
                    border: source === 'link' ? '2px solid #2563eb' : '1px solid #cbd5e1',
                    background: source === 'link' ? '#eff6ff' : '#ffffff',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <input type="radio" name="source" checked={source === 'link'} onChange={() => setSource('link')} style={{ marginTop: '0.2rem' }} />
                  <span>
                    <strong style={{ fontSize: '0.95rem' }}>Published link</strong>
                    <span className="help" style={{ margin: '0.2rem 0 0', fontSize: '0.82rem', color: '#475569' }}>
                      A web address people can open, such as a Rise share link or hosted course.
                    </span>
                  </span>
                </label>
                <label
                  className="choice"
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.75rem',
                    padding: '0.85rem',
                    borderRadius: '8px',
                    border: source === 'zip' ? '2px solid #2563eb' : '1px solid #cbd5e1',
                    background: source === 'zip' ? '#eff6ff' : '#ffffff',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <input type="radio" name="source" checked={source === 'zip'} onChange={() => setSource('zip')} style={{ marginTop: '0.2rem' }} />
                  <span>
                    <strong style={{ fontSize: '0.95rem' }}>Upload course ZIP</strong>
                    <span className="help" style={{ margin: '0.2rem 0 0', fontSize: '0.82rem', color: '#475569' }}>
                      SCORM or HTML5 export. Inspected first; nothing runs until confirmed.
                    </span>
                  </span>
                </label>
              </div>
            </fieldset>
            {source === 'link' ? (
              <div className="field" style={{ marginTop: '1rem' }}>
                <label htmlFor="s-url" style={{ fontSize: '0.95rem', fontWeight: 600 }}>Course link</label>
                <input
                  id="s-url"
                  type="url"
                  inputMode="url"
                  placeholder="https://"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onBlur={() => setUrlTouched(true)}
                  aria-invalid={urlTouched && Boolean(urlProblem)}
                  aria-describedby={urlTouched && urlProblem ? 's-url-err' : 's-url-help'}
                  autoComplete="off"
                  style={{
                    width: '100%',
                    padding: '0.65rem 0.85rem',
                    fontSize: '1rem',
                    borderRadius: '6px',
                    border: urlTouched && urlProblem ? '1px solid #dc2626' : '1px solid #cbd5e1',
                  }}
                />
                {urlTouched && urlProblem ? (
                  <p id="s-url-err" className="error-text" role="alert" style={{ marginTop: '0.35rem' }}>
                    {urlProblem}
                  </p>
                ) : (
                  <p id="s-url-help" className="help">
                    Private, local and reserved network addresses are blocked on purpose.
                  </p>
                )}
              </div>
            ) : (
              <div style={{ marginTop: '1rem' }}>
                <UploadBox projectId={projectId} />
                <p className="help">After the upload you will see what the ZIP contains, which platform made it and which lessons it has, then choose the lessons to scan.</p>
              </div>
            )}
          </div>
        )}

        {step === 1 && (
          <div>
            <h2 ref={heading} tabIndex={-1}>
              2. Choose checks
            </h2>
            <p className="muted" style={{ marginBottom: '1rem' }}>The recommended selection is already chosen. Change it only if you need to.</p>

            <div style={{ background: '#f8fafc', padding: '0.75rem 1rem', borderRadius: '6px', border: '1px solid #e2e8f0', marginBottom: '1.25rem', fontSize: '0.875rem' }}>
              <strong>Always checked:</strong> Opening page loads, scripts run without errors, images and media load, links work, and placeholder text (like “lorem ipsum” or “TBD”) is flagged.
            </div>

            <fieldset className="fieldset" style={{ marginBottom: '1.25rem' }}>
              <legend>How thorough?</legend>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0.75rem', marginTop: '0.5rem' }}>
                {(
                  [
                    ['full', 'Full available check', 'Interactive exploration, accessibility (axe-core), layout & responsiveness, and functional rules.', '🚀 Recommended'],
                    ['functional', 'Functional check', 'Opens course in browser, clicks through it, and runs interaction cases on recognized controls.', '⚡ Standard'],
                    ['quick', 'Quick check', 'Landing page only: checks link health, media, scripts, and placeholder text.', '⏱️ Fast'],
                    ['custom', 'Custom', 'Select specific automated checks, budgets, and viewports by hand.', '⚙️ Manual'],
                  ] as const
                ).map(([id, label, help, badge]) => (
                  <label
                    key={id}
                    className="choice"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      padding: '0.85rem',
                      borderRadius: '8px',
                      border: qaProfile === id ? '2px solid #2563eb' : '1px solid #cbd5e1',
                      background: qaProfile === id ? '#eff6ff' : '#ffffff',
                      cursor: 'pointer',
                      transition: 'border-color 0.15s ease, background-color 0.15s ease',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: '0.35rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <input type="radio" name="qa-profile" checked={qaProfile === id} onChange={() => choose(id)} />
                        <strong style={{ fontSize: '0.95rem' }}>{label}</strong>
                      </div>
                      <span className="badge" style={{ fontSize: '0.72rem', padding: '0.1rem 0.45rem' }}>{badge}</span>
                    </div>
                    <span className="help" style={{ margin: 0, fontSize: '0.82rem', color: '#475569' }}>{help}</span>
                  </label>
                ))}
              </div>

              <div className="profile-lists" aria-live="polite" style={{ marginTop: '0.85rem', padding: '0.75rem 1rem', background: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0', fontSize: '0.85rem' }}>
                <p style={{ margin: '0 0 0.35rem' }}>
                  <strong>Will run:</strong> opening page, scripts, images and media, links, placeholder text{explore ? ', click-through exploration' : ''}
                  {functional ? ', interaction cases (tabs, accordions, dialogs, Next/Previous) and your behavior rules' : ''}
                  {accessibility ? ', accessibility and keyboard checks' : ''}
                  {layout ? ', layout and page load' : ''}.
                </p>
                {functional && library.data && (
                  <p style={{ margin: '0 0 0.35rem', color: '#475569' }}>
                    <strong>Manual review queue:</strong> {library.data.definitions.filter((d) => d.effectiveAutomation === 'manual' && d.reviewState !== 'retired').length} non-automated cases (quizzes, drag and drop, media playback) queued for manual check.
                  </p>
                )}
                {!functional && <p style={{ margin: 0, color: '#475569' }}><strong>Not run:</strong> interaction cases and behavior rules. Interaction behavior is not executed in this profile, so a clean result says nothing about it.</p>}
              </div>
            </fieldset>

            <fieldset className="fieldset" style={{ marginBottom: '1.25rem' }}>
              <legend>Checks in detail</legend>
              <div style={{ display: 'grid', gap: '0.5rem', marginTop: '0.35rem' }}>
                <label className="checkbox" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={explore} onChange={(e) => custom(setExplore)(e.target.checked)} style={{ marginTop: '0.2rem' }} />
                  <span><strong>Click through the course (read-only)</strong><span className="help">Opens recognized tabs, accordions, pop-ups and Next/Back buttons without submitting forms.</span></span>
                </label>
                <label className="checkbox" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={accessibility} onChange={(e) => custom(setAccessibility)(e.target.checked)} style={{ marginTop: '0.2rem' }} />
                  <span><strong>Accessibility and keyboard checks</strong><span className="help">Automated checks with axe-core, tab focus traps, and 320px reflow.</span></span>
                </label>
                <label className="checkbox" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={layout} onChange={(e) => custom(setLayout)(e.target.checked)} style={{ marginTop: '0.2rem' }} />
                  <span><strong>Layout, screen sizes and page load</strong><span className="help">Checks for text clipping, overflow, and element overlap at multiple viewports.</span></span>
                </label>
                <label className="checkbox" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={functional} disabled={!explore && qaProfile !== 'custom'} onChange={(e) => custom(setFunctional)(e.target.checked)} style={{ marginTop: '0.2rem' }} />
                  <span><strong>Interaction cases and behavior rules</strong><span className="help">Runs project behavior rules and interaction checks on tabs, popups, and navigation.</span></span>
                </label>
                <label className="checkbox" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={autoAnswer} disabled={!functional} onChange={(e) => setAutoAnswer(e.target.checked)} style={{ marginTop: '0.2rem' }} />
                  <span><strong>Answer quiz questions automatically</strong><span className="help">Selects answers and submits to proceed past blocking quiz gates.</span></span>
                </label>
                <label className="checkbox" style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <input type="checkbox" checked={traces} disabled={!functional} onChange={(e) => setTraces(e.target.checked)} style={{ marginTop: '0.2rem' }} />
                  <span><strong>Keep a browser trace when a check fails</strong><span className="help">If a check fails, a step-by-step browser recording is kept for it. It can include page content and network data, so turn this off for courses with sensitive information.</span></span>
                </label>
              </div>
            </fieldset>

            <fieldset className="fieldset" style={{ marginBottom: '1.25rem' }}>
              <legend>Screen sizes</legend>
              <p className="help" style={{ marginBottom: '0.75rem' }}>Tested in simulated viewports. The primary size explores the course; other sizes verify responsive reflow.</p>
              <div className="checks-row" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                {VIEWPORTS.map((v) => (
                  <label
                    key={v.name}
                    className="checkbox"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.5rem',
                      padding: '0.45rem 0.85rem',
                      borderRadius: '6px',
                      border: sizes.includes(v.name) ? '1px solid #2563eb' : '1px solid #cbd5e1',
                      background: sizes.includes(v.name) ? '#eff6ff' : '#ffffff',
                      cursor: !layout ? 'not-allowed' : 'pointer',
                      opacity: !layout ? 0.6 : 1,
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={sizes.includes(v.name)}
                      disabled={!layout || (sizes.length === 1 && sizes.includes(v.name))}
                      onChange={(e) => (setSizesTouched(true), setSizes((cur) => (e.target.checked ? [...cur, v.name] : cur.filter((n) => n !== v.name))))}
                    />{' '}
                    <span style={{ fontWeight: 500, fontSize: '0.9rem' }}>
                      {v.label} <span className="muted" style={{ fontSize: '0.8rem' }}>({v.width}×{v.height})</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="field" style={{ marginBottom: '1.25rem' }}>
              <label htmlFor="s-profile">Client settings (optional)</label>
              <select id="s-profile" value={profileId} onChange={(e) => setProfileId(e.target.value)} aria-describedby="s-profile-help">
                <option value="">None (standard checks)</option>
                {(profiles.data ?? []).map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.name}
                  </option>
                ))}
              </select>
              <p id="s-profile-help" className="help">
                A client’s brand colors, forbidden words, link policy, and custom screen sizes. <a href="#/profiles">Manage client settings</a>
              </p>
            </div>

            <details className="advanced" style={{ marginTop: '1.25rem' }}>
              <summary>Advanced settings</summary>
              <p className="help" style={{ marginBottom: '0.75rem' }}>Defaults suit most courses. These values are used even while this section is closed.</p>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="s-origins">Other websites this course needs</label>
                  <textarea id="s-origins" rows={2} placeholder="https://cdn.example.com" value={origins} onChange={(e) => setOrigins(e.target.value)} aria-describedby="s-origins-help" />
                  <p id="s-origins-help" className="help">
                    Exact addresses for media or course resources, one per line. The course’s own site is always allowed.
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="s-prefixes">Limit scanning to these course paths</label>
                  <textarea id="s-prefixes" rows={2} placeholder="/course/" value={prefixes} onChange={(e) => setPrefixes(e.target.value)} aria-describedby="s-prefixes-help" />
                  <p id="s-prefixes-help" className="help">
                    Leave empty to use normal scope (the whole course origin).
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="s-timeout">Time allowed to open a page (seconds)</label>
                  <input id="s-timeout" type="number" min={1} max={120} required value={timeoutSec} onChange={(e) => setTimeoutSec(Number(e.target.value))} aria-describedby="s-timeout-help" />
                  <p id="s-timeout-help" className="help">
                    1 to 120. A page that takes longer is reported as “could not verify”.
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="s-states">Maximum screens or interaction views</label>
                  <input id="s-states" type="number" min={1} max={200} required disabled={!explore} value={maxStates} onChange={(e) => setMaxStates(Number(e.target.value))} aria-describedby="s-states-help" />
                  <p id="s-states-help" className="help">
                    1 to 200. A view may be a tab or pop-up, not only a lesson.
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="s-depth">Maximum steps from the start</label>
                  <input id="s-depth" type="number" min={0} max={10} required disabled={!explore} value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))} aria-describedby="s-depth-help" />
                  <p id="s-depth-help" className="help">
                    0 to 10. A limit on how far exploration travels from start.
                  </p>
                </div>
              </div>
              <label className="checkbox" style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
                <input type="checkbox" checked={compareBaseline} disabled={!layout} onChange={(e) => setCompareBaseline(e.target.checked)} /> <span><strong>Compare with an earlier scan</strong><span className="help">Uses a saved baseline from an earlier finished scan of the same course.</span></span>
              </label>
              <label className="checkbox" style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
                <input type="checkbox" checked={testNonResponsive} disabled={!layout} onChange={(e) => setTestNonResponsive(e.target.checked)} /> <span><strong>Test other screen sizes even for Storyline courses</strong><span className="help">Not recommended: Storyline stages are fixed-size by design.</span></span>
              </label>
              <div className="grid-2" style={{ marginTop: '0.75rem' }}>
                <div className="field">
                  <label htmlFor="s-terms">Terms to flag</label>
                  <textarea id="s-terms" rows={3} placeholder={'e-learning => eLearning'} value={terms} onChange={(e) => setTerms(e.target.value)} aria-describedby="s-terms-help" />
                  <p id="s-terms-help" className="help">
                    One per line. Use “term =&gt; preferred” to suggest replacement.
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="s-excl">Never flag text containing</label>
                  <textarea id="s-excl" rows={3} placeholder="XXX Series" value={exclusions} onChange={(e) => setExclusions(e.target.value)} aria-describedby="s-excl-help" />
                  <p id="s-excl-help" className="help">
                    One per line. For intentional uses of words like TBD.
                  </p>
                </div>
              </div>
            </details>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 ref={heading} tabIndex={-1}>
              3. Review and start
            </h2>
            <div style={{ background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '1.25rem', marginBottom: '1.25rem' }}>
              <dl className="kv review" style={{ margin: 0 }}>
                <div>
                  <dt>Course</dt>
                  <dd>
                    <span title={url} style={{ fontWeight: 600 }}>{hostPath(url)}</span> <span className="muted">(published link)</span>
                  </dd>
                </div>
                <div>
                  <dt>Checks</dt>
                  <dd>
                    Page, links, images and text{explore ? '; click-through' : ''}
                    {accessibility ? '; accessibility and keyboard' : ''}
                    {layout ? '; layout and page load' : ''}
                    {!explore && <span className="muted"> · only the opening page will be checked</span>}
                  </dd>
                </div>
                <div>
                  <dt>Screen sizes</dt>
                  <dd>{layout ? sizeList.map((v) => `${v.label} ${v.width}×${v.height}`).join(', ') || 'Desktop' : 'Not checked'} <span className="muted">(simulated)</span></dd>
                </div>
                <div>
                  <dt>Client settings</dt>
                  <dd>{profileName ?? 'None'}</dd>
                </div>
                <div>
                  <dt>Limits</dt>
                  <dd>
                    {explore ? `Up to ${maxStates} screens or views, ${maxDepth} step${maxDepth === 1 ? '' : 's'} from the start. ` : ''}Up to {timeoutSec} s to open a page.
                    {lines(prefixes).length > 0 && ` Only these paths: ${lines(prefixes).join(', ')}.`}
                    {lines(origins).length > 0 && ` Also allowed: ${lines(origins).join(', ')}.`}
                  </dd>
                </div>
              </dl>
            </div>
            <p className="help" style={{ marginBottom: '1rem' }}>
              The scan reads the course like a visitor would. It does not submit forms or click controls that look unsafe (like Submit or Delete), and it does not edit the course. A scan finishing is not a QA pass.
            </p>
            {browserBlocked && (
              <Alert tone="error" title="Scanning is not available on this computer yet." live>
                {caps.data?.find((c) => c.id === 'browser')?.detail ?? 'The scanning browser is not available.'} See <a href="#/help">Help → System status</a>.
              </Alert>
            )}
          </div>
        )}

        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}

        <div className="actions wizard-actions" style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginTop: '1.5rem', paddingTop: '1rem', borderTop: '1px solid #e2e8f0' }}>
          {step > 0 && (
            <button type="button" className="btn" onClick={back} disabled={busy}>
              Back
            </button>
          )}
          {step < 2 && !(step === 0 && source === 'zip') && (
            <button type="button" className="btn btn-primary" onClick={next}>
              Next
            </button>
          )}
          {step === 2 && (
            <button type="submit" className="btn btn-primary" disabled={busy || browserBlocked} style={{ padding: '0.6rem 1.4rem', fontSize: '0.95rem' }}>
              {busy ? 'Starting…' : 'Start scan'}
            </button>
          )}
          <a className="btn btn-quiet" href={`#/projects/${projectId}`}>
            Cancel
          </a>
        </div>
      </form>
    </section>
  );
}
