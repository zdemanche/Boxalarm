import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { listMembers } from '../personnel/api';
import { listExpiringCertifications } from './api';
import { CertificationsPanel } from './CertificationsPanel';

type Tab = 'certifications' | 'expiring';

function ExpiringTab() {
  const auth = useAuth();
  const expiringQuery = useQuery({
    queryKey: ['training', 'certifications', 'expiring'],
    queryFn: () => listExpiringCertifications(auth),
  });

  if (expiringQuery.error) {
    return (
      <ApiForbiddenGate error={expiringQuery.error} embedded>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  if (expiringQuery.isLoading) {
    return <p>Loading expiring certifications…</p>;
  }

  const rows = [...(expiringQuery.data ?? [])].sort((a, b) =>
    a.expiryDate.localeCompare(b.expiryDate),
  );

  if (rows.length === 0) {
    return <p>No certifications are due to expire within the configured window.</p>;
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th scope="col" style={{ textAlign: 'left' }}>
            Member
          </th>
          <th scope="col" style={{ textAlign: 'left' }}>
            Certification
          </th>
          <th scope="col" style={{ textAlign: 'left' }}>
            Expires
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.certId}>
            <td>{row.memberId}</td>
            <td>{row.certType}</td>
            <td>{row.expiryDate}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CertificationsPage() {
  const auth = useAuth();
  const [tab, setTab] = useState<Tab>('certifications');
  const [selectedMemberId, setSelectedMemberId] = useState<string>('');

  const membersQuery = useQuery({
    queryKey: ['personnel', 'members'],
    queryFn: () => listMembers(auth),
  });

  return (
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>Certifications</h1>

      <div
        role="tablist"
        aria-label="Certifications views"
        style={{
          display: 'flex',
          gap: 'var(--boxalarm-spacing-sm)',
          marginTop: 'var(--boxalarm-spacing-md)',
        }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'certifications'}
          onClick={() => setTab('certifications')}
          style={{ minHeight: 44 }}
        >
          Certifications
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'expiring'}
          onClick={() => setTab('expiring')}
          style={{ minHeight: 44 }}
        >
          Expiring
        </button>
      </div>

      {tab === 'certifications' ? (
        <div style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
          <label style={{ display: 'grid', gap: 4, maxWidth: 320 }}>
            Member
            <select
              value={selectedMemberId}
              onChange={(e) => setSelectedMemberId(e.target.value)}
              style={{ minHeight: 44 }}
            >
              <option value="">Select a member…</option>
              {(membersQuery.data ?? []).map((member) => (
                <option key={member.memberId} value={member.memberId}>
                  {member.lastName}, {member.firstName}
                </option>
              ))}
            </select>
          </label>
          {selectedMemberId ? <CertificationsPanel memberId={selectedMemberId} /> : null}
        </div>
      ) : (
        <div style={{ marginTop: 'var(--boxalarm-spacing-lg)' }}>
          <ExpiringTab />
        </div>
      )}
    </main>
  );
}
