import { type DragEvent, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { Empty, ErrorBox, Loading, formatDate, useLoader } from './ui';

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;

export const kindLabel = (k: string) => (k === 'html5' ? 'HTML5' : k === 'scorm12' ? 'SCORM 1.2' : k === 'scorm2004' ? 'SCORM 2004' : 'SCORM (version unclear)');

/** Upload a course ZIP. The file is only inspected here; nothing runs until a scan is started and acknowledged. */
export function UploadBox({ projectId, compact }: { projectId: string; compact?: boolean }) {
  const limits = useLoader(() => api.packageLimits(), []);
  const [file, setFile] = useState<File | undefined>();
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);

  const pick = (f?: File) => {
    setMessage(undefined);
    if (f && !/\.zip$/i.test(f.name)) {
      setMessage('That file is not a ZIP. Upload the exported course as a .zip file.');
      return;
    }
    setFile(f);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    pick(e.dataTransfer.files[0]);
  };

  const submit = async () => {
    if (!file || busyRef.current) return;
    if (limits.data && file.size > limits.data.maxUploadBytes) {
      setMessage(`This file is ${mb(file.size)}. The largest ZIP accepted is ${mb(limits.data.maxUploadBytes)}.`);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setMessage(undefined);
    try {
      const pkg = await api.uploadPackage(projectId, file);
      window.location.hash = `/packages/${pkg.id}`;
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : `The upload did not finish: ${String(err)}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // Not a <form>: this box sits inside the scan setup form, and forms cannot be nested.
  return (
    <div className="form" role="group" aria-label="Upload a course ZIP">
      <div
        className={`dropzone${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => (e.preventDefault(), setDragging(true))}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p>
          <strong>{file ? file.name : 'Drop the course ZIP here'}</strong>
          {file && <span className="muted"> · {mb(file.size)}</span>}
        </p>
        <div className="field">
          <label htmlFor="pkg-file">{file ? 'Choose a different file' : 'Or choose a ZIP file'}</label>
          <input id="pkg-file" ref={input} type="file" accept=".zip,application/zip" onChange={(e) => pick(e.target.files?.[0])} />
        </div>
      </div>
      {!compact && (
        <p className="help">
          Accepted: {(limits.data?.formats ?? ['SCORM 1.2', 'SCORM 2004', 'HTML5']).join(', ')} courses exported as a ZIP{limits.data ? `, up to ${mb(limits.data.maxUploadBytes)} (${limits.data.maxEntries.toLocaleString()} files, ${mb(limits.data.maxExpandedBytes)} once unpacked)` : ''}. The next screen inspects the files without running anything.
        </p>
      )}
      {message && (
        <p role="alert" className="alert alert-error">
          Not accepted: {message}
        </p>
      )}
      <button type="button" className="btn btn-primary" disabled={!file || busy} onClick={() => void submit()}>
        {busy ? 'Uploading and inspecting…' : 'Upload course'}
      </button>
    </div>
  );
}

/** "Course files": the upload form and the packages already uploaded to the project. */
export function PackagesPanel({ projectId }: { projectId: string }) {
  const { data, error, reload } = useLoader(() => api.listPackages(projectId), [projectId]);

  return (
    <section className="card" aria-labelledby="packages-heading">
      <h2 id="packages-heading">Course files</h2>
      <p className="muted">Upload a course exported as a ZIP. It is inspected without running anything; a scan then opens it from a separate local address. Course files are read only here, never edited.</p>
      <UploadBox projectId={projectId} />
      <h3>Uploaded courses</h3>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : !data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty title="No course files yet">Upload a ZIP above to inspect it and scan it.</Empty>
      ) : (
        <ul className="plain">
          {data.map((p) => (
            <li key={p.id}>
              <a href={`#/packages/${p.id}`}>{p.name}</a>{' '}
              <span className="muted">
                · {p.inspection.authoringTool ? `${p.inspection.authoringTool.product} · ` : ''}
                {kindLabel(p.inspection.kind)} · {p.inspection.launchChoices.length} lesson{p.inspection.launchChoices.length === 1 ? '' : 's'} · uploaded {formatDate(p.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
