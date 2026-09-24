import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useState } from 'react';
import { AccessibilityInfo, Text, TextInput, TouchableOpacity, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useScheduleRepository } from '../../features/schedule/apiScheduleRepository';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';

// F2.5: planned unavailability that suppresses alerting. Dates/times are plain HH:MM/YYYY-MM-DD
// text fields rather than a native picker component (ponytail: no date-picker dependency is
// installed yet; upgrade to the design system's picker once that package lands) - still a real,
// editable window rather than the previous hard-coded 7-day default.
function defaultDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseDateTime(date: string, time: string): string | null {
  const iso = `${date}T${time || '00:00'}:00`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function AvailabilityScreen() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const repository = useScheduleRepository();
  const { isOnline } = useOptionalConnectivity();
  const [startDate, setStartDate] = useState(defaultDate(0));
  const [startTime, setStartTime] = useState('00:00');
  const [endDate, setEndDate] = useState(defaultDate(7));
  const [endTime, setEndTime] = useState('00:00');
  const [reason, setReason] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'confirmed' | 'pending' | 'error'>(
    'idle',
  );
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const startAt = parseDateTime(startDate, startTime);
    const endAt = parseDateTime(endDate, endTime);
    if (!startAt || !endAt) {
      setError('Enter a valid start and end date/time.');
      return;
    }
    if (endAt <= startAt) {
      setError('End must be after start.');
      return;
    }
    setError(null);

    if (!isOnline) {
      setStatus('pending');
      AccessibilityInfo.announceForAccessibility('Pending. Saved on this device.');
      return;
    }

    setStatus('submitting');
    try {
      await repository.markUnavailable(startAt, endAt, reason || undefined);
      setStatus('confirmed');
      AccessibilityInfo.announceForAccessibility('Marked unavailable');
    } catch {
      setStatus('error');
      setError('Could not save. Nothing was marked off.');
    }
  };

  if (status === 'confirmed' || status === 'pending') {
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: tokens.background,
          alignItems: 'center',
          justifyContent: 'center',
          padding: spacing.lg,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{
            color: status === 'confirmed' ? tokens.success : tokens.accent,
            fontSize: typography.size.lg,
            fontWeight: '700',
          }}
        >
          {status === 'confirmed' ? 'Marked unavailable' : 'Pending — not yet in effect'}
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background, padding: spacing.lg }}>
      <Text
        accessibilityRole="header"
        style={{ color: tokens.foreground, fontSize: typography.size.lg, fontWeight: '700' }}
      >
        Mark unavailable
      </Text>
      <Text
        style={{
          color: tokens.foreground,
          opacity: 0.7,
          fontSize: typography.size.sm,
          marginTop: spacing.sm,
        }}
      >
        Suppresses alert paging for the selected window. This does not cancel any shift you&apos;ve
        already claimed.
      </Text>
      <TextInput
        accessibilityLabel="Start date"
        placeholder="Start date (YYYY-MM-DD)"
        placeholderTextColor={tokens.foreground + '88'}
        value={startDate}
        onChangeText={setStartDate}
        style={inputStyle(tokens)}
      />
      <TextInput
        accessibilityLabel="Start time"
        placeholder="Start time (HH:MM)"
        placeholderTextColor={tokens.foreground + '88'}
        value={startTime}
        onChangeText={setStartTime}
        style={inputStyle(tokens)}
      />
      <TextInput
        accessibilityLabel="End date"
        placeholder="End date (YYYY-MM-DD)"
        placeholderTextColor={tokens.foreground + '88'}
        value={endDate}
        onChangeText={setEndDate}
        style={inputStyle(tokens)}
      />
      <TextInput
        accessibilityLabel="End time"
        placeholder="End time (HH:MM)"
        placeholderTextColor={tokens.foreground + '88'}
        value={endTime}
        onChangeText={setEndTime}
        style={inputStyle(tokens)}
      />
      <TextInput
        value={reason}
        onChangeText={setReason}
        placeholder="Reason (optional)"
        placeholderTextColor={tokens.foreground + '88'}
        style={inputStyle(tokens)}
      />
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.error, marginTop: spacing.sm }}>
          {error}
        </Text>
      ) : null}
      <TouchableOpacity
        accessibilityRole="button"
        onPress={() => void handleSubmit()}
        disabled={status === 'submitting'}
        style={{
          minHeight: touchTarget.baseline.ios,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: tokens.accent,
          borderRadius: radius.default,
          marginTop: spacing.lg,
          opacity: status === 'submitting' ? 0.6 : 1,
        }}
      >
        <Text
          style={{ color: tokens.background, fontSize: typography.size.base, fontWeight: '600' }}
        >
          Mark unavailable
        </Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

function inputStyle(tokens: { foreground: string }) {
  return {
    marginTop: spacing.lg,
    minHeight: touchTarget.baseline.ios,
    borderWidth: 1,
    borderColor: tokens.foreground + '33',
    borderRadius: radius.default,
    paddingHorizontal: spacing.md,
    color: tokens.foreground,
    fontSize: typography.size.base,
  };
}
