import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  Button,
  Card,
  DataTable,
  PageHeader,
  StatusChip,
  TextInput,
  type DataTableColumn,
} from '../../components/ui';
import { createHydrant, listHydrants, updateHydrant } from './api';
import type { CreateHydrantInput, Hydrant } from './types';

const emptyForm: CreateHydrantInput = {
  hydrantId: '',
  latitude: 0,
  longitude: 0,
  size: '',
  flowRatingGpm: 0,
  nextFlowTestDue: '',
};

export function HydrantsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const canWrite = auth.roles.includes('ADMIN') || auth.roles.includes('CHIEF');
  const [form, setForm] = useState<CreateHydrantInput>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ['inspections', 'hydrants'],
    queryFn: () => listHydrants(auth),
  });

  const createMutation = useMutation({
    mutationFn: (input: CreateHydrantInput) => createHydrant(auth, input),
    onSuccess: async () => {
      setForm(emptyForm);
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ['inspections', 'hydrants'] });
    },
    onError: (error: Error) => setFormError(error.message),
  });

  const markOosMutation = useMutation({
    mutationFn: (hydrantId: string) => updateHydrant(auth, hydrantId, { status: 'OUT_OF_SERVICE' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['inspections', 'hydrants'] });
    },
  });

  const flowTestMutation = useMutation({
    mutationFn: ({ hydrantId, date }: { hydrantId: string; date: string }) =>
      updateHydrant(auth, hydrantId, { lastFlowTestDate: date, status: 'IN_SERVICE' }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['inspections', 'hydrants'] });
    },
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
      sortValue: (h) => h.hydrantId,
      render: (h) => h.hydrantId,
    },
    { key: 'size', header: 'Size', sortValue: (h) => h.size, render: (h) => h.size },
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
      render: (h) => h.nextFlowTestDue,
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
              <div style={{ display: 'flex', gap: 'var(--bx-space-sm)' }}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    flowTestMutation.mutate({
                      hydrantId: h.hydrantId,
                      date: new Date().toISOString().slice(0, 10),
                    })
                  }
                >
                  Record flow test
                </Button>
                {h.status !== 'OUT_OF_SERVICE' ? (
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => markOosMutation.mutate(h.hydrantId)}
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
      <PageHeader title="Hydrants" />

      <DataTable
        caption="Hydrant registry"
        rowKey={(h) => h.hydrantId}
        columns={columns}
        rows={listQuery.data ?? []}
        loading={listQuery.isLoading}
        emptyMessage="No hydrants registered yet."
      />

      {canWrite ? (
        <Card title="Register hydrant" style={{ marginTop: 'var(--bx-space-xl)', maxWidth: 480 }}>
          <form
            aria-label="Register hydrant"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              createMutation.mutate(form);
            }}
            style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
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
              value={form.latitude}
              required
              onChange={(e) => setForm((prev) => ({ ...prev, latitude: Number(e.target.value) }))}
            />
            <TextInput
              label="Longitude"
              type="number"
              step="any"
              value={form.longitude}
              required
              onChange={(e) => setForm((prev) => ({ ...prev, longitude: Number(e.target.value) }))}
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
              value={form.flowRatingGpm}
              required
              onChange={(e) =>
                setForm((prev) => ({ ...prev, flowRatingGpm: Number(e.target.value) }))
              }
            />
            <TextInput
              label="Next flow test due"
              type="date"
              value={form.nextFlowTestDue}
              required
              onChange={(e) => setForm((prev) => ({ ...prev, nextFlowTestDue: e.target.value }))}
            />
            {formError ? (
              <p role="alert" aria-live="assertive">
                {formError}
              </p>
            ) : null}
            <Button type="submit" loading={createMutation.isPending}>
              Save hydrant
            </Button>
          </form>
        </Card>
      ) : null}
    </main>
  );
}
