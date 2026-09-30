import { spacing, targetSize, typeScale, type StatusRole } from '@boxalarm/design-tokens';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, StatusChip, useTheme } from '../../components/ui';
import { useScheduleRepository } from '../../features/schedule/apiScheduleRepository';
import type { DutyShift, ShiftStatus } from '../../features/schedule/types';
import { ApiError } from '../../lib/apiClient';
import type { ScheduleStackParamList } from '../../navigation/ScheduleStack';
import { formatAsOf, NoCachedDataError } from '../../sync/readThrough';

const STATUS_LABEL: Record<ShiftStatus, string> = {
  OPEN: 'Open',
  PARTIALLY_FILLED: 'Partially filled',
  FULL: 'Full',
  CANCELLED: 'Cancelled',
};

const STATUS_ROLE: Record<ShiftStatus, StatusRole> = {
  OPEN: 'warning',
  PARTIALLY_FILLED: 'warning',
  FULL: 'ok',
  CANCELLED: 'neutral',
};

/** "Sat, Sep 20 · 18:00–06:00": the day and the window, not just the date. */
export function formatShiftWindow(startAt: number, endAt: number): string {
  const day = new Date(startAt).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const time = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${day} · ${time(startAt)}–${time(endAt)}`;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; shifts: DutyShift[]; cachedAt: number | null }
  | { kind: 'error'; message: string };

function describeLoadError(error: unknown): string {
  if (error instanceof NoCachedDataError) {
    return "You're offline, and this phone hasn't loaded the shift list yet. Connect once to download it.";
  }
  if (error instanceof ApiError && error.problem.status === 403) {
    return 'You do not have access to shifts. Contact your department administrator.';
  }
  return 'Shifts could not be loaded. Check your connection and try again.';
}

export function ShiftBoardScreen() {
  const navigation = useNavigation<NavigationProp<ScheduleStackParamList>>();
  const theme = useTheme();
  const repository = useScheduleRepository();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    repository
      .getShifts()
      .then((shifts) => {
        if (cancelled) return;
        setState({ kind: 'loaded', shifts, cachedAt: repository.shiftsCachedAt?.() ?? null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: 'error', message: describeLoadError(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [repository, attempt]);

  const header = (
    <View style={{ gap: spacing.md, paddingBottom: spacing.md }}>
      <Button
        label="Training events"
        variant="secondary"
        onPress={() => navigation.navigate('TrainingEvents')}
      />
      {state.kind === 'loaded' && state.cachedAt !== null ? (
        <Text
          style={{ color: theme.status.warning, fontSize: typeScale.body.size, fontWeight: '600' }}
        >
          Offline. Showing shifts saved on this phone as of {formatAsOf(state.cachedAt)}. Claiming
          needs a connection.
        </Text>
      ) : null}
    </View>
  );

  if (state.kind !== 'loaded') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
        <View style={{ padding: spacing.lg, gap: spacing.md }}>
          {header}
          {state.kind === 'loading' ? (
            <View
              accessibilityRole="progressbar"
              accessibilityLabel="Loading shifts"
              style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}
            >
              <ActivityIndicator color={theme.fg} />
              <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
                Loading shifts…
              </Text>
            </View>
          ) : (
            <>
              <Text
                accessibilityRole="alert"
                style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
              >
                {state.message}
              </Text>
              <Button label="Try again" onPress={() => setAttempt((n) => n + 1)} />
            </>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <FlatList
        data={state.shifts}
        keyExtractor={(item) => item.shiftId}
        contentContainerStyle={{ padding: spacing.lg }}
        ListHeaderComponent={header}
        ListEmptyComponent={
          <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
            No open shifts right now. Officers post shifts as they&apos;re scheduled.
          </Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => navigation.navigate('ShiftDetail', { shiftId: item.shiftId })}
            style={{
              minHeight: targetSize.field,
              justifyContent: 'center',
              gap: spacing.xs,
              paddingVertical: spacing.md,
              borderBottomWidth: 1,
              borderBottomColor: theme.borderDecorative,
            }}
          >
            <Text style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '600' }}>
              {item.stationId}
            </Text>
            <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
              {formatShiftWindow(item.startAt, item.endAt)}
            </Text>
            <StatusChip status={STATUS_ROLE[item.status]} label={STATUS_LABEL[item.status]} />
          </TouchableOpacity>
        )}
      />
    </SafeAreaView>
  );
}
