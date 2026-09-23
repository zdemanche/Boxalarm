import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { useState } from 'react';
import { Text, TouchableOpacity, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { mockAlertsRepository } from '../../features/alerts/mockAlertsRepository';
import type { AlertsStackParamList } from '../../navigation/AlertsStack';

// F1.10: self-test reuses the real alert payload/fan-out shape, so this entry point produces a
// real DispatchAlert the member can view, respond to, and see the roster/tone-ladder for -
// exercising the same screens the dispatch-received path will use once backend access lands.
export function AlertsHomeScreen() {
  const navigation = useNavigation<NavigationProp<AlertsStackParamList>>();
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const [sending, setSending] = useState(false);

  const handleSelfTest = () => {
    setSending(true);
    mockAlertsRepository.triggerSelfTest().then((result) => {
      setSending(false);
      navigation.navigate('AlertDetail', { dispatchId: result.dispatchId });
    });
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background, padding: spacing.lg }}>
      <Text
        accessibilityRole="header"
        style={{ color: tokens.foreground, fontSize: typography.size.lg, fontWeight: '700' }}
      >
        Self-test
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
        Send a test alert to confirm your phone will page correctly, then respond to it the same way
        you would a real dispatch.
      </Text>
      <View>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={handleSelfTest}
          disabled={sending}
          style={{
            minHeight: touchTarget.baseline.ios,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: tokens.accent,
            borderRadius: radius.default,
            paddingHorizontal: spacing.lg,
            opacity: sending ? 0.6 : 1,
          }}
        >
          <Text
            style={{ color: tokens.background, fontSize: typography.size.base, fontWeight: '600' }}
          >
            {sending ? 'Sending...' : 'Send test alert'}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
