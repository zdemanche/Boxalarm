import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { createMaintenance, getMaintenance } from './api';
import type { CreateMaintenanceInput } from './types';

const emptyForm = { description: '', vendor: '', cost: '' };

export function MaintenanceTab({ unitId }: { unitId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(emptyForm);

  const query = useQuery({
    queryKey: ['apparatus', unitId, 'maintenance'],
    queryFn: () => getMaintenance(auth, unitId),
  });

  const mutation = useMutation({
    mutationFn: (input: CreateMaintenanceInput) => createMaintenance(auth, unitId, input),
    onSuccess: () => {
      setForm(emptyForm);
      void queryClient.invalidateQueries({ queryKey: ['apparatus', unitId, 'maintenance'] });
    },
  });

  if (query.error) {
    return (
      <ApiForbiddenGate error={query.error} embedded>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const records = [...(query.data?.records ?? [])].sort((a, b) => b.performedAt - a.performedAt);

  return (
    <section>
      <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)' }}>Maintenance</h2>
      {query.isLoading ? (
        <p>Loading maintenance history…</p>
      ) : records.length === 0 ? (
        <p>No maintenance recorded for this unit.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {records.map((record) => (
            <li
              key={record.performedAt}
              style={{ padding: 'var(--boxalarm-spacing-sm) 0', borderBottom: '1px solid #0002' }}
            >
              <strong>{record.description}</strong> — {record.vendor} — ${record.cost.toFixed(2)}
              <div style={{ fontSize: 'var(--boxalarm-font-size-sm)' }}>
                {new Date(record.performedAt * 1000).toLocaleDateString()}
                {record.scheduledNextAt
                  ? ` — next scheduled ${new Date(record.scheduledNextAt * 1000).toLocaleDateString()}`
                  : ''}
              </div>
            </li>
          ))}
        </ul>
      )}

      <form
        aria-label="Log maintenance"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          const cost = Number(form.cost);
          mutation.mutate({ description: form.description, vendor: form.vendor, cost });
        }}
        style={{
          display: 'grid',
          gap: 'var(--boxalarm-spacing-sm)',
          maxWidth: 480,
          marginTop: 'var(--boxalarm-spacing-lg)',
        }}
      >
        <h3 style={{ fontSize: 'var(--boxalarm-font-size-base)', margin: 0 }}>
          Log maintenance event
        </h3>
        <label style={{ display: 'grid', gap: 4 }}>
          Description
          <input
            value={form.description}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
            style={{ minHeight: 44, padding: '0 12px' }}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          Vendor
          <input
            value={form.vendor}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, vendor: e.target.value }))}
            style={{ minHeight: 44, padding: '0 12px' }}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          Cost
          <input
            type="number"
            step="0.01"
            min="0"
            value={form.cost}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, cost: e.target.value }))}
            style={{ minHeight: 44, padding: '0 12px' }}
          />
        </label>
        {mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
        <button type="submit" style={{ minHeight: 44, maxWidth: 240 }}>
          Log maintenance
        </button>
      </form>
    </section>
  );
}
