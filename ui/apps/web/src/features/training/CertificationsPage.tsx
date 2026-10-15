import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Link } from 'react-router-dom';
import {
  Card,
  DataTable,
  PageHeader,
  Select,
  StatusChip,
  Tabs,
  type DataTableColumn,
} from '../../components/ui';
import { daysUntil, formatCalendarDate } from '../../lib/dates';
import { canAccessPath } from '../../routing/routeTable';
import { listMembers } from '../personnel/api';
import type { Member } from '../personnel/types';
import { listExpiringCertifications } from './api';
import { CertificationsPanel } from './CertificationsPanel';
import type { ExpiringCertification } from './types';
import styles from './training.module.css';

type Tab = 'certifications' | 'expiring';

function ExpiringTab({ members }: { members: readonly Member[] | undefined }) {
  const auth = useAuth();
  const canOpenMember = canAccessPath('/personnel', auth.roles);
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

  const rows = [...(expiringQuery.data ?? [])].sort((a, b) =>
    a.expiryDate.localeCompare(b.expiryDate),
  );

  const nameOf = (memberId: string) => {
    const member = members?.find((m) => m.memberId === memberId);
    return member ? `${member.firstName} ${member.lastName}` : memberId;
  };

  const columns: DataTableColumn<ExpiringCertification>[] = [
    {
      key: 'memberId',
      header: 'Member',
      sortValue: (r) => nameOf(r.memberId),
      render: (r) =>
        canOpenMember ? (
          <Link to={`/personnel/${encodeURIComponent(r.memberId)}`}>{nameOf(r.memberId)}</Link>
        ) : (
          nameOf(r.memberId)
        ),
    },
    { key: 'certType', header: 'Certification', render: (r) => r.certType },
    {
      key: 'expiryDate',
      header: 'Expires',
      sortValue: (r) => r.expiryDate,
      render: (r) => <span className={styles.date}>{formatCalendarDate(r.expiryDate)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (r) => r.expiryDate,
      render: (r) => {
        if (r.status === 'REVOKED') return <StatusChip status="neutral">Revoked</StatusChip>;
        const days = daysUntil(r.expiryDate);
        if (r.status === 'EXPIRED' || days < 0)
          return <StatusChip status="danger">Expired</StatusChip>;
        return (
          <StatusChip status="warning">
            {days === 0 ? 'Expires today' : `Expires in ${days} ${days === 1 ? 'day' : 'days'}`}
          </StatusChip>
        );
      },
    },
  ];

  return (
    <DataTable
      caption="Expiring certifications"
      rowKey={(r) => r.certId}
      columns={columns}
      rows={rows}
      loading={expiringQuery.isLoading}
      emptyMessage="No certifications are due to expire within the configured window."
    />
  );
}

export function CertificationsPage() {
  const auth = useAuth();
  // design.md O-11: open on the department's certifications, soonest-expiring first.
  const [tab, setTab] = useState<Tab>('expiring');
  const [selectedMemberId, setSelectedMemberId] = useState<string>('');

  const membersQuery = useQuery({
    queryKey: ['personnel', 'members'],
    queryFn: () => listMembers(auth),
  });

  const selected = membersQuery.data?.find((m) => m.memberId === selectedMemberId);

  return (
    <main id="main-content">
      <PageHeader
        title="Certifications"
        description="What each member holds, and what is about to expire."
      />

      {/* Shared Radix Tabs (PR #321 review m7): tab/tabpanel wiring, aria-controls, roving
          tabindex and arrow-key navigation, instead of a hand-rolled role="tab" row. */}
      <Tabs
        label="Certifications views"
        value={tab}
        onValueChange={(next) => setTab(next as Tab)}
        items={[
          {
            value: 'expiring',
            label: 'Expiring',
            content: (
              <div className={styles.tabPanel}>
                <ExpiringTab members={membersQuery.data} />
              </div>
            ),
          },
          {
            value: 'certifications',
            label: 'By member',
            content: (
              <div className={styles.tabPanel}>
                <Card>
                  <div className={styles.picker}>
                    <Select
                      label="Member"
                      value={selectedMemberId}
                      onChange={(e) => setSelectedMemberId(e.target.value)}
                    >
                      <option value="">Select a member…</option>
                      {(membersQuery.data ?? []).map((member) => (
                        <option key={member.memberId} value={member.memberId}>
                          {member.lastName}, {member.firstName}
                        </option>
                      ))}
                    </Select>
                  </div>
                </Card>
                {selectedMemberId ? (
                  <CertificationsPanel
                    memberId={selectedMemberId}
                    title={
                      selected
                        ? `Certifications for ${selected.firstName} ${selected.lastName}`
                        : 'Certifications'
                    }
                  />
                ) : null}
              </div>
            ),
          },
        ]}
      />
    </main>
  );
}
