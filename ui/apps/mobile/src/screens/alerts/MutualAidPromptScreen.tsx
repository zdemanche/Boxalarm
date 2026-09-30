import { radius, spacing, typeScale } from '@boxalarm/design-tokens';
import { useNavigation, useRoute, type NavigationProp } from '@react-navigation/native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, AppState, Platform, Text, TextInput, View } from 'react-native';
import { useOptionalAuth, type Role } from '../../auth/AuthContext';
import { Button, Screen, useTheme } from '../../components/ui';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import type { AlertPayload } from '../../features/alerts/alertPayload';
import { isDeviceLocked, setAlertShowsOverLockScreen } from '../../features/alerts/alertReadiness';
import { silenceMutualAidNotification } from '../../features/alerts/pushNotificationDisplay';
import type { MutualAid } from '../../features/alerts/types';
import { ApiError } from '../../lib/apiClient';
import type { AlertsStackParamList } from '../../navigation/AlertsStack';

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
      if (status === 'background') setAlertShowsOverLockScreen(false);
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
      setCall({ incidentType: dispatch.incidentType, address: dispatch.address });
      setMutualAid(dispatch.mutualAid);
      // Another officer already confirmed the call: nothing is left to act on, so it stops
      // ringing and no longer shows over the lock screen.
      if (dispatch.mutualAid?.acknowledgedAt != null && !releasedRef.current) {
        releasedRef.current = true;
        silence();
        setAlertShowsOverLockScreen(false);
      }
    } catch (loadError) {
      console.warn('[mutual-aid] reading the dispatch failed', loadError);
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
      <View onTouchStart={silence}>
        <Text
          accessibilityRole="header"
          style={{
            color: theme.status.danger,
            fontSize: typeScale.title.size,
            fontWeight: '700',
            marginBottom: spacing.sm,
          }}
        >
          MUTUAL AID REQUESTED
        </Text>
        {call.incidentType || call.address ? (
          <Text style={{ color: theme.fg, fontSize: typeScale.heading.size, fontWeight: '600' }}>
            {[call.incidentType, call.address].filter(Boolean).join(' — ')}
          </Text>
        ) : null}
        <Text
          style={{ color: theme.fg, fontSize: typeScale.body.size, marginVertical: spacing.md }}
        >
          Boxalarm does not page the neighboring department. Call them now, then confirm here so the
          other officers know it is done.
        </Text>

        {mutualAid === undefined ? (
          <Text accessibilityRole="text" style={{ color: theme.fg, fontSize: typeScale.body.size }}>
            Checking whether the call has been confirmed…
          </Text>
        ) : acknowledged ? (
          <Text
            accessibilityRole="summary"
            style={{ color: theme.fg, fontSize: typeScale.body.size, fontWeight: '600' }}
          >
            Call confirmed at {formatTime(mutualAid.acknowledgedAt)}
            {mutualAid.acknowledgedBy ? ` by ${mutualAid.acknowledgedBy}` : ''}
            {mutualAid.notes ? `: ${mutualAid.notes}` : '.'}
          </Text>
        ) : (
          <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
            {mutualAid
              ? `Requested at ${formatTime(mutualAid.triggeredAt)}. The call has not been confirmed yet.`
              : 'The server shows no mutual-aid request for this call yet.'}
          </Text>
        )}

        {!acknowledged && canConfirm ? (
          <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
            <Text style={{ color: theme.fg }}>
              Notes (optional) - who you spoke to, what they are sending
            </Text>
            <TextInput
              accessibilityLabel="Mutual-aid notes"
              value={notes}
              onChangeText={setNotes}
              maxLength={MAX_NOTES_LENGTH}
              multiline
              style={{
                minHeight: 80,
                borderWidth: 1,
                borderColor: theme.borderStrong,
                borderRadius: radius.default,
                padding: spacing.sm,
                color: theme.fg,
              }}
            />
            <Button
              label={saving ? 'Confirming…' : 'I made the mutual-aid call'}
              onPress={() => void confirm()}
              disabled={saving}
            />
          </View>
        ) : null}
        {!acknowledged && !canConfirm && mutualAid !== undefined ? (
          <Text style={{ color: theme.fg, marginTop: spacing.md }}>
            Only an officer can confirm the call.
          </Text>
        ) : null}

        {error ? (
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, marginTop: spacing.md }}
          >
            {error}
          </Text>
        ) : null}

        <View style={{ marginTop: spacing.lg }}>
          <Button
            label="Open the call"
            variant="secondary"
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
        </View>
      </View>
    </Screen>
  );
}
