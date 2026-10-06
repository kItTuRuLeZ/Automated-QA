import { useEffect, useRef, useState } from 'react';

export interface ExportItem {
  key: string;
  label: string;
  /** What this file covers, in plain words: this scan, one course across scans, or every course in the project. */
  scope: string;
  href: string;
  /** Shown when the download fails for this item (for example a PDF needs the browser engine). */
  recovery?: string;
}

function filenameFrom(header: string | null, fallback: string): string {
  const m = header && /filename="?([^";]+)"?/i.exec(header);
  return m?.[1] ?? fallback;
}

/**
 * "Download report" menu. Each item is fetched, so the button shows that the file is being prepared,
 * a second click while it is preparing does nothing, and a failure is shown with a way forward
 * instead of a browser error page.
 */
export function ExportMenu({ label = 'Download report', items, technical = [], align = 'right' }: { label?: string; items: ExportItem[]; technical?: ExportItem[]; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string }>();
  const button = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const download = async (item: ExportItem) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(item.key);
    setMessage(undefined);
    try {
      const res = await fetch(item.href);
      if (res.status === 401) {
        window.location.assign('/login');
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `The server answered ${res.status}.`);
      }
      const blob = await res.blob();
      const name = filenameFrom(res.headers.get('Content-Disposition'), `${item.key}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setMessage({ tone: 'ok', text: `${item.label} downloaded as ${name}.` });
      setOpen(false);
    } catch (e) {
      setMessage({ tone: 'error', text: `${item.label} could not be created. ${(e as Error).message}${item.recovery ? ` ${item.recovery}` : ''}` });
    } finally {
      busyRef.current = false;
      setBusy(undefined);
    }
  };

  const row = (item: ExportItem) => (
    <li key={item.key}>
      <button type="button" className="menu-item" onClick={() => void download(item)} disabled={busy !== undefined} aria-describedby={`exp-${item.key}`}>
        {busy === item.key ? 'Preparing…' : item.label}
      </button>
      <span id={`exp-${item.key}`} className="help">
        {item.scope}
      </span>
    </li>
  );

  return (
    <div className="menu" ref={root}>
      <button type="button" ref={button} className="btn btn-primary" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
        {busy ? 'Preparing…' : label} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className={`menu-panel menu-${align}`}>
          <ul className="menu-list">{items.map(row)}</ul>
          {technical.length > 0 && (
            <>
              <p className="menu-heading">Technical exports</p>
              <ul className="menu-list">{technical.map(row)}</ul>
            </>
          )}
          <p className="help menu-note">Editing a downloaded Excel tracker does not change anything in this app.</p>
        </div>
      )}
      <div aria-live="polite" className="menu-message">
        {message && <span className={message.tone === 'error' ? 'error-text' : 'muted'}>{message.text}</span>}
      </div>
    </div>
  );
}
