import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useIsFocused, useRoute } from '@react-navigation/native';
import { useEffect, useRef, useState } from 'react';
import { FlatList, Text, TouchableOpacity, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import type { RidingBoardApparatus, RosterEntry } from '../../features/alerts/types';
import { ApiError } from '../../lib/apiClient';
import { useConnectivity } from '../../sync/ConnectivityContext';

const REFETCH_INTERVAL_MS = 10_000;
// Backoff cap for repeated poll failures - retries slow down rather than hammering a struggling
// backend, but never wait longer than a minute during an active incident.
const MAX_BACKOFF_MS = 60_000;

function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface PendingAssignment {
  unitId: string;
  positionCode: string;
  memberId: string;
  version: number;
}

// E1-S18-UI: the officer's riding board. Members come from the response roster (name, quals,
// ETA, direct-to-scene distinction); seats come from apparatus-service's riding board. The
// member's own one-tap response flow (AlertDetailScreen) is untouched by this screen.
export function RidingBoardScreen() {
  const route = useRoute();
  const { dispatchId } = route.params as { dispatchId: string };
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const isFocused = useIsFocused();
  const { isOnline } = useConnectivity();
  const repository = useAlertsRepository();
  const [apparatus, setApparatus] = useState<RidingBoardApparatus[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [openSeat, setOpenSeat] = useState<{ unitId: string; positionCode: string } | null>(null);
  const [pending, setPending] = useState<Map<string, PendingAssignment>>(new Map());
  const [conflict, setConflict] = useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [staleSince, setStaleSince] = useState<number | null>(null);
  const failureCountRef = useRef(0);

  useEffect(() => {
    // React Navigation's native-stack keeps prior screens mounted (AlertDetail -> Roster ->
    // RidingBoard leaves Roster mounted underneath), so without this guard a backgrounded
    // screen's poll keeps running indefinitely - tripling live network/battery load. Stop
    // polling while not focused and resume (with an immediate load, not a stale wait) when it
    // regains focus.
    if (!isFocused) return;

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const scheduleNext = (delayMs: number) => {
      timeoutId = setTimeout(load, delayMs);
    };

    // A poll failure used to be an unhandled rejection: no error, no staleness indicator, and
    // stale live data could silently persist indefinitely. Now a failure is caught, backs off
    // (so a struggling backend isn't hammered every 10s during an incident), and surfaces a
    // "stopped updating" indicator instead of quietly continuing to show old data as if it were
    // current.
    const load = () => {
      Promise.all([repository.getRidingBoard(dispatchId), repository.getRoster(dispatchId)])
        .then(([board, rosterResult]) => {
          if (cancelled) return;
          setApparatus(board.apparatus);
          setRoster(rosterResult);
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
  }, [dispatchId, repository, isFocused]);

  // The offline branch below only ever added to `pending` and returned - nothing flushed or
  // retried it on reconnect, so an offline assignment showed "Pending sync" forever and was
  // silently lost. Keep a ref mirror of `pending` so the flush effect (keyed only on `isOnline`,
  // so it fires once per reconnect rather than looping) always reads the latest queued
  // assignments without needing `pending` itself in its dependency array.
  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(() => {
    if (!isOnline || pendingRef.current.size === 0) return;
    let cancelled = false;

    const flush = async () => {
      const queued = [...pendingRef.current];
      for (const [seatKey, assignment] of queued) {
        if (cancelled) return;
        try {
          await repository.assignRidingSeat(dispatchId, {
            unitId: assignment.unitId,
            positionCode: assignment.positionCode,
            memberId: assignment.memberId,
            expectedVersion: assignment.version,
          });
          if (cancelled) return;
          setPending((prev) => {
            const next = new Map(prev);
            next.delete(seatKey);
            return next;
          });
        } catch {
          // Leave it queued - the next reconnect (or a future retry trigger) will try again.
          // A stale version will surface as a 409 through the same assign() path once the
          // officer is back online and can see/resolve it interactively.
        }
      }
      if (!cancelled) {
        const board = await repository.getRidingBoard(dispatchId).catch(() => null);
        if (board && !cancelled) setApparatus(board.apparatus);
      }
    };

    void flush();
    return () => {
      cancelled = true;
    };
  }, [isOnline, dispatchId, repository]);

  const memberById = new Map(roster.map((entry) => [entry.memberId, entry]));
  const assignable = roster.filter(
    (entry) => entry.ackStatus === 'RESPONDING' || entry.ackStatus === 'DIRECT_TO_SCENE',
  );

  const assign = async (
    unitId: string,
    positionCode: string,
    memberId: string,
    version: number,
  ) => {
    const seatKey = `${unitId}#${positionCode}`;
    setOpenSeat(null);
    if (!isOnline) {
      setPending((prev) => {
        const next = new Map(prev);
        next.set(seatKey, { unitId, positionCode, memberId, version });
        return next;
      });
      return;
    }
    try {
      await repository.assignRidingSeat(dispatchId, {
        unitId,
        positionCode,
        memberId,
        expectedVersion: version,
      });
      setConflict(null);
      const board = await repository.getRidingBoard(dispatchId);
      setApparatus(board.apparatus);
    } catch (error) {
      // Every error used to collapse into one hardcoded "reassigned by another officer" message,
      // which mislabels a genuine network/auth/server failure as a version conflict during an
      // active incident. Branch on the actual problem status so the officer sees what really
      // happened, and reserve the reassignment-conflict copy for an actual 409.
      if (error instanceof ApiError) {
        if (error.problem.status === 401) {
          setSessionExpired(true);
          setConflict('Your session has expired. Sign in again to continue assigning seats.');
        } else if (error.problem.status === 403) {
          setConflict('You are not authorized to assign riding-board seats.');
        } else if (error.problem.status === 409) {
          setConflict(`${unitId} / ${positionCode} was reassigned by another officer. Refreshed.`);
        } else {
          setConflict(error.problem.detail ?? 'Could not update the assignment. Refreshed.');
        }
      } else {
        setConflict('Could not reach the server. Check your connection and try again.');
      }
      const board = await repository.getRidingBoard(dispatchId).catch(() => null);
      if (board) setApparatus(board.apparatus);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      {conflict ? (
        <Text
          accessibilityRole="alert"
          style={{ color: tokens.error, padding: spacing.sm, fontSize: typography.size.sm }}
        >
          {conflict}
        </Text>
      ) : null}
      {staleSince ? (
        <Text
          accessibilityRole="alert"
          style={{ color: tokens.warning, padding: spacing.sm, fontSize: typography.size.sm }}
        >
          {`Data stopped updating at ${formatClockTime(staleSince)} — retrying…`}
        </Text>
      ) : null}
      <FlatList
        data={apparatus}
        keyExtractor={(item) => item.apparatusId}
        contentContainerStyle={{ padding: spacing.lg }}
        renderItem={({ item: unit }) => (
          <View style={{ marginBottom: spacing.lg }}>
            <Text
              accessibilityRole="header"
              style={{
                color: tokens.foreground,
                fontSize: typography.size.base,
                fontWeight: '700',
              }}
            >
              {unit.unitId}
            </Text>
            {!unit.assignable ? (
              <Text style={{ color: tokens.error, fontSize: typography.size.sm }}>
                Out of service{unit.outOfServiceReason ? `: ${unit.outOfServiceReason}` : ''}
              </Text>
            ) : null}
            {unit.positions.map((position) => {
              const seatKey = `${unit.unitId}#${position.code}`;
              const assignedMember = position.assignment
                ? memberById.get(position.assignment.memberId)
                : undefined;
              const isPending = pending.has(seatKey);
              return (
                <View key={position.code} style={{ marginTop: spacing.sm }}>
                  <Text style={{ color: tokens.foreground, fontSize: typography.size.sm }}>
                    {position.label}:{' '}
                    {position.assignment
                      ? (assignedMember?.name ?? position.assignment.memberId)
                      : 'Unassigned'}
                    {position.assignment?.qualStatus === 'UNMET' ? ' · Missing qualification' : ''}
                    {isPending ? ' · Pending sync' : ''}
                  </Text>
                  {unit.assignable && !sessionExpired ? (
                    <TouchableOpacity
                      accessibilityRole="button"
                      onPress={() =>
                        setOpenSeat({ unitId: unit.unitId, positionCode: position.code })
                      }
                      style={{
                        marginTop: spacing.xs,
                        minHeight: touchTarget.baseline.ios,
                        justifyContent: 'center',
                        paddingHorizontal: spacing.sm,
                        borderRadius: radius.default,
                        borderWidth: 1,
                        borderColor: tokens.foreground + '33',
                        alignSelf: 'flex-start',
                      }}
                    >
                      <Text style={{ color: tokens.accent, fontSize: typography.size.sm }}>
                        Assign
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                  {openSeat?.unitId === unit.unitId && openSeat.positionCode === position.code ? (
                    <View style={{ marginTop: spacing.xs }}>
                      {assignable.map((member) => (
                        <TouchableOpacity
                          key={member.memberId}
                          accessibilityRole="button"
                          onPress={() =>
                            void assign(
                              unit.unitId,
                              position.code,
                              member.memberId,
                              position.assignment?.version ?? 0,
                            )
                          }
                          style={{ minHeight: touchTarget.baseline.ios, justifyContent: 'center' }}
                        >
                          <Text style={{ color: tokens.foreground, fontSize: typography.size.sm }}>
                            {member.name}
                            {member.ackStatus === 'DIRECT_TO_SCENE' ? ' (direct to scene)' : ''}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        )}
      />
    </SafeAreaView>
  );
}
