import { palette, spacing, typography } from '@boxalarm/design-tokens';
import { useIsFocused, useRoute } from '@react-navigation/native';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import { ackStatusColor, ackStatusLabel } from '../../features/alerts/ackStatus';
import type { RosterEntry } from '../../features/alerts/types';
import { useConnectivity } from '../../sync/ConnectivityContext';

const REFETCH_INTERVAL_MS = 10_000;
// Backoff cap for repeated poll failures - retries slow down rather than hammering a struggling
// backend, but never wait longer than a minute during an active incident.
const MAX_BACKOFF_MS = 60_000;

function formatEta(etaSeconds: number | null): string | null {
  if (etaSeconds === null) return null;
  return new Date(etaSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// F1.7: live roster is one row per member, reflecting each member's current answer. It requires
// connectivity by nature (real-time data) - architecture.md is explicit this is one of the two
// screens that must show a clear "offline, will resume" state rather than pretending to work.
export function RosterScreen() {
  const route = useRoute();
  const { dispatchId } = route.params as { dispatchId: string };
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const isFocused = useIsFocused();
  const { isOnline } = useConnectivity();
  const repository = useAlertsRepository();
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [staleSince, setStaleSince] = useState<number | null>(null);
  const failureCountRef = useRef(0);

  useEffect(() => {
    // React Navigation's native-stack keeps prior screens mounted (e.g. AlertDetail -> Roster
    // -> RidingBoard leaves Roster mounted underneath), so without this guard a backgrounded
    // screen's poll keeps running indefinitely - tripling live network/battery load. Stop
    // polling while not focused and resume (with an immediate load) when it regains focus.
    if (!isOnline || !isFocused) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const scheduleNext = (delayMs: number) => {
      timeoutId = setTimeout(load, delayMs);
    };

    // A poll failure used to be an unhandled rejection: no error, no staleness indicator, and
    // stale roster data could silently persist indefinitely. Now a failure is caught, backs off
    // (so a struggling backend isn't hammered every 10s during an incident), and surfaces a
    // "stopped updating" indicator instead of quietly continuing to show old data as if it were
    // current.
    const load = () => {
      repository
        .getRoster(dispatchId)
        .then((result) => {
          if (cancelled) return;
          setRoster(result);
          setStaleSince(null);
          failureCountRef.current = 0;
          scheduleNext(REFETCH_INTERVAL_MS);
        })
        .catch(() => {
          if (cancelled) return;
          failureCountRef.current += 1;
          setStaleSince((prev) => prev ?? Date.now());
          const backoffMs = Math.min(
            REFETCH_INTERVAL_MS * 2 ** failureCountRef.current,
            MAX_BACKOFF_MS,
          );
          scheduleNext(backoffMs);
        });
    };

    load();
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [dispatchId, isOnline, isFocused, repository]);

  if (!isOnline) {
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
        <Text style={{ color: tokens.foreground, fontSize: typography.size.base }}>
          Offline — roster will resume when connected.
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      {staleSince ? (
        <Text
          accessibilityRole="alert"
          style={{ color: tokens.warning, padding: spacing.sm, fontSize: typography.size.sm }}
        >
          {`Data stopped updating at ${formatClockTime(staleSince)} — retrying…`}
        </Text>
      ) : null}
      <FlatList
        data={roster}
        keyExtractor={(item) => item.memberId}
        contentContainerStyle={{ padding: spacing.lg }}
        renderItem={({ item }) => {
          const eta = formatEta(item.eta);
          return (
            <View
              style={{
                paddingVertical: spacing.md,
                borderBottomWidth: 1,
                borderBottomColor: tokens.foreground + '22',
              }}
            >
              <Text
                style={{
                  color: tokens.foreground,
                  fontSize: typography.size.base,
                  fontWeight: '600',
                }}
              >
                {item.name}
              </Text>
              <Text
                style={{
                  color: ackStatusColor(item.ackStatus, tokens),
                  fontSize: typography.size.sm,
                  marginTop: 2,
                }}
              >
                {ackStatusLabel(item.ackStatus)}
                {eta ? ` · ETA ${eta}` : ''}
              </Text>
              {item.assignedApparatusId ? (
                <Text
                  style={{ color: tokens.foreground, opacity: 0.7, fontSize: typography.size.sm }}
                >
                  Assigned: {item.assignedApparatusId}
                </Text>
              ) : null}
              <Text
                style={{
                  color: tokens.foreground,
                  opacity: 0.7,
                  fontSize: typography.size.sm,
                  marginTop: 2,
                }}
              >
                {item.quals.join(', ')}
              </Text>
            </View>
          );
        }}
      />
    </SafeAreaView>
  );
}
