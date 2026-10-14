import {
  radiusScale,
  spacing,
  targetSize,
  typeScale,
  type StatusRole,
} from '@boxalarm/design-tokens';
import { useRoute } from '@react-navigation/native';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Text, TextInput, View } from 'react-native';
import { useOptionalAuth } from '../../auth/AuthContext';
import { Button, Card, Screen, StatusChip, useTheme } from '../../components/ui';
import { useScheduleRepository } from '../../features/schedule/apiScheduleRepository';
import type { DutyShift } from '../../features/schedule/types';
import { ApiError } from '../../lib/apiClient';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';
import { NoCachedDataError } from '../../sync/readThrough';
import { formatShiftWindow } from './ShiftBoardScreen';

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

// Glyph + word + colour (design.md §2.3): an empty seat is hollow, a filled one solid, a claim in
// flight is "sending", and losing the race is a caution - never the alarm red.
const STATE_ROLE: Record<ClaimUiState, StatusRole> = {
  open: 'neutral',
  pending: 'info',
  claimed_by_you: 'ok',
  claimed_by_other: 'ok',
  already_taken: 'caution',
};

/** Field rows: primary text 17/600 (docs/design.md §1 field body). */
const ROW_TITLE_SIZE = 17;

export function ShiftDetailScreen() {
  const route = useRoute();
  const shiftId = (route.params as { shiftId: string }).shiftId;
  const theme = useTheme();
  const repository = useScheduleRepository();
  const { isOnline } = useOptionalConnectivity();
  const auth = useOptionalAuth();
  const [shift, setShift] = useState<DutyShift | null>(null);
  const [claimState, setClaimState] = useState<Record<string, ClaimUiState>>({});
  const [swapTargetMemberId, setSwapTargetMemberId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Generated once per claim intent (in handleClaim) and reused verbatim by every resolveClaim
  // call for that intent, including the reconnect-resubmit retry below - a value regenerated per
  // attempt (as this used to be, inline in apiScheduleRepository.ts) cannot function as an
  // idempotency key across retries.
  const claimIdempotencyKeys = useRef(new Map<string, string>());

  useEffect(() => {
    let cancelled = false;
    repository
      .getShift(shiftId)
      .then((found) => {
        if (cancelled) return;
        setShift(found);
        const initial: Record<string, ClaimUiState> = {};
        for (const position of found.positions) {
          // claimedByMe (server-computed, handleGetShift) takes priority over comparing ids
          // client-side: a position this member already holds from a previous session must
          // read "Claimed by you" on load, not the generic "Claimed" of claimed_by_other, or
          // give-back/propose-swap would be offered with no explanation of why.
          if (position.claimedByMe) {
            initial[position.positionCode] = 'claimed_by_you';
          } else if (position.claimedByMemberId) {
            initial[position.positionCode] = 'claimed_by_other';
          } else {
            initial[position.positionCode] = 'open';
          }
        }
        setClaimState(initial);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof NoCachedDataError) {
          setLoadError("You're offline, and this phone hasn't loaded this shift yet.");
        } else if (e instanceof ApiError && e.problem.status === 404) {
          setLoadError('This shift is no longer on the schedule.');
        } else {
          setLoadError('This shift could not be loaded. Check your connection and try again.');
        }
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
    repository
      .claimPosition(shiftId, positionCode, idempotencyKey)
      .catch((e: unknown) => {
        // Nothing was claimed. Never leave the row saying "Pending..." or promise a retry this
        // screen can't keep (review m5): back to Open, with the reason. A lost connection keeps
        // the idempotency key, so tapping Claim again can't double-book if the first one landed.
        setClaimState((prev) => ({ ...prev, [positionCode]: 'open' }));
        if (!(e instanceof ApiError)) {
          const message =
            'Not claimed: the connection dropped. When you have signal, tap Claim again.';
          setError(message);
          AccessibilityInfo.announceForAccessibility(message);
          return null;
        }
        claimIdempotencyKeys.current.delete(positionCode);
        const message = describeError(
          e,
          'You do not have access to claim this position.',
          'The shift was not claimed. Try again.',
        );
        setError(message);
        AccessibilityInfo.announceForAccessibility(message);
        return null;
      })
      .then((result) => {
        if (result === null) return;
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
    setError(null);
    if (!isOnline) {
      // Claiming is atomic on the server (F2.9) and can't be queued; say so instead of showing
      // "Pending" for a claim nothing will send (review m5).
      const message =
        "Not claimed: you need a connection to claim a shift - claiming has to be instant so two people can't take the same one.";
      setError(message);
      AccessibilityInfo.announceForAccessibility(message);
      return;
    }
    setClaimState((prev) => ({ ...prev, [positionCode]: 'pending' }));
    if (!claimIdempotencyKeys.current.has(positionCode)) {
      claimIdempotencyKeys.current.set(
        positionCode,
        `${shiftId}#${positionCode}#${Date.now()}#${Math.random().toString(36).slice(2)}`,
      );
    }
    resolveClaim(positionCode);
  };

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
    return (
      <Screen>
        <Card>
          <Text
            accessibilityRole={loadError ? 'alert' : undefined}
            style={{
              color: loadError ? theme.status.danger : theme.fgMuted,
              fontSize: typeScale.body.size,
            }}
          >
            {loadError ?? 'Loading shift…'}
          </Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      {error ? (
        <Card>
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, fontSize: typeScale.body.size, fontWeight: '600' }}
          >
            {error}
          </Text>
        </Card>
      ) : null}
      <Card>
        <Text style={{ color: theme.fg, fontSize: ROW_TITLE_SIZE, fontWeight: '600' }}>
          {shift.stationId}
        </Text>
        <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
          {formatShiftWindow(shift.startAt, shift.endAt)}
        </Text>
      </Card>
      <Card title="Positions">
        <View>
          {shift.positions.map((position, index) => {
            const state = claimState[position.positionCode] ?? 'open';
            const isMine =
              state === 'claimed_by_you' ||
              position.claimedByMe === true ||
              position.claimedByMemberId === auth?.memberId;
            return (
              <View
                key={position.positionCode}
                style={{
                  minHeight: targetSize.field,
                  gap: spacing.md,
                  paddingVertical: spacing.md,
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderTopColor: theme.borderDecorative,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                  <View style={{ flex: 1, gap: spacing.sm }}>
                    <Text style={{ color: theme.fg, fontSize: ROW_TITLE_SIZE, fontWeight: '600' }}>
                      {position.positionCode}
                    </Text>
                    <View accessibilityLiveRegion={state === 'already_taken' ? 'polite' : 'none'}>
                      <StatusChip status={STATE_ROLE[state]} label={STATE_LABEL[state]} />
                    </View>
                  </View>
                  {state === 'open' && (
                    <Button label="Claim" onPress={() => handleClaim(position.positionCode)} />
                  )}
                </View>
                {isMine && (
                  <View style={{ gap: spacing.sm }}>
                    <Button
                      label="Give back"
                      variant="secondary"
                      fullWidth
                      onPress={() => handleGiveBack(position.positionCode)}
                    />
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                      <TextInput
                        accessibilityLabel="Propose swap to member ID"
                        placeholder="Member ID"
                        placeholderTextColor={theme.fgFaint}
                        value={swapTargetMemberId}
                        onChangeText={setSwapTargetMemberId}
                        style={{
                          flex: 1,
                          minHeight: targetSize.field,
                          borderWidth: 1,
                          borderColor: theme.border,
                          borderRadius: radiusScale.lg,
                          backgroundColor: theme.surface,
                          paddingHorizontal: spacing.md,
                          color: theme.fg,
                          fontSize: ROW_TITLE_SIZE,
                        }}
                      />
                      <Button
                        label="Propose swap"
                        variant="secondary"
                        onPress={() => handleProposeSwap(position.positionCode)}
                      />
                    </View>
                  </View>
                )}
              </View>
            );
          })}
        </View>
      </Card>
    </Screen>
  );
}
