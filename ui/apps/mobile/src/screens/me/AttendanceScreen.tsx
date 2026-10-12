import { radiusScale, spacing, targetSize, typeScale } from '@boxalarm/design-tokens';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Text, TouchableOpacity, View } from 'react-native';
import { Button, Card, Screen, useTheme } from '../../components/ui';
import {
  activityLabel,
  useAttendanceRepository,
} from '../../features/attendance/apiAttendanceRepository';
import type { ActivityType, AttendanceRecord } from '../../features/attendance/types';
import type { SyncItem } from '../../features/sync/types';
import { ApiError } from '../../lib/apiClient';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';
import { DeliveryStatus } from '../../sync/DeliveryStatus';
import * as syncManager from '../../sync/syncManager';
import { InfoRow, ROW_TITLE_SIZE, Rows } from './MeRows';

const ACTIVITY_TYPES: ActivityType[] = ['CALL', 'DRILL', 'MEETING', 'WORK_DETAIL', 'STANDBY'];

// Mirrors ProfileEditScreen's error-handling pattern: a 403 gets its own message, everything
// else (offline, 5xx) gets a generic retry prompt, and the failure is both shown on screen and
// announced for a screen-reader user who isn't focused on this control when it lands.
function describeError(e: unknown, forbiddenMessage: string, fallbackMessage: string): string {
  return e instanceof ApiError && e.problem.status === 403 ? forbiddenMessage : fallbackMessage;
}

export function AttendanceScreen() {
  const theme = useTheme();
  const repository = useAttendanceRepository();
  const { isOnline } = useOptionalConnectivity();
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [pending, setPending] = useState<SyncItem[]>([]);
  const [activityType, setActivityType] = useState<ActivityType>('DRILL');
  const [error, setError] = useState<string | null>(null);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [saving, setSaving] = useState(false);
  // occurredAt (epoch seconds) is the record's server-side key and its outbox id, so two taps in
  // the same second would collapse into one record; each new record is kept a second apart.
  const lastOccurredAt = useRef(0);
  const pendingCount = useRef(0);

  const loadRecords = () => {
    repository
      .getOwnRecords()
      .then((next) => {
        setError(null);
        setHistoryUnavailable(false);
        setRecords(next);
      })
      .catch((e: unknown) => {
        // A network failure is the expected offline case, not an error: recording still works.
        if (!(e instanceof ApiError)) {
          setHistoryUnavailable(true);
          return;
        }
        const message = describeError(
          e,
          'You do not have access to view this attendance history.',
          'Could not load attendance history. Try again.',
        );
        setError(message);
        AccessibilityInfo.announceForAccessibility(message);
      });
  };

  useEffect(loadRecords, [repository]);

  // Records still on the phone come from the SQLite outbox, so they survive an app restart and
  // show their real state. When one leaves the outbox it was delivered (or discarded), so the
  // server history is reloaded to show it there instead.
  useEffect(
    () =>
      syncManager.subscribe((status) => {
        const next = status.items.filter((item) => item.kind === 'ATTENDANCE');
        if (next.length < pendingCount.current) loadRecords();
        pendingCount.current = next.length;
        setPending(next);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repository],
  );

  const handleRecord = async () => {
    const occurredAt = Math.max(Math.floor(Date.now() / 1000), lastOccurredAt.current + 1);
    lastOccurredAt.current = occurredAt;
    const entry: AttendanceRecord = { activityType, refId: null, occurredAt, hours: 1 };
    setSaving(true);
    setError(null);
    try {
      await repository.record(entry);
      loadRecords();
      AccessibilityInfo.announceForAccessibility(
        isOnline
          ? `${activityLabel(activityType)} attendance saved. Sending now.`
          : `${activityLabel(activityType)} attendance saved on this phone. It sends when you have signal.`,
      );
    } catch (e: unknown) {
      const message = describeError(
        e,
        'You do not have access to record attendance.',
        'Could not save attendance on this phone. Try again.',
      );
      setError(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setSaving(false);
    }
  };

  const sorted = [...records].sort((a, b) => b.occurredAt - a.occurredAt);

  const muted = { color: theme.fgMuted, fontSize: typeScale.body.size };

  return (
    <Screen>
      <Card title="Record attendance">
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="Activity"
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}
        >
          {ACTIVITY_TYPES.map((type) => {
            const selected = activityType === type;
            return (
              <TouchableOpacity
                key={type}
                accessibilityRole="radio"
                accessibilityLabel={activityLabel(type)}
                accessibilityState={{ selected, checked: selected }}
                onPress={() => setActivityType(type)}
                style={{
                  minHeight: targetSize.field,
                  minWidth: targetSize.field,
                  paddingHorizontal: spacing.md,
                  justifyContent: 'center',
                  alignItems: 'center',
                  borderRadius: radiusScale.pill,
                  borderWidth: selected ? 2 : 1,
                  borderColor: selected ? theme.indicator : theme.border,
                  backgroundColor: selected ? theme.accentFill : theme.card,
                }}
              >
                <Text
                  style={{
                    color: selected ? theme.onAccentFill : theme.fg,
                    fontSize: typeScale.body.size,
                    fontWeight: selected ? '700' : '600',
                  }}
                >
                  {activityLabel(type)}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
        <View style={{ marginTop: spacing.sm }}>
          <Button
            label={`Record ${activityLabel(activityType).toLowerCase()} attendance`}
            fullWidth
            loading={saving}
            onPress={() => void handleRecord()}
          />
        </View>
        {error ? (
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
          >
            {error}
          </Text>
        ) : null}
      </Card>

      {pending.length > 0 ? (
        <Card title="On this phone, not yet recorded">
          <Rows>
            {pending.map((item) => (
              <View key={item.id} style={{ paddingVertical: spacing.sm, gap: spacing.xs }}>
                <Text style={{ color: theme.fg, fontSize: ROW_TITLE_SIZE, fontWeight: '600' }}>
                  {item.label}
                </Text>
                <DeliveryStatus
                  itemId={item.id}
                  label={item.label}
                  state={item.status}
                  lastError={item.lastError}
                  isOnline={isOnline}
                />
              </View>
            ))}
          </Rows>
        </Card>
      ) : null}

      <Card title="Recorded">
        {sorted.length === 0 ? (
          <Text style={muted}>
            {historyUnavailable
              ? 'History loads when you have signal. New records are still saved on this phone.'
              : 'No attendance recorded yet.'}
          </Text>
        ) : (
          <Rows>
            {sorted.map((item) => (
              <InfoRow
                key={`${item.activityType}-${item.occurredAt}`}
                accessible
                title={`${activityLabel(item.activityType)}${
                  item.refId ? ` — dispatch ${item.refId}` : ''
                }`}
                detail={`${new Date(item.occurredAt * 1000).toLocaleDateString()} — ${item.hours}h`}
              />
            ))}
          </Rows>
        )}
        {historyUnavailable && sorted.length > 0 ? (
          <Text style={muted}>History may be out of date - it refreshes when you have signal.</Text>
        ) : null}
      </Card>
    </Screen>
  );
}
