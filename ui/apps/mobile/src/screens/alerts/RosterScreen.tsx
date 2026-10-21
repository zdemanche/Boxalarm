import { spacing, typeScale, type StatusRole } from '@boxalarm/design-tokens';
import {
  useIsFocused,
  useNavigation,
  useRoute,
  type NavigationProp,
} from '@react-navigation/native';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { Button, Card, Screen, StatusChip, useTheme } from '../../components/ui';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import { ackStatusLabel } from '../../features/alerts/ackStatus';
import { useMemberNames } from '../../features/alerts/useMemberNames';
import type { AckStatus, RosterEntry } from '../../features/alerts/types';
import type { AlertsStackParamList } from '../../navigation/AlertsStack';
import { useConnectivity } from '../../sync/ConnectivityContext';
import {
  Notice,
  noticeText,
  ROW_PRIMARY,
  ROW_SECONDARY,
  rowDivider,
  useCanAssignRiding,
} from './alertsUi';

const REFETCH_INTERVAL_MS = 10_000;
// Backoff cap for repeated poll failures - retries slow down rather than hammering a struggling
// backend, but never wait longer than a minute during an active incident.
const MAX_BACKOFF_MS = 60_000;

function formatEta(etaSeconds: number | null): string | null {
  if (etaSeconds === null) return null;
  return new Date(etaSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Chip status for an answer: coming (ok), coming direct (info), not coming (neutral - red is the
 * alarm's alone), not answered yet (warning). The word always rides with it. */
const ACK_CHIP: Record<AckStatus, StatusRole> = {
  RESPONDING: 'ok',
  DIRECT_TO_SCENE: 'info',
  NOT_RESPONDING: 'neutral',
  UNANSWERED: 'warning',
};

function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// F1.7: live roster is one row per member, reflecting each member's current answer. It requires
// connectivity by nature (real-time data) - offline it keeps the last roster it loaded, marked
// not live (design.md F-03), and shows "will resume" only when nothing was ever loaded.
export function RosterScreen() {
  const route = useRoute();
  const navigation = useNavigation<NavigationProp<AlertsStackParamList>>();
  const canAssignRiding = useCanAssignRiding();
  const { dispatchId } = route.params as { dispatchId: string };
  const theme = useTheme();
  const isFocused = useIsFocused();
  const { isOnline } = useConnectivity();
  const repository = useAlertsRepository();
  const memberNames = useMemberNames(repository);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [staleSince, setStaleSince] = useState<number | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const loaded = loadedAt !== null;
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
          setLoadedAt(Date.now());
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

  const ridingAction = canAssignRiding ? (
    <Button
      label="Riding assignments"
      variant="secondary"
      fullWidth
      onPress={() => navigation.navigate('RidingBoard', { dispatchId })}
    />
  ) : null;

  if (!isOnline && !loaded) {
    return (
      <Screen>
        {ridingAction}
        <Notice tone="warning">
          <Text style={noticeText(theme, 'warning')}>
            Offline — roster will resume when connected.
          </Text>
        </Notice>
      </Screen>
    );
  }

  return (
    <Screen>
      {ridingAction}
      {!isOnline && loadedAt !== null ? (
        <Notice tone="warning">
          <Text accessibilityRole="alert" style={noticeText(theme, 'warning')}>
            {`Offline. This roster was last updated ${formatClockTime(loadedAt)} and is not live.`}
          </Text>
        </Notice>
      ) : null}
      {memberNames.failed ? (
        <Notice tone="warning">
          <Text style={noticeText(theme, 'warning')}>Names couldn't load. Showing member IDs.</Text>
        </Notice>
      ) : null}
      {isOnline && staleSince ? (
        <Notice tone="warning">
          <Text accessibilityRole="alert" style={noticeText(theme, 'warning')}>
            {`Data stopped updating at ${formatClockTime(staleSince)} — retrying…`}
          </Text>
        </Notice>
      ) : null}
      <Card>
        {roster.length === 0 ? (
          <Text style={{ color: theme.fgMuted, ...ROW_SECONDARY }}>
            {loaded
              ? 'Nobody is on the roster for this call yet.'
              : staleSince
                ? 'The roster has not loaded yet.'
                : 'Loading the roster…'}
          </Text>
        ) : null}
        {roster.map((item, index) => {
          const eta = formatEta(item.eta);
          return (
            <View
              key={item.memberId}
              style={{ minHeight: 56, gap: spacing.xs, ...rowDivider(theme, index) }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: spacing.sm,
                }}
              >
                <Text style={{ flex: 1, minWidth: 120, color: theme.fg, ...ROW_PRIMARY }}>
                  {memberNames.displayName(item)}
                </Text>
                <StatusChip
                  status={ACK_CHIP[item.ackStatus]}
                  label={ackStatusLabel(item.ackStatus)}
                />
              </View>
              {eta ? (
                <Text style={{ color: theme.fg, ...ROW_SECONDARY, fontWeight: '600' }}>
                  ETA {eta}
                </Text>
              ) : null}
              {item.assignedApparatusId ? (
                <Text style={{ color: theme.fgMuted, ...ROW_SECONDARY }}>
                  Assigned: {item.assignedApparatusId}
                </Text>
              ) : null}
              {item.quals.length > 0 ? (
                <Text style={{ color: theme.fgMuted, fontSize: typeScale.label.size }}>
                  {item.quals.join(', ')}
                </Text>
              ) : null}
            </View>
          );
        })}
      </Card>
    </Screen>
  );
}
