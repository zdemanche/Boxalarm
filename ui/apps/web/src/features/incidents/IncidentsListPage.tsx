import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { DataTable, type DataTableColumn } from '../../components/ui/DataTable';
import { StatusChip } from '../../components/ui/Chip';
import { Checkbox, DatePicker, TextInput } from '../../components/ui/Field';
import { PageHeader } from '../../components/ui/PageHeader';
import { createIncidentFromDispatch, searchIncidents } from './api';
import { dateInputToEpoch, epochToDateInput, formatDate } from './format';
import type { Incident, IncidentStatus } from './types';
import styles from './IncidentsList.module.css';

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

const STATUS_ORDER: IncidentStatus[] = ['DRAFT', 'VALIDATED', 'SUBMITTED', 'ACCEPTED', 'REJECTED'];

const DEFAULT_RANGE_DAYS = 90;

function StatusCell({ status }: { status: IncidentStatus }) {
  return <StatusChip status={STATUS_ROLE[status]}>{STATUS_LABEL[status]}</StatusChip>;
}

export function IncidentsListPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canCreate = auth.roles.includes('CHIEF') || auth.roles.includes('OFFICER');

  const now = Math.floor(Date.now() / 1000);
  const [fromDate, setFromDate] = useState(epochToDateInput(now - DEFAULT_RANGE_DAYS * 86400));
  const [toDate, setToDate] = useState(epochToDateInput(now));
  const [selectedStatuses, setSelectedStatuses] = useState<IncidentStatus[]>([]);
  const [dispatchId, setDispatchId] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);

  const listQuery = useQuery({
    queryKey: ['incidents', fromDate, toDate],
    queryFn: () =>
      searchIncidents(auth, {
        fromAlarmAt: dateInputToEpoch(fromDate, false),
        toAlarmAt: dateInputToEpoch(toDate, true),
      }),
  });

  const createMutation = useMutation({
    mutationFn: () => createIncidentFromDispatch(auth, { dispatchId }),
    onSuccess: (created) => {
      queryClient.setQueryData(['incident', created.incidentId], created);
      setDispatchId('');
      navigate(`/incidents/${created.incidentId}`);
    },
  });

  useEffect(() => {
    if (createMutation.error) errorRef.current?.focus();
  }, [createMutation.error]);

  const ranged = useMemo(
    () => [...(listQuery.data ?? [])].sort((a, b) => (a.alarmAt ?? 0) - (b.alarmAt ?? 0)),
    [listQuery.data],
  );
  const visible =
    selectedStatuses.length === 0
      ? ranged
      : ranged.filter((incident) => selectedStatuses.includes(incident.status));
  const attention = ranged.filter(
    (incident) => incident.status === 'DRAFT' || incident.status === 'REJECTED',
  );
  const draftCount = attention.filter((incident) => incident.status === 'DRAFT').length;
  const rejectedCount = attention.filter((incident) => incident.status === 'REJECTED').length;
  const filtersActive =
    selectedStatuses.length > 0 ||
    fromDate !== epochToDateInput(now - DEFAULT_RANGE_DAYS * 86400) ||
    toDate !== epochToDateInput(now);

  const columns: DataTableColumn<Incident>[] = [
    {
      key: 'dispatchNumber',
      header: 'Report',
      sortValue: (incident) => incident.dispatchNumber,
      isRowHeader: true,
      render: (incident) => (
        <Link to={`/incidents/${incident.incidentId}`} className={styles.mono}>
          {incident.dispatchNumber}
        </Link>
      ),
    },
    {
      key: 'incidentType',
      header: 'Type',
      sortValue: (incident) => incident.incidentType ?? '',
      render: (incident) => incident.incidentType ?? 'Unclassified',
    },
    {
      key: 'address',
      header: 'Address',
      sortValue: (incident) => incident.address ?? '',
      render: (incident) => incident.address ?? '—',
    },
    {
      key: 'alarmAt',
      header: 'Date',
      sortValue: (incident) => incident.alarmAt ?? 0,
      render: (incident) => formatDate(incident.alarmAt),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (incident) => incident.status,
      render: (incident) => <StatusCell status={incident.status} />,
    },
  ];

  const createError =
    createMutation.error instanceof ApiError ? createMutation.error.problem : null;
  const loadError = listQuery.error;
  const forbidden = loadError instanceof ApiError && loadError.problem.status === 403;

  if (forbidden) {
    return (
      <ApiForbiddenGate error={loadError}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const emptyMessage =
    !listQuery.isLoading && ranged.length === 0
      ? filtersActive
        ? 'No incident reports in this range.'
        : 'No incident reports yet. Reports are created from dispatches — your first one appears after your first call.'
      : 'No incidents match these filters.';

  function clearFilters() {
    const nextNow = Math.floor(Date.now() / 1000);
    setFromDate(epochToDateInput(nextNow - DEFAULT_RANGE_DAYS * 86400));
    setToDate(epochToDateInput(nextNow));
    setSelectedStatuses([]);
  }

  function toggleStatus(status: IncidentStatus, checked: boolean) {
    setSelectedStatuses((current) =>
      checked ? [...current, status] : current.filter((item) => item !== status),
    );
  }

  return (
    <main id="main-content">
      <PageHeader title="Incidents" />
      <p className="visually-hidden" aria-live="polite">
        {listQuery.isLoading
          ? 'Loading incidents.'
          : listQuery.data
            ? `${visible.length} incidents. ${attention.length} need attention.`
            : ''}
      </p>

      <section className={styles.section} aria-labelledby="incident-filters-heading">
        <h2 id="incident-filters-heading">Filters</h2>
        <div className={styles.filters}>
          <DatePicker
            label="From"
            value={fromDate}
            max={toDate}
            onChange={(event) => setFromDate(event.target.value)}
          />
          <DatePicker
            label="To"
            value={toDate}
            min={fromDate}
            onChange={(event) => setToDate(event.target.value)}
          />
          <fieldset className={styles.statusSet}>
            <legend>Status</legend>
            {STATUS_ORDER.map((status) => (
              <Checkbox
                key={status}
                label={STATUS_LABEL[status]}
                checked={selectedStatuses.includes(status)}
                onCheckedChange={(checked) => toggleStatus(status, checked)}
              />
            ))}
          </fieldset>
          <Button type="button" variant="secondary" onClick={clearFilters}>
            Clear filters
          </Button>
        </div>
      </section>

      {loadError ? (
        <div role="alert" tabIndex={-1}>
          <h2>We couldn&apos;t load incidents.</h2>
          <p>
            {loadError instanceof ApiError && loadError.problem.status === 400
              ? 'The incident request was rejected by the server.'
              : 'Try again. The date range you chose is still here.'}
          </p>
          <Button type="button" onClick={() => void listQuery.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          <section className={styles.section} aria-labelledby="needs-attention-heading">
            <h2 id="needs-attention-heading">Needs attention</h2>
            <p className={styles.muted}>
              {attention.length === 0
                ? 'Nothing needs attention.'
                : `${attention.length} incidents need attention: ${draftCount} drafts, ${rejectedCount} rejected.`}
            </p>
            {attention.length > 0 ? (
              <ul className={styles.attentionList}>
                {attention.map((incident) => (
                  <li key={incident.incidentId} className={styles.attentionItem}>
                    <Link to={`/incidents/${incident.incidentId}`} className={styles.mono}>
                      {incident.dispatchNumber}
                    </Link>
                    <span className={styles.attentionMeta}>
                      <span>{incident.incidentType ?? 'Unclassified'}</span>
                      <span>{incident.address ?? '—'}</span>
                      <span>{formatDate(incident.alarmAt)}</span>
                      <StatusCell status={incident.status} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className={styles.section} aria-labelledby="all-incidents-heading">
            <h2 id="all-incidents-heading">All incidents</h2>
            <div className={styles.table}>
              <DataTable
                caption="Incident search results, ordered by alarm time"
                rowKey={(incident) => incident.incidentId}
                columns={columns}
                rows={visible}
                loading={listQuery.isLoading}
                emptyMessage={
                  <>
                    <p>{emptyMessage}</p>
                    {filtersActive ? (
                      <Button type="button" variant="secondary" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    ) : null}
                  </>
                }
              />
            </div>
            <ul
              className={styles.cards}
              aria-label="Incident search results, ordered by alarm time"
            >
              {visible.map((incident) => (
                <li key={incident.incidentId}>
                  <Link to={`/incidents/${incident.incidentId}`} className={styles.card}>
                    <span className={styles.mono}>{incident.dispatchNumber}</span>
                    <span>{incident.incidentType ?? 'Unclassified'}</span>
                    <span>{incident.address ?? '—'}</span>
                    <span className={styles.cardMeta}>
                      <span>{formatDate(incident.alarmAt)}</span>
                      <StatusCell status={incident.status} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

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
              onChange={(event) => setDispatchId(event.target.value)}
            />
            {createError ? (
              <div ref={errorRef} tabIndex={-1} role="alert">
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
