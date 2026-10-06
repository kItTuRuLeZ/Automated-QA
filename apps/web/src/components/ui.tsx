import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { CheckOutcome, FindingType, RunStatus, Severity } from '@cqa/shared';

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Scan finished',
  partial: 'Partial results',
  failed: 'Scan failed',
  cancelled: 'Cancelled',
};

export const RUN_STATUS_HELP: Record<RunStatus, string> = {
  queued: 'Waiting for the worker to start this scan.',
  running: 'The worker is scanning the course.',
  completed: 'Scan finished. Review the results; a finished scan is not a QA pass.',
  partial: 'The scan finished but some content was outside scope, over budget, or could not be checked.',
  failed: 'The scan could not capture the course. See the reason below.',
  cancelled: 'The scan was cancelled. Checks that did not run are marked not tested.',
};

export const OUTCOME_LABEL: Record<CheckOutcome, string> = {
  passed: 'Passed',
  failed: 'Failed',
  needs_review: 'Needs review',
  not_applicable: 'Not applicable',
  not_tested: 'Not tested',
  error: 'Error',
};

export const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', informational: 'Info' };

export const TYPE_LABEL: Record<FindingType, string> = {
  automated_defect: 'Automated defect',
  standards_warning: 'Standards warning',
  heuristic_warning: 'Heuristic warning',
  ai_recommendation: 'AI recommendation',
  manual_review: 'Manual review',
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`badge status-${status}`}>
      <span aria-hidden="true" className="dot" />
      {RUN_STATUS_LABEL[status]}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`badge sev-${severity}`}>{SEVERITY_LABEL[severity]}</span>;
}

export function OutcomeBadge({ outcome }: { outcome: CheckOutcome }) {
  return <span className={`badge out-${outcome}`}>{OUTCOME_LABEL[outcome]}</span>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="muted" role="status" aria-live="polite">
      {label}
    </p>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="alert alert-error" role="alert">
      <strong>Something went wrong.</strong> {error instanceof Error ? error.message : String(error)}
      {onRetry && (
        <button type="button" className="btn btn-small" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** Loads data with explicit loading/error states; optional polling while `poll` returns true. */
export function useLoader<T>(load: () => Promise<T>, deps: unknown[], poll?: (data: T) => boolean, intervalMs = 1500) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    let wasPolling = false;
    const run = async () => {
      try {
        const d = await loadRef.current();
        if (cancelled) return;
        setData(d);
        setError(undefined);
        wasPolling = Boolean(poll?.(d));
        if (wasPolling) timer = window.setTimeout(run, intervalMs);
      } catch (e) {
        if (cancelled) return;
        setError(e);
        // A scan that was running keeps running when this page loses contact; keep asking, more slowly.
        if (wasPolling) timer = window.setTimeout(run, intervalMs * 3);
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, reload: () => setNonce((n) => n + 1) };
}

export function formatDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export function duration(start?: string, end?: string): string {
  if (!start) return '—';
  const ms = (end ? Date.parse(end) : Date.now()) - Date.parse(start);
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <a href={`#${to}`} className={className}>
      {children}
    </a>
  );
}

/**
 * Lets a wide data table scroll sideways inside its own region instead of
 * forcing the whole page to scroll. The region is focusable so keyboard users
 * can scroll it.
 */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

/** Splits a hash route such as `/runs/abc/issues?action=fix` into path parts and query. */
export function splitRoute(route: string): { parts: string[]; query: URLSearchParams } {
  const [path = '', q = ''] = route.split('?');
  return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(q) };
}

/** A short readable form of an address: host and path, no scheme or query. */
export function hostPath(url?: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    const p = u.pathname === '/' ? '' : u.pathname;
    return `${u.host}${p}`;
  } catch {
    return url;
  }
}

export function Breadcrumb({ items }: { items: Array<{ label: string; to?: string }> }) {
  return (
    <nav aria-label="Breadcrumb" className="breadcrumb">
      <ol>
        {items.map((it, i) => (
          <li key={`${it.label}-${i}`}>
            {it.to ? <Link to={it.to}>{it.label}</Link> : <span aria-current="page">{it.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function PageHeader({ title, titleId, subtitle, actions }: { title: ReactNode; titleId?: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div className="page-title">
        <h1 id={titleId}>{title}</h1>
        {subtitle && <p className="muted page-sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

/** Link-based tabs: each tab is its own address, so refresh and deep links keep working. */
export function TabNav({ label, tabs }: { label: string; tabs: Array<{ to: string; label: string; current: boolean; count?: number }> }) {
  return (
    <nav aria-label={label} className="tabs">
      <ul>
        {tabs.map((t) => (
          <li key={t.to}>
            <a href={`#${t.to}`} aria-current={t.current ? 'page' : undefined} className={t.current ? 'tab current' : 'tab'}>
              {t.label}{' '}
              {t.count !== undefined && <span className="tab-count">{t.count}</span>}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Alert({ tone = 'note', title, children, live }: { tone?: 'note' | 'warn' | 'error' | 'ok'; title?: string; children?: ReactNode; live?: boolean }) {
  return (
    <div className={`alert alert-${tone}`} role={live ? (tone === 'error' ? 'alert' : 'status') : undefined}>
      {title && <strong>{title} </strong>}
      {children}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage, label }: { page: number; pageSize: number; total: number; onPage: (p: number) => void; label: string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <nav className="pagination" aria-label={`${label} pages`}>
      <button type="button" className="btn btn-small" onClick={() => onPage(page - 1)} disabled={page === 0}>
        Previous
      </button>
      <span role="status">
        {from}–{to} of {total}
      </span>
      <button type="button" className="btn btn-small" onClick={() => onPage(page + 1)} disabled={page >= pages - 1}>
        Next
      </button>
    </nav>
  );
}

export function CopyButton({ text, label = 'Copy address' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    window.setTimeout(() => setState('idle'), 2500);
  };
  return (
    <>
      <button type="button" className="btn btn-small btn-quiet" onClick={copy}>
        {label}
      </button>
      <span className="sr-only" role="status">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : ''}
      </span>
      {state !== 'idle' && (
        <span className="muted" aria-hidden="true">
          {state === 'copied' ? 'Copied' : 'Could not copy'}
        </span>
      )}
    </>
  );
}

/** The captured course title when there is one, else a readable form of the address. */
export function courseTitle(states: Array<{ title?: string }> | undefined, url?: string, fallback?: string): string {
  const t = states?.find((s) => s.title && s.title.trim())?.title?.trim();
  return t || fallback || hostPath(url) || 'Course';
}
