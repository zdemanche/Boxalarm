import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useRoute } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { mockScheduleRepository } from '../../features/schedule/mockScheduleRepository';
import type { DutyShift } from '../../features/schedule/types';

// F2.9: a claim made offline (or, here, mid-flight) is queued as PENDING in the UI, never shown
// as confirmed, until the server round trip either confirms or rejects it as already taken -
// architecture.md's explicit callout that this is the one workflow where offline-optimism would
// otherwise mislead a volunteer into believing a shift is theirs.
type ClaimUiState = 'open' | 'pending' | 'claimed_by_you' | 'claimed_by_other' | 'already_taken';

export function ShiftDetailScreen() {
  const route = useRoute();
  const shiftId = (route.params as { shiftId: string }).shiftId;
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const [shift, setShift] = useState<DutyShift | null>(null);
  const [claimState, setClaimState] = useState<Record<string, ClaimUiState>>({});

  useEffect(() => {
    let cancelled = false;
    mockScheduleRepository.getShifts().then((shifts) => {
      const found = shifts.find((s) => s.shiftId === shiftId) ?? null;
      if (cancelled || !found) return;
      setShift(found);
      const initial: Record<string, ClaimUiState> = {};
      for (const position of found.positions) {
        initial[position.positionCode] = position.claimedByMemberId ? 'claimed_by_other' : 'open';
      }
      setClaimState(initial);
    });
    return () => {
      cancelled = true;
    };
  }, [shiftId]);

  if (!shift) {
    return <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }} />;
  }

  const handleClaim = (positionCode: string) => {
    setClaimState((prev) => ({ ...prev, [positionCode]: 'pending' }));
    mockScheduleRepository.claimPosition(shiftId, positionCode).then((result) => {
      setClaimState((prev) => ({
        ...prev,
        [positionCode]: result === 'CLAIMED' ? 'claimed_by_you' : 'already_taken',
      }));
    });
  };

  const STATE_LABEL: Record<ClaimUiState, string> = {
    open: 'Open',
    pending: 'Pending…',
    claimed_by_you: 'Claimed by you',
    claimed_by_other: 'Claimed',
    already_taken: 'Already taken',
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        {shift.positions.map((position) => {
          const state = claimState[position.positionCode] ?? 'open';
          return (
            <View
              key={position.positionCode}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingVertical: spacing.md,
                borderBottomWidth: 1,
                borderBottomColor: tokens.foreground + '22',
              }}
            >
              <View>
                <Text
                  style={{
                    color: tokens.foreground,
                    fontSize: typography.size.base,
                    fontWeight: '600',
                  }}
                >
                  {position.positionCode}
                </Text>
                <Text
                  style={{
                    color: state === 'already_taken' ? tokens.error : tokens.foreground,
                    opacity: state === 'already_taken' ? 1 : 0.7,
                    fontSize: typography.size.sm,
                  }}
                >
                  {STATE_LABEL[state]}
                </Text>
              </View>
              {state === 'open' && (
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => handleClaim(position.positionCode)}
                  style={{
                    minHeight: touchTarget.baseline.ios,
                    paddingHorizontal: spacing.lg,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: tokens.accent,
                    borderRadius: radius.default,
                  }}
                >
                  <Text
                    style={{
                      color: tokens.background,
                      fontSize: typography.size.sm,
                      fontWeight: '600',
                    }}
                  >
                    Claim
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}
