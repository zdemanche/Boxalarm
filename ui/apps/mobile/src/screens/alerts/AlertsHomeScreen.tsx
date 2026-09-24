import { spacing, typeScale } from '@boxalarm/design-tokens';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { Text } from 'react-native';
import { useOptionalAuth } from '../../auth/AuthContext';
import { Button, Screen, useTheme } from '../../components/ui';
import type { AlertsStackParamList } from '../../navigation/AlertsStack';

// E1-S1-UI: officer-only degraded-mode fallback for when no CAD feed exists or it is down
// (N1.8). Self-test moved to the Me tab (E1-S8-UI) - one real flow, not two entry points.
export function AlertsHomeScreen() {
  const navigation = useNavigation<NavigationProp<AlertsStackParamList>>();
  const theme = useTheme();
  const auth = useOptionalAuth();
  const canEnterManually = (auth?.roles ?? []).some(
    (role) => role === 'OFFICER' || role === 'CHIEF',
  );

  return (
    <Screen scroll={false}>
      <Text
        accessibilityRole="header"
        style={{ color: theme.fg, fontSize: typeScale.title.size, fontWeight: '700' }}
      >
        Alerts
      </Text>
      <Text
        style={{
          color: theme.fgMuted,
          fontSize: typeScale.body.size,
          marginTop: spacing.sm,
          marginBottom: spacing.lg,
        }}
      >
        Active dispatches appear here as they come in.
      </Text>
      {canEnterManually ? (
        <Button label="Enter dispatch manually" onPress={() => navigation.navigate('ManualEntry')} />
      ) : null}
    </Screen>
  );
}
