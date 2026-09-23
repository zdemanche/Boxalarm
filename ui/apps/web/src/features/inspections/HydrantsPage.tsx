import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
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

  return (
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>Hydrants</h1>

      {listQuery.isLoading ? (
        <p>Loading hydrants…</p>
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
                Hydrant
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Size
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Flow rating
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Next flow test due
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Status
              </th>
              {canWrite ? (
                <th scope="col" style={{ textAlign: 'left' }}>
                  Actions
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {(listQuery.data ?? []).map((hydrant: Hydrant) => (
              <tr key={hydrant.hydrantId}>
                <th scope="row" style={{ textAlign: 'left', fontWeight: 500 }}>
                  {hydrant.hydrantId}
                </th>
                <td>{hydrant.size}</td>
                <td>{hydrant.flowRatingGpm} gpm</td>
                <td>{hydrant.nextFlowTestDue}</td>
                <td>
                  {hydrant.status === 'OUT_OF_SERVICE' ? (
                    <span style={{ color: 'var(--boxalarm-error)' }}>⊘ Out of service</span>
                  ) : (
                    <span>● In service</span>
                  )}
                </td>
                {canWrite ? (
                  <td style={{ display: 'flex', gap: 'var(--boxalarm-spacing-sm)' }}>
                    <button
                      type="button"
                      onClick={() =>
                        flowTestMutation.mutate({
                          hydrantId: hydrant.hydrantId,
                          date: new Date().toISOString().slice(0, 10),
                        })
                      }
                      style={{ minHeight: 44 }}
                    >
                      Record flow test
                    </button>
                    {hydrant.status !== 'OUT_OF_SERVICE' ? (
                      <button
                        type="button"
                        onClick={() => markOosMutation.mutate(hydrant.hydrantId)}
                        style={{ minHeight: 44 }}
                      >
                        Mark out of service
                      </button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canWrite ? (
        <form
          aria-label="Register hydrant"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            createMutation.mutate(form);
          }}
          style={{
            marginTop: 'var(--boxalarm-spacing-xl)',
            display: 'grid',
            gap: 'var(--boxalarm-spacing-md)',
            maxWidth: 480,
          }}
        >
          <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>Register hydrant</h2>
          <label style={{ display: 'grid', gap: 4 }}>
            Hydrant ID
            <input
              value={form.hydrantId}
              required
              onChange={(e) => setForm((prev) => ({ ...prev, hydrantId: e.target.value }))}
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            Latitude
            <input
              type="number"
              step="any"
              value={form.latitude}
              required
              onChange={(e) => setForm((prev) => ({ ...prev, latitude: Number(e.target.value) }))}
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            Longitude
            <input
              type="number"
              step="any"
              value={form.longitude}
              required
              onChange={(e) => setForm((prev) => ({ ...prev, longitude: Number(e.target.value) }))}
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            Size
            <input
              value={form.size}
              required
              onChange={(e) => setForm((prev) => ({ ...prev, size: e.target.value }))}
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            Flow rating (gpm)
            <input
              type="number"
              value={form.flowRatingGpm}
              required
              onChange={(e) =>
                setForm((prev) => ({ ...prev, flowRatingGpm: Number(e.target.value) }))
              }
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            Next flow test due
            <input
              type="date"
              value={form.nextFlowTestDue}
              required
              onChange={(e) => setForm((prev) => ({ ...prev, nextFlowTestDue: e.target.value }))}
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          {formError ? (
            <p role="alert" aria-live="assertive">
              {formError}
            </p>
          ) : null}
          <button type="submit" style={{ minHeight: 44 }}>
            Save hydrant
          </button>
        </form>
      ) : null}
    </main>
  );
}
