import { Alert, Breadcrumb, ErrorBox, Loading, PageHeader, TableScroll, useLoader } from '../components/ui';
import { api } from '../api';

const LABEL = { available: 'Available', blocked: 'Blocked', unavailable: 'Off', not_included: 'Not included' } as const;

/** Help: how to use the app in plain words, and System status that leads with readiness. */
export function HelpPage() {
  const { data, error, reload } = useLoader(() => api.capabilities(), []);
  const blocked = data?.filter((c) => c.status === 'blocked' && (c.id === 'browser' || c.id === 'pdf')) ?? [];

  return (
    <section aria-labelledby="help-heading">
      <Breadcrumb items={[{ label: 'Projects', to: '/' }, { label: 'Help' }]} />
      <PageHeader title="Help" titleId="help-heading" subtitle="How the app works and whether this computer is ready to scan." />

      <div className="card">
        <h2>How to check a course</h2>
        <ol className="steps">
          <li>
            <strong>Create a project</strong> for a course (or a set of related scans).
          </li>
          <li>
            <strong>Start a scan.</strong> Paste the published link, or upload the course ZIP. Choose the checks, then start.
          </li>
          <li>
            <strong>Review the results.</strong> “Issues to fix” are confirmed problems. “Needs your review” are things the scanner could not decide. “Coverage gaps” are areas it could not look at; they are not passes.
          </li>
          <li>
            <strong>Assign and track fixes.</strong> Set an owner and a status on each issue. “Marked fixed” is your note that the change was made.
          </li>
          <li>
            <strong>Retest.</strong> A retest scans again with the same settings. Only a retest can set an issue to “Verified”.
          </li>
          <li>
            <strong>Download a report</strong> (Excel tracker, PDF or HTML) to share.
          </li>
        </ol>
        <p className="help">
          <strong>Client settings</strong> are optional. They hold one client’s brand fonts and colours, terms to flag, and link and screen-size preferences, so the same checks are applied the same way each time.
        </p>
      </div>

      <div className="card">
        <h2>What a result does and does not tell you</h2>
        <ul>
          <li>A finished scan is not a QA pass. Checks that did not run, and areas that were not reached, are listed as gaps.</li>
          <li>A timeout is “could not verify”, not a confirmed broken link.</li>
          <li>Screen sizes are simulated in a desktop browser, not tested on real phones or tablets.</li>
          <li>Automated accessibility checks find only some problems. A manual review is still needed.</li>
          <li>Results for SCORM packages come from a test harness. They are not LMS results.</li>
        </ul>
      </div>

      <h2 id="status-heading">System status</h2>
      {error ? (
        <ErrorBox error={error} onRetry={reload} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          {blocked.length === 0 ? (
            <Alert tone="ok" title="Ready to scan." live>
              The scanning browser is installed, so scans and PDF reports can run.
            </Alert>
          ) : (
            <Alert tone="error" title="Not ready to scan." live>
              {blocked.map((c) => `${c.name}: ${c.detail}`).join(' ')}
            </Alert>
          )}
          <details className="card">
            <summary>
              <h3 className="inline-heading">Technical details: what this installation can and cannot do ({data.length} items)</h3>
            </summary>
            <p className="help">A blocked or missing item is never treated as a pass.</p>
            <TableScroll label="Capabilities of this installation">
              <table className="table">
                <caption className="sr-only">Capabilities of this installation</caption>
                <thead>
                  <tr>
                    <th scope="col">Capability</th>
                    <th scope="col">Status</th>
                    <th scope="col">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((c) => (
                    <tr key={c.id}>
                      <th scope="row">{c.name}</th>
                      <td>
                        <strong>{LABEL[c.status]}</strong>
                      </td>
                      <td>{c.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </details>
        </>
      )}
    </section>
  );
}
