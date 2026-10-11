import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  Card,
  DataTable,
  PageHeader,
  StatusChip,
  TextInput,
  type DataTableColumn,
} from '../../components/ui';
import { canAccessPath } from '../../routing/routeTable';
import { getCompliance } from './api';
import type { ComplianceEntry } from './types';
import styles from './Apparatus.module.css';

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
  // ADMIN can open this report but not /apparatus, so only link where the role can follow.
  const canOpenApparatus = canAccessPath('/apparatus', auth.roles);

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

  const entries = query.data ?? [];
  const compliantCount = entries.filter((e) => e.compliant).length;

  const columns: DataTableColumn<ComplianceEntry>[] = [
    {
      key: 'unitId',
      header: 'Unit',
      isRowHeader: true,
      sortValue: (e) => e.unitId,
      render: (e) =>
        canOpenApparatus ? (
          <Link
            to={`/apparatus/${encodeURIComponent(e.unitId)}`}
            className={styles.mono}
            style={{ fontWeight: 600 }}
          >
            {e.unitId}
          </Link>
        ) : (
          <span className={styles.mono}>{e.unitId}</span>
        ),
    },
    {
      key: 'expected',
      header: 'Expected checks',
      sortValue: (e) => e.expectedChecks,
      render: (e) => e.expectedChecks,
    },
    {
      key: 'actual',
      header: 'Recorded checks',
      sortValue: (e) => e.actualChecks,
      render: (e) => e.actualChecks,
    },
    {
      key: 'compliant',
      header: 'Status',
      sortValue: (e) => (e.compliant ? 1 : 0),
      render: (e) => (
        <StatusChip status={e.compliant ? 'ok' : 'danger'}>
          {e.compliant ? 'Compliant' : 'Missed checks'}
        </StatusChip>
      ),
    },
  ];

  return (
    <main id="main-content">
      <PageHeader
        title="Check compliance"
        description="Daily truck checks recorded against expected, unit by unit, for the dates you pick."
        // ADMIN can open this report but not /apparatus, so only link the parent crumb for
        // roles that can follow it (PR #321 review m4).
        breadcrumbs={[
          canOpenApparatus ? { label: 'Apparatus', to: '/apparatus' } : { label: 'Apparatus' },
          { label: 'Compliance' },
        ]}
      />

      <div className={styles.stack}>
        <Card title="Report range">
          <div className={styles.rangeRow}>
            <TextInput
              label="From"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <TextInput label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            <p role="status" className={styles.rangeSummary}>
              {query.isLoading
                ? ''
                : `${compliantCount} of ${entries.length} ${entries.length === 1 ? 'unit' : 'units'} met every daily check.`}
            </p>
          </div>
        </Card>

        <DataTable
          caption="Check compliance by unit"
          rowKey={(e) => e.unitId}
          columns={columns}
          rows={entries}
          loading={query.isLoading}
          emptyMessage="No compliance data for this range."
        />
      </div>
    </main>
  );
}
