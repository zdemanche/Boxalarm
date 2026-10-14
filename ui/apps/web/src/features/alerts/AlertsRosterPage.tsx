import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { listMembers } from '../personnel/api';
import {
  Button,
  Card,
  PageHeader,
  Select,
  Skeleton,
  StatusChip,
  Textarea,
  TextInput,
} from '../../components/ui';
import { AlertTriangle } from '../../components/ui/icons';
import type { StatusRole } from '@boxalarm/design-tokens';
import {
  assignRidingSeat,
  getDispatch,
  getHomeLocality,
  getReceipts,
  getRidingBoard,
  getRoster,
  listActiveDispatches,
  submitManualDispatch,
} from './api';
import { PrePlanPanel } from './PrePlanPanel';
import { StaleNotice } from './StaleNotice';
import { ToneLadderPanel } from './ToneLadderPanel';
import type {
  ActiveDispatch,
  DeliveryReceipt,
  DispatchUpdate,
  FieldError,
  ManualDispatchInput,
  RosterEntry,
} from './types';
import styles from './Alerts.module.css';

const REFETCH_INTERVAL_MS = 10_000;
const RECEIPT_CHANNELS = ['push', 'sms', 'voice'];

const EMPTY_FORM: ManualDispatchInput = {
  incidentType: '',
  address: '',
  crossStreets: '',
  unitsRequested: [],
  narrative: '',
  externalDispatchId: '',
};

function ackLabel(status: RosterEntry['ackStatus']): string {
  if (status === 'RESPONDING') return 'Responding';
  if (status === 'DIRECT_TO_SCENE') return 'Direct to scene';
  if (status === 'NOT_RESPONDING') return 'Not responding';
  return 'Awaiting response';
}

function occupantNote(entry: RosterEntry | undefined): string {
  if (!entry) return '';
  if (entry.ackStatus === 'NOT_RESPONDING') return ' (not responding)';
  if (entry.ackStatus === 'UNANSWERED') return ' (no answer)';
  return '';
}

/** design.md §2.3: both kinds of responding are ok; not responding and no answer are neutral. */
function ackRole(status: RosterEntry['ackStatus']): StatusRole {
  return status === 'RESPONDING' || status === 'DIRECT_TO_SCENE' ? 'ok' : 'neutral';
}

function receiptLabel(status: DeliveryReceipt['status']): string {
  if (status === 'SENT_UNCONFIRMED') return 'Sent, not confirmed delivered';
  if (status === 'NOT_SENT') return 'Not sent';
  return status.charAt(0) + status.slice(1).toLowerCase();
}

/** Delivered/opened ok, failed or never sent alarm, sent-but-unconfirmed a caution (a11y-spec §1.8). */
function receiptRole(status: DeliveryReceipt['status']): StatusRole {
  if (status === 'DELIVERED' || status === 'OPENED') return 'ok';
  if (status === 'FAILED' || status === 'NOT_SENT') return 'danger';
  if (status === 'SENT_UNCONFIRMED') return 'warning';
  return 'info';
}

const OTHER_TOWN = '__other__';

/**
 * The required "where is this?" choice (round-3 R3-A): one of the department's home towns or
 * villages, or "Other town" with the town typed in. It only decides whether a pre-plan can be
 * shown as this building's; it never delays or blocks the page. If the home list cannot be
 * loaded the choice is just "Other town".
 */
function LocalityField({
  homeTowns,
  choice,
  otherTown,
  onChoice,
  onOtherTown,
  error,
}: {
  homeTowns: string[];
  choice: string;
  otherTown: string;
  onChoice: (value: string) => void;
  onOtherTown: (value: string) => void;
  error: string | undefined;
}) {
  return (
    <>
      <Select
        label="Town / village"
        required
        value={choice}
        onChange={(e) => onChoice(e.target.value)}
        help="Pick a home town, or Other town for a mutual-aid call."
        error={error}
      >
        <option value="" disabled>
          Choose…
        </option>
        {homeTowns.map((town) => (
          <option key={town} value={town}>
            {town}
          </option>
        ))}
        <option value={OTHER_TOWN}>Other town…</option>
      </Select>
      {choice === OTHER_TOWN ? (
        <TextInput
          label="Other town name"
          required
          maxLength={MAX_TOWN_LENGTH}
          value={otherTown}
          onChange={(e) => onOtherTown(e.target.value)}
        />
      ) : null}
    </>
  );
}

// Matches the backend's MAX_LOCALITY_TOWN_LENGTH; a longer town is dropped server-side.
const MAX_TOWN_LENGTH = 80;

function ManualEntryForm({ onCreated }: { onCreated: (dispatchId: string) => void }) {
  const auth = useAuth();
  const homeQuery = useQuery({
    queryKey: ['alerts', 'home-locality'],
    queryFn: () => getHomeLocality(auth),
    staleTime: 5 * 60_000,
  });
  const homeTowns = homeQuery.data?.towns ?? [];
  const [localityChoice, setLocalityChoice] = useState('');
  const [otherTown, setOtherTown] = useState('');
  const [form, setForm] = useState<ManualDispatchInput>(EMPTY_FORM);
  const [unitsText, setUnitsText] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: ManualDispatchInput) => submitManualDispatch(auth, input),
    onSuccess: ({ dispatchId }) => {
      setForm(EMPTY_FORM);
      setLocalityChoice('');
      setOtherTown('');
      setUnitsText('');
      setFieldErrors([]);
      setFormError(null);
      onCreated(dispatchId);
    },
    onError: (error: unknown) => {
      const problem = (
        error as { problem?: { status?: number; detail?: string; errors?: FieldError[] } }
      ).problem;
      if (problem?.status === 409) {
        setFormError(
          'No new page was sent: the same reference was entered in the last 10 minutes. A new call needs a different reference.',
        );
      } else if (problem?.errors) {
        setFieldErrors(problem.errors);
      } else {
        setFormError(problem?.detail ?? 'Could not submit the dispatch.');
      }
    },
  });

  const errorFor = (field: string) => fieldErrors.find((e) => e.field === field)?.message;

  return (
    <Card title="Enter dispatch manually">
      <form
        aria-label="Enter dispatch manually"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          const locality =
            localityChoice === OTHER_TOWN
              ? { town: otherTown.trim(), choice: 'OTHER' as const }
              : { town: localityChoice, choice: 'HOME' as const };
          if (locality.town.length === 0) {
            setFieldErrors([{ field: 'locality', message: 'Choose the town or village.' }]);
            return;
          }
          mutation.mutate({
            ...form,
            locality,
            unitsRequested: unitsText
              .split(',')
              .map((u) => u.trim())
              .filter(Boolean),
          });
        }}
        // Short fields pair up on a desk-width screen so the fallback form isn't a page-long
        // column; narrative and submit always span the row.
        className={styles.formGrid}
      >
        {(
          [
            ['incidentType', 'Incident type'],
            ['address', 'Address'],
            ['crossStreets', 'Cross streets'],
          ] as const
        ).map(([key, label]) => (
          <TextInput
            key={key}
            label={label}
            required
            value={form[key]}
            onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
            error={errorFor(key)}
          />
        ))}
        <LocalityField
          homeTowns={homeTowns}
          choice={localityChoice}
          otherTown={otherTown}
          onChoice={setLocalityChoice}
          onOtherTown={setOtherTown}
          error={errorFor('locality') ?? errorFor('locality.town') ?? errorFor('locality.choice')}
        />
        <TextInput
          label="Units requested (comma separated)"
          optional
          value={unitsText}
          onChange={(e) => setUnitsText(e.target.value)}
        />
        <div className={styles.span}>
          <Textarea
            label="Narrative"
            required
            value={form.narrative}
            onChange={(e) => setForm((prev) => ({ ...prev, narrative: e.target.value }))}
            error={errorFor('narrative')}
          />
        </div>
        <TextInput
          label="Operator-entered reference"
          required
          value={form.externalDispatchId}
          onChange={(e) => setForm((prev) => ({ ...prev, externalDispatchId: e.target.value }))}
          error={errorFor('externalDispatchId')}
        />
        {formError ? (
          <p role="alert" aria-live="assertive" className={styles.formError}>
            {formError}
          </p>
        ) : null}
        <div className={styles.formActions}>
          {/* Primary even beside the live calls' buttons: when CAD is down this pages the
              department, and it must be the obvious button on the form. */}
          <Button type="submit" loading={mutation.isPending}>
            {mutation.isPending ? 'Submitting…' : 'Submit dispatch'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/**
 * Receipts sit behind the fail-closed authorizer (server-fix security MINOR 2): during a
 * platform-table outage they are refused while the roster and responses keep working. Only a
 * handler's own problem+json 403 (a Cedar denial) means "no access"; an authorizer refusal
 * (API Gateway's plain {"message":"Forbidden"}, no problem status), a 5xx or a network failure
 * is the service being down, and says so - an officer deciding whether to advance the tone
 * ladder must not be told they lack access.
 */
function ReceiptsUnavailable({ error }: { error: unknown }) {
  const refused = error instanceof ApiError && error.problem.status === 403;
  return (
    <Card title="Delivery receipts">
      <p role="status" className={styles.muted}>
        {refused
          ? 'You do not have access to delivery receipts.'
          : 'Delivery receipts are temporarily unavailable. The roster and responses above are unaffected; receipts retry on their own.'}
      </p>
    </Card>
  );
}

function useMemberNameOf(): (memberId: string) => string {
  const auth = useAuth();
  const members = useQuery({
    queryKey: ['personnel', 'members'],
    queryFn: () => listMembers(auth),
    staleTime: 60_000,
  });
  return (memberId) => {
    const member = members.data?.find((m) => m.memberId === memberId);
    return member ? `${member.firstName} ${member.lastName}` : memberId;
  };
}

function ReceiptsTable({ dispatchId }: { dispatchId: string }) {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['alerts', 'receipts', dispatchId],
    queryFn: () => getReceipts(auth, dispatchId),
    refetchInterval: REFETCH_INTERVAL_MS,
  });
  const nameOf = useMemberNameOf();

  if (query.error && !query.data) {
    return <ReceiptsUnavailable error={query.error} />;
  }

  const byMember = new Map<string, Map<string, DeliveryReceipt[]>>();
  for (const receipt of query.data ?? []) {
    const row = byMember.get(receipt.memberId) ?? new Map<string, DeliveryReceipt[]>();
    const channel = receipt.channel.toLowerCase();
    row.set(channel, [...(row.get(channel) ?? []), receipt]);
    byMember.set(receipt.memberId, row);
  }

  return (
    <Card title="Delivery receipts">
      <StaleNotice query={query} />
      <div role="region" aria-label="Delivery receipts" tabIndex={0} className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className="visually-hidden">Delivery receipts</caption>
          <thead>
            <tr>
              <th scope="col">Member</th>
              {RECEIPT_CHANNELS.map((channel) => (
                <th key={channel} scope="col">
                  {channel.toUpperCase()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...byMember.entries()].map(([memberId, channels]) => (
              <tr key={memberId}>
                <th scope="row">{nameOf(memberId)}</th>
                {RECEIPT_CHANNELS.map((channel) => {
                  const attempts = [...(channels.get(channel) ?? [])].sort(
                    (a, b) => a.toneSequence - b.toneSequence,
                  );
                  return (
                    <td key={channel}>
                      {attempts.length === 0
                        ? '—'
                        : attempts.map((receipt) => (
                            <StatusChip
                              key={receipt.toneSequence}
                              status={receiptRole(receipt.status)}
                            >
                              {attempts.length > 1 ? `Tone ${receipt.toneSequence}: ` : ''}
                              {receiptLabel(receipt.status)}
                            </StatusChip>
                          ))}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RosterTable({ dispatchId }: { dispatchId: string }) {
  const auth = useAuth();
  const nameOf = useMemberNameOf();
  const query = useQuery({
    queryKey: ['alerts', 'roster', dispatchId],
    queryFn: () => getRoster(auth, dispatchId),
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  if (query.error && !query.data) {
    return (
      <ApiForbiddenGate error={query.error} embedded>
        <p>Roster is unavailable.</p>
      </ApiForbiddenGate>
    );
  }

  return (
    <Card title="Live roster">
      <StaleNotice query={query} />
      <div role="region" aria-label="Live roster" tabIndex={0} className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className="visually-hidden">Live roster</caption>
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Status</th>
              <th scope="col">Quals</th>
              <th scope="col">Assigned</th>
              <th scope="col" className={styles.endCell}>
                <span className="visually-hidden">Delivery</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(query.data ?? []).map((entry) => (
              <tr key={entry.memberId}>
                <th scope="row">{nameOf(entry.memberId)}</th>
                <td>
                  <StatusChip status={ackRole(entry.ackStatus)}>
                    {ackLabel(entry.ackStatus)}
                  </StatusChip>
                </td>
                <td className={styles.quals}>{entry.quals.join(', ')}</td>
                <td className={styles.mono}>{entry.assignedApparatusId ?? '—'}</td>
                <td className={styles.endCell}>
                  <Link
                    to={`/alerts/diagnostics?dispatchId=${encodeURIComponent(dispatchId)}&memberId=${encodeURIComponent(entry.memberId)}`}
                    aria-label={`Delivery diagnostics for ${nameOf(entry.memberId)}`}
                  >
                    Diagnose
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RidingBoardSection({ dispatchId }: { dispatchId: string }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [assignError, setAssignError] = useState<string | null>(null);
  const boardQuery = useQuery({
    queryKey: ['alerts', 'riding-board', dispatchId],
    queryFn: () => getRidingBoard(auth, dispatchId),
    refetchInterval: REFETCH_INTERVAL_MS,
  });
  const nameOf = useMemberNameOf();
  const rosterQuery = useQuery({
    queryKey: ['alerts', 'roster', dispatchId],
    queryFn: () => getRoster(auth, dispatchId),
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  const assignMutation = useMutation({
    mutationFn: (input: {
      unitId: string;
      positionCode: string;
      memberId: string | null;
      expectedVersion: number;
    }) => assignRidingSeat(auth, dispatchId, input),
    onSuccess: () => setAssignError(null),
    onError: (error: unknown) => {
      // Mirrors ManualEntryForm's error branching above: a failed seat assignment must not
      // fail silently - the officer needs to know whether it was a version conflict (another
      // officer just assigned this seat), an auth problem, or something else, since the
      // <select>'s value only re-syncs from query data on the next successful render.
      const problem = (error as { problem?: { status?: number; detail?: string } }).problem;
      if (problem?.status === 409) {
        setAssignError('This seat was changed by another officer. The board has been refreshed.');
      } else if (problem?.status === 401) {
        setAssignError('Your session has expired. Sign in again to continue.');
      } else if (problem?.status === 403) {
        setAssignError('You are not authorized to assign riding-board seats.');
      } else {
        setAssignError(
          problem?.detail ?? 'Could not update the assignment. The board has been refreshed.',
        );
      }
    },
    onSettled: () => {
      // Explicitly reconcile the board either way - on success the new assignment should show,
      // and on failure the <select> must be pulled back to the server's actual value rather
      // than silently keeping whatever the user last picked.
      void queryClient.invalidateQueries({ queryKey: ['alerts', 'riding-board', dispatchId] });
    },
  });

  if (boardQuery.error && !boardQuery.data) {
    return (
      <ApiForbiddenGate error={boardQuery.error} embedded>
        <p>Riding board is unavailable.</p>
      </ApiForbiddenGate>
    );
  }

  const assignable = (rosterQuery.data ?? []).filter(
    (entry) => entry.ackStatus === 'RESPONDING' || entry.ackStatus === 'DIRECT_TO_SCENE',
  );

  return (
    <Card title="Riding board">
      <StaleNotice query={boardQuery.error ? boardQuery : rosterQuery} />
      {assignError ? (
        <p role="alert" aria-live="assertive" className={styles.alert}>
          <AlertTriangle size={16} aria-hidden="true" />
          {assignError}
        </p>
      ) : null}
      {(boardQuery.data?.apparatus ?? []).map((unit) => (
        <div key={unit.apparatusId} className={styles.unit}>
          <div className={styles.unitHead}>
            <h3>{unit.unitId}</h3>
            {/* Out of service = alarm colour + glyph + the words, then the reason. */}
            {!unit.assignable ? (
              <>
                <StatusChip status="danger">Out of service</StatusChip>
                {unit.outOfServiceReason ? (
                  <span className={styles.oosReason}>{unit.outOfServiceReason}</span>
                ) : null}
              </>
            ) : null}
          </div>
          <ul className={styles.seats}>
            {unit.positions.map((position) => {
              const occupant = position.assignment?.memberId;
              return (
                <li key={position.code}>
                  <Select
                    label={`${position.label}${position.assignment?.qualStatus === 'UNMET' ? ' (missing qualification)' : ''}`}
                    disabled={!unit.assignable}
                    value={position.assignment?.memberId ?? ''}
                    onChange={(e) =>
                      assignMutation.mutate({
                        unitId: unit.unitId,
                        positionCode: position.code,
                        memberId: e.target.value || null,
                        expectedVersion: position.version,
                      })
                    }
                  >
                    <option value="">Unassigned</option>
                    {occupant && !assignable.some((m) => m.memberId === occupant) ? (
                      <option value={occupant}>
                        {nameOf(occupant)}
                        {occupantNote(rosterQuery.data?.find((m) => m.memberId === occupant))}
                      </option>
                    ) : null}
                    {assignable.map((member) => (
                      <option key={member.memberId} value={member.memberId}>
                        {nameOf(member.memberId)}
                        {member.ackStatus === 'DIRECT_TO_SCENE' ? ' (direct to scene)' : ''}
                      </option>
                    ))}
                  </Select>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {boardQuery.isLoading ? <Skeleton lines={3} /> : null}
      {boardQuery.data && boardQuery.data.apparatus.length === 0 ? (
        <p className={styles.muted}>No apparatus on the riding board.</p>
      ) : null}
    </Card>
  );
}

function DispatchHeader({ dispatchId }: { dispatchId: string }) {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['alerts', 'dispatch', dispatchId],
    queryFn: () => getDispatch(auth, dispatchId),
  });

  if (query.error && !query.data) {
    return (
      <ApiForbiddenGate error={query.error} embedded>
        <p>Dispatch details are unavailable.</p>
      </ApiForbiddenGate>
    );
  }
  if (!query.data) {
    return (
      <Card>
        <Skeleton lines={3} />
      </Card>
    );
  }

  return (
    <>
      <Card>
        <StaleNotice query={query} />
        {query.data.verifyRequired ? <VerifyBanner /> : null}
        <h2 className={styles.dispatchTitle}>{query.data.incidentType}</h2>
        <p className={styles.address}>{query.data.address}</p>
        {query.data.crossStreets ? (
          <p className={styles.crossStreets}>Cross streets: {query.data.crossStreets}</p>
        ) : null}
        {query.data.mapLink ? (
          <a href={query.data.mapLink} target="_blank" rel="noreferrer" className={styles.mapLink}>
            Open in maps
          </a>
        ) : null}
        {query.data.narrative ? <p className={styles.narrative}>{query.data.narrative}</p> : null}
        <DispatchUpdates
          updates={query.data.updates}
          unavailable={query.data.updatesUnavailable === true}
        />
      </Card>
      {/* Its own card under the call, not nested inside it. */}
      <PrePlanPanel
        prePlan={query.data.prePlan}
        unavailable={query.data.prePlanUnavailable === true}
        {...(query.data.nearestHydrants ? { nearestHydrants: query.data.nearestHydrants } : {})}
        hydrantsUnavailable={query.data.nearestHydrantsUnavailable === true}
        hydrantsIncomplete={query.data.nearestHydrantsIncomplete === true}
      />
    </>
  );
}

/** A RAW (fail-open) CAD dispatch: the location is only in the dispatch text below. */
export function VerifyBanner() {
  return (
    <div role="alert" className={styles.verify}>
      <AlertTriangle size={18} aria-hidden="true" />
      <span>
        VERIFY: the CAD message could not be read automatically. The location is in the dispatch
        text below - confirm it by radio before responding.
      </span>
    </div>
  );
}

const UPDATE_FIELD_LABELS: Record<string, string> = {
  incidentType: 'Type',
  address: 'Address',
  crossStreets: 'Cross streets',
  unitsRequested: 'Units',
  narrative: 'Narrative',
};

/**
 * When an update arrived: time only while it is today, day and time otherwise - on a long
 * incident a bare "01:10" could be either night.
 */
function updateWhen(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString()
    : date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
}

/** The CAD's later messages for this call: what changed, when. */
export function DispatchUpdates({
  updates,
  unavailable,
}: {
  updates: DispatchUpdate[] | undefined;
  unavailable: boolean;
}) {
  if (unavailable) {
    return (
      <p role="status" className={styles.unavailable}>
        CAD updates for this call could not be loaded.
      </p>
    );
  }
  if (!updates || updates.length === 0) return null;
  return (
    <section aria-labelledby="dispatch-updates-heading" className={styles.updates}>
      <h3 id="dispatch-updates-heading">CAD updates ({updates.length})</h3>
      <ol className={styles.updateList}>
        {updates.map((update) => (
          <li key={update.updateId}>
            <time dateTime={new Date(update.receivedAt * 1000).toISOString()}>
              {updateWhen(update.receivedAt)}
            </time>
            : {update.summary}
            {update.changes.filter((c) => c.field !== 'narrative').length > 0 ? (
              <ul className={styles.changes}>
                {update.changes
                  .filter((c) => c.field !== 'narrative')
                  .map((c) => (
                    <li key={c.field}>
                      {UPDATE_FIELD_LABELS[c.field] ?? c.field}: {c.from || '(none)'} → {c.to}
                    </li>
                  ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function formatClock(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ladderLabel(status: string): string {
  switch (status) {
    case 'ACTIVE':
      return 'ladder running';
    case 'HALTED_MANUAL':
      return 'ladder halted by an officer';
    case 'COMPLETED':
      return 'all tones fired';
    default:
      return `ladder ${status.toLowerCase().replace(/_/g, ' ')}`;
  }
}

function formatWindow(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? 'hour' : `${hours} hours`;
  }
  return `${Math.round(seconds / 60)} minutes`;
}

function ActiveCallRow({ dispatch, onOpen }: { dispatch: ActiveDispatch; onOpen: () => void }) {
  const ladder = dispatch.toneLadder;
  return (
    <li className={styles.callRow}>
      <div className={styles.callBody}>
        {/* design.md §2.3: active dispatch = alarm colour + triangle + the word, as on the
            dashboard's Active calls card. */}
        <span className={styles.callStatus}>
          <AlertTriangle size={14} aria-hidden="true" />
          Dispatched <span className={styles.mono}>{formatClock(dispatch.dispatchedAt)}</span>
          <span className={styles.callStatusMeta}>
            · tone {ladder.currentToneSequence} · {ladderLabel(ladder.status)}
          </span>
        </span>
        <strong className={styles.callType}>{dispatch.incidentType ?? 'Unknown call type'}</strong>
        <span className={styles.callAddress}>
          {dispatch.address ?? 'No address on the dispatch'}
          {dispatch.crossStreets ? (
            <span className={styles.callStatusMeta}> ({dispatch.crossStreets})</span>
          ) : null}
        </span>
      </div>
      <Button variant="primary" onClick={onOpen}>
        Open roster
      </Button>
    </li>
  );
}

/**
 * The calls dispatched inside the alerting plane's recency window, newest first - what an
 * officer opening this screen during a call is looking for, so it sits above the manual-entry
 * fallback. The window comes from the server (the alerting plane has no "cleared" state).
 */
function ActiveCallsCard({ onOpen }: { onOpen: (dispatchId: string) => void }) {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['alerting', 'dispatches', 'active'],
    queryFn: () => listActiveDispatches(auth),
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  const hasLiveCalls = !query.error && (query.data?.dispatches.length ?? 0) > 0;
  return (
    // design.md §2.6 elevation.alarm - a live call only: the alarm edge plus a dot on the title,
    // the same treatment as the dashboard's Active calls card.
    <Card title="Active calls" className={hasLiveCalls ? styles.liveCard : undefined}>
      {query.isLoading ? <Skeleton lines={2} /> : null}
      {query.error ? (
        <p role="status" className={styles.muted}>
          Active calls aren&rsquo;t available right now. Open a call directly by its dispatch ID.
        </p>
      ) : null}
      {query.data ? (
        query.data.dispatches.length === 0 ? (
          <p className={styles.muted}>
            No calls dispatched in the last {formatWindow(query.data.activeWindowSeconds)} (as of{' '}
            {formatClock(query.data.asOf)}).
          </p>
        ) : (
          <ul className={styles.list}>
            {[...query.data.dispatches]
              .sort((a, b) => b.dispatchedAt - a.dispatchedAt)
              .map((dispatch) => (
                <ActiveCallRow
                  key={dispatch.dispatchId}
                  dispatch={dispatch}
                  onOpen={() => onOpen(dispatch.dispatchId)}
                />
              ))}
          </ul>
        )
      ) : null}
    </Card>
  );
}

/** Was Enter-only with no visible way to submit. */
function OpenCallCard({
  dispatchId,
  onOpen,
}: {
  dispatchId: string | null;
  onOpen: (dispatchId: string) => void;
}) {
  return (
    <Card title="Open a call">
      <form
        aria-label="Open a call by dispatch ID"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const value = String(new FormData(event.currentTarget).get('dispatchId') ?? '').trim();
          if (value) onOpen(value);
        }}
        className={styles.lookup}
      >
        <div className={styles.lookupField}>
          <TextInput
            key={dispatchId ?? ''}
            label="Dispatch ID"
            name="dispatchId"
            defaultValue={dispatchId ?? ''}
          />
        </div>
        <Button type="submit" variant="secondary">
          Open
        </Button>
      </form>
      {!dispatchId ? (
        <p className={styles.lookupHelp}>
          Opens any call&rsquo;s roster, receipts, and riding board — including one past the active
          window.
        </p>
      ) : null}
    </Card>
  );
}

// E1-S1-UI, E1-S4-UI, E1-S5-UI, E1-S6-UI, E1-S17-UI, E5-S8-UI, E1-S18-UI: one screen (/alerts/roster
// per the existing route table) - dispatch header + pre-plan, the tone-ladder / mutual-aid
// controls (F1.13/F1.14), live roster, delivery receipts, and the riding board, plus the
// manual-entry fallback that lands here on submit. The dispatchId is kept in the URL
// (?dispatchId=); the dashboard's active-call tile links here with it set.
export function AlertsRosterPage() {
  const auth = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const dispatchId = searchParams.get('dispatchId');
  // Route access is OFFICER/CHIEF only (routeTable.ts) - ADMIN is not currently granted
  // /alerts/roster, so it never reaches this check; see PR notes on the ticket's "officer,
  // chief, admin" text vs. the existing, tested route-guard invariant.
  const canEnterManually = auth.roles.some((r) => r === 'OFFICER' || r === 'CHIEF');
  const open = (id: string) => setSearchParams({ dispatchId: id });

  return (
    <main id="main-content">
      <PageHeader
        title={!dispatchId ? 'Live roster' : 'Alert'}
        description={
          !dispatchId
            ? 'Calls dispatched in the last few hours, and who is responding to each.'
            : 'The call, who is responding, delivery to each member, and who is riding.'
        }
        actions={
          dispatchId ? (
            <Button variant="secondary" onClick={() => setSearchParams({})}>
              All active calls
            </Button>
          ) : undefined
        }
      />

      {!dispatchId ? <ActiveCallsCard onOpen={open} /> : null}

      {/* Reading order is the phone's order (call, building, tone ladder, roster, receipts,
          riding board); at desk width the ladder and riding board move to the right column. */}
      {dispatchId ? (
        <>
          <div className={styles.grid}>
            <div className={styles.column}>
              <DispatchHeader dispatchId={dispatchId} />
            </div>
            <div className={styles.column}>
              <ToneLadderPanel dispatchId={dispatchId} />
            </div>
          </div>
          <div className={styles.grid}>
            <div className={styles.column}>
              <RosterTable dispatchId={dispatchId} />
              <ReceiptsTable dispatchId={dispatchId} />
            </div>
            <div className={styles.column}>
              <RidingBoardSection dispatchId={dispatchId} />
            </div>
          </div>
        </>
      ) : null}

      {/* Manual-entry fallback and direct dispatch-id lookup: first on the screen when no call
          is open, below the call when one is. */}
      <div className={[styles.grid, dispatchId ? styles.fallback : ''].join(' ')}>
        {canEnterManually ? (
          <div className={styles.column}>
            <ManualEntryForm onCreated={open} />
          </div>
        ) : null}
        <div className={styles.column}>
          <OpenCallCard dispatchId={dispatchId} onOpen={open} />
        </div>
      </div>
    </main>
  );
}
