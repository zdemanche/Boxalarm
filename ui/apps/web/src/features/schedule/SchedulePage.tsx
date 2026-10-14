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
import { problemMessage } from '../personnel/problemMessage';
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
import styles from './SchedulePage.module.css';

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
    <ul className={styles.list}>
      {shifts.map((shift) => (
        <li key={shift.shiftId} className={styles.row}>
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>{nameFor(shift.stationId)}</span>
            <span className={styles.rowMeta}>{formatShiftWindow(shift.startAt, shift.endAt)}</span>
          </span>
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

const MAX_POSITIONS = 99;

type PositionRow = CreateShiftPosition & { rowId: number };

let nextRowId = 0;
const newPositionRow = (): PositionRow => ({
  rowId: nextRowId++,
  positionCode: '',
  requiredQual: '',
});
const initialPositionRows = () => [newPositionRow(), newPositionRow()];

function CreateShiftForm({ onCreated }: { onCreated: () => void }) {
  const auth = useAuth();
  const { stations, isLoading: stationsLoading } = useStations();
  const { positions: ridingPositions } = useRidingPositions();
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');
  const [stationId, setStationId] = useState('');
  const [positions, setPositions] = useState<PositionRow[]>(initialPositionRows);

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
      setPositions(initialPositionRows());
      onCreated();
    },
  });

  return (
    <Card title="New shift">
      <form
        aria-label="New shift"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          createMutation.mutate();
        }}
        className={styles.form}
      >
        <div className={styles.pair}>
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
        </div>
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
          <fieldset key={position.rowId} className={styles.position}>
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
            {positions.length > 1 ? (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-label={`Remove position ${index + 1}`}
                onClick={() =>
                  setPositions((prev) => prev.filter((p) => p.rowId !== position.rowId))
                }
              >
                Remove
              </Button>
            ) : null}
          </fieldset>
        ))}
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={positions.length >= MAX_POSITIONS}
            onClick={() => setPositions((prev) => [...prev, newPositionRow()])}
          >
            Add position
          </Button>
        </div>
        {createMutation.error ? (
          <p role="alert" aria-live="assertive" className={styles.error}>
            {problemMessage(createMutation.error)}
          </p>
        ) : null}
        <div className={styles.submit}>
          <Button type="submit" loading={createMutation.isPending}>
            Create shift
          </Button>
        </div>
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

  const shifts = coverageQuery.data ?? [];

  return (
    <Card title="Coverage">
      {coverageQuery.isLoading ? (
        <Skeleton lines={3} />
      ) : shifts.length === 0 ? (
        <p className={styles.muted}>No upcoming shifts to check.</p>
      ) : (
        <ul className={styles.list}>
          {shifts.map((shift) => {
            const gaps = shift.positions.filter((position) => position.status !== 'covered');
            return (
              <li key={shift.shiftId} className={styles.row}>
                <span className={styles.rowMain}>
                  <span className={styles.rowTitle}>{nameFor(shift.stationId)}</span>
                  <span className={styles.rowMeta}>
                    {formatShiftWindow(shift.startAt, shift.endAt)}
                  </span>
                </span>
                <StatusChip status={COVERAGE_STATUS[shift.status]}>
                  {COVERAGE_WORD[shift.status]}
                </StatusChip>
                {gaps.length > 0 ? (
                  <ul
                    className={styles.gaps}
                    aria-label={`Open positions, ${nameFor(shift.stationId)}`}
                  >
                    {gaps.map((position, index) => (
                      // A shift can be short the same position twice (two firefighters).
                      <li key={`${position.positionCode}-${index}`} className={styles.gap}>
                        <span>
                          {positionLabel(position.positionCode)}
                          {position.status === 'qual-gapped' && position.requiredQual ? (
                            <span className={styles.need}>
                              {' '}
                              · needs {qualLabel(position.requiredQual)}
                            </span>
                          ) : null}
                        </span>
                        <StatusChip status={COVERAGE_STATUS[position.status]}>
                          {COVERAGE_WORD[position.status]}
                        </StatusChip>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
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
    body = <p className={styles.muted}>No swaps are waiting for approval.</p>;
  } else {
    body = (
      <ul className={styles.list}>
        {swapsQuery.data.map((swap) => {
          const shift = shiftsQuery.data?.find((s) => s.shiftId === swap.shiftId);
          const what = `${memberName(swap.fromMemberId)} to ${memberName(swap.toMemberId)}, ${positionLabel(swap.positionCode)}`;
          const approving =
            approveMutation.isPending &&
            approveMutation.variables?.shiftId === swap.shiftId &&
            approveMutation.variables.requestedAt === swap.requestedAt;
          return (
            <li key={`${swap.shiftId}-${swap.requestedAt}`} className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>
                  {memberName(swap.fromMemberId)} → {memberName(swap.toMemberId)}
                </span>
                <span className={styles.rowMeta}>
                  {positionLabel(swap.positionCode)}
                  {shift
                    ? ` · ${nameFor(shift.stationId)}, ${formatShiftWindow(shift.startAt, shift.endAt)}`
                    : ''}
                </span>
              </span>
              <Button
                variant="secondary"
                size="sm"
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
    <Card title="Swaps waiting for approval">
      {body}
      {approveMutation.error ? (
        <p role="alert" aria-live="assertive" className={[styles.error, styles.message].join(' ')}>
          The swap wasn&rsquo;t approved: {problemMessage(approveMutation.error)}
        </p>
      ) : null}
      {approveMutation.isSuccess ? (
        <p role="status" className={styles.message}>
          Swap approved.
        </p>
      ) : null}
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
      <PageHeader
        title="Schedule"
        description="Duty shifts by station: swaps to approve, coverage gaps, and the plan ahead."
      />

      <div className={styles.layout}>
        {/* What needs an officer first: swaps to approve, then gaps, then the plan itself. */}
        <div className={styles.column}>
          <PendingSwaps />
          <CoverageSection />

          <Card title="Upcoming shifts">
            {shiftsQuery.isLoading ? (
              <Skeleton lines={4} />
            ) : upcoming.length === 0 ? (
              <p className={styles.muted}>No upcoming shifts are scheduled.</p>
            ) : (
              <ShiftRows shifts={upcoming} nameFor={nameFor} />
            )}
            {past.length > 0 ? (
              <details className={styles.earlier}>
                <summary>Earlier shifts ({past.length})</summary>
                <ShiftRows shifts={past} nameFor={nameFor} />
              </details>
            ) : null}
          </Card>
        </div>

        <CreateShiftForm
          onCreated={() => void queryClient.invalidateQueries({ queryKey: ['schedule'] })}
        />
      </div>
    </main>
  );
}
