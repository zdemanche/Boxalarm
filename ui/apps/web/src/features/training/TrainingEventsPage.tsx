import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { createTrainingEvent, listTrainingEvents, recordEventHours, signUpForEvent } from './api';
import type { TrainingEvent } from './types';

interface EventFormState {
  title: string;
  category: string;
  startAt: number;
  endAt: number;
}

const emptyForm: EventFormState = { title: '', category: '', startAt: 0, endAt: 0 };

function toEpochMs(localDateTime: string): number {
  return new Date(localDateTime).getTime();
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
      style={{
        display: 'flex',
        gap: 'var(--boxalarm-spacing-sm)',
        alignItems: 'end',
        marginTop: 8,
      }}
    >
      <label style={{ display: 'grid', gap: 4 }}>
        Member ID
        <input
          value={memberId}
          onChange={(e) => setMemberId(e.target.value)}
          required
          style={{ minHeight: 44, padding: '0 12px' }}
        />
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        Hours
        <input
          type="number"
          min={0}
          step="0.25"
          value={hours}
          onChange={(e) => setHours(e.target.value)}
          required
          style={{ minHeight: 44, padding: '0 12px', width: 80 }}
        />
      </label>
      <button type="submit" disabled={mutation.isPending} style={{ minHeight: 44 }}>
        Record hours
      </button>
    </form>
  );
}

export function TrainingEventsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const isTraining = auth.roles.includes('TRAINING') || auth.roles.includes('ADMIN');
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

  const events = [...(eventsQuery.data ?? [])].sort((a, b) => a.startAt - b.startAt);
  const now = Date.now();

  return (
    <main id="main-content" style={{ padding: 'var(--boxalarm-spacing-lg)' }}>
      <h1 style={{ fontSize: 'var(--boxalarm-font-size-xl)', margin: 0 }}>Training events</h1>

      {eventsQuery.isLoading ? (
        <p>Loading events…</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 'var(--boxalarm-spacing-lg) 0', padding: 0 }}>
          {events.map((event) => (
            <li
              key={event.eventId}
              style={{
                padding: 'var(--boxalarm-spacing-md) 0',
                borderBottom: '1px solid var(--boxalarm-fg)',
              }}
            >
              <strong>{event.title}</strong> ({event.category}) —{' '}
              {new Date(event.startAt).toLocaleString()}
              {event.signedUp ? ' · Signed up' : ''}
              {!event.signedUp ? (
                <>
                  {' '}
                  <button
                    type="button"
                    onClick={() => signUpMutation.mutate(event.eventId)}
                    disabled={signUpMutation.isPending}
                    style={{ minHeight: 44 }}
                  >
                    Sign up
                  </button>
                </>
              ) : null}
              {isTraining && event.startAt <= now ? <HoursForm event={event} /> : null}
            </li>
          ))}
          {events.length === 0 ? <li>No training events scheduled.</li> : null}
        </ul>
      )}

      {isTraining ? (
        <form
          onSubmit={onSubmit}
          aria-label="Create training event"
          style={{
            display: 'grid',
            gap: 'var(--boxalarm-spacing-md)',
            maxWidth: 480,
          }}
        >
          <h2 style={{ fontSize: 'var(--boxalarm-font-size-lg)', margin: 0 }}>Create event</h2>
          <label style={{ display: 'grid', gap: 4 }}>
            Title
            <input
              value={form.title}
              onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
              required
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            Category
            <input
              value={form.category}
              onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}
              required
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            Starts
            <input
              type="datetime-local"
              onChange={(e) => setForm((prev) => ({ ...prev, startAt: toEpochMs(e.target.value) }))}
              required
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            Ends
            <input
              type="datetime-local"
              onChange={(e) => setForm((prev) => ({ ...prev, endAt: toEpochMs(e.target.value) }))}
              required
              style={{ minHeight: 44, padding: '0 12px' }}
            />
          </label>
          {formError ? (
            <p role="alert" aria-live="assertive">
              {formError}
            </p>
          ) : null}
          <button type="submit" disabled={createMutation.isPending} style={{ minHeight: 44 }}>
            Create event
          </button>
        </form>
      ) : null}
    </main>
  );
}
