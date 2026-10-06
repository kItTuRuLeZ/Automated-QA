import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { qaApi } from '../api-qa';
import { UploadBox } from '../components/Packages';
import { WorkflowSteps } from '../components/qa/WorkflowSteps';
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

      <WorkflowSteps current={step === 0 ? 0 : step === 1 ? 1 : 2} />
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
              <label className="choice">
                <input type="radio" name="source" checked={source === 'link'} onChange={() => setSource('link')} /> <span><strong>Published link</strong><span className="help">A web address people can open, such as a Rise share link or a hosted Storyline course.</span></span>
              </label>
              <label className="choice">
                <input type="radio" name="source" checked={source === 'zip'} onChange={() => setSource('zip')} /> <span><strong>Upload course ZIP</strong><span className="help">A SCORM or HTML5 export. It is inspected first; nothing runs until you confirm.</span></span>
              </label>
            </fieldset>
            {source === 'link' ? (
              <div className="field">
                <label htmlFor="s-url">Course link</label>
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
                />
                {urlTouched && urlProblem ? (
                  <p id="s-url-err" className="error-text" role="alert">
                    {urlProblem}
                  </p>
                ) : (
                  <p id="s-url-help" className="help">
                    Private, local and reserved network addresses are blocked on purpose.
                  </p>
                )}
              </div>
            ) : (
              <div>
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
            <p className="muted">The recommended selection is already chosen. Change it only if you need to.</p>
            <ul className="plain always-on">
              <li>
                <strong>Always checked:</strong> the opening page loads, scripts run without errors, images and media load, links work, and placeholder text (like “lorem ipsum” or “TBD”) is flagged. This is not a spelling or grammar review.
              </li>
            </ul>
            <fieldset className="fieldset">
              <legend>How thorough?</legend>
              {(
                [
                  ['quick', 'Quick check', 'Opens the first page and reads the files. Interaction behavior is not executed.'],
                  ['functional', 'Functional check', 'Opens the course in a browser, clicks through it, and runs the interaction cases and your behavior rules.'],
                  ['full', 'Full available check', 'Everything this tool can actually run, plus a queue of cases that only a person can do. It does not cover all possible course behavior.'],
                  ['custom', 'Custom', 'You choose the checks and screen sizes below.'],
                ] as const
              ).map(([id, label, help]) => (
                <label key={id} className="choice">
                  <input type="radio" name="qa-profile" checked={qaProfile === id} onChange={() => choose(id)} />{' '}
                  <span>
                    <strong>{label}</strong>
                    <span className="help">{help}</span>
                  </span>
                </label>
              ))}
              <div className="profile-lists" aria-live="polite">
                <p>
                  <strong>Will run:</strong> opening page, scripts, images and media, links, placeholder text{explore ? ', click-through exploration' : ''}
                  {functional ? ', interaction cases (tabs, accordions, dialogs, Next/Previous) and your behavior rules' : ''}
                  {accessibility ? ', accessibility and keyboard checks' : ''}
                  {layout ? ', layout and page load' : ''}.
                </p>
                {functional && library.data && (
                  <p>
                    <strong>Manual review queue:</strong> {library.data.definitions.filter((d) => d.effectiveAutomation === 'manual' && d.reviewState !== 'retired').length} cases the tool has no automation for (quizzes, drag and drop, media playback and others) are listed for a person. They are never marked passed.
                  </p>
                )}
                {!functional && <p><strong>Not run:</strong> interaction cases and behavior rules. Interaction behavior is not executed in this profile, so a clean result says nothing about it.</p>}
                <p><strong>Not available in this tool:</strong> real-device testing, a real LMS, drag and drop, video and audio playback, quiz scoring, and exhaustive click orders.</p>
              </div>
            </fieldset>
            <fieldset className="fieldset">
              <legend>Checks in detail</legend>
              <label className="checkbox">
                <input type="checkbox" checked={explore} onChange={(e) => custom(setExplore)(e.target.checked)} /> <span>Click through the course (read-only)<span className="help">Opens recognized tabs, accordions, pop-ups and Next/Back buttons without submitting anything. A scan with this off only checks the opening page.</span></span>
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={accessibility} onChange={(e) => custom(setAccessibility)(e.target.checked)} /> <span>Accessibility and keyboard checks<span className="help">Automated checks find only some problems and cannot confirm the course is accessible. Adds time per screen.</span></span>
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={layout} onChange={(e) => custom(setLayout)(e.target.checked)} /> <span>Layout, screen sizes and page load<span className="help">Looks for text running off screen and elements overlapping, and measures one sample of page load.</span></span>
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={functional} disabled={!explore && qaProfile !== 'custom'} onChange={(e) => custom(setFunctional)(e.target.checked)} /> <span>Interaction cases and behavior rules<span className="help">Runs the test library’s cases on tabs, accordions, dialogs and Next/Previous, and the behavior rules you set up for this project. Each runs on a fresh copy of the screen.</span></span>
              </label>
            </fieldset>
            <fieldset className="fieldset">
              <legend>Screen sizes</legend>
              <p className="help">Simulated in a desktop browser, not tested on real devices. The first size is used to explore the course; the others re-check the first screens reached. Storyline courses are a fixed-size stage and are recognized automatically and tested at the first size only.</p>
              <div className="checks-row">
                {VIEWPORTS.map((v) => (
                  <label key={v.name} className="checkbox">
                    <input
                      type="checkbox"
                      checked={sizes.includes(v.name)}
                      disabled={!layout || (sizes.length === 1 && sizes.includes(v.name))}
                      onChange={(e) => (setSizesTouched(true), setSizes((cur) => (e.target.checked ? [...cur, v.name] : cur.filter((n) => n !== v.name))))}
                    />{' '}
                    <span>
                      {v.label} <span className="muted">{v.width}×{v.height}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="field">
              <label htmlFor="s-profile">Client settings (optional)</label>
              <select id="s-profile" value={profileId} onChange={(e) => setProfileId(e.target.value)} aria-describedby="s-profile-help">
                <option value="">None (no brand checks)</option>
                {(profiles.data ?? []).map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.name}
                  </option>
                ))}
              </select>
              <p id="s-profile-help" className="help">
                A client’s own brand fonts and colours, terms to flag, link policy and screen sizes. The scan keeps a copy, so editing them later does not change past reports. <a href="#/profiles">Manage client settings</a>
              </p>
            </div>

            <details className="advanced">
              <summary>Advanced settings</summary>
              <p className="help">Defaults suit most courses. These values are used even while this section is closed.</p>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="s-origins">Other websites this course needs</label>
                  <textarea id="s-origins" rows={2} placeholder="https://cdn.example.com" value={origins} onChange={(e) => setOrigins(e.target.value)} aria-describedby="s-origins-help" />
                  <p id="s-origins-help" className="help">
                    Exact addresses for media or course resources, one per line. The course’s own site is always allowed. This does not override the blocked-network rules.
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="s-prefixes">Limit scanning to these course paths</label>
                  <textarea id="s-prefixes" rows={2} placeholder="/course/" value={prefixes} onChange={(e) => setPrefixes(e.target.value)} aria-describedby="s-prefixes-help" />
                  <p id="s-prefixes-help" className="help">
                    Leave empty to use the normal course scope (the whole site of the link).
                  </p>
                </div>
                <div className="field">
                  <label htmlFor="s-timeout">Time allowed to open a page (seconds)</label>
                  <input id="s-timeout" type="number" min={1} max={120} required value={timeoutSec} onChange={(e) => setTimeoutSec(Number(e.target.value))} aria-describedby="s-timeout-help" />
                  <p id="s-timeout-help" className="help">
                    1 to 120. A page that takes longer is reported as “could not verify”, not as broken.
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
                    0 to 10. A limit on how far exploration goes, not course completion.
                  </p>
                </div>
              </div>
              <label className="checkbox">
                <input type="checkbox" checked={compareBaseline} disabled={!layout} onChange={(e) => setCompareBaseline(e.target.checked)} /> <span>Compare with an earlier scan<span className="help">Uses a saved baseline from a finished scan of the same course, screen, size, browser and settings. Use on stable pages only. Only available once a baseline has been saved.</span></span>
              </label>
              <label className="checkbox">
                <input type="checkbox" checked={testNonResponsive} disabled={!layout} onChange={(e) => setTestNonResponsive(e.target.checked)} /> <span>Test other screen sizes even for Storyline courses<span className="help">Not recommended: Storyline stages are fixed-size by design.</span></span>
              </label>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="s-terms">Terms to flag</label>
                  <textarea id="s-terms" rows={3} placeholder={'e-learning => eLearning'} value={terms} onChange={(e) => setTerms(e.target.value)} aria-describedby="s-terms-help" />
                  <p id="s-terms-help" className="help">
                    One per line. Use “term =&gt; preferred” to suggest a replacement.
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
            <dl className="kv review">
              <div>
                <dt>Course</dt>
                <dd>
                  <span title={url}>{hostPath(url)}</span> <span className="muted">(published link)</span>
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
            <p className="help">The scan reads the course like a visitor would. It does not submit forms or click controls that look unsafe (like Submit or Delete), and it does not edit the course. A scan finishing is not a QA pass.</p>
            {browserBlocked && (
              <Alert tone="error" title="Scanning is not available on this computer yet." live>
                The scanning browser is not installed. See <a href="#/help">Help → System status</a> for the one-time install step.
              </Alert>
            )}
          </div>
        )}

        {error && (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        )}

        <div className="actions wizard-actions">
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
            <button type="submit" className="btn btn-primary" disabled={busy || browserBlocked}>
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
