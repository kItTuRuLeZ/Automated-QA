import { ErrorBox, Loading, useLoader } from '../components/ui';
import { api } from '../api';

const LABEL = { available: 'Available', blocked: 'Blocked', unavailable: 'Off', not_included: 'Not included' } as const;

export function AboutPage() {
  const { data, error, reload } = useLoader(() => api.capabilities(), []);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  return (
    <>
      <h1>About this installation</h1>
      <p className="muted">
        What this copy of the app can and cannot do right now. A blocked or missing item is never treated as a pass. <a href="#/">Back to projects</a>
      </p>
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
    </>
  );
}
