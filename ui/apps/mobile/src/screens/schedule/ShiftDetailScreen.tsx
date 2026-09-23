import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useRoute } from '@react-navigation/native';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useOptionalAuth } from '../../auth/AuthContext';
import { useScheduleRepository } from '../../features/schedule/apiScheduleRepository';
import type { DutyShift } from '../../features/schedule/types';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';

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
  const repository = useScheduleRepository();
  const { isOnline } = useOptionalConnectivity();
  const auth = useOptionalAuth();
  const [shift, setShift] = useState<DutyShift | null>(null);
  const [claimState, setClaimState] = useState<Record<string, ClaimUiState>>({});
  const [swapTargetMemberId, setSwapTargetMemberId] = useState('');
  const pendingClaims = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    repository.getShifts().then((shifts) => {
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
  }, [shiftId, repository]);

  const STATE_LABEL: Record<ClaimUiState, string> = {
    open: 'Open',
    pending: 'Pending...',
    claimed_by_you: 'Claimed by you',
    claimed_by_other: 'Claimed',
    already_taken: 'Already taken',
  };

  const resolveClaim = (positionCode: string) => {
    setClaimState((prev) => ({ ...prev, [positionCode]: 'pending' }));
    repository.claimPosition(shiftId, positionCode).then((result) => {
      pendingClaims.current.delete(positionCode);
      const next: ClaimUiState = result === 'CLAIMED' ? 'claimed_by_you' : 'already_taken';
      setClaimState((prev) => ({ ...prev, [positionCode]: next }));
      // Pending resolves in place (no screen swap), so a screen-reader user focused elsewhere
      // wouldn't otherwise notice the outcome land.
      AccessibilityInfo.announceForAccessibility(STATE_LABEL[next]);
    });
  };

  const handleClaim = (positionCode: string) => {
    setClaimState((prev) => ({ ...prev, [positionCode]: 'pending' }));
    if (!isOnline) {
      // Claiming is not queueable server-side (must be atomic, no double-booking) - the pending
      // claim is retried in full once connectivity returns, in resolveClaim's onSuccess path.
      pendingClaims.current.add(positionCode);
      AccessibilityInfo.announceForAccessibility('Pending. Waiting for a connection.');
      return;
    }
    resolveClaim(positionCode);
  };

  // Reconnect: resubmit every claim that was queued while offline through the same claim call.
  useEffect(() => {
    if (!isOnline) return;
    for (const positionCode of pendingClaims.current) {
      resolveClaim(positionCode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  const handleGiveBack = (positionCode: string) => {
    repository.releasePosition?.(shiftId, positionCode).then(() => {
      setClaimState((prev) => ({ ...prev, [positionCode]: 'open' }));
      AccessibilityInfo.announceForAccessibility('Given back');
    });
  };

  const handleProposeSwap = (positionCode: string) => {
    if (!swapTargetMemberId.trim()) return;
    repository.proposeSwap?.(shiftId, positionCode, swapTargetMemberId.trim()).then(() => {
      setSwapTargetMemberId('');
      AccessibilityInfo.announceForAccessibility('Swap proposed, pending approval');
    });
  };

  if (!shift) {
    return <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }} />;
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        {shift.positions.map((position) => {
          const state = claimState[position.positionCode] ?? 'open';
          const isMine =
            state === 'claimed_by_you' || position.claimedByMemberId === auth?.memberId;
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
                  accessibilityLiveRegion={state === 'already_taken' ? 'polite' : 'none'}
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
              {isMine && (
                <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => handleGiveBack(position.positionCode)}
                    style={{
                      minHeight: touchTarget.baseline.ios,
                      paddingHorizontal: spacing.md,
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ color: tokens.foreground, fontSize: typography.size.sm }}>
                      Give back
                    </Text>
                  </TouchableOpacity>
                  <TextInput
                    accessibilityLabel="Propose swap to member ID"
                    placeholder="Member ID"
                    placeholderTextColor={tokens.foreground + '88'}
                    value={swapTargetMemberId}
                    onChangeText={setSwapTargetMemberId}
                    style={{
                      minHeight: touchTarget.baseline.ios,
                      borderWidth: 1,
                      borderColor: tokens.foreground + '33',
                      borderRadius: radius.default,
                      paddingHorizontal: spacing.sm,
                      color: tokens.foreground,
                      minWidth: 90,
                    }}
                  />
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => handleProposeSwap(position.positionCode)}
                    style={{
                      minHeight: touchTarget.baseline.ios,
                      paddingHorizontal: spacing.md,
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ color: tokens.accent, fontSize: typography.size.sm }}>
                      Propose swap
                    </Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}
