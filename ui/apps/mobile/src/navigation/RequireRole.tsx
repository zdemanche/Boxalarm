import { palette, spacing, typography } from '@boxalarm/design-tokens';
import type { ReactElement } from 'react';
import { Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useOptionalAuth, type Role } from '../auth/AuthContext';

// Defense-in-depth only: AlertsHomeScreen already hides the "Enter dispatch manually" button
// for non-OFFICER/CHIEF roles, but that was client-side visibility alone - nothing stopped a
// deep link or programmatic navigation from reaching ManualEntry/RidingBoard directly. This
// mirrors the web's RequireRole (routing/RequireRole.tsx) at the navigator/screen level. The
// real boundary is server-side Cedar authorization on the corresponding POST endpoints - this
// guard only prevents the app from *offering* a flow the backend would reject anyway.
export function RequireRole({
  roles,
  children,
}: {
  roles: readonly Role[];
  children: ReactElement;
}) {
  const auth = useOptionalAuth();
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const allowed = (auth?.roles ?? []).some((role) => roles.includes(role));

  if (!allowed) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
        <View style={{ flex: 1, padding: spacing.lg, justifyContent: 'center' }}>
          <Text
            accessibilityRole="header"
            style={{ color: tokens.foreground, fontSize: typography.size.lg, fontWeight: '700' }}
          >
            Forbidden
          </Text>
          <Text
            style={{
              color: tokens.foreground,
              opacity: 0.7,
              fontSize: typography.size.base,
              marginTop: spacing.sm,
            }}
          >
            You do not have access to this screen.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return children;
}
