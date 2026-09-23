import { spacing, typeScale } from '@boxalarm/design-tokens';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { useState } from 'react';
import { Text } from 'react-native';
import { Button, Screen, useTheme } from '../../components/ui';
import { mockAlertsRepository } from '../../features/alerts/mockAlertsRepository';
import type { AlertsStackParamList } from '../../navigation/AlertsStack';

// F1.10: self-test reuses the real alert payload/fan-out shape, so this entry point produces a
// real DispatchAlert the member can view, respond to, and see the roster/tone-ladder for -
// exercising the same screens the dispatch-received path will use once backend access lands.
export function AlertsHomeScreen() {
  const navigation = useNavigation<NavigationProp<AlertsStackParamList>>();
  const theme = useTheme();
  const [sending, setSending] = useState(false);

  const handleSelfTest = () => {
    setSending(true);
    mockAlertsRepository.triggerSelfTest().then((result) => {
      setSending(false);
      navigation.navigate('AlertDetail', { dispatchId: result.dispatchId });
    });
  };

  return (
    <Screen scroll={false}>
      <Text
        accessibilityRole="header"
        style={{ color: theme.fg, fontSize: typeScale.title.size, fontWeight: '700' }}
      >
        Self-test
      </Text>
      <Text
        style={{
          color: theme.fgMuted,
          fontSize: typeScale.body.size,
          marginTop: spacing.sm,
          marginBottom: spacing.lg,
        }}
      >
        Send a test alert to confirm your phone will page correctly, then respond to it the same way
        you would a real dispatch.
      </Text>
      <Button
        label={sending ? 'Sending...' : 'Send test alert'}
        onPress={handleSelfTest}
        disabled={sending}
      />
    </Screen>
  );
}
