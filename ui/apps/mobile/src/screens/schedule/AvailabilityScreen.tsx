import { radius, spacing, targetSize, typeScale } from '@boxalarm/design-tokens';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, Text, TouchableOpacity, View } from 'react-native';
import { useOptionalAuth } from '../../auth/AuthContext';
import { Button, Screen, useTheme, type SurfaceTheme } from '../../components/ui';
import { useScheduleRepository } from '../../features/schedule/apiScheduleRepository';
import { MarkOffList } from '../../features/schedule/MarkOffList';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';
import { DeliveryStatus } from '../../sync/DeliveryStatus';
import { AVAILABILITY_MAY_BE_IN_EFFECT } from '../../sync/syncManager';
import { kvGet, kvSet } from '../../sync/kvStore';
import { memberCacheKey } from '../../sync/memberCache';
import { useOutboxItem } from '../../sync/useOutboxItem';

// F2.5 / design.md F-06: a mark-off suppresses alerting, so nothing here is pre-chosen - the old
// screen defaulted to a seven-day window that one tap would submit. The member picks a duration;
// Custom uses tap steppers, never typed dates (design.md §4.8: field forms avoid free text).

export type DurationPreset = 'tonight' | '24h' | '3d' | '1w' | 'custom';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 06:00 the next morning - or this morning, when it is still before 06:00. */
export function nextSixAm(now: Date): Date {
  const six = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 0, 0, 0);
  return now.getTime() < six.getTime() ? six : new Date(six.getTime() + DAY_MS);
}

/** Called at submit time with the real current time: no rounding, so two mark-offs made a few
 * seconds apart have different starts (review M1). */
export function presetWindow(preset: Exclude<DurationPreset, 'custom'>, now: Date) {
  const start = new Date(now.getTime());
  switch (preset) {
    case 'tonight':
      return { start, end: nextSixAm(now) };
    case '24h':
      return { start, end: new Date(start.getTime() + DAY_MS) };
    case '3d':
      return { start, end: new Date(start.getTime() + 3 * DAY_MS) };
    case '1w':
      return { start, end: new Date(start.getTime() + 7 * DAY_MS) };
  }
}

export function formatWhen(date: Date): string {
  const day = date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}`;
}

const PRESETS: { value: DurationPreset; label: (now: Date) => string }[] = [
  {
    value: 'tonight',
    label: (now) =>
      `Tonight — until ${nextSixAm(now).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      })} ${nextSixAm(now).toLocaleDateString(undefined, { weekday: 'short' })}`,
  },
  { value: '24h', label: () => '24 hours' },
  { value: '3d', label: () => '3 days' },
  { value: '1w', label: () => '1 week' },
  { value: 'custom', label: () => 'Custom dates…' },
];

const REASONS = ['Work', 'Travel', 'Sick', 'Family', 'Other'] as const;

function startOfNextHour(now: Date): Date {
  const next = new Date(now.getTime() + HOUR_MS);
  next.setMinutes(0, 0, 0);
  return next;
}

interface LastMarkOff {
  readonly startAt: string;
  readonly endAt: string;
}

function Choice({
  label,
  selected,
  onPress,
  theme,
  accessibilityLabel,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  theme: SurfaceTheme;
  accessibilityLabel?: string;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="radio"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ checked: selected }}
      onPress={onPress}
      style={{
        minHeight: targetSize.field,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.md,
        borderRadius: radius.default,
        borderWidth: selected ? 2 : 1,
        borderColor: selected ? theme.fg : theme.borderStrong,
        backgroundColor: selected ? theme.surfaceRaised : 'transparent',
      }}
    >
      <Text accessible={false} style={{ color: theme.fg, fontSize: typeScale.heading.size }}>
        {selected ? '●' : '○'}
      </Text>
      <Text
        style={{
          color: theme.fg,
          fontSize: typeScale.heading.size,
          fontWeight: selected ? '700' : '400',
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/** A date-and-time stepped by whole hours and days - glove-friendly, no keyboard. */
function DateTimeStepper({
  label,
  value,
  onChange,
  theme,
}: {
  label: string;
  value: Date;
  onChange: (next: Date) => void;
  theme: SurfaceTheme;
}) {
  const step = (ms: number) => onChange(new Date(value.getTime() + ms));
  const steps: { text: string; ms: number; spoken: string }[] = [
    { text: '−1 day', ms: -DAY_MS, spoken: 'one day earlier' },
    { text: '−1 h', ms: -HOUR_MS, spoken: 'one hour earlier' },
    { text: '+1 h', ms: HOUR_MS, spoken: 'one hour later' },
    { text: '+1 day', ms: DAY_MS, spoken: 'one day later' },
  ];
  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={{ color: theme.fg, fontSize: typeScale.label.size, fontWeight: '600' }}>
        {label}
      </Text>
      <Text
        accessibilityLiveRegion="polite"
        accessibilityLabel={`${label}: ${formatWhen(value)}`}
        style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '700' }}
      >
        {formatWhen(value)}
      </Text>
      <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
        {steps.map((s) => (
          <TouchableOpacity
            key={s.text}
            accessibilityRole="button"
            accessibilityLabel={`${label} ${s.spoken}`}
            onPress={() => step(s.ms)}
            style={{
              minHeight: targetSize.field,
              minWidth: targetSize.field + 16,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.default,
              borderWidth: 1,
              borderColor: theme.borderStrong,
              paddingHorizontal: spacing.sm,
            }}
          >
            <Text style={{ color: theme.fg, fontSize: typeScale.body.size, fontWeight: '600' }}>
              {s.text}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

export function AvailabilityScreen() {
  const theme = useTheme();
  const navigation = useNavigation();
  const auth = useOptionalAuth();
  const repository = useScheduleRepository();
  const { isOnline } = useOptionalConnectivity();
  const lastKey = auth?.memberId ? memberCacheKey.lastMarkOff(auth.memberId) : null;
  // Signed in but with no member id on the session: nothing can be sent for "me" (review m8).
  const signedInWithoutId = auth?.isAuthenticated === true && !auth.memberId;
  const [now] = useState(() => new Date());
  const [preset, setPreset] = useState<DurationPreset | null>(null);
  const [customStart, setCustomStart] = useState(() => startOfNextHour(now));
  const [customEnd, setCustomEnd] = useState(
    () => new Date(startOfNextHour(now).getTime() + 12 * HOUR_MS),
  );
  const [reason, setReason] = useState<(typeof REASONS)[number] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{
    start: Date;
    end: Date;
    outboxId: string | null;
    replacedUnsent: number;
    earlierMayStand: number;
  } | null>(null);
  const [lastMarkOff, setLastMarkOff] = useState<LastMarkOff | null>(null);
  const delivery = useOutboxItem(submitted?.outboxId ?? null);

  useEffect(() => {
    let cancelled = false;
    if (!lastKey) return undefined;
    void kvGet<LastMarkOff>(lastKey).then((entry) => {
      if (!cancelled && entry && new Date(entry.value.endAt).getTime() > Date.now()) {
        setLastMarkOff(entry.value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [lastKey]);

  // Remember a mark-off as "last marked off" only once the server has it (review m9): a rejected
  // or never-sent one must not be reported back to the member as their status.
  useEffect(() => {
    if (!submitted || !lastKey) return;
    if (submitted.outboxId !== null && delivery.state !== 'SYNCED') return;
    void kvSet<LastMarkOff>(lastKey, {
      startAt: submitted.start.toISOString(),
      endAt: submitted.end.toISOString(),
    });
  }, [submitted, delivery.state, lastKey]);

  const windowAt = (at: Date) =>
    preset === null
      ? null
      : preset === 'custom'
        ? { start: customStart, end: customEnd }
        : presetWindow(preset, at);
  // Preview only; the window actually sent is computed at submit (a screen left open for an hour
  // must not send a window that started an hour ago).
  const markOff = windowAt(new Date());

  const handleSubmit = async () => {
    const markOff = windowAt(new Date());
    if (!markOff) {
      const message = 'Choose how long you will be unavailable first.';
      setError(message);
      AccessibilityInfo.announceForAccessibility(message);
      return;
    }
    if (markOff.end.getTime() <= markOff.start.getTime()) {
      setError('The end has to be after the start.');
      return;
    }
    if (markOff.end.getTime() <= Date.now()) {
      setError('The end has to be in the future.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await repository.markUnavailable(
        markOff.start.toISOString(),
        markOff.end.toISOString(),
        reason ?? undefined,
      );
      setSubmitted({
        start: markOff.start,
        end: markOff.end,
        outboxId: result.outboxId,
        replacedUnsent: result.replacedUnsent ?? 0,
        earlierMayStand: result.earlierMayStand ?? 0,
      });
      AccessibilityInfo.announceForAccessibility(
        result.outboxId === null
          ? `Marked unavailable until ${formatWhen(markOff.end)}.`
          : 'Saved on this phone. You may still be alerted until this syncs.',
      );
    } catch {
      // Nothing was queued: say so plainly. The member is NOT marked off.
      setError(
        'This could not be saved on this phone, so you are not marked unavailable. Try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (signedInWithoutId) {
    return (
      <Screen>
        <Text
          accessibilityRole="header"
          style={{ color: theme.fg, fontSize: typeScale.title.size, fontWeight: '700' }}
        >
          Sign in again to mark yourself unavailable
        </Text>
        <Text style={{ color: theme.fg, fontSize: typeScale.body.size, marginTop: spacing.md }}>
          This phone's sign-in doesn't say which member you are, so a mark-off can't be sent. Sign
          out from Me and sign back in. Until then, tell an officer if you can't respond.
        </Text>
      </Screen>
    );
  }

  if (submitted) {
    const inEffect = submitted.outboxId === null || delivery.state === 'SYNCED';
    // A 409 on a resend: the first send probably landed. Never "you will still be alerted" (R2-M1).
    const maybeInEffect =
      delivery.state === 'REJECTED' && delivery.lastError === AVAILABILITY_MAY_BE_IN_EFFECT;
    const failed =
      (delivery.state === 'REJECTED' && !maybeInEffect) || delivery.state === 'DISCARDED';
    // A mark-off this phone delivered earlier, still running, that this one does not cancel.
    const earlier =
      lastMarkOff &&
      new Date(lastMarkOff.endAt).getTime() > Date.now() &&
      new Date(lastMarkOff.endAt).getTime() !== submitted.end.getTime()
        ? lastMarkOff
        : null;
    return (
      <Screen>
        <View style={{ gap: spacing.md }}>
          <Text
            accessibilityRole="header"
            style={{ color: theme.fg, fontSize: typeScale.title.size, fontWeight: '700' }}
          >
            {maybeInEffect
              ? 'May already be in effect'
              : failed
                ? 'Not marked unavailable'
                : inEffect
                  ? `Marked unavailable until ${formatWhen(submitted.end)}`
                  : 'Saved on this phone — not in effect yet'}
          </Text>
          {maybeInEffect ? (
            <Text
              style={{
                color: theme.status.warning,
                fontSize: typeScale.body.size,
                fontWeight: '600',
              }}
            >
              An earlier send may have reached Boxalarm before the connection dropped, so you may
              already be marked off until {formatWhen(submitted.end)}. Ask an officer to check.
            </Text>
          ) : failed ? (
            <Text
              style={{
                color: theme.status.danger,
                fontSize: typeScale.body.size,
                fontWeight: '600',
              }}
            >
              This mark-off was not recorded, so you will still be alerted.
            </Text>
          ) : inEffect ? (
            <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
              You won&apos;t be alerted for calls until then. You&apos;ll still get drill and shift
              reminders.
            </Text>
          ) : (
            <Text
              style={{
                color: theme.status.warning,
                fontSize: typeScale.body.size,
                fontWeight: '600',
              }}
            >
              You may still be alerted until this syncs. Until {formatWhen(submitted.end)} once it
              does.
            </Text>
          )}
          {submitted.earlierMayStand > 0 ? (
            <Text
              style={{
                color: theme.status.warning,
                fontSize: typeScale.body.size,
                fontWeight: '600',
              }}
            >
              An earlier mark-off from this phone may already be in effect: it was sent before, so
              it can&apos;t be taken back. This one does not cancel it, and both may stand. Ask an
              officer to check.
            </Text>
          ) : null}
          {submitted.replacedUnsent > 0 ? (
            <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
              This replaces the mark-off you saved earlier that hadn&apos;t been sent yet.
            </Text>
          ) : null}
          {earlier && !failed ? (
            <Text
              style={{
                color: theme.status.warning,
                fontSize: typeScale.body.size,
                fontWeight: '600',
              }}
            >
              Your earlier mark-off until {formatWhen(new Date(earlier.endAt))} is still in effect.
              This one does not cancel it.
            </Text>
          ) : null}
          <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
            To end a mark-off early, tap &ldquo;I&apos;m available again&rdquo; on Me (it needs
            signal).
          </Text>
          {submitted.outboxId !== null ? (
            <DeliveryStatus
              itemId={submitted.outboxId}
              label="Mark unavailable"
              state={delivery.state}
              lastError={delivery.lastError}
              isOnline={isOnline}
            />
          ) : null}
          <Button label="Done" fullWidth onPress={() => navigation.goBack()} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ gap: spacing.lg }}>
        <Text
          accessibilityRole="header"
          style={{ color: theme.fg, fontSize: typeScale.title.size, fontWeight: '700' }}
        >
          Mark unavailable
        </Text>
        {lastMarkOff ? (
          <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
            From this phone, you last marked yourself unavailable until{' '}
            {formatWhen(new Date(lastMarkOff.endAt))}. A new mark-off does not cancel it; to end it
            early, use &ldquo;I&apos;m available again&rdquo; below.
          </Text>
        ) : null}
        <MarkOffList />
        <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
          You won&apos;t be alerted for calls while you&apos;re marked off. You&apos;ll still get
          drill and shift reminders. Shifts you have claimed are not cancelled.
        </Text>

        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="How long"
          style={{ gap: spacing.sm }}
        >
          <Text style={{ color: theme.fg, fontSize: typeScale.label.size, fontWeight: '600' }}>
            How long
          </Text>
          {PRESETS.map((option) => (
            <Choice
              key={option.value}
              label={option.label(new Date())}
              selected={preset === option.value}
              onPress={() => {
                setPreset(option.value);
                setError(null);
              }}
              theme={theme}
            />
          ))}
        </View>

        {preset === 'custom' ? (
          <View style={{ gap: spacing.lg }}>
            <DateTimeStepper
              label="From"
              value={customStart}
              onChange={setCustomStart}
              theme={theme}
            />
            <DateTimeStepper
              label="Until"
              value={customEnd}
              onChange={setCustomEnd}
              theme={theme}
            />
          </View>
        ) : null}

        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="Reason (optional)"
          style={{ gap: spacing.sm }}
        >
          <Text style={{ color: theme.fg, fontSize: typeScale.label.size, fontWeight: '600' }}>
            Reason (optional)
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            {REASONS.map((value) => (
              <Choice
                key={value}
                label={value}
                selected={reason === value}
                onPress={() => setReason(reason === value ? null : value)}
                theme={theme}
              />
            ))}
          </View>
        </View>

        {markOff ? (
          <Text style={{ color: theme.fg, fontSize: typeScale.body.size, fontWeight: '600' }}>
            From {formatWhen(markOff.start)} until {formatWhen(markOff.end)}.
          </Text>
        ) : null}
        {!isOnline ? (
          <Text style={{ color: theme.status.warning, fontSize: typeScale.body.size }}>
            You&apos;re offline. This will be saved on this phone and sent when you have signal.
            Until then you may still be alerted.
          </Text>
        ) : null}
        {error ? (
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
          >
            {error}
          </Text>
        ) : null}
        <Button
          label="Mark unavailable"
          size="alert"
          fullWidth
          loading={submitting}
          onPress={() => void handleSubmit()}
        />
      </View>
    </Screen>
  );
}
