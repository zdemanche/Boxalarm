import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiErrorState } from '../../components/ApiErrorState';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { ApiError } from '../../lib/apiClient';
import {
  Card,
  DataTable,
  PageHeader,
  StatusChip,
  TextInput,
  type DataTableColumn,
} from '../../components/ui';
import { toCalendarDate } from '../../lib/dates';
import { canAccessPath } from '../../routing/routeTable';
import { getCompliance } from './api';
import type { ComplianceEntry } from './types';
import styles from './Apparatus.module.css';

const MAX_RANGE_DAYS = 400;

function daysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return toCalendarDate(date.getTime());
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

  const filled = from !== '' && to !== '';
  const inverted = filled && from > to;
  const tooLong =
    filled &&
    !inverted &&
    toEpochSeconds(to) + 86399 - toEpochSeconds(from) > MAX_RANGE_DAYS * 86400;
  const rangeError = inverted
    ? 'Must be on or after From.'
    : tooLong
      ? `Pick at most ${MAX_RANGE_DAYS} days.`
      : undefined;

  const query = useQuery({
    queryKey: ['apparatus', 'compliance', from, to],
    queryFn: () => getCompliance(auth, toEpochSeconds(from), toEpochSeconds(to) + 86399),
    enabled: filled && !rangeError,
  });

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
              error={from === '' ? 'Pick a date.' : undefined}
            />
            <TextInput
              label="To"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              error={to === '' ? 'Pick a date.' : rangeError}
            />
            <p role="status" className={styles.rangeSummary}>
              {query.isLoading || query.error || !query.data
                ? ''
                : `${compliantCount} of ${entries.length} ${entries.length === 1 ? 'unit' : 'units'} met every daily check.`}
            </p>
          </div>
        </Card>

        {query.error ? (
          query.error instanceof ApiError && query.error.problem.status === 403 ? (
            <ApiForbiddenGate error={query.error} embedded>
              <></>
            </ApiForbiddenGate>
          ) : (
            <ApiErrorState embedded headingLevel="h2" onRetry={() => void query.refetch()} />
          )
        ) : (
          <DataTable
            caption="Check compliance by unit"
            rowKey={(e) => e.unitId}
            columns={columns}
            rows={entries}
            loading={query.isLoading}
            emptyMessage={
              filled && !rangeError ? 'No compliance data for this range.' : 'Pick a valid range.'
            }
          />
        )}
      </div>
    </main>
  );
}
