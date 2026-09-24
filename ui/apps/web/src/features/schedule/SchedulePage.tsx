import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { approveShiftSwap, createShift, getShiftCoverage, listShifts } from './api';
import type { CoverageStatus, CreateShiftPosition } from './types';

const COVERAGE_LABEL: Record<CoverageStatus, string> = {
  covered: '✓ Covered',
  short: '△ Short',
  'qual-gapped': '✕ Missing qual',
};

function toEpochSeconds(localDateTime: string): number {
  return Math.floor(new Date(localDateTime).getTime() / 1000);
}

const emptyPosition: CreateShiftPosition = { positionCode: '', requiredQual: '' };

function CreateShiftForm({ onCreated }: { onCreated: () => void }) {
  const auth = useAuth();
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [stationId, setStationId] = useState('');
  const [positions, setPositions] = useState<CreateShiftPosition[]>([
    { ...emptyPosition },
    { ...emptyPosition },
  ]);

  const createMutation = useMutation({
    mutationFn: () =>
      createShift(auth, {
        startAt: toEpochSeconds(startAt),
        endAt: toEpochSeconds(endAt),
        stationId,
        positions: positions
          .filter((position) => position.positionCode.trim().length > 0)
          .map((position) =>
            position.requiredQual?.trim()
              ? { positionCode: position.positionCode, requiredQual: position.requiredQual }
              : { positionCode: position.positionCode },
          ),
      }),
    onSuccess: () => {
      setStartAt('');
      setEndAt('');
      setStationId('');
      setPositions([{ ...emptyPosition }, { ...emptyPosition }]);
      onCreated();
    },
  });

  return (
    <form
      aria-label="New shift"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        createMutation.mutate();
      }}
      style={{
        marginTop: 'var(--boxalarm-spacing-xl)',
        display: 'grid',
        gap: 'var(--boxalarm-spacing-md)',
        maxWidth: 480,
      }}
    >
      <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>New shift</h2>
      <label style={{ display: 'grid', gap: 4 }}>
        Start
        <input
          type="datetime-local"
          value={startAt}
          onChange={(e) => setStartAt(e.target.value)}
          required
          style={{ minHeight: 44, padding: '0 12px' }}
        />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        End
        <input
          type="datetime-local"
          value={endAt}
          onChange={(e) => setEndAt(e.target.value)}
          required
          style={{ minHeight: 44, padding: '0 12px' }}
        />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        Station ID
        <input
          value={stationId}
          onChange={(e) => setStationId(e.target.value)}
          required
          style={{ minHeight: 44, padding: '0 12px' }}
        />
      </label>
      {positions.map((position, index) => (
        <fieldset key={index} style={{ display: 'flex', gap: 'var(--boxalarm-spacing-sm)' }}>
          <legend>Position {index + 1}</legend>
          <label style={{ display: 'grid', gap: 4 }}>
            Position code
            <input
              value={position.positionCode}
              onChange={(e) =>
                setPositions((prev) =>
                  prev.map((p, i) => (i === index ? { ...p, positionCode: e.target.value } : p)),
                )
              }
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            Required qual (optional)
            <input
              value={position.requiredQual ?? ''}
              onChange={(e) =>
                setPositions((prev) =>
                  prev.map((p, i) => (i === index ? { ...p, requiredQual: e.target.value } : p)),
                )
              }
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
        </fieldset>
      ))}
      {createMutation.error ? (
        <p role="alert" aria-live="assertive">
          {createMutation.error.message}
        </p>
      ) : null}
      <button type="submit" style={{ minHeight: 44 }}>
        Create shift
      </button>
    </form>
  );
}

function CoverageSection() {
  const auth = useAuth();
  const coverageQuery = useQuery({
    queryKey: ['schedule', 'coverage'],
    queryFn: () => getShiftCoverage(auth),
  });

  if (coverageQuery.error) {
    return (
      <ApiForbiddenGate error={coverageQuery.error} embedded>
        <p>Unable to load coverage.</p>
      </ApiForbiddenGate>
    );
  }

  return (
    <section style={{ marginTop: 'var(--boxalarm-spacing-xl)' }}>
      <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>Coverage</h2>
      {coverageQuery.isLoading ? (
        <p>Loading coverage…</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {(coverageQuery.data ?? []).map((shift) => (
            <li key={shift.shiftId} style={{ padding: 'var(--boxalarm-spacing-sm) 0' }}>
              <strong>{shift.stationId}</strong> — {COVERAGE_LABEL[shift.status]}
              <ul style={{ listStyle: 'none', paddingLeft: 'var(--boxalarm-spacing-md)' }}>
                {shift.positions
                  .filter((position) => position.status !== 'covered')
                  .map((position) => (
                    <li key={position.positionCode}>
                      {position.positionCode} — {COVERAGE_LABEL[position.status]}
                      {position.status === 'qual-gapped' && position.requiredQual
                        ? ` (${position.requiredQual})`
                        : ''}
                    </li>
                  ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SwapApprovalForm() {
  const auth = useAuth();
  const [shiftId, setShiftId] = useState('');
  const [swapId, setSwapId] = useState('');
  const approveMutation = useMutation({
    mutationFn: () => approveShiftSwap(auth, shiftId, swapId),
    onSuccess: () => {
      setShiftId('');
      setSwapId('');
    },
  });

  return (
    <section style={{ marginTop: 'var(--boxalarm-spacing-xl)' }}>
      <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>Approve shift swap</h2>
      <form
        aria-label="Approve shift swap"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          approveMutation.mutate();
        }}
        style={{ display: 'flex', gap: 'var(--boxalarm-spacing-sm)', alignItems: 'end' }}
      >
        <label style={{ display: 'grid', gap: 4 }}>
          Shift ID
          <input
            value={shiftId}
            onChange={(e) => setShiftId(e.target.value)}
            required
            style={{ minHeight: 44, padding: '0 12px' }}
          />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          Swap ID
          <input
            value={swapId}
            onChange={(e) => setSwapId(e.target.value)}
            required
            style={{ minHeight: 44, padding: '0 12px' }}
          />
        </label>
        <button type="submit" style={{ minHeight: 44 }}>
          Approve
        </button>
      </form>
      {approveMutation.error ? (
        <p role="alert" aria-live="assertive">
          {approveMutation.error.message}
        </p>
      ) : null}
      {approveMutation.isSuccess ? <p role="status">Swap approved.</p> : null}
    </section>
  );
}

export function SchedulePage() {
  const auth = useAuth();
  const queryClient = useQueryClient();

  const shiftsQuery = useQuery({
    queryKey: ['schedule', 'shifts'],
    queryFn: () => listShifts(auth),
  });

  if (shiftsQuery.error) {
    return (
      <ApiForbiddenGate error={shiftsQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  return (
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>Schedule</h1>

      {shiftsQuery.isLoading ? (
        <p>Loading shifts…</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: 'var(--boxalarm-spacing-lg)' }}>
          {(shiftsQuery.data ?? []).map((shift) => (
            <li key={shift.shiftId} style={{ padding: 'var(--boxalarm-spacing-sm) 0' }}>
              <strong>{shift.stationId}</strong> — {new Date(shift.startAt * 1000).toLocaleString()}{' '}
              — {shift.status}
            </li>
          ))}
        </ul>
      )}

      <CreateShiftForm
        onCreated={() => void queryClient.invalidateQueries({ queryKey: ['schedule', 'shifts'] })}
      />
      <CoverageSection />
      <SwapApprovalForm />
    </main>
  );
}
