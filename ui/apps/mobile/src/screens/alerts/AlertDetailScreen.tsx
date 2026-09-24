import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useNavigation, useRoute, type NavigationProp } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  Linking,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAlertsRepository } from '../../features/alerts/apiAlertsRepository';
import { ackStatusLabel } from '../../features/alerts/ackStatus';
import { PrePlanPanel } from '../../features/alerts/PrePlanPanel';
import type { AckStatus, DispatchAlert } from '../../features/alerts/types';
import type { AlertsStackParamList } from '../../navigation/AlertsStack';

type RespondUiState = 'unanswered' | 'entering_eta' | 'answered';

export function AlertDetailScreen() {
  const navigation = useNavigation<NavigationProp<AlertsStackParamList>>();
  const route = useRoute();
  const { dispatchId } = route.params as { dispatchId: string };
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const repository = useAlertsRepository();
  const [dispatch, setDispatch] = useState<DispatchAlert | null>(null);
  const [respondState, setRespondState] = useState<RespondUiState>('unanswered');
  const [pendingAckStatus, setPendingAckStatus] = useState<AckStatus | null>(null);
  const [answeredAs, setAnsweredAs] = useState<AckStatus | null>(null);
  const [eta, setEta] = useState('');

  useEffect(() => {
    let cancelled = false;
    repository.getDispatch(dispatchId).then((result) => {
      if (!cancelled) setDispatch(result);
    });
    return () => {
      cancelled = true;
    };
  }, [dispatchId, repository]);

  if (!dispatch) {
    return <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }} />;
  }

  // Alert-path guarantee: response buttons are live as soon as the dispatch renders; tapping one
  // confirms visually immediately (optimistic, N4.2) and never waits on the round trip.
  const submitResponse = (ackStatus: AckStatus, etaMinutesValue?: number) => {
    setAnsweredAs(ackStatus);
    setRespondState('answered');
    AccessibilityInfo.announceForAccessibility(`You responded: ${ackStatusLabel(ackStatus)}`);
    void repository.submitResponse(dispatchId, ackStatus, etaMinutesValue);
  };

  const beginResponse = (ackStatus: AckStatus) => {
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
          {dispatch.incidentType}
        </Text>
        <Text style={{ color: tokens.foreground, fontSize: typography.size.base, marginTop: 2 }}>
          {dispatch.address}
        </Text>
        {dispatch.crossStreets ? (
          <Text
            style={{
              color: tokens.foreground,
              opacity: 0.7,
              fontSize: typography.size.sm,
              marginTop: 2,
            }}
          >
            Cross streets: {dispatch.crossStreets}
          </Text>
        ) : null}
        {dispatch.mapLink ? (
          <TouchableOpacity
            accessibilityRole="link"
            onPress={() => void Linking.openURL(dispatch.mapLink as string)}
            style={{ marginTop: spacing.xs }}
          >
            <Text style={{ color: tokens.accent, fontSize: typography.size.sm }}>Open in maps</Text>
          </TouchableOpacity>
        ) : null}
        <Text
          style={{
            color: tokens.foreground,
            opacity: 0.7,
            fontSize: typography.size.sm,
            marginTop: spacing.xs,
          }}
        >
          {dispatch.narrative}
        </Text>

        {dispatch.toneLadder ? (
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
          {respondState === 'unanswered' && (
            <View style={{ flexDirection: 'row', gap: spacing.md, flexWrap: 'wrap' }}>
              <TouchableOpacity
                accessibilityRole="button"
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

          {respondState === 'answered' && answeredAs && (
            <Text style={{ color: tokens.foreground, fontSize: typography.size.base }}>
              You responded: {ackStatusLabel(answeredAs)}
            </Text>
          )}
        </View>

        <PrePlanPanel prePlan={dispatch.prePlan} />

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
