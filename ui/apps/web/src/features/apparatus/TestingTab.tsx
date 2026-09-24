import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, Select, Skeleton, TextInput } from '../../components/ui';
import { createTestRecord, getTestingSchedules } from './api';
import type { CreateTestRecordInput, TestType } from './types';

const TEST_TYPES: TestType[] = ['HOSE', 'LADDER', 'PUMP', 'AERIAL'];
const emptyForm: CreateTestRecordInput = { testType: 'HOSE', result: 'PASS', nextDueDate: '' };

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
      <ApiForbiddenGate error={scheduleQuery.error} embedded>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const scheduleForUnit = (scheduleQuery.data ?? []).filter((entry) => entry.unitId === unitId);

  return (
    <section>
      <h2 style={{ fontSize: 17, fontWeight: 600 }}>Testing schedules</h2>
      {scheduleQuery.isLoading ? (
        <Skeleton lines={2} />
      ) : scheduleForUnit.length === 0 ? (
        <p>No scheduled tests for this unit.</p>
      ) : (
        <ul>
          {scheduleForUnit.map((entry) => (
            <li key={entry.testType}>
              {entry.testType} due {entry.nextDueDate}
            </li>
          ))}
        </ul>
      )}

      <Card title="Log test record" style={{ marginTop: 'var(--bx-space-lg)', maxWidth: 480 }}>
        <form
          aria-label="Log test record"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            mutation.mutate(form);
          }}
          style={{ display: 'grid', gap: 'var(--bx-space-sm)' }}
        >
          <Select
            label="Test type"
            value={form.testType}
            onChange={(e) => setForm((prev) => ({ ...prev, testType: e.target.value as TestType }))}
          >
            {TEST_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
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
          {mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
          <Button type="submit" loading={mutation.isPending} style={{ maxWidth: 240 }}>
            Save test record
          </Button>
        </form>
      </Card>
    </section>
  );
}
