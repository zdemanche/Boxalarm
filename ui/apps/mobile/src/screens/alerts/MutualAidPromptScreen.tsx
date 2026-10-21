import { radiusScale, spacing, typeScale } from '@boxalarm/design-tokens';
import { useNavigation, useRoute, type NavigationProp } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, AppState, Platform, Text, TextInput, View } from 'react-native';
import { useOptionalAuth, type Role } from '../../auth/AuthContext';
import { Button, Card, Screen, useTheme } from '../../components/ui';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import type { AlertPayload } from '../../features/alerts/alertPayload';
import { isDeviceLocked, setAlertShowsOverLockScreen } from '../../features/alerts/alertReadiness';
import { silenceMutualAidNotification } from '../../features/alerts/pushNotificationDisplay';
import type { MutualAid } from '../../features/alerts/types';
import { ApiError } from '../../lib/apiClient';
import type { AlertsStackParamList } from '../../navigation/AlertsStack';
import { LiveCard, LiveDot, Notice, noticeText } from './alertsUi';

/**
 * The roles the backend lets confirm the call: Cedar AcknowledgeMutualAid is granted to
 * ALERTING_OFFICER_GROUPS (infrastructure authz/cedar-policies.ts) - officer, chief and admin.
 * The server stays the authority; this only decides whether to offer the button.
 */
const CONFIRMING_ROLES: readonly Role[] = ['OFFICER', 'CHIEF', 'ADMIN'];
/** Matches the backend's MAX_NOTES_LENGTH (mutualAidAcknowledgeHandler.ts). */
const MAX_NOTES_LENGTH = 1000;

function formatTime(epochSeconds: number | null): string {
  if (epochSeconds === null) return 'an unknown time';
  return new Date(epochSeconds * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Why a confirmation was not saved, in words - never a silent failure. */
function confirmFailure(error: unknown): string {
  if (error instanceof ApiError) {
    const { status, detail } = error.problem;
    if (status === 409 && detail) return detail;
    if (status === 403) return 'Only an officer can confirm the mutual-aid call.';
  }
  return "Couldn't reach Boxalarm - your confirmation was not saved. Try again, or confirm on the web.";
}

/**
 * The officer's mutual-aid prompt (push alertKind mutual_aid_prompt, F1.13): a call's tone
 * ladder ran out or an officer requested mutual aid, and someone must phone the neighboring
 * department - Boxalarm does not page them. Opened from the prompt's own notification, never
 * the call's page, and separate from the alert screen, which has no mutual-aid action. Confirms
 * the call through POST .../mutual-aid/acknowledge; the first confirmation is the record.
 */
export function MutualAidPromptScreen() {
  const route = useRoute();
  const { dispatchId, payload } = route.params as { dispatchId: string; payload?: AlertPayload };
  const navigation = useNavigation<NavigationProp<AlertsStackParamList>>();
  const theme = useTheme();
  const repository = useAlertsRepository();
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;
  const roles = useOptionalAuth()?.roles ?? [];
  const canConfirm = roles.some((role) => CONFIRMING_ROLES.includes(role));
  // undefined: not read yet or unreadable; null: the server says none was requested.
  const [mutualAid, setMutualAid] = useState<MutualAid | null | undefined>(undefined);
  const [call, setCall] = useState({
    incidentType: payload?.incidentType ?? null,
    address: payload?.address ?? null,
  });
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The dispatch read failed while the state is still unknown - never an endless "Checking…".
  const [loadFailed, setLoadFailed] = useState(false);

  // Like a page (N-m8): shown over the lock screen and ringing until the officer acts on it - a
  // touch, or opening it unlocked. It stops showing over the lock screen once confirmed or when
  // the app is left.
  const silencedRef = useRef(false);
  // Confirmed (here or by another officer): nothing left to show over the lock screen.
  const releasedRef = useRef(false);
  const silence = useCallback(() => {
    if (silencedRef.current) return;
    silencedRef.current = true;
    void silenceMutualAidNotification(dispatchId);
  }, [dispatchId]);

  useEffect(() => {
    let cancelled = false;
    const onFocus = () => {
      if (!releasedRef.current) setAlertShowsOverLockScreen(true);
      if (AppState.currentState !== 'active') return;
      void isDeviceLocked().then((locked) => {
        if (!cancelled && locked === false) silence();
      });
    };
    onFocus();
    const unsubscribeFocus = navigation.addListener?.('focus', onFocus);
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'background' && navigationRef.current.isFocused?.() !== false) {
        setAlertShowsOverLockScreen(false);
      }
    });
    return () => {
      cancelled = true;
      unsubscribeFocus?.();
      subscription.remove();
    };
  }, [navigation, silence]);

  const load = useCallback(async () => {
    try {
      const dispatch = await repository.getDispatch(dispatchId);
      setLoadFailed(dispatch.mutualAid === undefined);
      setCall({ incidentType: dispatch.incidentType, address: dispatch.address });
      setMutualAid(dispatch.mutualAid);
      // Another officer already confirmed the call: nothing is left to act on, so it stops
      // ringing and no longer shows over the lock screen.
      if (dispatch.mutualAid?.acknowledgedAt != null && !releasedRef.current) {
        releasedRef.current = true;
        silence();
        if (navigationRef.current.isFocused?.() !== false) setAlertShowsOverLockScreen(false);
      }
    } catch (loadError) {
      console.warn('[mutual-aid] reading the dispatch failed', loadError);
      setLoadFailed(true);
    }
  }, [dispatchId, repository, silence]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirm = async () => {
    silence();
    // Anyone holding a locked phone could otherwise record "call made" and stop the officers
    // from making it: confirming is an officer's write, so it needs the phone unlocked.
    // Android: a lock state that cannot be read counts as locked. (iOS reports none - its prompt
    // only opens the app after an unlock.)
    const locked = await isDeviceLocked();
    if (locked === true || (locked === null && Platform.OS === 'android')) {
      const message = 'Unlock your phone to confirm the call.';
      setError(message);
      AccessibilityInfo.announceForAccessibility(message);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await repository.acknowledgeMutualAid(dispatchId, notes);
      setMutualAid(result.mutualAid);
      releasedRef.current = true;
      setAlertShowsOverLockScreen(false);
      AccessibilityInfo.announceForAccessibility('Mutual-aid call confirmed.');
    } catch (confirmError) {
      const message = confirmFailure(confirmError);
      setError(message);
      AccessibilityInfo.announceForAccessibility(message);
      // Another officer may have confirmed it: show what the server has.
      void load();
    } finally {
      setSaving(false);
    }
  };

  const acknowledged = mutualAid?.acknowledgedAt != null;

  return (
    <Screen>
      <View onTouchStart={silence} style={{ gap: spacing.md }}>
        {/* Rings like a page until acted on: the live-call edge. */}
        <LiveCard>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <LiveDot />
            <Text
              accessibilityRole="header"
              style={{
                flex: 1,
                color: theme.status.danger,
                fontSize: typeScale.title.size,
                lineHeight: typeScale.title.lineHeight,
                fontWeight: '800',
                letterSpacing: 0.5,
              }}
            >
              MUTUAL AID REQUESTED
            </Text>
          </View>
          {call.incidentType || call.address ? (
            <Text
              style={{
                color: theme.fg,
                fontSize: typeScale.title.size,
                lineHeight: typeScale.title.lineHeight,
                fontWeight: '700',
              }}
            >
              {[call.incidentType, call.address].filter(Boolean).join(' — ')}
            </Text>
          ) : null}
          <Text style={{ color: theme.fg, fontSize: 17, lineHeight: 24 }}>
            Boxalarm does not page the neighboring department. Call them now, then confirm here so
            the other officers know it is done.
          </Text>

          <View
            style={{
              gap: spacing.sm,
              marginTop: spacing.xs,
              paddingTop: spacing.sm,
              borderTopWidth: 1,
              borderTopColor: theme.borderDecorative,
            }}
          >
            {mutualAid === undefined ? (
              loadFailed ? (
                <>
                  <Notice tone="warning">
                    <Text accessibilityRole="alert" style={noticeText(theme, 'warning')}>
                      Couldn&apos;t check whether the call has been confirmed. Confirm below only if
                      you made the call yourself.
                    </Text>
                  </Notice>
                  <Button label="Check again" variant="secondary" onPress={() => void load()} />
                </>
              ) : (
                <Text
                  accessibilityRole="text"
                  style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}
                >
                  Checking whether the call has been confirmed…
                </Text>
              )
            ) : acknowledged ? (
              <Text
                accessibilityRole="summary"
                style={{ color: theme.fg, fontSize: 17, lineHeight: 24, fontWeight: '700' }}
              >
                Call confirmed at {formatTime(mutualAid.acknowledgedAt)}
                {mutualAid.acknowledgedBy ? ` by ${mutualAid.acknowledgedBy}` : ''}
                {mutualAid.notes ? `: ${mutualAid.notes}` : '.'}
              </Text>
            ) : (
              <Text style={{ color: theme.fg, fontSize: 17, lineHeight: 24, fontWeight: '600' }}>
                {mutualAid
                  ? `Requested at ${formatTime(mutualAid.triggeredAt)}. The call has not been confirmed yet.`
                  : 'The server shows no mutual-aid request for this call yet.'}
              </Text>
            )}
            {!acknowledged && !canConfirm && mutualAid !== undefined ? (
              <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
                Only an officer can confirm the call.
              </Text>
            ) : null}
          </View>
        </LiveCard>

        {!acknowledged && canConfirm ? (
          <Card>
            <Text style={{ color: theme.fg, fontSize: typeScale.body.size, fontWeight: '600' }}>
              Notes (optional) - who you spoke to, what they are sending
            </Text>
            <TextInput
              accessibilityLabel="Mutual-aid notes"
              value={notes}
              onChangeText={setNotes}
              maxLength={MAX_NOTES_LENGTH}
              multiline
              placeholderTextColor={theme.fgFaint}
              style={{
                minHeight: 96,
                borderWidth: 1,
                borderColor: theme.border,
                borderRadius: radiusScale.md,
                backgroundColor: theme.surface,
                padding: spacing.md,
                color: theme.fg,
                fontSize: 17,
                textAlignVertical: 'top',
              }}
            />
            {error ? (
              <Notice tone="warning">
                <Text accessibilityRole="alert" style={noticeText(theme, 'warning', true)}>
                  {error}
                </Text>
              </Notice>
            ) : null}
            <Button
              label={saving ? 'Confirming…' : 'I made the mutual-aid call'}
              onPress={() => void confirm()}
              disabled={saving}
              fullWidth
            />
          </Card>
        ) : error ? (
          <Notice tone="warning">
            <Text accessibilityRole="alert" style={noticeText(theme, 'warning', true)}>
              {error}
            </Text>
          </Notice>
        ) : null}

        <Card>
          <Button
            label="Open the call"
            variant="secondary"
            fullWidth
            onPress={() => {
              // The call's own page, not the prompt: the alert screen must not treat it as one.
              const callPayload = payload ? { ...payload } : undefined;
              if (callPayload) delete callPayload.mutualAidPrompt;
              navigation.navigate(
                'AlertDetail',
                callPayload ? { dispatchId, payload: callPayload } : { dispatchId },
              );
            }}
          />
        </Card>
      </View>
    </Screen>
  );
}
