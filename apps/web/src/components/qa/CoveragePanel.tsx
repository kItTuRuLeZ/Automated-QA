import type { CoverageSummary, Ratio } from '../../api-qa';
import { Alert, TableScroll } from '../ui';

const text = (r: Ratio, unit: string) => (r.available ? `${r.numerator} of ${r.denominator} ${unit} (${r.percent}%)` : `Not available. ${r.reason}`);

/**
 * The coverage dimensions, kept apart. Each shows its count with its denominator; none is combined into a score, and a
 * missing or unknown denominator says "Not available" with the reason.
 */
export function CoveragePanel({ c, noun }: { c: CoverageSummary; noun: { singular: string; plural: string } }) {
  const tone = c.discovery.completeness === 'complete' && c.gaps.unitsNotVisited === 0 && c.manual.outstanding === 0 ? 'note' : 'warn';
  return (
    <section className="card" aria-labelledby="cov-h">
      <h2 id="cov-h">What this scan covered</h2>
      <Alert tone={tone} title="In one statement:">
        {c.statement}
      </Alert>
      <dl className="dims">
        <div>
          <dt>1. What the course contains</dt>
          <dd>
            <strong>Discovery: {c.discovery.completeness}.</strong> {c.discovery.reason}
            <span className="help block">
              Sources: {Object.entries(c.discovery.bySource).map(([k, v]) => `${v} from ${k.replace(/_/g, ' ')}`).join(', ') || 'none'} · confidence: {c.discovery.byConfidence.high} high, {c.discovery.byConfidence.medium} medium, {c.discovery.byConfidence.low} low · list revision {c.discovery.revision}
            </span>
          </dd>
        </div>
        <div>
          <dt>2. {noun.plural[0]!.toUpperCase() + noun.plural.slice(1)} a browser opened</dt>
          <dd>{text(c.visit, noun.plural)}{c.listedNotTracked > 0 ? <span className="help block">{c.listedNotTracked} more items (blocks, layers, scenes, package items) are listed but not tracked one by one.</span> : null}</dd>
        </div>
        <div>
          <dt>3. Interactions exercised</dt>
          <dd>
            {text(c.interactions.exercised, 'detected interactions')}
            <span className="help block">{c.interactions.total} controls were detected. “Exercised” means a check passed or failed on it, not just that it was clicked during exploration.</span>
          </dd>
        </div>
        <div>
          <dt>4. Automated checks that reached a result</dt>
          <dd>
            {text(c.execution, 'mapped automated checks')}
            <span className="help block">Counts passed and failed only. Blocked, errored, skipped, running and not-yet-run checks do not count as executed.</span>
          </dd>
        </div>
        <div>
          <dt>Pass rate of the executed checks</dt>
          <dd>{text(c.passRate, 'executed checks')}</dd>
        </div>
        <div>
          <dt>5. Branches and states</dt>
          <dd>Reached states are listed on the screens; the total number of states and click orders is not known, so branch coverage is partial by definition. Nothing here claims every path was tried.</dd>
        </div>
        <div>
          <dt>6. Manual review outstanding</dt>
          <dd>
            <strong>{c.manual.outstanding}</strong> check{c.manual.outstanding === 1 ? '' : 's'} need a person. {c.manual.manualOnlyCases} {c.manual.manualOnlyCases === 1 ? 'case has' : 'cases have'} no automation yet.
          </dd>
        </div>
      </dl>
      <p className="help">
        Not run: {c.gaps.blocked} blocked, {c.gaps.errored} runner error{c.gaps.errored === 1 ? '' : 's'}, {c.gaps.skipped} skipped, {c.gaps.pending} waiting. Blocked and errored checks are about the scan, not confirmed course defects.
      </p>
      {c.gaps.unitsNotReached.length > 0 && (
        <details>
          <summary>
            {c.gaps.unitsNotReached.length} {c.gaps.unitsNotReached.length === 1 ? noun.singular : noun.plural} known but not reached
          </summary>
          <TableScroll label="Units not reached">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{noun.singular[0]!.toUpperCase() + noun.singular.slice(1)}</th>
                  <th scope="col">Why it was not reached</th>
                </tr>
              </thead>
              <tbody>
                {c.gaps.unitsNotReached.map((u) => (
                  <tr key={u.id}>
                    <th scope="row">{u.title}</th>
                    <td>{u.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </details>
      )}
    </section>
  );
}
