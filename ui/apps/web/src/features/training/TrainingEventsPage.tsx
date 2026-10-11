import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { canManageTraining } from '../../auth/roles';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, PageHeader, Skeleton, StatusChip, TextInput } from '../../components/ui';
import { createTrainingEvent, listTrainingEvents, recordEventHours, signUpForEvent } from './api';
import type { TrainingEvent } from './types';
import styles from './training.module.css';

interface EventFormState {
  title: string;
  category: string;
  startAt: number;
  endAt: number;
}

const emptyForm: EventFormState = { title: '', category: '', startAt: 0, endAt: 0 };

function toEpochMs(localDateTime: string): number {
  if (!localDateTime) return 0;
  const ms = new Date(localDateTime).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/** Epoch ms -> the `YYYY-MM-DDTHH:mm` local value a datetime-local input expects; 0 -> ''. */
function toLocalInputValue(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Mon, Oct 12, 2026 · 5:30 – 7:30 PM" - the day, then the window a volunteer plans around. */
function formatEventWhen(event: TrainingEvent): string {
  const start = new Date(event.startAt);
  const day = start.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return event.endAt > event.startAt
    ? `${day} · ${time(start)} – ${time(new Date(event.endAt))}`
    : `${day} · ${time(start)}`;
}

/** Month over day, like a calendar page. Decorative: the row's text carries the full date. */
function DateTile({ epochMs, upcoming }: { epochMs: number; upcoming: boolean }) {
  const date = new Date(epochMs);
  return (
    <span
      aria-hidden="true"
      className={[styles.dateTile, upcoming ? styles.dateTileUpcoming : ''].join(' ')}
    >
      <span className={styles.dateMonth}>
        {date.toLocaleDateString(undefined, { month: 'short' })}
      </span>
      <span className={styles.dateDay}>{date.getDate()}</span>
    </span>
  );
}

function HoursForm({ event }: { event: TrainingEvent }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [memberId, setMemberId] = useState('');
  const [hours, setHours] = useState('');

  const mutation = useMutation({
    mutationFn: () => recordEventHours(auth, event.eventId, [{ memberId, hours: Number(hours) }]),
    onSuccess: async () => {
      setMemberId('');
      setHours('');
      await queryClient.invalidateQueries({ queryKey: ['training', 'events'] });
    },
  });

  return (
    <form
      aria-label={`Record hours for ${event.title}`}
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate();
      }}
      className={styles.rowForm}
    >
      <TextInput
        label="Member ID"
        value={memberId}
        onChange={(e) => setMemberId(e.target.value)}
        required
      />
      <TextInput
        label="Hours"
        type="number"
        min={0}
        step="0.25"
        value={hours}
        onChange={(e) => setHours(e.target.value)}
        required
        style={{ width: 96 }}
      />
      <Button type="submit" variant="secondary" loading={mutation.isPending}>
        Record hours
      </Button>
      {mutation.error ? (
        <p role="alert" className={styles.error}>
          Hours not recorded: {mutation.error.message}
        </p>
      ) : null}
    </form>
  );
}

interface EventRowProps {
  event: TrainingEvent;
  now: number;
  canRecordHours: boolean;
  signingUp: boolean;
  onSignUp: () => void;
}

function EventRow({ event, now, canRecordHours, signingUp, onSignUp }: EventRowProps) {
  const started = event.startAt <= now;
  const over = now >= event.endAt;
  return (
    <li className={styles.row}>
      <span className={styles.rowLead}>
        <DateTile epochMs={event.startAt} upcoming={!over} />
        <span className={styles.rowMain}>
          <span className={styles.rowTitle}>{event.title}</span>
          <span className={styles.rowMeta}>
            {event.category} · {formatEventWhen(event)}
          </span>
        </span>
      </span>
      <span className={styles.rowAside}>
        {event.signedUp ? (
          <StatusChip status="ok">Signed up</StatusChip>
        ) : started ? (
          // Signing up for a drill that has already begun is no use to the officer running it:
          // say why the button is gone rather than leave a dead control.
          <span className={styles.rowNote}>
            Sign-up closed: the event {over ? 'is over' : 'has started'}
          </span>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onSignUp}
            // Only the row that was clicked spins; the others stay usable.
            loading={signingUp}
          >
            Sign up
          </Button>
        )}
      </span>
      {canRecordHours && started ? <HoursForm event={event} /> : null}
    </li>
  );
}

export function TrainingEventsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const isTraining = canManageTraining(auth.roles);
  const [form, setForm] = useState<EventFormState>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  const eventsQuery = useQuery({
    queryKey: ['training', 'events'],
    queryFn: () => listTrainingEvents(auth),
  });

  const createMutation = useMutation({
    mutationFn: (input: EventFormState) => createTrainingEvent(auth, input),
    onSuccess: async () => {
      setForm(emptyForm);
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ['training', 'events'] });
    },
    onError: (error: Error) => setFormError(error.message),
  });

  const signUpMutation = useMutation({
    mutationFn: (eventId: string) => signUpForEvent(auth, eventId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['training', 'events'] });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    createMutation.mutate(form);
  };

  if (eventsQuery.error) {
    return (
      <ApiForbiddenGate error={eventsQuery.error}>
        <p>Unexpected error</p>
      </ApiForbiddenGate>
    );
  }

  const now = Date.now();
  const byStart = [...(eventsQuery.data ?? [])].sort((a, b) => a.startAt - b.startAt);
  // An event still running stays under Upcoming (its row says sign-up has closed); past events
  // read newest first.
  const upcoming = byStart.filter((event) => event.endAt > now);
  const past = byStart.filter((event) => event.endAt <= now).reverse();

  const rows = (events: TrainingEvent[]) => (
    <ul className={styles.list}>
      {events.map((event) => (
        <EventRow
          key={event.eventId}
          event={event}
          now={now}
          canRecordHours={isTraining}
          signingUp={signUpMutation.isPending && signUpMutation.variables === event.eventId}
          onSignUp={() => signUpMutation.mutate(event.eventId)}
        />
      ))}
    </ul>
  );

  const lists = (
    <div className={styles.column}>
      <Card title="Upcoming">
        {signUpMutation.error ? (
          <p role="alert" className={[styles.error, styles.banner].join(' ')}>
            Sign-up failed: {signUpMutation.error.message}
          </p>
        ) : null}
        {eventsQuery.isLoading ? (
          <Skeleton lines={4} />
        ) : upcoming.length === 0 ? (
          <p className={styles.muted}>No training events scheduled.</p>
        ) : (
          rows(upcoming)
        )}
      </Card>
      {past.length > 0 ? <Card title="Past">{rows(past)}</Card> : null}
    </div>
  );

  return (
    <main id="main-content">
      <PageHeader
        title="Training events"
        description="Drills and classes: sign up for what's coming and see what's been held."
      />

      {isTraining ? (
        <div className={[styles.layout, styles.layoutWithAside].join(' ')}>
          {lists}
          <Card title="Create event">
            <form
              onSubmit={onSubmit}
              aria-label="Create training event"
              className={styles.formStack}
            >
              <TextInput
                label="Title"
                value={form.title}
                onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                required
              />
              <TextInput
                label="Category"
                value={form.category}
                onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}
                required
              />
              {/* Controlled (PR #321 review M9): uncontrolled inputs kept their old DOM value
                  after setForm(emptyForm), so `required` passed and the next create posted
                  epoch 0. */}
              <TextInput
                label="Starts"
                type="datetime-local"
                value={toLocalInputValue(form.startAt)}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, startAt: toEpochMs(e.target.value) }))
                }
                required
              />
              <TextInput
                label="Ends"
                type="datetime-local"
                value={toLocalInputValue(form.endAt)}
                onChange={(e) => setForm((prev) => ({ ...prev, endAt: toEpochMs(e.target.value) }))}
                required
              />
              {formError ? (
                <p role="alert" aria-live="assertive" className={styles.error}>
                  {formError}
                </p>
              ) : null}
              <div>
                <Button type="submit" loading={createMutation.isPending}>
                  Create event
                </Button>
              </div>
            </form>
          </Card>
        </div>
      ) : (
        lists
      )}
    </main>
  );
}
