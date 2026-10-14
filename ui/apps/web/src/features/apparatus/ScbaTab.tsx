import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { Button, Card, Skeleton, StatusChip, TextInput } from '../../components/ui';
import { daysUntil, dueLabel, formatCalendarDate } from '../../lib/dates';
import { createScbaRecord, getScbaDueSoon } from './api';
import type { CreateScbaInput, ScbaRecord } from './types';
import styles from './Apparatus.module.css';

const emptyForm: CreateScbaInput = {
  scbaUnitId: '',
  cylinderId: '',
  flowTestDate: '',
  hydroTestDate: '',
};

// POST /apparatus/{unitId}/scba resolves the unit by its display unitId (backend postScba.ts,
// via GSI3), and stores the resolved apparatusId on the SCBA and due items. So the write goes
// to unitId and the due-soon filter matches on apparatusId.
export function ScbaTab({ unitId, apparatusId }: { unitId: string; apparatusId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(emptyForm);
  const [records, setRecords] = useState<ScbaRecord[]>([]);

  const dueSoonQuery = useQuery({
    queryKey: ['apparatus', 'scba', 'due-soon'],
    queryFn: () => getScbaDueSoon(auth),
  });

  const mutation = useMutation({
    mutationFn: (input: CreateScbaInput) => createScbaRecord(auth, unitId, input),
    onSuccess: (created) => {
      setRecords((prev) => [created, ...prev]);
      setForm(emptyForm);
      void queryClient.invalidateQueries({ queryKey: ['apparatus', 'scba', 'due-soon'] });
    },
  });

  // A failed due-soon read is reported inline in its own section; it must not take down the
  // "Log SCBA record" form below, which writes to a different endpoint (PR #321 review M3).
  // 403 copy stays generic, never the problem detail (ForbiddenState rule, PR #93 review).
  const dueSoonErrorMessage =
    dueSoonQuery.error instanceof ApiError && dueSoonQuery.error.problem.status === 403
      ? 'You do not have access to the SCBA due-soon list.'
      : 'The SCBA due-soon list could not be loaded.';

  const dueForUnit = (dueSoonQuery.data ?? []).filter((entry) => entry.apparatusId === apparatusId);

  return (
    <div className={styles.stack}>
      {records.length > 0 ? (
        <Card title="Recorded this visit">
          <ul className={styles.list}>
            {records.map((record) => (
              <li key={record.scbaUnitId} className={styles.row}>
                <span className={styles.rowBody}>
                  <span className={[styles.rowTitle, styles.mono].join(' ')}>
                    {record.scbaUnitId}
                  </span>
                  <span className={styles.rowMeta}>
                    Cylinder {record.cylinderId} · next flow test{' '}
                    {formatCalendarDate(record.nextFlowTestDue)} · next hydro test{' '}
                    {formatCalendarDate(record.nextHydroTestDue)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="SCBA tests due soon">
        {dueSoonQuery.isLoading ? (
          <Skeleton lines={2} />
        ) : dueSoonQuery.error ? (
          <div role="alert" className={styles.notice}>
            <p>{dueSoonErrorMessage}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void dueSoonQuery.refetch()}
            >
              Try again
            </Button>
          </div>
        ) : dueForUnit.length === 0 ? (
          <p className={styles.message}>Nothing due soon for this unit.</p>
        ) : (
          <ul className={styles.list}>
            {dueForUnit.map((entry) => {
              const days = daysUntil(entry.dueDate);
              return (
                <li key={`${entry.scbaUnitId}-${entry.testType}`} className={styles.row}>
                  <span className={styles.rowBody}>
                    <span className={[styles.rowTitle, styles.mono].join(' ')}>
                      {entry.scbaUnitId}
                    </span>
                    <span className={styles.rowMeta}>
                      {entry.testType === 'SCBA_FLOW' ? 'Flow test' : 'Hydro test'} due{' '}
                      {formatCalendarDate(entry.dueDate)}
                    </span>
                  </span>
                  <StatusChip status={days < 0 ? 'danger' : 'warning'}>{dueLabel(days)}</StatusChip>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Log SCBA record">
        <form
          aria-label="Log SCBA record"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            mutation.mutate(form);
          }}
          className={styles.formGrid}
        >
          <TextInput
            label="SCBA unit"
            value={form.scbaUnitId}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, scbaUnitId: e.target.value }))}
          />
          <TextInput
            label="Cylinder ID"
            value={form.cylinderId}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, cylinderId: e.target.value }))}
          />
          <TextInput
            label="Flow test date"
            type="date"
            value={form.flowTestDate}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, flowTestDate: e.target.value }))}
          />
          <TextInput
            label="Hydro test date"
            type="date"
            value={form.hydroTestDate}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, hydroTestDate: e.target.value }))}
          />
          {mutation.error ? (
            <p role="alert" className={styles.error}>
              {mutation.error.message}
            </p>
          ) : null}
          <div className={styles.formActions}>
            <Button type="submit" loading={mutation.isPending}>
              Save SCBA record
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
