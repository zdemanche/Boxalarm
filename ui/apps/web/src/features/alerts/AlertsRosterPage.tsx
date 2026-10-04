import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  Button,
  Card,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  TextInput,
} from '../../components/ui';
import {
  assignRidingSeat,
  getDispatch,
  getHomeLocality,
  getReceipts,
  getRidingBoard,
  getRoster,
  submitManualDispatch,
} from './api';
import { PrePlanPanel } from './PrePlanPanel';
import { ToneLadderPanel } from './ToneLadderPanel';
import type {
  DeliveryReceipt,
  DispatchUpdate,
  FieldError,
  ManualDispatchInput,
  RosterEntry,
} from './types';

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
        setFormError('This dispatch was already entered. It has not been resubmitted.');
      } else if (problem?.errors) {
        setFieldErrors(problem.errors);
      } else {
        setFormError(problem?.detail ?? 'Could not submit the dispatch.');
      }
    },
  });

  const errorFor = (field: string) => fieldErrors.find((e) => e.field === field)?.message;

  return (
    <Card
      title="Enter dispatch manually"
      style={{ maxWidth: 480, marginBottom: 'var(--bx-space-xl)' }}
    >
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
        style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
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
        <Textarea
          label="Narrative"
          required
          value={form.narrative}
          onChange={(e) => setForm((prev) => ({ ...prev, narrative: e.target.value }))}
          error={errorFor('narrative')}
        />
        <TextInput
          label="Operator-entered reference"
          required
          value={form.externalDispatchId}
          onChange={(e) => setForm((prev) => ({ ...prev, externalDispatchId: e.target.value }))}
          error={errorFor('externalDispatchId')}
        />
        {formError ? (
          <p role="alert" aria-live="assertive">
            {formError}
          </p>
        ) : null}
        <Button type="submit" loading={mutation.isPending}>
          {mutation.isPending ? 'Submitting…' : 'Submit dispatch'}
        </Button>
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
    <Card title="Delivery receipts" style={{ marginTop: 'var(--bx-space-lg)' }}>
      <p role="status">
        {refused
          ? 'You do not have access to delivery receipts.'
          : 'Delivery receipts are temporarily unavailable. The roster and responses above are unaffected; receipts retry on their own.'}
      </p>
    </Card>
  );
}

function ReceiptsTable({ dispatchId }: { dispatchId: string }) {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['alerts', 'receipts', dispatchId],
    queryFn: () => getReceipts(auth, dispatchId),
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  if (query.error) {
    return <ReceiptsUnavailable error={query.error} />;
  }

  const byMember = new Map<string, Map<string, DeliveryReceipt>>();
  for (const receipt of query.data ?? []) {
    const row = byMember.get(receipt.memberId) ?? new Map();
    row.set(receipt.channel.toLowerCase(), receipt);
    byMember.set(receipt.memberId, row);
  }

  return (
    <Card title="Delivery receipts" style={{ marginTop: 'var(--bx-space-lg)' }}>
      <div role="region" aria-label="Delivery receipts" tabIndex={0} style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <caption className="visually-hidden">Delivery receipts</caption>
          <thead>
            <tr>
              <th scope="col" style={{ textAlign: 'left' }}>
                Member
              </th>
              {RECEIPT_CHANNELS.map((channel) => (
                <th key={channel} scope="col" style={{ textAlign: 'left' }}>
                  {channel.toUpperCase()}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...byMember.entries()].map(([memberId, channels]) => (
              <tr key={memberId}>
                <th scope="row" style={{ textAlign: 'left', fontWeight: 500 }}>
                  {memberId}
                </th>
                {RECEIPT_CHANNELS.map((channel) => {
                  const receipt = channels.get(channel);
                  const label = !receipt
                    ? '—'
                    : receipt.status === 'SENT_UNCONFIRMED'
                      ? 'Sent, not confirmed delivered'
                      : receipt.status.charAt(0) + receipt.status.slice(1).toLowerCase();
                  return <td key={channel}>{label}</td>;
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
  const query = useQuery({
    queryKey: ['alerts', 'roster', dispatchId],
    queryFn: () => getRoster(auth, dispatchId),
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  if (query.error) {
    return (
      <ApiForbiddenGate error={query.error} embedded>
        <p>Roster is unavailable.</p>
      </ApiForbiddenGate>
    );
  }

  return (
    <Card title="Live roster">
      <div role="region" aria-label="Live roster" tabIndex={0} style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <caption className="visually-hidden">Live roster</caption>
          <thead>
            <tr>
              <th scope="col" style={{ textAlign: 'left' }}>
                Member
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Status
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Quals
              </th>
              <th scope="col" style={{ textAlign: 'left' }}>
                Assigned
              </th>
            </tr>
          </thead>
          <tbody>
            {(query.data ?? []).map((entry) => (
              <tr key={entry.memberId}>
                <th scope="row" style={{ textAlign: 'left', fontWeight: 500 }}>
                  {entry.name}
                </th>
                <td>{ackLabel(entry.ackStatus)}</td>
                <td>{entry.quals.join(', ')}</td>
                <td>{entry.assignedApparatusId ?? '—'}</td>
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

  if (boardQuery.error) {
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
    <Card title="Riding board" style={{ marginTop: 'var(--bx-space-lg)' }}>
      {assignError ? (
        <p role="alert" aria-live="assertive" style={{ color: 'var(--bx-status-danger)' }}>
          {assignError}
        </p>
      ) : null}
      {(boardQuery.data?.apparatus ?? []).map((unit) => (
        <div key={unit.apparatusId} style={{ marginBottom: 'var(--bx-space-md)' }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{unit.unitId}</h3>
          {!unit.assignable ? (
            <p style={{ color: 'var(--bx-status-danger)' }}>
              Out of service{unit.outOfServiceReason ? `: ${unit.outOfServiceReason}` : ''}
            </p>
          ) : null}
          <ul>
            {unit.positions.map((position) => (
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
                      expectedVersion: position.assignment?.version ?? 0,
                    })
                  }
                >
                  <option value="">Unassigned</option>
                  {assignable.map((member) => (
                    <option key={member.memberId} value={member.memberId}>
                      {member.name}
                      {member.ackStatus === 'DIRECT_TO_SCENE' ? ' (direct to scene)' : ''}
                    </option>
                  ))}
                </Select>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Card>
  );
}

function DispatchHeader({ dispatchId }: { dispatchId: string }) {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['alerts', 'dispatch', dispatchId],
    queryFn: () => getDispatch(auth, dispatchId),
  });

  if (query.error) {
    return (
      <ApiForbiddenGate error={query.error} embedded>
        <p>Dispatch details are unavailable.</p>
      </ApiForbiddenGate>
    );
  }
  if (!query.data) return <Skeleton lines={3} />;

  return (
    <Card>
      {query.data.verifyRequired ? <VerifyBanner /> : null}
      <h2 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>{query.data.incidentType}</h2>
      <p>{query.data.address}</p>
      {query.data.crossStreets ? <p>Cross streets: {query.data.crossStreets}</p> : null}
      {query.data.mapLink ? (
        <a href={query.data.mapLink} target="_blank" rel="noreferrer">
          Open in maps
        </a>
      ) : null}
      <p>{query.data.narrative}</p>
      <PrePlanPanel
        prePlan={query.data.prePlan}
        unavailable={query.data.prePlanUnavailable === true}
        {...(query.data.nearestHydrants ? { nearestHydrants: query.data.nearestHydrants } : {})}
        hydrantsUnavailable={query.data.nearestHydrantsUnavailable === true}
        hydrantsIncomplete={query.data.nearestHydrantsIncomplete === true}
      />
      <DispatchUpdates
        updates={query.data.updates}
        unavailable={query.data.updatesUnavailable === true}
      />
    </Card>
  );
}

/** A RAW (fail-open) CAD dispatch: the location is only in the dispatch text below. */
export function VerifyBanner() {
  return (
    <div
      role="alert"
      style={{
        border: '2px solid var(--bx-color-danger, #b00020)',
        borderRadius: 8,
        padding: 'var(--bx-space-sm)',
        fontWeight: 700,
      }}
    >
      VERIFY: the CAD message could not be read automatically. The location is in the dispatch text
      below - confirm it by radio before responding.
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
    return <p role="status">CAD updates for this call could not be loaded.</p>;
  }
  if (!updates || updates.length === 0) return null;
  return (
    <section aria-labelledby="dispatch-updates-heading">
      <h3 id="dispatch-updates-heading" style={{ fontSize: 17, fontWeight: 600 }}>
        CAD updates ({updates.length})
      </h3>
      <ol>
        {updates.map((update) => (
          <li key={update.updateId}>
            <time dateTime={new Date(update.receivedAt * 1000).toISOString()}>
              {updateWhen(update.receivedAt)}
            </time>
            : {update.summary}
            {update.changes.filter((c) => c.field !== 'narrative').length > 0 ? (
              <ul>
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

  return (
    <main id="main-content">
      <PageHeader title={!dispatchId ? 'Live roster' : 'Alert'} />

      {canEnterManually ? (
        <ManualEntryForm onCreated={(id) => setSearchParams({ dispatchId: id })} />
      ) : null}

      <TextInput
        label="Dispatch ID"
        defaultValue={dispatchId ?? ''}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          const value = (e.target as HTMLInputElement).value.trim();
          if (value) setSearchParams({ dispatchId: value });
        }}
        style={{ maxWidth: 320, marginBottom: 'var(--bx-space-lg)' }}
      />

      {dispatchId ? (
        <>
          <DispatchHeader dispatchId={dispatchId} />
          <ToneLadderPanel dispatchId={dispatchId} />
          <RosterTable dispatchId={dispatchId} />
          <ReceiptsTable dispatchId={dispatchId} />
          <RidingBoardSection dispatchId={dispatchId} />
        </>
      ) : (
        <p>Enter a dispatch ID to see its roster, receipts, and riding board.</p>
      )}
    </main>
  );
}
