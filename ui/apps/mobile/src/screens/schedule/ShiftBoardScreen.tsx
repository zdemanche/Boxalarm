import { spacing, targetSize, typeScale, type StatusRole } from '@boxalarm/design-tokens';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Text, TouchableOpacity, View } from 'react-native';
import { Button, Card, Screen, StatusChip, useTheme } from '../../components/ui';
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

/** Field rows: primary text 17/600 (docs/design.md §1 field body). */
const ROW_TITLE_SIZE = 17;

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** "Sat, Sep 20 · 18:00–06:00": the day and the window, not just the date. */
export function formatShiftWindow(startAt: number, endAt: number): string {
  const day = new Date(startAt).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return `${day} · ${time(startAt)}–${time(endAt)}`;
}

function dayKey(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** A row under its day's heading: the length and the window, "12 h · 18:00–06:00 next day". */
function formatShiftTimes(startAt: number, endAt: number): string {
  const hours = Math.round(((endAt - startAt) / 3_600_000) * 10) / 10;
  const nextDay = dayKey(endAt) !== dayKey(startAt) ? ' next day' : '';
  return `${hours} h · ${time(startAt)}–${time(endAt)}${nextDay}`;
}

/** Shifts by the local day they start on, soonest first. */
function groupByDay(shifts: DutyShift[]): { key: string; title: string; shifts: DutyShift[] }[] {
  const groups = new Map<string, { key: string; title: string; shifts: DutyShift[] }>();
  for (const shift of [...shifts].sort((a, b) => a.startAt - b.startAt)) {
    const key = dayKey(shift.startAt);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        title: new Date(shift.startAt).toLocaleDateString(undefined, {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        }),
        shifts: [],
      };
      groups.set(key, group);
    }
    group.shifts.push(shift);
  }
  return [...groups.values()];
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

  const bodyText = { color: theme.fg, fontSize: typeScale.body.size };

  return (
    <Screen>
      <Card>
        <Button
          label="Mark unavailable"
          fullWidth
          onPress={() => navigation.navigate('Availability')}
        />
        <Button
          label="Training events"
          variant="secondary"
          fullWidth
          onPress={() => navigation.navigate('TrainingEvents')}
        />
      </Card>

      {state.kind === 'loaded' && state.cachedAt !== null ? (
        <Card>
          <Text
            style={{
              color: theme.status.warning,
              fontSize: typeScale.body.size,
              fontWeight: '600',
            }}
          >
            Offline. Showing shifts saved on this phone as of {formatAsOf(state.cachedAt)}. Claiming
            needs a connection.
          </Text>
        </Card>
      ) : null}

      {state.kind === 'loading' ? (
        <Card>
          <View
            accessibilityRole="progressbar"
            accessibilityLabel="Loading shifts"
            style={{
              minHeight: targetSize.field,
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.sm,
            }}
          >
            <ActivityIndicator color={theme.fgMuted} />
            <Text style={bodyText}>Loading shifts…</Text>
          </View>
        </Card>
      ) : state.kind === 'error' ? (
        <Card>
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
          >
            {state.message}
          </Text>
          <Button
            label="Try again"
            variant="secondary"
            fullWidth
            onPress={() => setAttempt((n) => n + 1)}
          />
        </Card>
      ) : state.shifts.length === 0 ? (
        <Card>
          <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
            No open shifts right now. Officers post shifts as they&apos;re scheduled.
          </Text>
        </Card>
      ) : (
        groupByDay(state.shifts).map((group) => (
          <Card key={group.key} title={group.title}>
            <View>
              {group.shifts.map((item, index) => (
                <TouchableOpacity
                  key={item.shiftId}
                  accessibilityRole="button"
                  onPress={() => navigation.navigate('ShiftDetail', { shiftId: item.shiftId })}
                  style={{
                    minHeight: targetSize.field,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.sm,
                    paddingVertical: spacing.sm + spacing.xs,
                    borderTopWidth: index === 0 ? 0 : 1,
                    borderTopColor: theme.borderDecorative,
                  }}
                >
                  <View style={{ flex: 1, gap: spacing.xs }}>
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: spacing.sm,
                      }}
                    >
                      <Text
                        style={{ color: theme.fg, fontSize: ROW_TITLE_SIZE, fontWeight: '600' }}
                      >
                        {item.stationId}
                      </Text>
                      <StatusChip
                        status={STATUS_ROLE[item.status]}
                        label={STATUS_LABEL[item.status]}
                      />
                    </View>
                    <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
                      {formatShiftTimes(item.startAt, item.endAt)}
                    </Text>
                  </View>
                  <Text
                    accessible={false}
                    importantForAccessibility="no"
                    style={{ color: theme.fgFaint, fontSize: typeScale.title.size }}
                  >
                    ›
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </Card>
        ))
      )}
    </Screen>
  );
}
