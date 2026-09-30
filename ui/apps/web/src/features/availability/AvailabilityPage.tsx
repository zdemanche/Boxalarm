import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, PageHeader, Select, TextInput } from '../../components/ui';
import { ApiError } from '../../lib/apiClient';
import { useOnlineStatus } from '../../lib/useOnlineStatus';
import { markUnavailable } from './api';
import styles from './AvailabilityPage.module.css';

// F2.5 / docs/design.md F-06 on the office surface. A mark-off suppresses alerting, so there is
// no default duration: the member picks one. Same presets as the app.

export type Preset = 'tonight' | '24h' | '3d' | '1w' | 'custom';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 06:00 the next morning - or this morning, when it is still before 06:00. */
export function nextSixAm(now: Date): Date {
  const six = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 0, 0);
  return now.getTime() < six.getTime() ? six : new Date(six.getTime() + DAY_MS);
}

function presetEnd(preset: Exclude<Preset, 'custom'>, start: Date, now: Date): Date {
  switch (preset) {
    case 'tonight':
      return nextSixAm(now);
    case '24h':
      return new Date(start.getTime() + DAY_MS);
    case '3d':
      return new Date(start.getTime() + 3 * DAY_MS);
    case '1w':
      return new Date(start.getTime() + 7 * DAY_MS);
  }
}

function formatWhen(date: Date): string {
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Epoch ms -> the `YYYY-MM-DDTHH:mm` local value a datetime-local input expects. */
function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const REASONS = ['Work', 'Travel', 'Sick', 'Family', 'Other'];

export function AvailabilityPage() {
  const auth = useAuth();
  const isOnline = useOnlineStatus();
  const [now] = useState(() => new Date());
  const [preset, setPreset] = useState<Preset | null>(null);
  const [customStart, setCustomStart] = useState(() => toLocalInputValue(now.getTime() + HOUR_MS));
  const [customEnd, setCustomEnd] = useState(() => toLocalInputValue(now.getTime() + 13 * HOUR_MS));
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: { start: Date; end: Date; reason: string }) =>
      markUnavailable(auth, auth.memberId ?? '', {
        startAt: Math.floor(input.start.getTime() / 1000),
        endAt: Math.floor(input.end.getTime() / 1000),
        ...(input.reason ? { reason: input.reason } : {}),
      }),
  });

  const presetLabels: { value: Preset; label: string }[] = [
    {
      value: 'tonight',
      label: `Tonight — until ${nextSixAm(new Date()).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      })} ${nextSixAm(new Date()).toLocaleDateString(undefined, { weekday: 'short' })}`,
    },
    { value: '24h', label: '24 hours' },
    { value: '3d', label: '3 days' },
    { value: '1w', label: '1 week' },
    { value: 'custom', label: 'Custom dates' },
  ];

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!preset) {
      setFormError('Choose how long you will be unavailable.');
      return;
    }
    if (!isOnline) {
      setFormError("You're offline, so this can't be saved. Nothing was marked off.");
      return;
    }
    // Taken at submit, not at page load: a page left open for an hour must not send a window
    // that started an hour ago.
    const submitNow = new Date();
    const start = preset === 'custom' ? new Date(customStart) : submitNow;
    const end = preset === 'custom' ? new Date(customEnd) : presetEnd(preset, submitNow, submitNow);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      setFormError('Enter both the start and the end.');
      return;
    }
    if (end.getTime() <= start.getTime()) {
      setFormError('The end has to be after the start.');
      return;
    }
    if (end.getTime() <= Date.now()) {
      setFormError('The end has to be in the future.');
      return;
    }
    setFormError(null);
    mutation.mutate({ start, end, reason });
  };

  if (mutation.isSuccess) {
    const end = new Date(mutation.data.endAt * 1000);
    return (
      <main id="main-content">
        <PageHeader title="My availability" />
        <Card>
          <p role="status" className={styles.confirmation}>
            You&rsquo;re marked unavailable until {formatWhen(end)}.
          </p>
          <p>
            You won&rsquo;t be alerted for calls until then. You&rsquo;ll still get drill and shift
            reminders.
          </p>
          <p>To end it early, ask an officer to clear it. Boxalarm can&rsquo;t cancel one yet.</p>
          <Button variant="secondary" onClick={() => mutation.reset()}>
            Mark another period
          </Button>
        </Card>
      </main>
    );
  }

  const submitError =
    mutation.error instanceof ApiError && mutation.error.problem.status === 409
      ? 'Not recorded: you already have a mark-off starting at that exact time. To change it, ask an officer to clear it.'
      : mutation.error
        ? 'This could not be saved, so you are not marked unavailable. Try again.'
        : null;

  return (
    <main id="main-content">
      <PageHeader title="My availability" />
      <Card>
        <form onSubmit={onSubmit} aria-label="Mark unavailable" className={styles.form}>
          <p className={styles.consequence}>
            You won&rsquo;t be alerted for calls while you&rsquo;re marked off. You&rsquo;ll still
            get drill and shift reminders. Shifts you have claimed are not cancelled.
          </p>
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>How long</legend>
            {presetLabels.map((option) => (
              <label key={option.value} className={styles.choice}>
                <input
                  type="radio"
                  name="duration"
                  value={option.value}
                  checked={preset === option.value}
                  onChange={() => {
                    setPreset(option.value);
                    setFormError(null);
                  }}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
          {preset === 'custom' ? (
            <div className={styles.custom}>
              <TextInput
                label="From"
                type="datetime-local"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
                required
              />
              <TextInput
                label="Until"
                type="datetime-local"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
                required
              />
            </div>
          ) : null}
          <Select
            label="Reason"
            optional
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          >
            <option value="">No reason given</option>
            {REASONS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
          {formError || submitError ? (
            <p role="alert" className={styles.error}>
              {formError ?? submitError}
            </p>
          ) : null}
          <div>
            <Button type="submit" loading={mutation.isPending}>
              Mark unavailable
            </Button>
          </div>
        </form>
      </Card>
    </main>
  );
}
