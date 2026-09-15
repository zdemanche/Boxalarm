import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useNavigation, useRoute, type NavigationProp } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  ScrollView,
  Text,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { mockChecksRepository } from '../../features/checks/mockChecksRepository';
import type { ChecklistTemplate, ItemResult } from '../../features/checks/types';
import type { ChecksStackParamList } from '../../navigation/ChecksStack';

// N4.2: the whole point of this screen is that no step waits on a network round trip - every
// pass/fail tap is a local, instant state update, and "Complete check" resolves the same way
// (mockChecksRepository.submitChecklistRun is optimistic, matching @boxalarm/core's eventual
// outbox-backed contract).
export function CheckRunnerScreen() {
  const route = useRoute();
  const navigation = useNavigation<NavigationProp<ChecksStackParamList>>();
  const apparatusId = (route.params as { apparatusId: string }).apparatusId;
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const [template, setTemplate] = useState<ChecklistTemplate | null>(null);
  const [results, setResults] = useState<Record<string, boolean>>({});
  const [startedAt] = useState(() => Date.now());
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    mockChecksRepository.getChecklistTemplate(apparatusId).then((result) => {
      if (!cancelled) setTemplate(result);
    });
    return () => {
      cancelled = true;
    };
  }, [apparatusId]);

  if (!template) {
    return <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }} />;
  }

  const allAnswered = template.items.every((item) => item.code in results);

  const handleComplete = () => {
    const itemResults: ItemResult[] = template.items.map((item) => ({
      code: item.code,
      pass: results[item.code] ?? false,
    }));
    const durationSeconds = Math.round((Date.now() - startedAt) / 1000);
    void mockChecksRepository.submitChecklistRun({
      apparatusId,
      templateId: template.templateId,
      durationSeconds,
      itemResults,
    });
    // Optimistic: the local write already happened above; the UI confirms immediately rather
    // than waiting on any promise settling.
    setCompleted(true);
    // The confirmation replaces the whole screen, so a screen-reader user needs an explicit
    // announcement - there's no visible element left to shift focus onto naturally.
    AccessibilityInfo.announceForAccessibility('Check complete');
  };

  if (completed) {
    return (
      <SafeAreaView
        style={{
          flex: 1,
          backgroundColor: tokens.background,
          alignItems: 'center',
          justifyContent: 'center',
          padding: spacing.lg,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{ color: tokens.success, fontSize: typography.size.lg, fontWeight: '700' }}
        >
          Check complete
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => navigation.navigate('DefectReport', { apparatusId })}
          style={{
            alignSelf: 'flex-end',
            marginBottom: spacing.md,
            minHeight: touchTarget.baseline.ios,
            justifyContent: 'center',
          }}
        >
          <Text style={{ color: tokens.error, fontSize: typography.size.sm, fontWeight: '600' }}>
            Report a defect
          </Text>
        </TouchableOpacity>
        {template.items.map((item) => {
          const answer = results[item.code];
          return (
            <View
              key={item.code}
              style={{
                marginBottom: spacing.md,
                paddingBottom: spacing.md,
                borderBottomWidth: 1,
                borderBottomColor: tokens.foreground + '22',
              }}
            >
              <Text
                style={{
                  color: tokens.foreground,
                  fontSize: typography.size.base,
                  marginBottom: spacing.sm,
                }}
              >
                {item.label}
              </Text>
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => setResults((prev) => ({ ...prev, [item.code]: true }))}
                  style={{
                    flex: 1,
                    minHeight: touchTarget.oversized.ios,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: radius.default,
                    backgroundColor: answer === true ? tokens.success : tokens.foreground + '11',
                  }}
                >
                  <Text
                    style={{
                      color: answer === true ? tokens.background : tokens.foreground,
                      fontWeight: '600',
                    }}
                  >
                    Pass
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={() => setResults((prev) => ({ ...prev, [item.code]: false }))}
                  style={{
                    flex: 1,
                    minHeight: touchTarget.oversized.ios,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: radius.default,
                    backgroundColor: answer === false ? tokens.error : tokens.foreground + '11',
                  }}
                >
                  <Text
                    style={{
                      color: answer === false ? tokens.background : tokens.foreground,
                      fontWeight: '600',
                    }}
                  >
                    Fail
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        })}
        {allAnswered && (
          <TouchableOpacity
            accessibilityRole="button"
            onPress={handleComplete}
            style={{
              minHeight: touchTarget.oversized.ios,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: tokens.accent,
              borderRadius: radius.default,
              marginTop: spacing.md,
            }}
          >
            <Text
              style={{
                color: tokens.background,
                fontSize: typography.size.base,
                fontWeight: '700',
              }}
            >
              Complete check
            </Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
