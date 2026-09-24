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
import { ApiError } from '../../lib/apiClient';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';

// Mirrors ProfileEditScreen's error-handling pattern: a 403 gets its own message, everything
// else (offline, 409, 500) gets a generic retry prompt, shown on screen and announced for a
// screen-reader user who isn't focused on this row when the result lands.
function describeError(e: unknown, forbiddenMessage: string, fallbackMessage: string): string {
  return e instanceof ApiError && e.problem.status === 403 ? forbiddenMessage : fallbackMessage;
}

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
  const [error, setError] = useState<string | null>(null);
  const pendingClaims = useRef(new Set<string>());
  // Generated once per claim intent (in handleClaim) and reused verbatim by every resolveClaim
  // call for that intent, including the reconnect-resubmit retry below - a value regenerated per
  // attempt (as this used to be, inline in apiScheduleRepository.ts) cannot function as an
  // idempotency key across retries.
  const claimIdempotencyKeys = useRef(new Map<string, string>());

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
    const idempotencyKey = claimIdempotencyKeys.current.get(positionCode);
    repository.claimPosition(shiftId, positionCode, idempotencyKey).then((result) => {
      pendingClaims.current.delete(positionCode);
      claimIdempotencyKeys.current.delete(positionCode);
      // ALREADY_MINE (this member already holds it - e.g. a reconnect resubmit of a claim that
      // actually succeeded before the connection dropped) reads the same as a fresh CLAIMED:
      // only ALREADY_TAKEN (someone else holds it) is the honest "you lost this one" outcome.
      const next: ClaimUiState = result === 'ALREADY_TAKEN' ? 'already_taken' : 'claimed_by_you';
      setClaimState((prev) => ({ ...prev, [positionCode]: next }));
      // Pending resolves in place (no screen swap), so a screen-reader user focused elsewhere
      // wouldn't otherwise notice the outcome land.
      AccessibilityInfo.announceForAccessibility(STATE_LABEL[next]);
    });
  };

  const handleClaim = (positionCode: string) => {
    setClaimState((prev) => ({ ...prev, [positionCode]: 'pending' }));
    if (!claimIdempotencyKeys.current.has(positionCode)) {
      claimIdempotencyKeys.current.set(
        positionCode,
        `${shiftId}#${positionCode}#${Date.now()}#${Math.random().toString(36).slice(2)}`,
      );
    }
    if (!isOnline) {
      // Claiming is not queueable server-side (must be atomic, no double-booking) - the pending
      // claim is retried in full once connectivity returns, in resolveClaim's onSuccess path,
      // reusing the idempotency key generated just above.
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
    setError(null);
    repository
      .releasePosition?.(shiftId, positionCode)
      .then(() => {
        setClaimState((prev) => ({ ...prev, [positionCode]: 'open' }));
        AccessibilityInfo.announceForAccessibility('Given back');
      })
      .catch((e: unknown) => {
        const message = describeError(
          e,
          'You do not have access to give back this position.',
          'Could not give back this position. Try again.',
        );
        setError(message);
        AccessibilityInfo.announceForAccessibility(message);
      });
  };

  const handleProposeSwap = (positionCode: string) => {
    if (!swapTargetMemberId.trim()) return;
    setError(null);
    repository
      .proposeSwap?.(shiftId, positionCode, swapTargetMemberId.trim())
      .then(() => {
        setSwapTargetMemberId('');
        AccessibilityInfo.announceForAccessibility('Swap proposed, pending approval');
      })
      .catch((e: unknown) => {
        const message = describeError(
          e,
          'You do not have access to propose this swap.',
          'Could not propose swap. Try again.',
        );
        setError(message);
        AccessibilityInfo.announceForAccessibility(message);
      });
  };

  if (!shift) {
    return <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }} />;
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        {error ? (
          <Text
            accessibilityRole="alert"
            style={{
              color: tokens.error,
              marginBottom: spacing.md,
              fontSize: typography.size.sm,
            }}
          >
            {error}
          </Text>
        ) : null}
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
