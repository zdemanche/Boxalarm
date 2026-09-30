import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StatusRole } from '@boxalarm/design-tokens';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  Button,
  Card,
  PageHeader,
  Select,
  Skeleton,
  StatusChip,
  TextInput,
} from '../../components/ui';
import { useStations } from '../../lib/useStations';
import { listMembers } from '../personnel/api';
import {
  approveShiftSwap,
  createShift,
  getShiftCoverage,
  listPendingShiftSwaps,
  listShifts,
} from './api';
import { formatShiftWindow } from './format';
import { SHIFT_STATUS_LABEL, type CoverageStatus, type CreateShiftPosition } from './types';

const COVERAGE_STATUS: Record<CoverageStatus, StatusRole> = {
  covered: 'ok',
  short: 'warning',
  'qual-gapped': 'danger',
};

const COVERAGE_WORD: Record<CoverageStatus, string> = {
  covered: 'Covered',
  short: 'Short',
  'qual-gapped': 'Missing qual',
};

// DUTY_SHIFT.startAt/endAt are epoch MILLISECONDS (personnel-service shifts/
// completeShiftAttendance.ts; coverage and claim compare them with Date.now()). Sending
// seconds made every web-created shift read as 1970 — never in coverage, never completable.
function toEpochMillis(localDateTime: string): number {
  return new Date(localDateTime).getTime();
}

const emptyPosition: CreateShiftPosition = { positionCode: '', requiredQual: '' };

function CreateShiftForm({ onCreated }: { onCreated: () => void }) {
  const auth = useAuth();
  const { stations, isLoading: stationsLoading } = useStations();
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
        startAt: toEpochMillis(startAt),
        endAt: toEpochMillis(endAt),
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
    <Card title="New shift" style={{ marginTop: 'var(--bx-space-xl)', maxWidth: 480 }}>
      <form
        aria-label="New shift"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          createMutation.mutate();
        }}
        style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
      >
        <TextInput
          label="Start"
          type="datetime-local"
          value={startAt}
          onChange={(e) => setStartAt(e.target.value)}
          required
        />
        <TextInput
          label="End"
          type="datetime-local"
          value={endAt}
          onChange={(e) => setEndAt(e.target.value)}
          required
        />
        {stations.length > 0 ? (
          <Select
            label="Station"
            value={stationId}
            onChange={(e) => setStationId(e.target.value)}
            required
          >
            <option value="">Choose a station</option>
            {stations.map((station) => (
              <option key={station.stationId} value={station.stationId}>
                {station.name}
              </option>
            ))}
          </Select>
        ) : (
          <TextInput
            label="Station"
            help={
              stationsLoading
                ? undefined
                : "Stations aren't set up in Settings yet, so enter the station's name."
            }
            value={stationId}
            onChange={(e) => setStationId(e.target.value)}
            required
          />
        )}
        {positions.map((position, index) => (
          <fieldset
            key={index}
            style={{ display: 'flex', gap: 'var(--bx-space-sm)', border: 'none', padding: 0 }}
          >
            <legend>Position {index + 1}</legend>
            <TextInput
              label="Position code"
              value={position.positionCode}
              onChange={(e) =>
                setPositions((prev) =>
                  prev.map((p, i) => (i === index ? { ...p, positionCode: e.target.value } : p)),
                )
              }
            />
            <TextInput
              label="Required qual"
              optional
              value={position.requiredQual ?? ''}
              onChange={(e) =>
                setPositions((prev) =>
                  prev.map((p, i) => (i === index ? { ...p, requiredQual: e.target.value } : p)),
                )
              }
            />
          </fieldset>
        ))}
        {createMutation.error ? (
          <p role="alert" aria-live="assertive">
            {createMutation.error.message}
          </p>
        ) : null}
        <Button type="submit" loading={createMutation.isPending}>
          Create shift
        </Button>
      </form>
    </Card>
  );
}

function CoverageSection() {
  const auth = useAuth();
  const { nameFor } = useStations();
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
    <Card title="Coverage" style={{ marginTop: 'var(--bx-space-xl)' }}>
      {coverageQuery.isLoading ? (
        <Skeleton lines={3} />
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {(coverageQuery.data ?? []).map((shift) => (
            <li key={shift.shiftId} style={{ padding: 'var(--bx-space-sm) 0' }}>
              <strong>{nameFor(shift.stationId)}</strong>{' '}
              {formatShiftWindow(shift.startAt, shift.endAt)}{' '}
              <StatusChip status={COVERAGE_STATUS[shift.status]}>
                {COVERAGE_WORD[shift.status]}
              </StatusChip>
              <ul style={{ listStyle: 'none', paddingLeft: 'var(--bx-space-md)' }}>
                {shift.positions
                  .filter((position) => position.status !== 'covered')
                  .map((position) => (
                    <li key={position.positionCode}>
                      {position.positionCode} —{' '}
                      <StatusChip status={COVERAGE_STATUS[position.status]}>
                        {COVERAGE_WORD[position.status]}
                      </StatusChip>
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
    </Card>
  );
}

/** Swaps waiting for an officer, each with its own Approve - no Shift ID or Swap ID to type. */
function PendingSwaps() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const { nameFor } = useStations();
  const swapsQuery = useQuery({
    queryKey: ['schedule', 'swaps', 'pending'],
    queryFn: () => listPendingShiftSwaps(auth),
  });
  const membersQuery = useQuery({
    queryKey: ['personnel', 'members'],
    queryFn: () => listMembers(auth),
  });
  const shiftsQuery = useQuery({
    queryKey: ['schedule', 'shifts'],
    queryFn: () => listShifts(auth),
  });
  const approveMutation = useMutation({
    mutationFn: (swap: { shiftId: string; requestedAt: number }) =>
      approveShiftSwap(auth, swap.shiftId, String(swap.requestedAt)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['schedule'] });
    },
  });

  const memberName = (memberId: string) => {
    const member = membersQuery.data?.find((m) => m.memberId === memberId);
    return member ? `${member.firstName} ${member.lastName}` : 'A member';
  };

  let body: React.ReactNode;
  if (swapsQuery.isLoading) {
    body = <Skeleton lines={2} />;
  } else if (swapsQuery.error || !swapsQuery.data) {
    body = (
      <ApiForbiddenGate error={swapsQuery.error} embedded>
        <p>Pending swaps couldn&rsquo;t load.</p>
      </ApiForbiddenGate>
    );
  } else if (swapsQuery.data.length === 0) {
    body = <p>No swaps are waiting for approval.</p>;
  } else {
    body = (
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {swapsQuery.data.map((swap) => {
          const shift = shiftsQuery.data?.find((s) => s.shiftId === swap.shiftId);
          const what = `${memberName(swap.fromMemberId)} to ${memberName(swap.toMemberId)}, ${swap.positionCode}`;
          const approving =
            approveMutation.isPending &&
            approveMutation.variables?.shiftId === swap.shiftId &&
            approveMutation.variables.requestedAt === swap.requestedAt;
          return (
            <li
              key={`${swap.shiftId}-${swap.requestedAt}`}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--bx-space-sm)',
                padding: 'var(--bx-space-sm) 0',
                borderBottom: '1px solid var(--bx-border-decorative)',
              }}
            >
              <span>
                <strong>
                  {memberName(swap.fromMemberId)} → {memberName(swap.toMemberId)}
                </strong>{' '}
                · {swap.positionCode}
                {shift
                  ? ` · ${nameFor(shift.stationId)}, ${formatShiftWindow(shift.startAt, shift.endAt)}`
                  : ''}
              </span>
              <Button
                variant="secondary"
                loading={approving}
                aria-label={`Approve swap: ${what}`}
                onClick={() =>
                  approveMutation.mutate({ shiftId: swap.shiftId, requestedAt: swap.requestedAt })
                }
              >
                Approve
              </Button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Card title="Swaps waiting for approval" style={{ marginTop: 'var(--bx-space-xl)' }}>
      {body}
      {approveMutation.error ? (
        <p role="alert" aria-live="assertive">
          The swap wasn&rsquo;t approved: {approveMutation.error.message}
        </p>
      ) : null}
      {approveMutation.isSuccess ? <p role="status">Swap approved.</p> : null}
    </Card>
  );
}

export function SchedulePage() {
  const auth = useAuth();
  const { nameFor } = useStations();
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
    <main id="main-content">
      <PageHeader title="Schedule" />

      {shiftsQuery.isLoading ? (
        <Skeleton lines={4} />
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {(shiftsQuery.data ?? []).map((shift) => (
            <li key={shift.shiftId} style={{ padding: 'var(--bx-space-sm) 0' }}>
              <strong>{nameFor(shift.stationId)}</strong> —{' '}
              {formatShiftWindow(shift.startAt, shift.endAt)} — {SHIFT_STATUS_LABEL[shift.status]}
            </li>
          ))}
        </ul>
      )}

      <CreateShiftForm
        onCreated={() => void queryClient.invalidateQueries({ queryKey: ['schedule', 'shifts'] })}
      />
      <CoverageSection />
      <PendingSwaps />
    </main>
  );
}
