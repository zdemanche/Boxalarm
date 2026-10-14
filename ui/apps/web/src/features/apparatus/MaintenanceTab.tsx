import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, Skeleton, TextInput } from '../../components/ui';
import { formatCalendarDate, toCalendarDate } from '../../lib/dates';
import { createMaintenance, getMaintenance } from './api';
import type { CreateMaintenanceInput } from './types';
import styles from './Apparatus.module.css';

const emptyForm = { description: '', vendor: '', cost: '', scheduledNextAt: '' };

function formatEpochDate(epochSeconds: number): string {
  return formatCalendarDate(toCalendarDate(epochSeconds * 1000));
}

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
      <Card>
        <ApiForbiddenGate error={query.error} embedded>
          <p>Unexpected error</p>
        </ApiForbiddenGate>
      </Card>
    );
  }

  const records = [...(query.data?.records ?? [])].sort((a, b) => b.performedAt - a.performedAt);

  return (
    <div className={styles.stack}>
      <Card title="Maintenance history">
        {query.isLoading ? (
          <Skeleton lines={3} />
        ) : records.length === 0 ? (
          <p className={styles.message}>No maintenance recorded for this unit.</p>
        ) : (
          <ul className={styles.list}>
            {records.map((record) => (
              <li key={record.performedAt} className={styles.row}>
                <span className={styles.rowBody}>
                  <span className={styles.rowTitle}>{record.description}</span>
                  <span className={styles.rowMeta}>
                    {formatEpochDate(record.performedAt)} · {record.vendor}
                    {record.scheduledNextAt
                      ? ` · next scheduled ${formatEpochDate(record.scheduledNextAt)}`
                      : ''}
                  </span>
                </span>
                <span className={styles.amount}>
                  {record.cost.toLocaleString(undefined, { style: 'currency', currency: 'USD' })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Log maintenance event">
        <form
          aria-label="Log maintenance"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            const cost = Number(form.cost);
            mutation.mutate({
              description: form.description,
              vendor: form.vendor,
              cost,
              scheduledNextAt: form.scheduledNextAt
                ? Math.floor(new Date(form.scheduledNextAt).getTime() / 1000)
                : null,
            });
          }}
          className={styles.formGrid}
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
          <TextInput
            label="Next scheduled"
            type="date"
            optional
            value={form.scheduledNextAt}
            onChange={(e) => setForm((prev) => ({ ...prev, scheduledNextAt: e.target.value }))}
          />
          {mutation.error ? (
            <p role="alert" className={styles.error}>
              {mutation.error.message}
            </p>
          ) : null}
          <div className={styles.formActions}>
            <Button type="submit" loading={mutation.isPending}>
              Log maintenance
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
