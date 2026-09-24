import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, Skeleton, TextInput } from '../../components/ui';
import { createMaintenance, getMaintenance } from './api';
import type { CreateMaintenanceInput } from './types';

const emptyForm = { description: '', vendor: '', cost: '' };

// Takes the apparatus's apparatusId (not its display unitId) — matches ApparatusDetailPage's
// own detail fetch and the real backend's maintenance endpoint, which keys directly on
// apparatusId (apparatus-service postMaintenance.ts).
export function MaintenanceTab({ apparatusId }: { apparatusId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(emptyForm);

  const query = useQuery({
    queryKey: ['apparatus', apparatusId, 'maintenance'],
    queryFn: () => getMaintenance(auth, apparatusId),
  });

  const mutation = useMutation({
    mutationFn: (input: CreateMaintenanceInput) => createMaintenance(auth, apparatusId, input),
    onSuccess: () => {
      setForm(emptyForm);
      void queryClient.invalidateQueries({ queryKey: ['apparatus', apparatusId, 'maintenance'] });
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
      <h2 style={{ fontSize: 17, fontWeight: 600 }}>Maintenance</h2>
      {query.isLoading ? (
        <Skeleton lines={3} />
      ) : records.length === 0 ? (
        <p>No maintenance recorded for this unit.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {records.map((record) => (
            <li
              key={record.performedAt}
              style={{
                padding: 'var(--bx-space-sm) 0',
                borderBottom: '1px solid var(--bx-border-decorative)',
              }}
            >
              <strong>{record.description}</strong> — {record.vendor} — ${record.cost.toFixed(2)}
              <div style={{ fontSize: 13, color: 'var(--bx-fg-muted)' }}>
                {new Date(record.performedAt * 1000).toLocaleDateString()}
                {record.scheduledNextAt
                  ? ` — next scheduled ${new Date(record.scheduledNextAt * 1000).toLocaleDateString()}`
                  : ''}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Card
        title="Log maintenance event"
        style={{ marginTop: 'var(--bx-space-lg)', maxWidth: 480 }}
      >
        <form
          aria-label="Log maintenance"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            const cost = Number(form.cost);
            mutation.mutate({ description: form.description, vendor: form.vendor, cost });
          }}
          style={{ display: 'grid', gap: 'var(--bx-space-sm)' }}
        >
          <TextInput
            label="Description"
            value={form.description}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
          />
          <TextInput
            label="Vendor"
            value={form.vendor}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, vendor: e.target.value }))}
          />
          <TextInput
            label="Cost"
            type="number"
            step="0.01"
            min="0"
            value={form.cost}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, cost: e.target.value }))}
          />
          {mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
          <Button type="submit" loading={mutation.isPending} style={{ maxWidth: 240 }}>
            Log maintenance
          </Button>
        </form>
      </Card>
    </section>
  );
}
