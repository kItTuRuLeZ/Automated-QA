import { type FormEvent, useState } from 'react';
import { ApiError, api } from '../api';
import { Empty, ErrorBox, Loading, formatDate, useLoader } from './ui';

/** Upload a course ZIP to a project and list the packages already uploaded. */
export function PackagesPanel({ projectId }: { projectId: string }) {
  const { data, error, reload } = useLoader(() => api.listPackages(projectId), [projectId]);
  const [file, setFile] = useState<File | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const pkg = await api.uploadPackage(projectId, file);
      window.location.hash = `/packages/${pkg.id}`;
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : String(err));
      reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="packages-heading">
      <h2 id="packages-heading">Course packages</h2>
      <p className="muted">
        Upload a published course as a ZIP (SCORM 1.2, SCORM 2004, or plain HTML5). It is inspected without running anything; a scan then opens it from a separate local address. Packages are read only here, never edited.
      </p>
      <form onSubmit={submit} className="form" aria-label="Upload a course package">
        <div className="field">
          <label htmlFor="pkg-file">Package ZIP file</label>
          <input id="pkg-file" type="file" accept=".zip,application/zip" onChange={(e) => setFile(e.target.files?.[0])} />
        </div>
        <button type="submit" className="btn btn-primary" disabled={!file || busy}>
          {busy ? 'Checking the package…' : 'Upload and inspect'}
        </button>
        {message && (
          <p role="alert" className="error-text">
            Not accepted: {message}
          </p>
        )}
      </form>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : !data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty title="No packages yet" />
      ) : (
        <ul className="plain">
          {data.map((p) => (
            <li key={p.id}>
              <a href={`#/packages/${p.id}`}>{p.name}</a> <span className="muted">· {p.inspection.kind === 'html5' ? 'HTML5' : p.inspection.kind === 'scorm12' ? 'SCORM 1.2' : p.inspection.kind === 'scorm2004' ? 'SCORM 2004' : 'SCORM (version unclear)'} · {p.inspection.launchChoices.length} launch point(s) · uploaded {formatDate(p.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
