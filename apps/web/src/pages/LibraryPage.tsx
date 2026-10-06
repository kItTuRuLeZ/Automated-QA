import { type ChangeEvent, useMemo, useState } from 'react';
import { type ImportPreview, type LibraryCase, qaApi } from '../api-qa';
import { ExportMenu } from '../components/ExportMenu';
import { Alert, Breadcrumb, ErrorBox, Loading, PageHeader, Pagination, TableScroll, useLoader } from '../components/ui';

const AUTOMATION_LABEL: Record<string, string> = { automated: 'Automated', partially_automated: 'Partly automated', manual: 'Manual' };
const REVIEW_LABEL: Record<string, string> = { starter: 'Starter (not reviewed)', draft: 'Draft', reviewed: 'Reviewed', approved: 'Approved', retired: 'Retired' };
const SOURCE_LABEL: Record<string, string> = { approved_case: 'A reviewer-approved case', specification: 'A specification or storyboard', extracted_metadata: 'Extracted from the course files', starter_baseline: 'Starter baseline (not a client requirement)', observed_hypothesis: 'Observed behavior, not yet confirmed' };
const PAGE = 25;

export function LibraryPage() {
  const lib = useLoader(() => qaApi.library(), []);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [automation, setAutomation] = useState('');
  const [review, setReview] = useState('');
  const [page, setPage] = useState(0);
  const [openId, setOpenId] = useState<string>();
  const [showImport, setShowImport] = useState(false);

  const defs = lib.data?.definitions ?? [];
  const categories = useMemo(() => [...new Set(defs.map((d) => d.category))].sort(), [defs]);
  const needle = q.trim().toLowerCase();
  const list = defs.filter((d) => (!category || d.category === category) && (!automation || d.effectiveAutomation === automation) && (!review || d.reviewState === review) && (!needle || `${d.id} ${d.externalId ?? ''} ${d.title} ${d.category} ${d.body.expectedResult}`.toLowerCase().includes(needle)));
  const safePage = Math.min(page, Math.max(0, Math.ceil(list.length / PAGE) - 1));
  const shown = list.slice(safePage * PAGE, safePage * PAGE + PAGE);
  const counts = (key: 'effectiveAutomation' | 'reviewState') => defs.reduce<Record<string, number>>((m, d) => ((m[d[key]] = (m[d[key]] ?? 0) + 1), m), {});
  const byAuto = counts('effectiveAutomation');

  return (
    <section aria-labelledby="lib-h">
      <Breadcrumb items={[{ label: 'Projects', to: '/' }, { label: 'Test library' }]} />
      <PageHeader
        title="Test library"
        titleId="lib-h"
        subtitle="Reusable test cases the scanner runs, and the cases your team adds. Starter cases are a baseline, not client requirements."
        actions={
          <>
            <ExportMenu
              label="Export cases"
              items={[
                { key: 'lib-xlsx', label: 'Excel (.xlsx)', scope: 'Every case, one row each, to edit and bring back with Import.', href: '/api/test-library/export.xlsx' },
                { key: 'lib-csv', label: 'CSV', scope: 'The same table as plain text.', href: '/api/test-library/export.csv' },
                { key: 'lib-tpl', label: 'Empty template (CSV)', scope: 'The columns the importer understands, with one example row.', href: '/api/test-library/template.csv' },
              ]}
              technical={[{ key: 'lib-json', label: 'JSON (with structured steps)', scope: 'Every case including its structured actions and checks.', href: '/api/test-library/export.json' }]}
            />
            <button type="button" className="btn" onClick={() => setShowImport((s) => !s)} aria-expanded={showImport}>
              Import team cases
            </button>
            <button type="button" className="btn btn-primary" onClick={() => setOpenId('__new__')}>
              New case
            </button>
          </>
        }
      />
      {showImport && <ImportPanel onDone={() => (lib.reload(), setShowImport(false))} />}
      {lib.error ? (
        <ErrorBox error={lib.error} onRetry={lib.reload} />
      ) : !lib.data ? (
        <Loading />
      ) : (
        <>
          <Alert tone="note">
            {lib.data.total} cases: {byAuto.automated ?? 0} automated, {byAuto.partially_automated ?? 0} partly automated, {byAuto.manual ?? 0} manual. “Automated” means this scanner really performs the case today, judged against the starter baseline unless a reviewer approves different wording. Manual cases appear in each scan’s manual review queue.
          </Alert>
          <div className="lib-filters" role="search" aria-label="Filter test cases">
            <div className="field">
              <label htmlFor="lib-q">Search</label>
              <input id="lib-q" type="search" value={q} onChange={(e) => (setQ(e.target.value), setPage(0))} placeholder="ID, team ID, title or expected result" />
            </div>
            <div className="field">
              <label htmlFor="lib-c">Category</label>
              <select id="lib-c" value={category} onChange={(e) => (setCategory(e.target.value), setPage(0))}>
                <option value="">All categories</option>
                {categories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="lib-a">Automation</label>
              <select id="lib-a" value={automation} onChange={(e) => (setAutomation(e.target.value), setPage(0))}>
                <option value="">Any</option>
                {Object.entries(AUTOMATION_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="lib-r">Approval</label>
              <select id="lib-r" value={review} onChange={(e) => (setReview(e.target.value), setPage(0))}>
                <option value="">Any</option>
                {Object.entries(REVIEW_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p className="muted" role="status">
            Showing {list.length} of {defs.length} cases.
          </p>
          <TableScroll label="Test cases">
            <table className="table">
              <caption className="sr-only">Test cases</caption>
              <thead>
                <tr>
                  <th scope="col">Case</th>
                  <th scope="col">Category</th>
                  <th scope="col">Automation</th>
                  <th scope="col">Approval</th>
                  <th scope="col">Version</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((d) => (
                  <tr key={d.id}>
                    <th scope="row">
                      <button type="button" className="link-button" onClick={() => setOpenId(d.id)}>
                        {d.id}: {d.title}
                      </button>
                      {d.externalId && d.externalId !== d.id && <span className="help block">Team ID {d.externalId}</span>}
                    </th>
                    <td>{d.category}</td>
                    <td>{AUTOMATION_LABEL[d.effectiveAutomation]}</td>
                    <td>{REVIEW_LABEL[d.reviewState]}</td>
                    <td>{d.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          <Pagination page={safePage} pageSize={PAGE} total={list.length} onPage={setPage} label="Test cases" />
        </>
      )}
      {openId && <CaseEditor key={openId} id={openId} onClose={() => setOpenId(undefined)} onSaved={() => lib.reload()} existing={defs.find((d) => d.id === openId)} />}
    </section>
  );
}

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function CaseEditor({ id, existing, onClose, onSaved }: { id: string; existing?: LibraryCase; onClose: () => void; onSaved: () => void }) {
  const creating = id === '__new__';
  const detail = useLoader(() => (creating ? Promise.resolve(undefined) : qaApi.libraryCase(id)), [id]);
  const base = detail.data?.definition ?? existing;
  const [f, setF] = useState<Record<string, string>>({});
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string>();
  const [actor, setActor] = useState(() => {
    try {
      return localStorage.getItem('cqa-actor') ?? '';
    } catch {
      return '';
    }
  });
  if (!creating && !base) return <Loading />;
  const val = (k: string, fallback: string) => f[k] ?? fallback;
  const set = (k: string) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => (setF((cur) => ({ ...cur, [k]: e.target.value })), setState('idle'));
  const b = base?.body;
  const allManual = b ? b.actions.every((a) => a.kind === 'manual') : true;

  const save = async () => {
    setState('saving');
    setError(undefined);
    try {
      const newId = val('id', base?.id ?? '').trim();
      const def = {
        id: creating ? newId : base!.id,
        externalId: val('externalId', base?.externalId ?? '').trim() || undefined,
        title: val('title', base?.title ?? ''),
        category: val('category', base?.category ?? ''),
        interactionType: val('interactionType', base?.interactionType ?? 'general'),
        severity: val('severity', base?.severity ?? 'medium'),
        priority: Number(val('priority', String(base?.priority ?? 2))),
        automation: base?.automation ?? 'manual',
        reviewState: val('reviewState', base?.reviewState ?? 'draft'),
        body: {
          preconditions: lines(val('preconditions', (b?.preconditions ?? []).join('\n'))),
          applicability: val('applicability', b?.applicability ?? ''),
          actions: allManual ? lines(val('steps', (b?.actions ?? []).map((a) => (a.kind === 'manual' ? a.instruction : '')).join('\n'))).map((instruction) => ({ kind: 'manual', instruction })) : b!.actions,
          assertions: b?.assertions ?? [{ kind: 'manual_review', question: val('expectedResult', '') || 'Does the course behave as the case describes?' }],
          resetPolicy: val('resetPolicy', b?.resetPolicy ?? 'none'),
          timeoutMs: Number(val('timeoutMs', String(b?.timeoutMs ?? 15000))),
          expectedResult: val('expectedResult', b?.expectedResult ?? ''),
          expectationSource: val('expectationSource', b?.expectationSource ?? 'approved_case'),
          evidence: lines(val('evidence', (b?.evidence ?? []).join('\n'))),
          requiredCapability: b?.requiredCapability,
          courseTypes: lines(val('courseTypes', (b?.courseTypes ?? []).join('\n'))),
          environments: b?.environments ?? [],
        },
      };
      if (def.body.actions.length === 0) throw new Error('Add at least one step.');
      if (creating) await qaApi.createCase(def, actor || 'Reviewer');
      else await qaApi.saveCase(def.id, def, actor || 'Reviewer', val('note', ''));
      try {
        localStorage.setItem('cqa-actor', actor);
      } catch {
        /* storage may be unavailable */
      }
      setState('saved');
      onSaved();
      if (creating) onClose();
      else detail.reload();
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  };

  return (
    <section className="card" aria-labelledby="case-h">
      <div className="toolbar">
        <h2 id="case-h">{creating ? 'New test case' : `${base!.id}: ${base!.title}`}</h2>
        <button type="button" className="btn btn-small" onClick={onClose}>
          Close
        </button>
      </div>
      {!creating && base && (
        <Alert tone={base.effectiveAutomation === 'manual' ? 'note' : 'ok'}>
          <strong>{AUTOMATION_LABEL[base.effectiveAutomation]}.</strong> {base.effectiveAutomation === 'manual' ? 'The scanner does not perform this case. It appears in each scan’s manual review queue.' : `The scanner performs this case using the capability “${base.body.requiredCapability}”. Changing the wording here does not change what the scanner does.`} Version {base.version}.
        </Alert>
      )}
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="form-grid">
          {creating && (
            <div className="field">
              <label htmlFor="c-id">ID</label>
              <input id="c-id" required value={val('id', '')} onChange={set('id')} maxLength={64} />
              <p className="help">Letters, digits, dot, dash. Cannot be changed later.</p>
            </div>
          )}
          <div className="field">
            <label htmlFor="c-ext">Team ID (optional)</label>
            <input id="c-ext" value={val('externalId', base?.externalId ?? '')} onChange={set('externalId')} maxLength={120} />
          </div>
          <div className="field">
            <label htmlFor="c-title">Title</label>
            <input id="c-title" required value={val('title', base?.title ?? '')} onChange={set('title')} maxLength={200} />
          </div>
          <div className="field">
            <label htmlFor="c-cat">Category</label>
            <input id="c-cat" required value={val('category', base?.category ?? '')} onChange={set('category')} maxLength={80} />
          </div>
          <div className="field">
            <label htmlFor="c-sev">Severity</label>
            <select id="c-sev" value={val('severity', base?.severity ?? 'medium')} onChange={set('severity')}>
              {['critical', 'high', 'medium', 'low'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="c-pri">Priority</label>
            <select id="c-pri" value={val('priority', String(base?.priority ?? 2))} onChange={set('priority')}>
              {['1', '2', '3'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="c-rev">Approval</label>
            <select id="c-rev" value={val('reviewState', base?.reviewState ?? 'draft')} onChange={set('reviewState')}>
              {Object.entries(REVIEW_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="c-src">Where the expected result comes from</label>
            <select id="c-src" value={val('expectationSource', b?.expectationSource ?? 'approved_case')} onChange={set('expectationSource')}>
              {Object.entries(SOURCE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="c-pre">Preconditions (one per line)</label>
          <textarea id="c-pre" rows={2} value={val('preconditions', (b?.preconditions ?? []).join('\n'))} onChange={set('preconditions')} />
        </div>
        <div className="field">
          <label htmlFor="c-app">When it applies</label>
          <textarea id="c-app" rows={2} value={val('applicability', b?.applicability ?? '')} onChange={set('applicability')} />
        </div>
        {allManual ? (
          <div className="field">
            <label htmlFor="c-steps">Steps (one per line, in order)</label>
            <textarea id="c-steps" rows={4} value={val('steps', (b?.actions ?? []).map((a) => (a.kind === 'manual' ? a.instruction : '')).join('\n'))} onChange={set('steps')} />
          </div>
        ) : (
          <div className="field">
            <p className="label">Steps the scanner performs (fixed)</p>
            <ol>
              {b!.actions.map((a, i) => (
                <li key={i}>
                  {a.kind.replace(/_/g, ' ')} {'target' in a ? a.target : 'group' in a ? a.group : ''}
                </li>
              ))}
            </ol>
          </div>
        )}
        <div className="field">
          <label htmlFor="c-exp">Expected result</label>
          <textarea id="c-exp" rows={2} required value={val('expectedResult', b?.expectedResult ?? '')} onChange={set('expectedResult')} />
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="c-ev">Evidence to keep (one per line)</label>
            <textarea id="c-ev" rows={2} value={val('evidence', (b?.evidence ?? []).join('\n'))} onChange={set('evidence')} />
          </div>
          <div className="field">
            <label htmlFor="c-ct">Course types (one per line)</label>
            <textarea id="c-ct" rows={2} value={val('courseTypes', (b?.courseTypes ?? []).join('\n'))} onChange={set('courseTypes')} />
          </div>
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="c-name">Your name</label>
            <input id="c-name" value={actor} onChange={(e) => setActor(e.target.value)} maxLength={60} placeholder="Reviewer" />
          </div>
          {!creating && (
            <div className="field">
              <label htmlFor="c-note">What did you change?</label>
              <input id="c-note" value={val('note', '')} onChange={set('note')} maxLength={500} />
            </div>
          )}
        </div>
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={state === 'saving'}>
            {state === 'saving' ? 'Saving…' : creating ? 'Create case' : 'Save as a new version'}
          </button>
          <span className="save-feedback" role="status" aria-live="polite">
            {state === 'saved' ? 'Saved' : ''}
          </span>
          {state === 'error' && (
            <span role="alert" className="error-text">
              Not saved: {error}
            </span>
          )}
        </div>
      </form>
      {detail.data && detail.data.history.length > 0 && (
        <details>
          <summary>Version history ({detail.data.history.length})</summary>
          <ul className="plain">
            {detail.data.history.map((h) => (
              <li key={h.version}>
                Version {h.version} · {new Date(h.at).toLocaleString()} · {h.actor}: {h.note || '—'} <span className="muted">({REVIEW_LABEL[h.reviewState]})</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function ImportPanel({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<{ format: 'csv' | 'json' | 'xlsx'; content: string; name: string }>();
  const [preview, setPreview] = useState<ImportPreview>();
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [dupes, setDupes] = useState<'skip' | 'replace'>('skip');
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string }>();
  const [busy, setBusy] = useState(false);

  const read = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    setPreview(undefined);
    setMessage(undefined);
    if (!f) return;
    const ext = f.name.toLowerCase().split('.').pop();
    const format = ext === 'xlsx' ? 'xlsx' : ext === 'json' ? 'json' : ext === 'csv' ? 'csv' : undefined;
    if (!format) return setMessage({ tone: 'error', text: 'That file type is not supported. Use a .csv, .xlsx or .json file. Word documents and PDFs cannot be imported; copy the cases into the template instead.' });
    if (f.size > 4 * 1024 * 1024) return setMessage({ tone: 'error', text: 'That file is larger than 4 MB. Split it into smaller files.' });
    const content = format === 'xlsx' ? btoa(String.fromCharCode(...new Uint8Array(await f.arrayBuffer()))) : await f.text();
    setFile({ format, content, name: f.name });
    await run({ format, content }, undefined);
  };
  const run = async (src: { format: 'csv' | 'json' | 'xlsx'; content: string }, map?: Record<string, string>) => {
    setBusy(true);
    try {
      const p = await qaApi.previewImport({ ...src, mapping: map });
      setPreview(p);
      setMapping(p.mapping);
      setMessage(undefined);
    } catch (err) {
      setMessage({ tone: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    if (!file || busy) return;
    setBusy(true);
    try {
      const r = await qaApi.commitImport({ format: file.format, content: file.content, mapping, duplicates: dupes, actor: (() => { try { return localStorage.getItem('cqa-actor') ?? undefined; } catch { return undefined; } })() });
      setMessage({ tone: 'ok', text: `Imported: ${r.created} new, ${r.replaced} replaced, ${r.skipped} skipped, ${r.invalid} not imported because of problems.` });
      onDone();
    } catch (err) {
      setMessage({ tone: 'error', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="imp-h">
      <h2 id="imp-h">Import team cases</h2>
      <p className="muted">Bring cases in from a CSV, Excel or JSON file. Nothing is saved until you have seen the preview. Team IDs and wording are kept exactly. Imported cases start as drafts and are manual unless they name something the scanner can really do. Steps are never run as code.</p>
      <div className="field">
        <label htmlFor="imp-file">File (.csv, .xlsx or .json)</label>
        <input id="imp-file" type="file" accept=".csv,.xlsx,.json" onChange={read} />
        <p className="help">
          Need a layout? <a href="/api/test-library/template.csv">Download the template</a>.
        </p>
      </div>
      {message && <Alert tone={message.tone === 'ok' ? 'ok' : 'error'} live>{message.text}</Alert>}
      {preview && file && (
        <>
          {preview.headers.length > 0 && (
            <fieldset className="fieldset">
              <legend>Which of your columns is which?</legend>
              <p className="help">The importer suggested these. Change any that are wrong, then preview again.</p>
              <div className="form-grid">
                {preview.columns.map((col) => (
                  <div className="field" key={col}>
                    <label htmlFor={`map-${col}`}>{col.replace(/_/g, ' ')}</label>
                    <select id={`map-${col}`} value={mapping[col] ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [col]: e.target.value }))}>
                      <option value="">(none)</option>
                      {preview.headers.map((h) => (
                        <option key={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => run(file, Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)))}>
                Preview again with these columns
              </button>
            </fieldset>
          )}
          <p role="status">
            <strong>{preview.summary.rows}</strong> rows: <strong>{preview.summary.new}</strong> new, <strong>{preview.summary.duplicates}</strong> already exist, <strong>{preview.summary.invalid}</strong> have problems and will not be imported.
          </p>
          <TableScroll label="Import preview">
            <table className="table">
              <caption className="sr-only">Import preview, one row per case in the file</caption>
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">ID</th>
                  <th scope="col">Title</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, 200).map((r) => (
                  <tr key={r.row}>
                    <td>{r.row}</td>
                    <td>{r.externalId ?? r.id}</td>
                    <td>{r.title ?? ''}</td>
                    <td>{r.status === 'new' ? 'New' : r.status === 'duplicate' ? `Already exists as ${r.existing?.id} (version ${r.existing?.version})` : `Problem: ${r.problems.join(' ')}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          {preview.summary.duplicates > 0 && (
            <fieldset className="fieldset">
              <legend>For cases that already exist</legend>
              <label className="choice">
                <input type="radio" name="dupes" checked={dupes === 'skip'} onChange={() => setDupes('skip')} /> <span><strong>Skip them</strong><span className="help">Keep what is in the library now.</span></span>
              </label>
              <label className="choice">
                <input type="radio" name="dupes" checked={dupes === 'replace'} onChange={() => setDupes('replace')} /> <span><strong>Replace them</strong><span className="help">Save the file’s version as a new version; the old one stays in the history.</span></span>
              </label>
            </fieldset>
          )}
          <button type="button" className="btn btn-primary" disabled={busy || preview.summary.new + preview.summary.duplicates === 0} onClick={commit}>
            {busy ? 'Working…' : `Import ${preview.summary.new + (dupes === 'replace' ? preview.summary.duplicates : 0)} cases`}
          </button>
        </>
      )}
    </section>
  );
}
