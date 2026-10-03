import type { CheckResult, Finding, ScanRun } from '@cqa/shared';
import { api } from '../api';
import { Loading, SeverityBadge, useLoader } from './ui';

/** Accessibility and keyboard summary, the compliance disclaimer, and the manual review checklist. */
export function Accessibility({ run, checks, findings }: { run: ScanRun; checks?: CheckResult[]; findings?: Finding[] }) {
  const checklist = useLoader(() => api.manualChecklist(), []);
  const enabled = run.config.engines.accessibility;
  const axe = (checks ?? []).filter((c) => c.ruleId.startsWith('A11Y-AXE-'));
  const kbd = (checks ?? []).filter((c) => c.ruleId.startsWith('KBD-'));
  const a11yFindings = (findings ?? []).filter((f) => f.category === 'accessibility' || f.category === 'keyboard');
  const engine = axe.find((c) => c.engineVersion)?.engineVersion;
  const count = (list: CheckResult[], o: CheckResult['outcome']) => list.filter((c) => c.outcome === o).length;
  const uniqueAxe = new Set(axe.map((c) => c.ruleId)).size;

  return (
    <section aria-labelledby="a11y-heading" className="card">
      <h2 id="a11y-heading">Accessibility and keyboard</h2>
      <p className="alert alert-note" role="note">
        {checklist.data?.disclaimer ?? 'Automated checks find a subset of accessibility problems. A clean automated result does not mean the course is accessible or compliant.'}
      </p>
      {!enabled ? (
        <p className="muted">Accessibility checks were turned off for this scan.</p>
      ) : !checks ? (
        <Loading />
      ) : (
        <>
          <dl className="kv">
            <div>
              <dt>Engine</dt>
              <dd>{engine ?? '—'}</dd>
            </div>
            <div>
              <dt>Automated rules</dt>
              <dd>
                {uniqueAxe} evaluated across {axe.length} executions: {count(axe, 'failed')} failed, {count(axe, 'needs_review')} need review, {count(axe, 'passed')} passed,{' '}
                {count(axe, 'not_applicable')} not applicable
              </dd>
            </div>
            <div>
              <dt>Keyboard checks</dt>
              <dd>
                {kbd.length} executions: {count(kbd, 'failed')} failed, {count(kbd, 'needs_review')} need review, {count(kbd, 'passed')} passed, {count(kbd, 'not_applicable')} not applicable,{' '}
                {count(kbd, 'not_tested') + count(kbd, 'error')} not tested or errored
              </dd>
            </div>
            <div>
              <dt>Findings</dt>
              <dd>{a11yFindings.length}</dd>
            </div>
          </dl>
          {a11yFindings.length > 0 && (
            <>
              <h3>Most serious</h3>
              <ul className="plain">
                {a11yFindings.slice(0, 5).map((f) => (
                  <li key={f.id}>
                    <SeverityBadge severity={f.severity} /> <a href={`#/findings/${f.id}`}>{f.title}</a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <details className="manual">
        <summary>
          <h3 className="inline-heading">Manual review checklist ({checklist.data?.items.length ?? '…'} items)</h3>
        </summary>
        <p className="help">These always need a person. They are never counted as tested or passed.</p>
        {checklist.data && (
          <ol className="checklist">
            {checklist.data.items.map((i) => (
              <li key={i.id}>
                <strong>{i.title}</strong> <span className="muted">({i.id})</span>
                <br />
                {i.howToCheck}
                <br />
                <span className="help">Why manual: {i.whyManual}</span>
              </li>
            ))}
          </ol>
        )}
      </details>
    </section>
  );
}
