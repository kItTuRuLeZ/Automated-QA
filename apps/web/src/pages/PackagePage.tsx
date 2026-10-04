import { useState } from 'react';
import { ApiError, api } from '../api';
import { type JourneyDraft, ScormJourneys, emptyJourney, journeysToApi } from '../components/ScormJourneys';
import { ErrorBox, Loading, TableScroll, useLoader } from '../components/ui';

const KIND = { scorm12: 'SCORM 1.2', scorm2004: 'SCORM 2004', scorm_unknown: 'SCORM (version unclear)', html5: 'Plain HTML5' } as const;
const OUTCOME = { passed: 'Passed', failed: 'Problem', needs_review: 'Check by hand', not_applicable: 'Not applicable', not_tested: 'Not checked' } as const;
const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function PackagePage({ id }: { id: string }) {
  const { data, error, reload } = useLoader(() => api.getPackage(id), [id]);
  const [picked, setPicked] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  const [allowed, setAllowed] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [harness, setHarness] = useState(true);
  const [journeys, setJourneys] = useState<JourneyDraft[]>([emptyJourney('Pass journey'), emptyJourney('Fail journey'), emptyJourney('Leave part-way')]);

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const p = data;
  const ins = p.inspection;
  const choices = ins.launchChoices;
  const effective = choices.length === 1 ? [choices[0]!.key] : picked;

  const start = async () => {
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
      });
      window.location.hash = `/runs/${res.runs[0]!.id}`;
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="pkg-heading">
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <a href={`#/projects/${p.projectId}`}>Project</a> <span aria-hidden="true">/</span> <span aria-current="page">{p.name}</span>
      </nav>
      <h1 id="pkg-heading">{p.name}</h1>
      <p className="muted">
        {KIND[ins.kind]}
        {ins.scormVersionDeclared ? ` (schema version ${ins.scormVersionDeclared})` : ''} · {ins.inventory.files} files · {mb(ins.inventory.bytes)} · uploaded as {p.originalFilename}
      </p>

      <div className="card">
        <h2>Checks on the package files</h2>
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

      <div className="card">
        <h2>Contents and outside websites</h2>
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
        <p>
          <strong>Outside websites referenced:</strong>{' '}
          {ins.externalDependencies.length ? ins.externalDependencies.map((d) => d.host).join(', ') : 'none found in the package text'}
        </p>
      </div>

      <div className="card form">
        <h2>Scan this package</h2>
        {choices.length === 0 ? (
          <p>There is nothing to scan: no launch file was found. Fix the package and upload it again.</p>
        ) : (
          <>
            {choices.length > 1 && (
              <fieldset className="fieldset">
                <legend>Which lessons to scan (each is scanned separately)</legend>
                <p className="help">Lessons you do not pick are listed as not scanned in the results. Nothing is picked for you.</p>
                {choices.map((c) => (
                  <label key={c.key} className="checkbox">
                    <input type="checkbox" checked={picked.includes(c.key)} onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, c.key] : cur.filter((k) => k !== c.key)))} /> {c.title} <span className="muted mono">{c.path}</span>
                  </label>
                ))}
                <button type="button" className="btn btn-small" onClick={() => setPicked(choices.slice(0, 25).map((c) => c.key))}>
                  Pick all
                </button>
              </fieldset>
            )}
            {(ins.kind === 'scorm12' || ins.kind === 'scorm2004') && (
              <>
                <label className="checkbox">
                  <input type="checkbox" checked={harness} onChange={(e) => setHarness(e.target.checked)} /> Also run the {ins.kind === 'scorm12' ? 'SCORM 1.2' : 'SCORM 2004'} test harness
                </label>
                <p className="help">
                  A built-in stand-in for the LMS side of SCORM: it checks what the course sends (start, saving, errors, status, bookmark) and records every call. It is not your LMS, does not run sequencing, and tests one lesson per scan. Nothing it shows says how your LMS will behave.
                </p>
                {harness && <ScormJourneys version={ins.kind === 'scorm12' ? '1.2' : '2004'} value={journeys} onChange={setJourneys} />}
              </>
            )}
            <div className="field">
              <label htmlFor="pkg-allowed">Outside websites the package may load from (optional, one per line)</label>
              <textarea id="pkg-allowed" rows={2} placeholder="https://fonts.example.com" value={allowed} onChange={(e) => setAllowed(e.target.value)} />
              <p className="help">Anything else outside the package is blocked and listed in the results.</p>
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand a scan runs this package's own JavaScript in a browser on this computer. It is limited to the package's own address and the sites above, but it does not run in a container.
            </label>
            {problem && (
              <p role="alert" className="error-text">
                {problem}
              </p>
            )}
            <button type="button" className="btn btn-primary" disabled={busy || !ack || effective.length === 0} onClick={start}>
              {busy ? 'Starting…' : `Scan ${effective.length || ''} lesson${effective.length === 1 ? '' : 's'}`}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
