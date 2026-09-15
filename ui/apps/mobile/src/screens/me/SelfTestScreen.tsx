import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useState } from 'react';
import { Text, TouchableOpacity, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// F1.10: triggers a synthetic test dispatch through the same fan-out path as a real alert and
// surfaces a per-channel result. That path lives in alerting-service (boxalarm-backend), which
// this session has no access to yet - so the entry point is real, the round trip isn't.
export function SelfTestScreen() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const [message, setMessage] = useState<string | null>(null);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background, padding: spacing.lg }}>
      <Text
        accessibilityRole="header"
        style={{ color: tokens.foreground, fontSize: typography.size.lg, fontWeight: '700' }}
      >
        Test my alert path
      </Text>
      <Text
        style={{
          color: tokens.foreground,
          opacity: 0.7,
          fontSize: typography.size.base,
          marginTop: spacing.sm,
          marginBottom: spacing.lg,
        }}
      >
        Sends a synthetic dispatch through the same fan-out path as a real alert and shows what
        arrived on push, SMS, and voice.
      </Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Run self-test"
        onPress={() =>
          setMessage(
            'Self-test is not yet connected — this needs alerting-service to be reachable.',
          )
        }
        style={{
          minHeight: touchTarget.baseline.ios,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: tokens.accent,
          borderRadius: radius.default,
          paddingHorizontal: spacing.lg,
        }}
      >
        <Text
          style={{ color: tokens.background, fontSize: typography.size.base, fontWeight: '600' }}
        >
          Run self-test
        </Text>
      </TouchableOpacity>
      {message && (
        <View style={{ marginTop: spacing.lg }}>
          <Text accessible style={{ color: tokens.foreground, fontSize: typography.size.sm }}>
            {message}
          </Text>
        </View>
      )}
    </SafeAreaView>
  );
}
