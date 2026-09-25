import { FormEvent, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { DataTable, type DataTableColumn } from '../../components/ui/DataTable';
import { StatusChip } from '../../components/ui/Chip';
import { DatePicker, TextInput } from '../../components/ui/Field';
import { PageHeader } from '../../components/ui/PageHeader';
import { ToolbarGroup } from '../../components/ui/Toolbar';
import { createIncidentFromDispatch, searchIncidents } from './api';
import { focusFieldById } from './focusField';
import type { Incident, IncidentStatus } from './types';

const STATUS_ROLE: Record<IncidentStatus, 'neutral' | 'info' | 'warning' | 'ok' | 'danger'> = {
  DRAFT: 'neutral',
  VALIDATED: 'info',
  SUBMITTED: 'warning',
  ACCEPTED: 'ok',
  REJECTED: 'danger',
};

const STATUS_LABEL: Record<IncidentStatus, string> = {
  DRAFT: 'Draft',
  VALIDATED: 'Validated',
  SUBMITTED: 'Submitted',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
};

function toDateInput(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

function fromDateInput(value: string, endOfDay: boolean): number {
  const ms = Date.parse(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}Z`);
  return Math.floor(ms / 1000);
}

const DEFAULT_RANGE_DAYS = 90;

export function IncidentsListPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  // §7.1: /incidents is OFFICER|CHIEF; createIncident.ts requires isAdmin (ADMIN or CHIEF), and
  // ADMIN cannot reach this route — CHIEF is the only client-verifiable role for the gate.
  const canCreate = auth.roles.includes('CHIEF');

  const now = Math.floor(Date.now() / 1000);
  const [fromDate, setFromDate] = useState(toDateInput(now - DEFAULT_RANGE_DAYS * 86400));
  const [toDate, setToDate] = useState(toDateInput(now));

  const [dispatchId, setDispatchId] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);

  const listQuery = useQuery({
    queryKey: ['incidents', fromDate, toDate],
    queryFn: () =>
      searchIncidents(auth, {
        fromAlarmAt: fromDateInput(fromDate, false),
        toAlarmAt: fromDateInput(toDate, true),
      }),
  });

  const createMutation = useMutation({
    mutationFn: () => createIncidentFromDispatch(auth, { dispatchId }),
    onSuccess: (created) => {
      setDispatchId('');
      navigate(`/incidents/${created.incidentId}`);
    },
  });

  useEffect(() => {
    if (createMutation.error) errorRef.current?.focus();
  }, [createMutation.error]);

  if (listQuery.error) {
    return (
      <ApiForbiddenGate error={listQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const columns: DataTableColumn<Incident>[] = [
    {
      key: 'incidentType',
      header: 'Type',
      sortValue: (i) => i.incidentType ?? '',
      isRowHeader: true,
      render: (i) => (
        <Link to={`/incidents/${i.incidentId}`} style={{ fontWeight: 600 }}>
          {i.incidentType ?? 'Unclassified'}
        </Link>
      ),
    },
    {
      key: 'address',
      header: 'Address',
      sortValue: (i) => i.address ?? '',
      render: (i) => i.address ?? '—',
    },
    {
      key: 'alarmAt',
      header: 'Date',
      sortValue: (i) => i.alarmAt ?? 0,
      render: (i) => (i.alarmAt ? new Date(i.alarmAt * 1000).toLocaleDateString() : '—'),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (i) => i.status,
      render: (i) => (
        <StatusChip status={STATUS_ROLE[i.status]}>{STATUS_LABEL[i.status]}</StatusChip>
      ),
    },
  ];

  const createError =
    createMutation.error instanceof ApiError ? createMutation.error.problem : null;

  return (
    <main id="main-content">
      <PageHeader title="Incidents" />

      <ToolbarGroup>
        <DatePicker
          label="From"
          value={fromDate}
          max={toDate}
          onChange={(e) => setFromDate(e.target.value)}
        />
        <DatePicker
          label="To"
          value={toDate}
          min={fromDate}
          onChange={(e) => setToDate(e.target.value)}
        />
      </ToolbarGroup>

      <DataTable
        caption="Incident search results"
        rowKey={(i) => i.incidentId}
        columns={columns}
        rows={listQuery.data ?? []}
        loading={listQuery.isLoading}
        emptyMessage="No incidents in this date range."
      />

      {canCreate ? (
        <Card
          title="Create report from dispatch"
          style={{ marginTop: 'var(--bx-space-lg)', maxWidth: 480 }}
        >
          <form
            aria-label="Create report from dispatch"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              createMutation.mutate();
            }}
            style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
          >
            <TextInput
              label="Dispatch ID"
              value={dispatchId}
              required
              onChange={(e) => setDispatchId(e.target.value)}
            />
            {createError ? (
              <div ref={errorRef} tabIndex={-1} role="alert" aria-live="assertive">
                <p style={{ fontWeight: 600, margin: 0 }}>{createError.title}</p>
                {createError.detail ? <p style={{ margin: 0 }}>{createError.detail}</p> : null}
              </div>
            ) : null}
            <Button type="submit" loading={createMutation.isPending} disabled={!dispatchId}>
              Create report
            </Button>
          </form>
        </Card>
      ) : null}
    </main>
  );
}
