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
import { useChecksRepository } from '../../features/checks/apiChecksRepository';
import type { ChecklistTemplate, ItemResult } from '../../features/checks/types';
import type { ChecksStackParamList } from '../../navigation/ChecksStack';

function newIdempotencyKey(): string {
  return `check-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// N4.2: the whole point of this screen is that no step waits on a network round trip - every
// pass/fail tap is a local, instant state update, and "Complete check" resolves the same way
// (the repository's submitChecklistRun is optimistic/local-first).
export function CheckRunnerScreen() {
  const route = useRoute();
  const navigation = useNavigation<NavigationProp<ChecksStackParamList>>();
  const apparatusId = (route.params as { apparatusId: string }).apparatusId;
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const repository = useChecksRepository();
  const [template, setTemplate] = useState<ChecklistTemplate | null>(null);
  const [results, setResults] = useState<Record<string, boolean>>({});
  const [photosCaptured, setPhotosCaptured] = useState<Record<string, boolean>>({});
  const [startedAt] = useState(() => Date.now());
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    repository.getChecklistTemplate(apparatusId).then((result) => {
      if (!cancelled) setTemplate(result);
    });
    return () => {
      cancelled = true;
    };
  }, [apparatusId, repository]);

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
    void repository.submitChecklistRun({
      apparatusId,
      templateId: template.templateId,
      durationSeconds,
      itemResults,
      idempotencyKey,
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
          const photoCaptured = photosCaptured[item.code] ?? false;
          const needsPhoto = item.requiresPhoto && !photoCaptured;
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
              {item.requiresPhoto ? (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={photoCaptured ? 'Photo captured' : 'Add photo'}
                  onPress={() => setPhotosCaptured((prev) => ({ ...prev, [item.code]: true }))}
                  style={{
                    minHeight: touchTarget.baseline.ios,
                    justifyContent: 'center',
                    marginBottom: spacing.sm,
                  }}
                >
                  <Text
                    style={{
                      color: photoCaptured ? tokens.success : tokens.accent,
                      fontSize: typography.size.sm,
                      fontWeight: '600',
                    }}
                  >
                    {photoCaptured ? 'Photo captured' : 'Add photo (required)'}
                  </Text>
                </TouchableOpacity>
              ) : null}
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <TouchableOpacity
                  accessibilityRole="button"
                  disabled={needsPhoto}
                  accessibilityState={{ disabled: needsPhoto }}
                  onPress={() => setResults((prev) => ({ ...prev, [item.code]: true }))}
                  style={{
                    flex: 1,
                    minHeight: touchTarget.oversized.ios,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: radius.default,
                    opacity: needsPhoto ? 0.5 : 1,
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
                  disabled={needsPhoto}
                  accessibilityState={{ disabled: needsPhoto }}
                  onPress={() => setResults((prev) => ({ ...prev, [item.code]: false }))}
                  style={{
                    flex: 1,
                    minHeight: touchTarget.oversized.ios,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: radius.default,
                    opacity: needsPhoto ? 0.5 : 1,
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
