import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { getCompliance } from './api';

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

function toEpochSeconds(isoDate: string): number {
  return Math.floor(new Date(`${isoDate}T00:00:00Z`).getTime() / 1000);
}

export function CompliancePage() {
  const auth = useAuth();
  const [from, setFrom] = useState(daysAgo(7));
  const [to, setTo] = useState(daysAgo(0));

  const query = useQuery({
    queryKey: ['apparatus', 'compliance', from, to],
    queryFn: () => getCompliance(auth, toEpochSeconds(from), toEpochSeconds(to) + 86399),
  });

  if (query.error) {
    return (
      <ApiForbiddenGate error={query.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  return (
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      <p>
        <Link to="/apparatus">← Apparatus</Link>
      </p>
      <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>Check compliance</h1>

      <div
        style={{
          display: 'flex',
          gap: 'var(--boxalarm-spacing-md)',
          marginTop: 'var(--boxalarm-spacing-md)',
        }}
      >
        <label style={{ display: 'grid', gap: 4 }}>
          From
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            style={{ minHeight: 44, padding: '0 12px' }}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          To
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            style={{ minHeight: 44, padding: '0 12px' }}
          />
        </label>
      </div>

      {query.isLoading ? (
        <p>Loading compliance report…</p>
      ) : (
        <table
          style={{
            width: '100%',
            marginTop: 'var(--boxalarm-spacing-lg)',
            borderCollapse: 'collapse',
          }}
        >
          <thead>
            <tr>
              <th scope="col" style={{ textAlign: 'left' }}>
                Unit
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Expected
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Actual
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Compliant
              </th>
            </tr>
          </thead>
          <tbody>
            {(query.data ?? []).map((entry) => (
              <tr key={entry.unitId}>
                <th scope="row" style={{ textAlign: 'left', fontWeight: 500 }}>
                  {entry.unitId}
                </th>
                <td>{entry.expectedChecks}</td>
                <td>{entry.actualChecks}</td>
                <td
                  style={{
                    color: entry.compliant ? 'var(--boxalarm-success)' : 'var(--boxalarm-error)',
                    fontWeight: 600,
                  }}
                >
                  {entry.compliant ? 'Yes' : 'No'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
