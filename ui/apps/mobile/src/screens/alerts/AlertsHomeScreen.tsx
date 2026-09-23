import { palette, radius, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useNavigation, type NavigationProp } from '@react-navigation/native';
import { Text, TouchableOpacity, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useOptionalAuth } from '../../auth/AuthContext';
import type { AlertsStackParamList } from '../../navigation/AlertsStack';

// E1-S1-UI: officer-only degraded-mode fallback for when no CAD feed exists or it is down
// (N1.8). Self-test moved to the Me tab (E1-S8-UI) - one real flow, not two entry points.
export function AlertsHomeScreen() {
  const navigation = useNavigation<NavigationProp<AlertsStackParamList>>();
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const auth = useOptionalAuth();
  const canEnterManually = (auth?.roles ?? []).some(
    (role) => role === 'OFFICER' || role === 'CHIEF',
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background, padding: spacing.lg }}>
      <Text
        accessibilityRole="header"
        style={{ color: tokens.foreground, fontSize: typography.size.lg, fontWeight: '700' }}
      >
        Alerts
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
        Active dispatches appear here as they come in.
      </Text>
      {canEnterManually ? (
        <View>
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => navigation.navigate('ManualEntry')}
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
              style={{
                color: tokens.background,
                fontSize: typography.size.base,
                fontWeight: '600',
              }}
            >
              Enter dispatch manually
            </Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </SafeAreaView>
  );
}
