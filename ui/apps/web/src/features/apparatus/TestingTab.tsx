import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
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
      <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)' }}>Testing schedules</h2>
      {scheduleQuery.isLoading ? (
        <p>Loading testing schedules…</p>
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

      <form
        aria-label="Log test record"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          mutation.mutate(form);
        }}
        style={{
          display: 'grid',
          gap: 'var(--boxalarm-spacing-sm)',
          maxWidth: 480,
          marginTop: 'var(--boxalarm-spacing-lg)',
        }}
      >
        <h3 style={{ fontSize: 'var(--boxalarm-font-size-base)', margin: 0 }}>Log test record</h3>
        <label style={{ display: 'grid', gap: 4 }}>
          Test type
          <select
            value={form.testType}
            onChange={(e) => setForm((prev) => ({ ...prev, testType: e.target.value as TestType }))}
            style={{ minHeight: 44 }}
          >
            {TEST_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          Result
          <select
            value={form.result}
            onChange={(e) =>
              setForm((prev) => ({ ...prev, result: e.target.value as 'PASS' | 'FAIL' }))
            }
            style={{ minHeight: 44 }}
          >
            <option value="PASS">Pass</option>
            <option value="FAIL">Fail</option>
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          Next due date
          <input
            type="date"
            value={form.nextDueDate}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, nextDueDate: e.target.value }))}
            style={{ minHeight: 44, padding: '0 12px' }}
          />
        </label>
        {mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
        <button type="submit" style={{ minHeight: 44, maxWidth: 240 }}>
          Save test record
        </button>
      </form>
    </section>
  );
}
