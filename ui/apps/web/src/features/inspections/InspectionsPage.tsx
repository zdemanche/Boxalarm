import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StatusRole } from '@boxalarm/design-tokens';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  Button,
  Card,
  DataTable,
  Dialog,
  PageHeader,
  Select,
  StatusChip,
  TextInput,
  type DataTableColumn,
} from '../../components/ui';
import { conductInspection, listDueInspections, listOccupancies, scheduleInspection } from './api';
import type { Inspection, Violation, ViolationStatus } from './types';
import { daysUntil, dueLabel, formatCalendarDate } from '../../lib/dates';
import { humanize } from '../../lib/labels';
import styles from './Inspections.module.css';

const emptyViolation: Violation = { code: '', description: '', status: 'open' };

/** Inside this many days an inspection reads as due soon. */
const DUE_SOON_DAYS = 30;

/** Dates are compared character by character down a column, so they read in mono (§2.4). */
const MONO_DATE = { fontFamily: 'var(--bx-font-mono)', whiteSpace: 'nowrap' } as const;

/** Prose cells (addresses, violation lists) wrap within a readable minimum width, padded so a
 * wrapped cell clears the row dividers. The row-header column is nowrap by default (it is built
 * for short IDs), so the address opts back in. */
const WRAPPING_CELL = {
  display: 'inline-block',
  whiteSpace: 'normal',
  padding: 'var(--bx-space-xs) 0',
} as const;

/**
 * Where an inspection stands against its due date - colour, glyph and word via StatusChip. The
 * service never moves `nextDueDate` when an inspection is conducted (recordInspection leaves it at
 * the scheduled date), so a conducted inspection is done, however early - it must not read as due.
 */
function inspectionState(inspection: Inspection): { status: StatusRole; label: string } {
  if (inspection.conductedDate !== undefined) return { status: 'ok', label: 'Conducted' };
  const days = daysUntil(inspection.nextDueDate);
  if (days < 0) return { status: 'danger', label: dueLabel(days) };
  if (days <= DUE_SOON_DAYS) return { status: 'warning', label: dueLabel(days) };
  return { status: 'neutral', label: 'Scheduled' };
}

export function InspectionsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canWrite =
    auth.roles.includes('OFFICER') || auth.roles.includes('ADMIN') || auth.roles.includes('CHIEF');
  const [occupancyId, setOccupancyId] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [conducting, setConducting] = useState<Inspection | null>(null);
  const [violations, setViolations] = useState<Violation[]>([]);

  const listQuery = useQuery({
    queryKey: ['inspections', 'due'],
    queryFn: () => listDueInspections(auth),
  });
  // Occupancies are picked by address, never typed as an internal id (docs/design.md §4.8). The
  // same list names each inspection row.
  const occupanciesQuery = useQuery({
    queryKey: ['inspections', 'occupancies'],
    queryFn: () => listOccupancies(auth),
  });
  const occupancyLabel = (id: string) => {
    const occupancy = occupanciesQuery.data?.find((o) => o.occupancyId === id);
    return occupancy ? `${occupancy.address} (${occupancy.occupancyType})` : id;
  };

  const scheduleMutation = useMutation({
    mutationFn: () => scheduleInspection(auth, occupancyId, scheduledDate),
    onSuccess: async () => {
      setOccupancyId('');
      setScheduledDate('');
      setScheduleError(null);
      await queryClient.invalidateQueries({ queryKey: ['inspections', 'due'] });
    },
    onError: (error: Error) => setScheduleError(error.message),
  });

  const conductMutation = useMutation({
    mutationFn: (params: { occId: string; inspectionId: string }) =>
      conductInspection(auth, params.occId, params.inspectionId, violations),
    onSuccess: async () => {
      setConducting(null);
      setViolations([]);
      await queryClient.invalidateQueries({ queryKey: ['inspections', 'due'] });
    },
  });

  if (listQuery.error) {
    return (
      <ApiForbiddenGate error={listQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  // Soonest due first, so an overdue inspection is at the top rather than wherever it was created.
  const inspections = [...(listQuery.data ?? [])].sort((a, b) =>
    a.nextDueDate.localeCompare(b.nextDueDate),
  );

  const columns: DataTableColumn<Inspection>[] = [
    {
      key: 'occupancy',
      header: 'Occupancy',
      isRowHeader: true,
      sortValue: (i) => occupancyLabel(i.occupancyId),
      render: (i) => (
        <span style={{ ...WRAPPING_CELL, minWidth: '10rem', fontWeight: 500 }}>
          {occupancyLabel(i.occupancyId)}
        </span>
      ),
    },
    // Status before the date: on a phone the table scrolls sideways, and the chip is what an
    // officer scans for.
    {
      key: 'status',
      header: 'Status',
      render: (i) => {
        const state = inspectionState(i);
        return <StatusChip status={state.status}>{state.label}</StatusChip>;
      },
    },
    {
      key: 'due',
      header: 'Due date',
      sortValue: (i) => i.nextDueDate,
      render: (i) => <span style={MONO_DATE}>{formatCalendarDate(i.nextDueDate)}</span>,
    },
    {
      key: 'conducted',
      header: 'Conducted',
      render: (i) =>
        i.conductedDate ? (
          <span style={{ ...WRAPPING_CELL, minWidth: '8rem' }}>
            <span style={MONO_DATE}>{formatCalendarDate(i.conductedDate)}</span>
            {i.conductedBy ? ` by ${i.conductedBy}` : null}
          </span>
        ) : (
          <span style={{ ...WRAPPING_CELL, minWidth: '8rem', color: 'var(--bx-fg-muted)' }}>
            Not yet conducted
          </span>
        ),
    },
    {
      key: 'violations',
      header: 'Violations',
      render: (i) =>
        i.violations.length === 0 ? (
          '—'
        ) : (
          <span style={{ ...WRAPPING_CELL, minWidth: '10rem' }}>
            {i.violations.map((v) => `${v.code} (${humanize(v.status)})`).join(', ')}
          </span>
        ),
    },
    ...(canWrite
      ? [
          {
            key: 'actions',
            header: 'Actions',
            render: (i: Inspection) => (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  conductMutation.reset();
                  setConducting(i);
                  setViolations(i.violations.length > 0 ? i.violations : []);
                }}
              >
                Conduct
              </Button>
            ),
          } satisfies DataTableColumn<Inspection>,
        ]
      : []),
  ];

  const conductingLabel = conducting ? occupancyLabel(conducting.occupancyId) : '';

  return (
    <main id="main-content">
      <PageHeader
        title="Inspections"
        description="Fire-code inspections, soonest due first: conduct one, or schedule the next."
      />

      <div className={styles.stack}>
        <DataTable
          caption="Inspections due"
          rowKey={(i) => i.inspectionId}
          columns={columns}
          rows={inspections}
          loading={listQuery.isLoading}
          emptyMessage="No inspections scheduled."
        />

        {/* The conduct form opens over the table: a row can't expand inside DataTable, and a
          dialog keeps the form next to the row's Conduct button on a phone. */}
        <Dialog
          open={conducting !== null}
          onOpenChange={(open) => {
            if (!open && !conductMutation.isPending) setConducting(null);
          }}
          title="Conduct inspection"
          description={conductingLabel}
        >
          {conducting ? (
            <form
              aria-label={`Conduct inspection at ${conductingLabel}`}
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                conductMutation.mutate({
                  occId: conducting.occupancyId,
                  inspectionId: conducting.inspectionId,
                });
              }}
              style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
            >
              <fieldset
                style={{
                  display: 'grid',
                  gap: 'var(--bx-space-md)',
                  border: 'none',
                  padding: 0,
                  margin: 0,
                  minWidth: 0,
                }}
              >
                <legend style={{ fontWeight: 600, marginBottom: 'var(--bx-space-sm)' }}>
                  Violations
                </legend>
                {violations.length === 0 ? (
                  <p style={{ margin: 0, color: 'var(--bx-fg-muted)' }}>No violations recorded.</p>
                ) : null}
                {violations.map((violation, index) => (
                  // Code and status side by side, the description on its own full-width line.
                  <div
                    key={index}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                      gap: 'var(--bx-space-sm)',
                      paddingBottom: 'var(--bx-space-md)',
                      borderBottom: '1px solid var(--bx-border-decorative)',
                    }}
                  >
                    <TextInput
                      label="Code"
                      value={violation.code}
                      onChange={(e) =>
                        setViolations((prev) =>
                          prev.map((v, i) => (i === index ? { ...v, code: e.target.value } : v)),
                        )
                      }
                    />
                    <Select
                      label="Status"
                      value={violation.status}
                      onChange={(e) =>
                        setViolations((prev) =>
                          prev.map((v, i) =>
                            i === index ? { ...v, status: e.target.value as ViolationStatus } : v,
                          ),
                        )
                      }
                    >
                      <option value="open">Open</option>
                      <option value="resolved">Resolved</option>
                    </Select>
                    <div style={{ gridColumn: '1 / -1' }}>
                      <TextInput
                        label="Description"
                        value={violation.description}
                        onChange={(e) =>
                          setViolations((prev) =>
                            prev.map((v, i) =>
                              i === index ? { ...v, description: e.target.value } : v,
                            ),
                          )
                        }
                      />
                    </div>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setViolations((prev) => [...prev, { ...emptyViolation }])}
                  style={{ justifySelf: 'start' }}
                >
                  Add violation
                </Button>
              </fieldset>
              {conductMutation.error ? (
                <p role="alert" style={{ margin: 0, color: 'var(--bx-status-danger)' }}>
                  The inspection was not saved: {conductMutation.error.message}
                </p>
              ) : null}
              <div
                style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--bx-space-sm)' }}
              >
                {/* Not natively disabled (a11y-spec: never disabled), but a click while the save
                  is in flight is ignored - closing then would lose a failure message. */}
                <Button
                  type="button"
                  variant="secondary"
                  aria-disabled={conductMutation.isPending || undefined}
                  onClick={() => {
                    if (!conductMutation.isPending) setConducting(null);
                  }}
                >
                  Cancel
                </Button>
                <Button type="submit" loading={conductMutation.isPending}>
                  Save conduct
                </Button>
              </div>
            </form>
          ) : null}
        </Dialog>

        {canWrite ? (
          <Card title="Schedule inspection">
            <form
              aria-label="Schedule inspection"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                scheduleMutation.mutate();
              }}
              className={styles.formGrid}
            >
              <Select
                label="Occupancy"
                value={occupancyId}
                required
                disabled={occupanciesQuery.isLoading}
                help={
                  occupanciesQuery.error
                    ? "Occupancies couldn't load. Try again later."
                    : occupanciesQuery.data?.length === 0
                      ? 'No occupancies yet. Add one on the Occupancies page first.'
                      : undefined
                }
                onChange={(e) => setOccupancyId(e.target.value)}
              >
                <option value="">
                  {occupanciesQuery.isLoading ? 'Loading occupancies…' : 'Choose an occupancy'}
                </option>
                {[...(occupanciesQuery.data ?? [])]
                  .sort((a, b) => a.address.localeCompare(b.address))
                  .map((occupancy) => (
                    <option key={occupancy.occupancyId} value={occupancy.occupancyId}>
                      {occupancy.address} ({occupancy.occupancyType})
                    </option>
                  ))}
              </Select>
              <TextInput
                label="Scheduled date"
                type="date"
                value={scheduledDate}
                required
                onChange={(e) => setScheduledDate(e.target.value)}
              />
              {scheduleError ? (
                <p role="alert" aria-live="assertive" className={styles.error}>
                  {scheduleError}
                </p>
              ) : null}
              <div className={styles.formActions}>
                <Button type="submit" loading={scheduleMutation.isPending}>
                  Schedule
                </Button>
              </div>
            </form>
          </Card>
        ) : null}
      </div>
    </main>
  );
}
