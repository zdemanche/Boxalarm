import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { createScbaRecord, getScbaDueSoon } from './api';
import type { CreateScbaInput, ScbaRecord } from './types';

const emptyForm: CreateScbaInput = {
  scbaUnitId: '',
  cylinderId: '',
  flowTestDate: '',
  hydroTestDate: '',
};

// Takes the apparatus's apparatusId (not its display unitId) — matches ApparatusDetailPage's
// own detail fetch and ScbaDueEntry.apparatusId (backend scbaRecord.ts parseScbaDueItem, which
// never resolves to the display unit code), so the due-soon filter below actually matches.
export function ScbaTab({ apparatusId }: { apparatusId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(emptyForm);
  const [records, setRecords] = useState<ScbaRecord[]>([]);

  const dueSoonQuery = useQuery({
    queryKey: ['apparatus', 'scba', 'due-soon'],
    queryFn: () => getScbaDueSoon(auth),
  });

  const mutation = useMutation({
    mutationFn: (input: CreateScbaInput) => createScbaRecord(auth, apparatusId, input),
    onSuccess: (created) => {
      setRecords((prev) => [created, ...prev]);
      setForm(emptyForm);
      void queryClient.invalidateQueries({ queryKey: ['apparatus', 'scba', 'due-soon'] });
    },
  });

  if (dueSoonQuery.error) {
    return (
      <ApiForbiddenGate error={dueSoonQuery.error} embedded>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const dueForUnit = (dueSoonQuery.data ?? []).filter((entry) => entry.apparatusId === apparatusId);

  return (
    <section>
      <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)' }}>SCBA</h2>

      {records.length > 0 ? (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {records.map((record) => (
            <li
              key={record.scbaUnitId}
              style={{ padding: 'var(--boxalarm-spacing-sm) 0', borderBottom: '1px solid #0002' }}
            >
              <strong>{record.scbaUnitId}</strong> — cylinder {record.cylinderId}
              <div style={{ fontSize: 'var(--boxalarm-font-size-sm)' }}>
                Next flow test due {record.nextFlowTestDue} — next hydro test due{' '}
                {record.nextHydroTestDue}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <h3 style={{ fontSize: 'var(--boxalarm-font-size-base)' }}>Due soon</h3>
      {dueSoonQuery.isLoading ? (
        <p>Loading due-soon SCBA tests…</p>
      ) : dueForUnit.length === 0 ? (
        <p>Nothing due soon for this unit.</p>
      ) : (
        <ul>
          {dueForUnit.map((entry) => (
            <li key={`${entry.scbaUnitId}-${entry.testType}`}>
              {entry.scbaUnitId} — {entry.testType === 'SCBA_FLOW' ? 'Flow test' : 'Hydro test'} due{' '}
              {entry.dueDate}
            </li>
          ))}
        </ul>
      )}

      <form
        aria-label="Log SCBA record"
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
        <h3 style={{ fontSize: 'var(--boxalarm-font-size-base)', margin: 0 }}>Log SCBA record</h3>
        <label style={{ display: 'grid', gap: 4 }}>
          SCBA unit
          <input
            value={form.scbaUnitId}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, scbaUnitId: e.target.value }))}
            style={{ minHeight: 44, padding: '0 12px' }}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          Cylinder ID
          <input
            value={form.cylinderId}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, cylinderId: e.target.value }))}
            style={{ minHeight: 44, padding: '0 12px' }}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          Flow test date
          <input
            type="date"
            value={form.flowTestDate}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, flowTestDate: e.target.value }))}
            style={{ minHeight: 44, padding: '0 12px' }}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          Hydro test date
          <input
            type="date"
            value={form.hydroTestDate}
            required
            onChange={(e) => setForm((prev) => ({ ...prev, hydroTestDate: e.target.value }))}
            style={{ minHeight: 44, padding: '0 12px' }}
          />
        </label>
        {mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
        <button type="submit" style={{ minHeight: 44, maxWidth: 240 }}>
          Save SCBA record
        </button>
      </form>
    </section>
  );
}
