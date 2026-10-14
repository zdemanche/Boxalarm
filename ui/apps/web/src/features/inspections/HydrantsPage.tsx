import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  PageHeader,
  StatusChip,
  TextInput,
  type DataTableColumn,
} from '../../components/ui';
import { ApiError } from '../../lib/apiClient';
import { daysUntil, dueLabel, formatCalendarDate, toCalendarDate } from '../../lib/dates';
import { createHydrant, listHydrants, updateHydrant } from './api';
import type { Hydrant } from './types';
import styles from './Inspections.module.css';

/** Inside this many days a flow test reads as due soon. */
const DUE_SOON_DAYS = 30;

const MONO = { fontFamily: 'var(--bx-font-mono)', whiteSpace: 'nowrap' } as const;

/** Form values as typed. Numbers start empty rather than 0: a 0,0 default sends a hydrant to
 * the Gulf of Guinea, and a pre-filled 0 satisfies `required` without anyone entering it. */
interface HydrantForm {
  hydrantId: string;
  latitude: string;
  longitude: string;
  size: string;
  flowRatingGpm: string;
  nextFlowTestDue: string;
}

const emptyForm: HydrantForm = {
  hydrantId: '',
  latitude: '',
  longitude: '',
  size: '',
  flowRatingGpm: '',
  nextFlowTestDue: '',
};

// A failed status change must never be silent: an inspector who marked a hydrant out of
// service has to know when it did not take (a 409 means someone else changed it first).
function updateErrorMessage(hydrantId: string, action: string, error: Error): string {
  const status = error instanceof ApiError ? error.problem.status : undefined;
  return status === 409
    ? `${hydrantId} was changed by someone else just now - ${action} was not saved. Reload and try again.`
    : `${action} for ${hydrantId} was not saved${status ? ` (HTTP ${status})` : ''}. Try again.`;
}

/** The due date, plus an alarm once it has passed and a warning inside the due-soon window. */
function FlowTestDue({ isoDate }: { isoDate: string }) {
  const days = daysUntil(isoDate);
  return (
    <span
      style={{
        display: 'inline-flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 'var(--bx-space-sm)',
      }}
    >
      <span style={MONO}>{formatCalendarDate(isoDate)}</span>
      {days <= DUE_SOON_DAYS ? (
        <StatusChip status={days < 0 ? 'danger' : 'warning'}>{dueLabel(days)}</StatusChip>
      ) : null}
    </span>
  );
}

export function HydrantsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canWrite = auth.roles.includes('ADMIN') || auth.roles.includes('CHIEF');
  const [form, setForm] = useState<HydrantForm>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  // The target outlives the open flag so the dialog's title doesn't blank while it closes.
  const [oosTarget, setOosTarget] = useState<Hydrant | null>(null);
  const [oosOpen, setOosOpen] = useState(false);

  const listQuery = useQuery({
    queryKey: ['inspections', 'hydrants'],
    queryFn: () => listHydrants(auth),
  });

  const createMutation = useMutation({
    mutationFn: (input: HydrantForm) =>
      createHydrant(auth, {
        ...input,
        latitude: Number(input.latitude),
        longitude: Number(input.longitude),
        flowRatingGpm: Number(input.flowRatingGpm),
      }),
    onSuccess: async () => {
      setForm(emptyForm);
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ['inspections', 'hydrants'] });
    },
    onError: (error: Error) => setFormError(error.message),
  });

  // Errors surface inside the confirm dialog (see onConfirm below), not in the page banner.
  const markOosMutation = useMutation({
    mutationFn: (hydrantId: string) => updateHydrant(auth, hydrantId, { status: 'OUT_OF_SERVICE' }),
    onMutate: () => setUpdateError(null),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['inspections', 'hydrants'] });
    },
  });

  const flowTestMutation = useMutation({
    mutationFn: ({ hydrantId, date }: { hydrantId: string; date: string }) =>
      updateHydrant(auth, hydrantId, { lastFlowTestDate: date, status: 'IN_SERVICE' }),
    onMutate: () => setUpdateError(null),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['inspections', 'hydrants'] });
    },
    onError: (error: Error, { hydrantId }) =>
      setUpdateError(updateErrorMessage(hydrantId, 'The flow test', error)),
  });

  if (listQuery.error) {
    return (
      <ApiForbiddenGate error={listQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const columns: DataTableColumn<Hydrant>[] = [
    {
      key: 'hydrantId',
      header: 'Hydrant',
      isRowHeader: true,
      sortValue: (h) => h.hydrantId,
      render: (h) => <span style={MONO}>{h.hydrantId}</span>,
    },
    {
      key: 'size',
      header: 'Size',
      sortValue: (h) => h.size,
      render: (h) => <span style={{ whiteSpace: 'nowrap' }}>{h.size}</span>,
    },
    {
      key: 'flowRatingGpm',
      header: 'Flow rating',
      sortValue: (h) => h.flowRatingGpm,
      render: (h) => `${h.flowRatingGpm} gpm`,
    },
    {
      key: 'nextFlowTestDue',
      header: 'Next flow test due',
      sortValue: (h) => h.nextFlowTestDue,
      render: (h) => <FlowTestDue isoDate={h.nextFlowTestDue} />,
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (h) => h.status,
      render: (h) => (
        <StatusChip status={h.status === 'OUT_OF_SERVICE' ? 'danger' : 'ok'}>
          {h.status === 'OUT_OF_SERVICE' ? 'Out of service' : 'In service'}
        </StatusChip>
      ),
    },
    ...(canWrite
      ? [
          {
            key: 'actions',
            header: 'Actions',
            render: (h: Hydrant) => (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--bx-space-sm)' }}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  loading={
                    flowTestMutation.isPending &&
                    flowTestMutation.variables?.hydrantId === h.hydrantId
                  }
                  onClick={() =>
                    flowTestMutation.mutate({
                      hydrantId: h.hydrantId,
                      // The local day, not UTC's: after 8 PM in Trumbull UTC is already tomorrow.
                      date: toCalendarDate(Date.now()),
                    })
                  }
                >
                  Record flow test
                </Button>
                {/* Secondary, not a solid red button per row: the dialog carries the alarm,
                    and a column of red buttons drowns out the out-of-service chips. */}
                {h.status !== 'OUT_OF_SERVICE' ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setOosTarget(h);
                      setOosOpen(true);
                    }}
                  >
                    Mark out of service
                  </Button>
                ) : null}
              </div>
            ),
          } satisfies DataTableColumn<Hydrant>,
        ]
      : []),
  ];

  return (
    <main id="main-content">
      <PageHeader
        title="Hydrants"
        description="Every hydrant in the district, its flow rating and when its next flow test is due."
      />

      <div className={styles.stack}>
        {updateError ? (
          <p role="alert" className={styles.alertBanner}>
            {updateError}
          </p>
        ) : null}

        <DataTable
          caption="Hydrant registry"
          rowKey={(h) => h.hydrantId}
          columns={columns}
          rows={listQuery.data ?? []}
          loading={listQuery.isLoading}
          emptyMessage="No hydrants registered yet."
        />

        {/* Taking a hydrant out of service changes what crews see on the map mid-call: confirm,
          naming the hydrant and the consequence (design §4.5). A failed update stays in the
          dialog with the reason instead of closing blind. */}
        <ConfirmDialog
          open={oosOpen}
          onOpenChange={setOosOpen}
          title={`Mark hydrant ${oosTarget?.hydrantId ?? ''} out of service?`}
          consequence={`${oosTarget?.hydrantId ?? 'This hydrant'} will show as out of service in the hydrant registry and on the inspections map. Recording a flow test puts it back in service.`}
          confirmLabel={`Mark ${oosTarget?.hydrantId ?? 'hydrant'} out of service`}
          danger
          onConfirm={async () => {
            if (!oosTarget) return;
            try {
              await markOosMutation.mutateAsync(oosTarget.hydrantId);
            } catch (error) {
              throw new Error(
                updateErrorMessage(oosTarget.hydrantId, 'Marking out of service', error as Error),
                { cause: error },
              );
            }
          }}
        />

        {canWrite ? (
          <Card title="Register hydrant">
            <form
              aria-label="Register hydrant"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                createMutation.mutate(form);
              }}
              className={styles.formGrid}
            >
              <TextInput
                label="Hydrant ID"
                value={form.hydrantId}
                required
                onChange={(e) => setForm((prev) => ({ ...prev, hydrantId: e.target.value }))}
              />
              <TextInput
                label="Latitude"
                type="number"
                step="any"
                min={-90}
                max={90}
                inputMode="decimal"
                help="Decimal degrees, e.g. 41.2429"
                value={form.latitude}
                required
                onChange={(e) => setForm((prev) => ({ ...prev, latitude: e.target.value }))}
              />
              <TextInput
                label="Longitude"
                type="number"
                step="any"
                min={-180}
                max={180}
                inputMode="decimal"
                help="Decimal degrees, e.g. -73.2007 (west is negative)"
                value={form.longitude}
                required
                onChange={(e) => setForm((prev) => ({ ...prev, longitude: e.target.value }))}
              />
              <TextInput
                label="Size"
                value={form.size}
                required
                onChange={(e) => setForm((prev) => ({ ...prev, size: e.target.value }))}
              />
              <TextInput
                label="Flow rating (gpm)"
                type="number"
                min={0}
                value={form.flowRatingGpm}
                required
                onChange={(e) => setForm((prev) => ({ ...prev, flowRatingGpm: e.target.value }))}
              />
              <TextInput
                label="Next flow test due"
                type="date"
                value={form.nextFlowTestDue}
                required
                onChange={(e) => setForm((prev) => ({ ...prev, nextFlowTestDue: e.target.value }))}
              />
              {formError ? (
                <p role="alert" aria-live="assertive" className={styles.error}>
                  {formError}
                </p>
              ) : null}
              <div className={styles.formActions}>
                <Button type="submit" loading={createMutation.isPending}>
                  Save hydrant
                </Button>
              </div>
            </form>
          </Card>
        ) : null}
      </div>
    </main>
  );
}
