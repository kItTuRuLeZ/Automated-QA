import { type FormEvent, useState } from 'react';
import { ApiError, type ProfileForm, type ProfileView, api } from '../api';
import { Empty, ErrorBox, Loading, formatDate, useLoader } from '../components/ui';

const SIZES = ['desktop', 'laptop', 'tablet', 'mobile'];
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'];

const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

function toText(p: ProfileView | undefined) {
  return {
    fonts: (p?.brand.approvedFonts ?? []).join('\n'),
    colors: (p?.brand.approvedColors ?? []).map((c) => `${c.name} ${c.value}`).join('\n'),
    terms: (p?.terminology ?? []).map((t) => (t.preferred ? `${t.term} => ${t.preferred}` : t.term)).join('\n'),
    exclusions: (p?.textExclusions ?? []).join('\n'),
    urlPatterns: (p?.linkPolicy.excludedUrlPatterns ?? []).join('\n'),
    origins: (p?.scopeRules.allowedOrigins ?? []).join('\n'),
    prefixes: (p?.scopeRules.allowedPathPrefixes ?? []).join('\n'),
    ruleExclusions: (p?.ruleExclusions ?? []).map((r) => `${r.ruleId} ${r.reason}`).join('\n'),
    overrides: (p?.severityOverrides ?? []).map((o) => `${o.ruleId} ${o.severity} ${o.reason}`).join('\n'),
  };
}

function ProfileEditor({ profile, onDone }: { profile?: ProfileView; onDone: () => void }) {
  const t0 = toText(profile);
  const [name, setName] = useState(profile?.name ?? '');
  const [fonts, setFonts] = useState(t0.fonts);
  const [colors, setColors] = useState(t0.colors);
  const [tolerance, setTolerance] = useState(profile?.brand.colorTolerance?.toString() ?? '');
  const [minSize, setMinSize] = useState(profile?.brand.minTextSizePx?.toString() ?? '');
  const [source, setSource] = useState(profile?.brand.provenance?.note ?? '');
  const [terms, setTerms] = useState(t0.terms);
  const [exclusions, setExclusions] = useState(t0.exclusions);
  const [checkExternal, setCheckExternal] = useState(profile?.linkPolicy.checkExternalLinks ?? true);
  const [urlPatterns, setUrlPatterns] = useState(t0.urlPatterns);
  const [sizes, setSizes] = useState<string[]>(profile?.presets?.viewports ?? []);
  const [loadMs, setLoadMs] = useState(profile?.presets?.thresholds.loadMs?.toString() ?? '');
  const [origins, setOrigins] = useState(t0.origins);
  const [prefixes, setPrefixes] = useState(t0.prefixes);
  const [ruleExclusions, setRuleExclusions] = useState(t0.ruleExclusions);
  const [overrides, setOverrides] = useState(t0.overrides);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const body: ProfileForm = {
        name,
        brand: {
          approvedFonts: lines(fonts),
          approvedColors: lines(colors).map((l) => {
            const m = /^(.*?)\s*(#[0-9a-fA-F]{6})$/.exec(l);
            return { name: m?.[1]?.trim() || l, value: m?.[2] ?? l };
          }),
          colorTolerance: tolerance ? Number(tolerance) : undefined,
          minTextSizePx: minSize ? Number(minSize) : undefined,
          source: source.trim(),
        },
        terminology: lines(terms).map((l) => {
          const [term, preferred] = l.split('=>').map((x) => x.trim());
          return preferred ? { term: term!, preferred } : { term: term! };
        }),
        textExclusions: lines(exclusions),
        linkPolicy: { checkExternalLinks: checkExternal, excludedUrlPatterns: lines(urlPatterns) },
        viewports: sizes,
        thresholds: loadMs ? { loadMs: Number(loadMs) * 1000 } : {},
        scopeRules: { allowedOrigins: lines(origins), allowedPathPrefixes: lines(prefixes) },
        ruleExclusions: lines(ruleExclusions).map((l) => {
          const [ruleId, ...rest] = l.split(/\s+/);
          return { ruleId: ruleId!, reason: rest.join(' ') };
        }),
        severityOverrides: lines(overrides).map((l) => {
          const [ruleId, severity, ...rest] = l.split(/\s+/);
          return { ruleId: ruleId!, severity: severity ?? '', reason: rest.join(' ') };
        }),
      };
      if (profile) await api.updateProfile(profile.id, body);
      else await api.createProfile(body);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? [err.message, ...(err.issues?.map((i) => `${i.path.join('.')}: ${i.message}`) ?? [])].join(' ') : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={submit} aria-labelledby="profile-heading">
      <h2 id="profile-heading">{profile ? `Edit ${profile.name}` : 'New client profile'}</h2>
      <p className="muted">Everything here is typed in by a person. The scanner has no brand rules of its own, and leaving a list empty means that check is off, not that it passes.</p>
      <div className="field">
        <label htmlFor="p-name">Profile name</label>
        <input id="p-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <fieldset className="fieldset">
        <legend>Brand values (optional)</legend>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="p-fonts">Approved fonts</label>
            <textarea id="p-fonts" rows={3} placeholder="Arial" value={fonts} onChange={(e) => setFonts(e.target.value)} aria-describedby="p-fonts-help" />
            <p id="p-fonts-help" className="help">One per line. Compared with the first font the page asks for.</p>
          </div>
          <div className="field">
            <label htmlFor="p-colors">Approved text colours</label>
            <textarea id="p-colors" rows={3} placeholder="Brand blue #1f4e9c" value={colors} onChange={(e) => setColors(e.target.value)} aria-describedby="p-colors-help" />
            <p id="p-colors-help" className="help">One per line: a name, then a hex value. Black, white and grey text is never flagged.</p>
          </div>
          <div className="field">
            <label htmlFor="p-tol">Colour tolerance (CIEDE2000)</label>
            <input id="p-tol" type="number" min={0.5} max={30} step={0.5} placeholder="10" value={tolerance} onChange={(e) => setTolerance(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="p-min">Minimum text size (px)</label>
            <input id="p-min" type="number" min={6} max={48} value={minSize} onChange={(e) => setMinSize(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="p-source">Where these brand values came from</label>
          <input id="p-source" maxLength={300} placeholder="Brand guide v3, page 12" value={source} onChange={(e) => setSource(e.target.value)} aria-describedby="p-source-help" />
          <p id="p-source-help" className="help">Required when any brand value is set. It is printed in the report.</p>
        </div>
      </fieldset>
      <fieldset className="fieldset">
        <legend>Text and links</legend>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="p-terms">Terminology</label>
            <textarea id="p-terms" rows={3} placeholder="learnings => lessons" value={terms} onChange={(e) => setTerms(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="p-excl">Text never to flag</label>
            <textarea id="p-excl" rows={3} value={exclusions} onChange={(e) => setExclusions(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="p-urls">Do not check links containing</label>
            <textarea id="p-urls" rows={3} placeholder="intranet.example.com" value={urlPatterns} onChange={(e) => setUrlPatterns(e.target.value)} />
          </div>
          <div className="field">
            <label className="checkbox">
              <input type="checkbox" checked={checkExternal} onChange={(e) => setCheckExternal(e.target.checked)} /> Check links to other websites
            </label>
            <p className="help">Skipped links are counted in the report, never treated as working.</p>
          </div>
        </div>
      </fieldset>
      <fieldset className="fieldset">
        <legend>Scan defaults</legend>
        <div className="checks-row">
          {SIZES.map((s) => (
            <label key={s} className="checkbox">
              <input type="checkbox" checked={sizes.includes(s)} onChange={(e) => setSizes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))} /> {s}
            </label>
          ))}
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="p-load">Page load warning after (seconds)</label>
            <input id="p-load" type="number" min={1} max={120} value={loadMs} onChange={(e) => setLoadMs(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="p-origins">Additional allowed origins</label>
            <textarea id="p-origins" rows={2} value={origins} onChange={(e) => setOrigins(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="p-prefixes">Allowed path prefixes</label>
            <textarea id="p-prefixes" rows={2} value={prefixes} onChange={(e) => setPrefixes(e.target.value)} />
          </div>
        </div>
      </fieldset>
      <fieldset className="fieldset">
        <legend>Rules</legend>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="p-rx">Switch off rules</label>
            <textarea id="p-rx" rows={3} placeholder="BRD-003 Legal text is allowed to be small" value={ruleExclusions} onChange={(e) => setRuleExclusions(e.target.value)} aria-describedby="p-rx-help" />
            <p id="p-rx-help" className="help">One per line: rule ID, then the reason. Shown in reports as switched off, never as passed.</p>
          </div>
          <div className="field">
            <label htmlFor="p-ov">Change priority</label>
            <textarea id="p-ov" rows={3} placeholder={`BRD-001 high Client treats font misuse as serious`} value={overrides} onChange={(e) => setOverrides(e.target.value)} aria-describedby="p-ov-help" />
            <p id="p-ov-help" className="help">One per line: rule ID, then {SEVERITIES.join(', ')}, then the reason.</p>
          </div>
        </div>
      </fieldset>
      {error && <div role="alert" className="error-box">{error}</div>}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save profile'}
        </button>{' '}
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ProfilesPage() {
  const { data, error, reload } = useLoader(() => api.listProfiles(), []);
  const [editing, setEditing] = useState<ProfileView | 'new' | undefined>();
  const [deleteError, setDeleteError] = useState<string>();

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  if (editing)
    return (
      <ProfileEditor
        profile={editing === 'new' ? undefined : editing}
        onDone={() => {
          setEditing(undefined);
          reload();
        }}
      />
    );
  return (
    <>
      <h1>Client settings</h1>
      <p className="muted">Optional. Client settings hold one client’s brand fonts and colours, terms to flag, link and screen-size preferences, and any rules to switch off. Choose one when you start a scan so the same checks are applied the same way each time.</p>
      <p className="muted">
        A profile holds one client's own settings. Scans without a profile use neutral settings and run no brand checks. <a href="#/">Back to projects</a>
      </p>
      <p>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
          New profile
        </button>
      </p>
      {deleteError && <p role="alert" className="error-text">{deleteError}</p>}
      {data.length === 0 ? (
        <Empty title="No profiles yet">Create one when a client has brand values or terms to check against.</Empty>
      ) : (
        <ul className="issues">
          {data.map((p) => (
            <li key={p.id}>
              <strong>{p.name}</strong> <span className="muted">updated {formatDate(p.updatedAt)}</span>
              <p className="help">
                {p.brand.approvedFonts.length} font(s), {p.brand.approvedColors.length} colour(s){p.brand.minTextSizePx ? `, minimum ${p.brand.minTextSizePx} px` : ''}
                {p.brand.provenance?.note ? ` · source: ${p.brand.provenance.note}` : ''} · {p.ruleExclusions.length} rule(s) switched off
              </p>
              <button type="button" className="btn btn-small" onClick={() => setEditing(p)}>
                Edit
              </button>{' '}
              <button
                type="button"
                className="btn btn-small btn-danger"
                onClick={async () => {
                  if (!window.confirm(`Delete the profile "${p.name}"? Past scans keep their own copy of its settings.`)) return;
                  try {
                    await api.deleteProfile(p.id);
                    reload();
                  } catch (e) {
                    setDeleteError((e as Error).message);
                  }
                }}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
