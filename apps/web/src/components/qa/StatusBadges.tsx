import type { ScreenBadge, ScreenStatus } from '@cqa/shared';
import { BADGE_LABEL, SCREEN_STATUS_LABEL, TEST_STATUS_LABEL } from '../../api-qa';

const ICON: Record<ScreenStatus, string> = { not_tested: '○', in_progress: '◔', issues_found: '✕', needs_manual_review: '?', passed_automated: '✓' };

/** Status in words with a symbol, so color is never the only cue. */
export function ScreenStatusBadge({ status }: { status: ScreenStatus }) {
  return (
    <span className={`badge screen-${status}`}>
      <span aria-hidden="true">{ICON[status]}</span> {SCREEN_STATUS_LABEL[status]}
    </span>
  );
}

export function BadgeList({ badges }: { badges: ScreenBadge[] }) {
  if (badges.length === 0) return null;
  return (
    <span className="badge-list">
      {badges.map((b) => (
        <span key={b} className="badge badge-quiet">
          {BADGE_LABEL[b]}
        </span>
      ))}
    </span>
  );
}

const TEST_ICON: Record<string, string> = { passed: '✓', failed: '✕', blocked: '⊘', error: '!', skipped: '⤼', manual_review_required: '?', not_applicable: '–', pending: '○', running: '◔' };

export function TestStatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge test-${status}`}>
      <span aria-hidden="true">{TEST_ICON[status] ?? '·'}</span> {TEST_STATUS_LABEL[status] ?? status}
    </span>
  );
}
