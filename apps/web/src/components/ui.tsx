import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { CheckOutcome, FindingType, RunStatus, Severity } from '@cqa/shared';

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Scan completed',
  partial: 'Partial',
  failed: 'Scan failed',
  cancelled: 'Cancelled',
};

export const RUN_STATUS_HELP: Record<RunStatus, string> = {
  queued: 'Waiting for the worker to start this scan.',
  running: 'The worker is scanning the course.',
  completed: 'The configured scan finished. This does not mean the course passed QA; review the findings.',
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
    const run = async () => {
      try {
        const d = await loadRef.current();
        if (cancelled) return;
        setData(d);
        setError(undefined);
        if (poll?.(d)) timer = window.setTimeout(run, intervalMs);
      } catch (e) {
        if (!cancelled) setError(e);
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
