import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useNavigation, useRoute, type NavigationProp } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import {
  Linking,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useOptionalAuth } from '../../auth/AuthContext';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import type { AlertPayload } from '../../features/alerts/alertPayload';
import { setAlertShowsOverLockScreen } from '../../features/alerts/alertReadiness';
import { silenceDispatchNotification } from '../../features/alerts/pushNotificationDisplay';
import { PrePlanPanel } from '../../features/alerts/PrePlanPanel';
import type { ResponseAnswer } from '../../features/alerts/alertResponses';
import { ResponseStatus } from '../../features/alerts/ResponseStatus';
import { useAlertDetail, type DetailFailure } from '../../features/alerts/useAlertDetail';
import { useAlertResponse } from '../../features/alerts/useAlertResponse';
import { useOptionalConnectivity } from '../../sync/ConnectivityContext';
import type { AlertsStackParamList } from '../../navigation/AlertsStack';

// a11y-spec N1 Error: the reassurance is required - a visible failure next to an address makes a
// member doubt the address.
function failureText(failure: DetailFailure, hasAddress: boolean): string {
  const reassurance = hasAddress
    ? ' The address above came with the page and is correct.'
    : ' Your response buttons still work.';
  switch (failure) {
    case 'refused':
      return `The server refused to show this call's details.${reassurance}`;
    case 'server':
      return `The server couldn't load this call's details right now.${reassurance}`;
    case 'timeout':
    case 'unreachable':
      return `We couldn't load the call details - no answer from the server.${reassurance}`;
  }
}

type RespondUiState = 'choosing' | 'entering_eta';

export function AlertDetailScreen() {
  const navigation = useNavigation<NavigationProp<AlertsStackParamList>>();
  const route = useRoute();
  const { dispatchId, payload } = route.params as { dispatchId: string; payload?: AlertPayload };
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const repository = useAlertsRepository();
  const {
    header,
    detail: dispatch,
    detailCachedAt,
    status,
    failure,
    retry,
  } = useAlertDetail(repository, dispatchId, payload);
  const auth = useOptionalAuth();
  const { isOnline } = useOptionalConnectivity();
  const response = useAlertResponse(repository, dispatchId, auth?.memberId ?? null, isOnline);
  const [respondState, setRespondState] = useState<RespondUiState>('choosing');

  // The call is open: stop the looping alarm. Leaving the alert (another tab, back, a pushed
  // screen) ends its show-over-lock-screen, so the rest of the app is not open on a locked phone.
  useEffect(() => {
    void silenceDispatchNotification(dispatchId);
    const unsubscribeBlur = navigation.addListener?.('blur', () =>
      setAlertShowsOverLockScreen(false),
    );
    return () => {
      unsubscribeBlur?.();
      setAlertShowsOverLockScreen(false);
    };
  }, [dispatchId, navigation]);
  const [pendingAckStatus, setPendingAckStatus] = useState<ResponseAnswer | null>(null);
  const [eta, setEta] = useState('');

  // Never blank (design.md F-01): the page payload paints the header, the response buttons are
  // live at first paint, and the detail fetch only enriches. A tap saves the answer on the phone
  // (outbox) and the status below says exactly whether it has reached the server.
  const submitResponse = (ackStatus: ResponseAnswer, etaMinutesValue?: number) => {
    setRespondState('choosing');
    void response.respond(ackStatus, etaMinutesValue);
  };

  const beginResponse = (ackStatus: ResponseAnswer) => {
    if (ackStatus === 'NOT_RESPONDING') {
      submitResponse(ackStatus);
      return;
    }
    setPendingAckStatus(ackStatus);
    setRespondState('entering_eta');
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        <Text
          accessibilityRole="header"
          style={{ color: tokens.foreground, fontSize: typography.size.lg, fontWeight: '700' }}
        >
          {header?.incidentType ?? `Dispatch ${dispatchId}`}
        </Text>
        <Text style={{ color: tokens.foreground, fontSize: typography.size.base, marginTop: 2 }}>
          {header?.address ||
            (status === 'failed' ? 'Address not available' : 'Loading the address…')}
        </Text>
        {header?.crossStreets ? (
          <Text
            style={{
              color: tokens.foreground,
              opacity: 0.7,
              fontSize: typography.size.sm,
              marginTop: 2,
            }}
          >
            Cross streets: {header.crossStreets}
          </Text>
        ) : null}
        {dispatch?.mapLink ? (
          <TouchableOpacity
            accessibilityRole="link"
            onPress={() => void Linking.openURL(dispatch.mapLink as string)}
            style={{ marginTop: spacing.xs }}
          >
            <Text style={{ color: tokens.accent, fontSize: typography.size.sm }}>Open in maps</Text>
          </TouchableOpacity>
        ) : null}
        {dispatch ? (
          <Text
            style={{
              color: tokens.foreground,
              opacity: 0.7,
              fontSize: typography.size.sm,
              marginTop: spacing.xs,
            }}
          >
            {dispatch.narrative || 'No narrative was sent with this dispatch.'}
          </Text>
        ) : null}
        {status === 'loading' && !dispatch ? (
          <Text
            accessibilityLiveRegion="polite"
            style={{
              color: tokens.foreground,
              fontSize: typography.size.sm,
              marginTop: spacing.xs,
            }}
          >
            Loading the dispatch narrative…
          </Text>
        ) : null}
        {status === 'failed' && failure ? (
          <View
            accessibilityLiveRegion="polite"
            style={{
              marginTop: spacing.md,
              padding: spacing.md,
              borderRadius: radius.default,
              borderLeftWidth: 4,
              borderLeftColor: tokens.warning,
              backgroundColor: tokens.warning + '22',
            }}
          >
            <Text style={{ color: tokens.foreground, fontSize: typography.size.base }}>
              ▲ {failureText(failure, Boolean(header?.address))}
            </Text>
            {detailCachedAt ? (
              <Text
                style={{ color: tokens.foreground, fontSize: typography.size.sm, marginTop: 4 }}
              >
                Showing details saved on this phone at{' '}
                {new Date(detailCachedAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                .
              </Text>
            ) : null}
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Retry loading the call details"
              onPress={retry}
              style={{
                marginTop: spacing.sm,
                minHeight: 72,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: radius.default,
                borderWidth: 1,
                borderColor: tokens.foreground + '55',
              }}
            >
              <Text style={{ color: tokens.foreground, fontSize: typography.size.base }}>
                Retry
              </Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {dispatch?.toneLadder ? (
          <View
            style={{
              marginTop: spacing.lg,
              padding: spacing.md,
              borderRadius: radius.default,
              borderWidth: 1,
              borderColor: tokens.foreground + '22',
            }}
          >
            <Text style={{ color: tokens.foreground, fontSize: typography.size.sm, opacity: 0.7 }}>
              Tone {dispatch.toneLadder.currentToneSequence} / {dispatch.toneLadder.status}
            </Text>
            {dispatch.toneLadder.predicateGaps.map((gap) => (
              <Text
                key={gap}
                style={{ color: tokens.accent, fontSize: typography.size.sm, marginTop: 2 }}
              >
                {gap}
              </Text>
            ))}
          </View>
        ) : null}

        <View style={{ marginTop: spacing.lg }}>
          {response.answer && response.delivery ? (
            <View style={{ marginBottom: spacing.md }}>
              <ResponseStatus
                answer={response.answer}
                delivery={response.delivery}
                outboxId={response.outboxId}
                lastError={response.lastError}
                onResend={() =>
                  submitResponse(
                    response.answer!.ackStatus,
                    response.answer!.etaMinutes ?? undefined,
                  )
                }
              />
            </View>
          ) : null}
          {respondState === 'choosing' && (
            <View style={{ flexDirection: 'row', gap: spacing.md, flexWrap: 'wrap' }}>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{ selected: response.answer?.ackStatus === 'RESPONDING' }}
                onPress={() => beginResponse('RESPONDING')}
                style={{
                  flex: 1,
                  minWidth: 120,
                  minHeight: touchTarget.oversized.ios,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: tokens.success,
                  borderRadius: radius.default,
                }}
              >
                <Text
                  style={{
                    color: tokens.background,
                    fontSize: typography.size.base,
                    fontWeight: '600',
                  }}
                >
                  Responding
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{ selected: response.answer?.ackStatus === 'DIRECT_TO_SCENE' }}
                onPress={() => beginResponse('DIRECT_TO_SCENE')}
                style={{
                  flex: 1,
                  minWidth: 120,
                  minHeight: touchTarget.oversized.ios,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: tokens.accent,
                  borderRadius: radius.default,
                }}
              >
                <Text
                  style={{
                    color: tokens.background,
                    fontSize: typography.size.base,
                    fontWeight: '600',
                  }}
                >
                  Direct to scene
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{ selected: response.answer?.ackStatus === 'NOT_RESPONDING' }}
                onPress={() => beginResponse('NOT_RESPONDING')}
                style={{
                  flex: 1,
                  minWidth: 120,
                  minHeight: touchTarget.oversized.ios,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: tokens.error,
                  borderRadius: radius.default,
                }}
              >
                <Text
                  style={{
                    color: tokens.background,
                    fontSize: typography.size.base,
                    fontWeight: '600',
                  }}
                >
                  Not responding
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {respondState === 'entering_eta' && pendingAckStatus && (
            <View>
              <TextInput
                value={eta}
                onChangeText={setEta}
                placeholder="ETA in minutes"
                keyboardType="number-pad"
                placeholderTextColor={tokens.foreground + '88'}
                style={{
                  minHeight: touchTarget.baseline.ios,
                  borderWidth: 1,
                  borderColor: tokens.foreground + '33',
                  borderRadius: radius.default,
                  paddingHorizontal: spacing.md,
                  color: tokens.foreground,
                  fontSize: typography.size.base,
                }}
              />
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => submitResponse(pendingAckStatus, parseInt(eta, 10) || undefined)}
                style={{
                  marginTop: spacing.md,
                  minHeight: touchTarget.oversized.ios,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: tokens.accent,
                  borderRadius: radius.default,
                }}
              >
                <Text
                  style={{
                    color: tokens.background,
                    fontSize: typography.size.base,
                    fontWeight: '600',
                  }}
                >
                  Confirm
                </Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {dispatch ? (
          <PrePlanPanel
            prePlan={dispatch.prePlan}
            unavailable={dispatch.prePlanUnavailable === true}
            {...(dispatch.nearestHydrants ? { nearestHydrants: dispatch.nearestHydrants } : {})}
            hydrantsUnavailable={dispatch.nearestHydrantsUnavailable === true}
            hydrantsIncomplete={dispatch.nearestHydrantsIncomplete === true}
          />
        ) : null}

        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => navigation.navigate('Roster', { dispatchId })}
          style={{
            marginTop: spacing.lg,
            minHeight: touchTarget.baseline.ios,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: radius.default,
            borderWidth: 1,
            borderColor: tokens.foreground + '33',
          }}
        >
          <Text style={{ color: tokens.foreground, fontSize: typography.size.base }}>
            View roster
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}
