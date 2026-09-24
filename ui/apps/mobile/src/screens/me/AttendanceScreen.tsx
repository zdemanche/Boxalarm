import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  FlatList,
  Text,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAttendanceRepository } from '../../features/attendance/apiAttendanceRepository';
import type { ActivityType, AttendanceRecord } from '../../features/attendance/types';
import { ApiError } from '../../lib/apiClient';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';

const ACTIVITY_TYPES: ActivityType[] = ['CALL', 'DRILL', 'MEETING', 'WORK_DETAIL', 'STANDBY'];

// Mirrors ProfileEditScreen's error-handling pattern: a 403 gets its own message, everything
// else (offline, 5xx) gets a generic retry prompt, and the failure is both shown on screen and
// announced for a screen-reader user who isn't focused on this control when it lands.
function describeError(e: unknown, forbiddenMessage: string, fallbackMessage: string): string {
  return e instanceof ApiError && e.problem.status === 403 ? forbiddenMessage : fallbackMessage;
}

export function AttendanceScreen() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const repository = useAttendanceRepository();
  const { isOnline } = useOptionalConnectivity();
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [activityType, setActivityType] = useState<ActivityType>('DRILL');
  const [error, setError] = useState<string | null>(null);
  const queue = useRef<AttendanceRecord[]>([]);

  const loadRecords = () => {
    repository
      .getOwnRecords()
      .then((next) => {
        setError(null);
        setRecords(next);
      })
      .catch((e: unknown) => {
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

  useEffect(() => {
    if (!isOnline || queue.current.length === 0) return;
    const pending = queue.current;
    queue.current = [];
    Promise.all(pending.map((entry) => repository.record(entry))).then(() => {
      loadRecords();
      AccessibilityInfo.announceForAccessibility('Queued attendance synced');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  const handleRecord = () => {
    const entry: AttendanceRecord = {
      activityType,
      refId: null,
      occurredAt: Math.floor(Date.now() / 1000),
      hours: 1,
    };
    if (!isOnline) {
      queue.current.push(entry);
      setRecords((prev) => [...prev, entry]);
      AccessibilityInfo.announceForAccessibility('Queued. Will sync when you have signal.');
      return;
    }
    repository
      .record(entry)
      .then(() => {
        loadRecords();
        AccessibilityInfo.announceForAccessibility('Attendance recorded');
      })
      .catch((e: unknown) => {
        const message = describeError(
          e,
          'You do not have access to record attendance.',
          'Could not record attendance. Try again.',
        );
        setError(message);
        AccessibilityInfo.announceForAccessibility(message);
      });
  };

  const sorted = [...records].sort((a, b) => a.occurredAt - b.occurredAt);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <View
        style={{ padding: spacing.lg, flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}
      >
        {ACTIVITY_TYPES.map((type) => (
          <TouchableOpacity
            key={type}
            accessibilityRole="button"
            accessibilityState={{ selected: activityType === type }}
            onPress={() => setActivityType(type)}
            style={{
              minHeight: touchTarget.baseline.ios,
              paddingHorizontal: spacing.md,
              justifyContent: 'center',
              borderRadius: radius.default,
              borderWidth: 1,
              borderColor: tokens.accent,
              backgroundColor: activityType === type ? tokens.accent : 'transparent',
            }}
          >
            <Text
              style={{
                color: activityType === type ? tokens.background : tokens.accent,
                fontSize: typography.size.sm,
              }}
            >
              {type}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <TouchableOpacity
        accessibilityRole="button"
        onPress={handleRecord}
        style={{
          marginHorizontal: spacing.lg,
          minHeight: touchTarget.baseline.ios,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: tokens.accent,
          borderRadius: radius.default,
        }}
      >
        <Text
          style={{ color: tokens.background, fontSize: typography.size.base, fontWeight: '600' }}
        >
          Record attendance
        </Text>
      </TouchableOpacity>
      {error ? (
        <Text
          accessibilityRole="alert"
          style={{
            color: tokens.error,
            marginHorizontal: spacing.lg,
            marginTop: spacing.sm,
            fontSize: typography.size.sm,
          }}
        >
          {error}
        </Text>
      ) : null}
      <FlatList
        data={sorted}
        keyExtractor={(item, index) => `${item.activityType}-${item.occurredAt}-${index}`}
        contentContainerStyle={{ padding: spacing.lg }}
        renderItem={({ item }) => (
          <View style={{ paddingVertical: spacing.sm }}>
            <Text style={{ color: tokens.foreground, fontSize: typography.size.base }}>
              {item.activityType}
              {item.refId ? ` — dispatch ${item.refId}` : ''}
            </Text>
            <Text style={{ color: tokens.foreground, opacity: 0.7, fontSize: typography.size.sm }}>
              {new Date(item.occurredAt * 1000).toLocaleDateString()} — {item.hours}h
            </Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}
