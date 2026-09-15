import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useNavigation, useRoute, type NavigationProp } from '@react-navigation/native';
import { useEffect, useState } from 'react';
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
import { ackStatusLabel } from '../../features/alerts/ackStatus';
import { mockAlertsRepository } from '../../features/alerts/mockAlertsRepository';
import type { AckStatus, DispatchAlert } from '../../features/alerts/types';
import type { AlertsStackParamList } from '../../navigation/AlertsStack';

type RespondUiState = 'unanswered' | 'entering_eta' | 'answered';

export function AlertDetailScreen() {
  const navigation = useNavigation<NavigationProp<AlertsStackParamList>>();
  const route = useRoute();
  const { dispatchId } = route.params as { dispatchId: string };
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const [dispatch, setDispatch] = useState<DispatchAlert | null>(null);
  const [respondState, setRespondState] = useState<RespondUiState>('unanswered');
  const [answeredAs, setAnsweredAs] = useState<AckStatus | null>(null);
  const [eta, setEta] = useState('');

  useEffect(() => {
    let cancelled = false;
    mockAlertsRepository.getDispatch(dispatchId).then((result) => {
      if (!cancelled) setDispatch(result);
    });
    return () => {
      cancelled = true;
    };
  }, [dispatchId]);

  if (!dispatch) {
    return <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }} />;
  }

  const submitResponse = (ackStatus: AckStatus, etaValue?: string) => {
    void mockAlertsRepository.submitResponse(dispatchId, ackStatus, etaValue || undefined);
    // Optimistic (N4.2): confirm immediately rather than waiting on the round trip to settle.
    setAnsweredAs(ackStatus);
    setRespondState('answered');
    // The Responding/Not responding buttons disappear in favor of a confirmation line - a
    // screen-reader user swiping past that spot wouldn't otherwise notice the change happened.
    AccessibilityInfo.announceForAccessibility(`You responded: ${ackStatusLabel(ackStatus)}`);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        <Text
          accessibilityRole="header"
          style={{ color: tokens.foreground, fontSize: typography.size.lg, fontWeight: '700' }}
        >
          {dispatch.type}
        </Text>
        <Text style={{ color: tokens.foreground, fontSize: typography.size.base, marginTop: 2 }}>
          {dispatch.address}
        </Text>
        <Text
          style={{
            color: tokens.foreground,
            opacity: 0.7,
            fontSize: typography.size.sm,
            marginTop: spacing.xs,
          }}
        >
          {dispatch.notes}
        </Text>

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

        <View style={{ marginTop: spacing.lg }}>
          {respondState === 'unanswered' && (
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <TouchableOpacity
                accessibilityRole="button"
                onPress={() => setRespondState('entering_eta')}
                style={{
                  flex: 1,
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
                onPress={() => submitResponse('NOT_RESPONDING')}
                style={{
                  flex: 1,
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

          {respondState === 'entering_eta' && (
            <View>
              <TextInput
                value={eta}
                onChangeText={setEta}
                placeholder="ETA (optional)"
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
                onPress={() => submitResponse('RESPONDING', eta)}
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
