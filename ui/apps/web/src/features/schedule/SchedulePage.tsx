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
import { humanize } from '../../lib/labels';
import { useRidingPositions } from '../../lib/useRidingPositions';
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
import {
  SHIFT_STATUS_LABEL,
  type CoverageStatus,
  type CreateShiftPosition,
  type DutyShift,
} from './types';

/** The department's label for a riding-position code ("FF" -> "Firefighter (interior)"), or the
 * code itself when no riding positions are configured. */
function usePositionLabel(): (code: string) => string {
  const { positions } = useRidingPositions();
  return (code) => positions.find((position) => position.code === code)?.label ?? code;
}

/** Spelled-out qual codes ("DRIVER_OPERATOR") read as words; short department codes ("DO") stay. */
function qualLabel(code: string): string {
  return code.includes('_') ? humanize(code) : code;
}

const SHIFT_STATUS_ROLE: Record<DutyShift['status'], StatusRole> = {
  FULL: 'ok',
  PARTIALLY_FILLED: 'warning',
  OPEN: 'warning',
  CANCELLED: 'neutral',
};

function ShiftRows({
  shifts,
  nameFor,
}: {
  shifts: readonly DutyShift[];
  nameFor: (stationId: string) => string;
}) {
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {shifts.map((shift) => (
        <li
          key={shift.shiftId}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 'var(--bx-space-xs) var(--bx-space-sm)',
            padding: 'var(--bx-space-sm) 0',
            borderBottom: '1px solid var(--bx-border-decorative)',
          }}
        >
          <strong>{nameFor(shift.stationId)}</strong>
          <span>{formatShiftWindow(shift.startAt, shift.endAt)}</span>
          <StatusChip status={SHIFT_STATUS_ROLE[shift.status]}>
            {SHIFT_STATUS_LABEL[shift.status]}
          </StatusChip>
        </li>
      ))}
    </ul>
  );
}

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
  const { positions: ridingPositions } = useRidingPositions();
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
            {ridingPositions.length > 0 ? (
              // Pick from the department's riding positions; the position's own required qual
              // fills in, or clears when it has none (and can still be changed).
              <Select
                label="Position"
                value={position.positionCode}
                onChange={(e) => {
                  const chosen = ridingPositions.find((p) => p.code === e.target.value);
                  setPositions((prev) =>
                    prev.map((p, i) =>
                      i === index
                        ? {
                            ...p,
                            positionCode: e.target.value,
                            // The position's own qual, or none: a qual kept from the previous
                            // choice would silently narrow who can claim this one.
                            requiredQual: chosen?.requiredQual ?? '',
                          }
                        : p,
                    ),
                  );
                }}
              >
                <option value="">No position</option>
                {ridingPositions.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
              </Select>
            ) : (
              <TextInput
                label="Position code"
                help="Riding positions aren't set up in Settings yet, so enter the position's code."
                value={position.positionCode}
                onChange={(e) =>
                  setPositions((prev) =>
                    prev.map((p, i) => (i === index ? { ...p, positionCode: e.target.value } : p)),
                  )
                }
              />
            )}
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
  const positionLabel = usePositionLabel();
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
                  .map((position, index) => (
                    // A shift can be short the same position twice (two firefighters).
                    <li key={`${position.positionCode}-${index}`}>
                      {positionLabel(position.positionCode)} —{' '}
                      <StatusChip status={COVERAGE_STATUS[position.status]}>
                        {COVERAGE_WORD[position.status]}
                      </StatusChip>
                      {position.status === 'qual-gapped' && position.requiredQual
                        ? ` (needs ${qualLabel(position.requiredQual)})`
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
  const positionLabel = usePositionLabel();
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
          const what = `${memberName(swap.fromMemberId)} to ${memberName(swap.toMemberId)}, ${positionLabel(swap.positionCode)}`;
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
                · {positionLabel(swap.positionCode)}
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

  const now = Date.now();
  const byStart = [...(shiftsQuery.data ?? [])].sort((a, b) => a.startAt - b.startAt);
  const upcoming = byStart.filter((shift) => shift.endAt > now);
  const past = byStart.filter((shift) => shift.endAt <= now).reverse();

  return (
    <main id="main-content">
      <PageHeader title="Schedule" />

      {/* What needs an officer first: swaps to approve, then gaps, then the plan itself. */}
      <PendingSwaps />
      <CoverageSection />

      <Card title="Upcoming shifts" style={{ marginTop: 'var(--bx-space-xl)' }}>
        {shiftsQuery.isLoading ? (
          <Skeleton lines={4} />
        ) : upcoming.length === 0 ? (
          <p>No upcoming shifts are scheduled.</p>
        ) : (
          <ShiftRows shifts={upcoming} nameFor={nameFor} />
        )}
        {past.length > 0 ? (
          <details style={{ marginTop: 'var(--bx-space-md)' }}>
            <summary style={{ cursor: 'pointer', color: 'var(--bx-fg-muted)' }}>
              Earlier shifts ({past.length})
            </summary>
            <ShiftRows shifts={past} nameFor={nameFor} />
          </details>
        ) : null}
      </Card>

      <CreateShiftForm
        onCreated={() => void queryClient.invalidateQueries({ queryKey: ['schedule', 'shifts'] })}
      />
    </main>
  );
}
