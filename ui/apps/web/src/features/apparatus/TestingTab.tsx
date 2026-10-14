import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, Select, Skeleton, StatusChip, TextInput } from '../../components/ui';
import { daysUntil, dueLabel, formatCalendarDate } from '../../lib/dates';
import { humanize } from '../../lib/labels';
import { createTestRecord, getTestingSchedules } from './api';
import type { CreateTestRecordInput, TestType } from './types';
import styles from './Apparatus.module.css';

const TEST_TYPES: TestType[] = ['HOSE', 'LADDER', 'PUMP', 'AERIAL'];
const emptyForm: CreateTestRecordInput = { testType: 'HOSE', result: 'PASS', nextDueDate: '' };

/** Inside this many days a scheduled test reads as due soon. */
const DUE_SOON_DAYS = 30;

export function TestingTab({ unitId }: { unitId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(emptyForm);

  const scheduleQuery = useQuery({
    queryKey: ['apparatus', 'testing-schedules'],
    queryFn: () => getTestingSchedules(auth),
  });

  const mutation = useMutation({
    mutationFn: (input: CreateTestRecordInput) => createTestRecord(auth, unitId, input),
    onSuccess: () => {
      setForm(emptyForm);
      void queryClient.invalidateQueries({ queryKey: ['apparatus', 'testing-schedules'] });
    },
  });

  if (scheduleQuery.error) {
    return (
      <Card>
        <ApiForbiddenGate error={scheduleQuery.error} embedded>
          <p>Unexpected error</p>
        </ApiForbiddenGate>
      </Card>
    );
  }

  const scheduleForUnit = (scheduleQuery.data ?? []).filter((entry) => entry.unitId === unitId);

  return (
    <div className={styles.stack}>
      <Card title="Testing schedule">
        {scheduleQuery.isLoading ? (
          <Skeleton lines={2} />
        ) : scheduleForUnit.length === 0 ? (
          <p className={styles.message}>No scheduled tests for this unit.</p>
        ) : (
          <ul aria-label="Scheduled tests" className={styles.list}>
            {scheduleForUnit.map((entry) => {
              const days = daysUntil(entry.nextDueDate);
              return (
                <li key={entry.testType} className={styles.row}>
                  <span className={styles.rowBody}>
                    <span className={styles.rowTitle}>{humanize(entry.testType)} test</span>
                    <span className={styles.rowMeta}>
                      Next due {formatCalendarDate(entry.nextDueDate)}
                    </span>
                  </span>
                  {days <= DUE_SOON_DAYS ? (
                    <StatusChip status={days < 0 ? 'danger' : 'warning'}>
                      {dueLabel(days)}
                    </StatusChip>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="Log test record">
        <form
          aria-label="Log test record"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            mutation.mutate(form);
          }}
          className={styles.formGrid}
        >
          <Select
            label="Test type"
            value={form.testType}
            onChange={(e) => setForm((prev) => ({ ...prev, testType: e.target.value as TestType }))}
          >
            {TEST_TYPES.map((type) => (
              <option key={type} value={type}>
                {humanize(type)}
              </option>
            ))}
          </Select>
          <Select
            label="Result"
            value={form.result}
            onChange={(e) =>
              setForm((prev) => ({ ...prev, result: e.target.value as 'PASS' | 'FAIL' }))
            }
          >
            <option value="PASS">Pass</option>
            <option value="FAIL">Fail</option>
          </Select>
          <TextInput
            label="Next due date"
            type="date"
            value={form.nextDueDate}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, nextDueDate: e.target.value }))}
          />
          {mutation.error ? (
            <p role="alert" className={styles.error}>
              {mutation.error.message}
            </p>
          ) : null}
          <div className={styles.formActions}>
            <Button type="submit" loading={mutation.isPending}>
              Save test record
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
