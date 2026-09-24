import { FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, PageHeader, Skeleton, TextInput } from '../../components/ui';
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
      style={{ display: 'flex', gap: 'var(--bx-space-sm)', alignItems: 'end', marginTop: 8 }}
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
        style={{ width: 80 }}
      />
      <Button type="submit" loading={mutation.isPending}>
        Record hours
      </Button>
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
    <main id="main-content">
      <PageHeader title="Training events" />

      {eventsQuery.isLoading ? (
        <Skeleton lines={4} />
      ) : (
        <ul style={{ listStyle: 'none', margin: 'var(--bx-space-lg) 0', padding: 0 }}>
          {events.map((event) => (
            <li
              key={event.eventId}
              style={{
                padding: 'var(--bx-space-md) 0',
                borderBottom: '1px solid var(--bx-border-decorative)',
              }}
            >
              <strong>{event.title}</strong> ({event.category}) —{' '}
              {new Date(event.startAt).toLocaleString()}
              {event.signedUp ? ' · Signed up' : ''}
              {!event.signedUp ? (
                <>
                  {' '}
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => signUpMutation.mutate(event.eventId)}
                    loading={signUpMutation.isPending}
                  >
                    Sign up
                  </Button>
                </>
              ) : null}
              {isTraining && event.startAt <= now ? <HoursForm event={event} /> : null}
            </li>
          ))}
          {events.length === 0 ? <li>No training events scheduled.</li> : null}
        </ul>
      )}

      {isTraining ? (
        <Card title="Create event" style={{ maxWidth: 480 }}>
          <form
            onSubmit={onSubmit}
            aria-label="Create training event"
            style={{ display: 'grid', gap: 'var(--bx-space-md)' }}
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
            <TextInput
              label="Starts"
              type="datetime-local"
              onChange={(e) => setForm((prev) => ({ ...prev, startAt: toEpochMs(e.target.value) }))}
              required
            />
            <TextInput
              label="Ends"
              type="datetime-local"
              onChange={(e) => setForm((prev) => ({ ...prev, endAt: toEpochMs(e.target.value) }))}
              required
            />
            {formError ? (
              <p role="alert" aria-live="assertive">
                {formError}
              </p>
            ) : null}
            <Button type="submit" loading={createMutation.isPending}>
              Create event
            </Button>
          </form>
        </Card>
      ) : null}
    </main>
  );
}
