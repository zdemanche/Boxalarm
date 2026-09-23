import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useRoute } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { FlatList, Text, TouchableOpacity, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import type { RidingBoardApparatus, RosterEntry } from '../../features/alerts/types';
import { useConnectivity } from '../../sync/ConnectivityContext';

const REFETCH_INTERVAL_MS = 10_000;

// E1-S18-UI: the officer's riding board. Members come from the response roster (name, quals,
// ETA, direct-to-scene distinction); seats come from apparatus-service's riding board. The
// member's own one-tap response flow (AlertDetailScreen) is untouched by this screen.
export function RidingBoardScreen() {
  const route = useRoute();
  const { dispatchId } = route.params as { dispatchId: string };
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const { isOnline } = useConnectivity();
  const repository = useAlertsRepository();
  const [apparatus, setApparatus] = useState<RidingBoardApparatus[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [openSeat, setOpenSeat] = useState<{ unitId: string; positionCode: string } | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [conflict, setConflict] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      repository.getRidingBoard(dispatchId).then((board) => {
        if (!cancelled) setApparatus(board.apparatus);
      });
      repository.getRoster(dispatchId).then((result) => {
        if (!cancelled) setRoster(result);
      });
    };
    load();
    const interval = setInterval(load, REFETCH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [dispatchId, repository]);

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
      setPending((prev) => new Set(prev).add(seatKey));
      return;
    }
    try {
      await repository.assignRidingSeat(dispatchId, {
        unitId,
        positionCode,
        memberId,
        expectedVersion: version,
      });
      const board = await repository.getRidingBoard(dispatchId);
      setApparatus(board.apparatus);
    } catch {
      setConflict(`${unitId} / ${positionCode} was reassigned by another officer. Refreshed.`);
      const board = await repository.getRidingBoard(dispatchId);
      setApparatus(board.apparatus);
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
                  {unit.assignable ? (
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
