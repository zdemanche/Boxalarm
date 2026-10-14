import {
  radiusScale,
  spacing,
  statusPalette,
  targetSize,
  typeScale,
  typography,
} from '@boxalarm/design-tokens';
import { useEffect, useRef, useState, type ElementRef } from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  Linking,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../auth/AuthContext';
import { buildForgotPasswordUrl } from '../auth/config';
import { Button, useTheme } from '../components/ui';

/** The first screen a member sees, and the one place the product is named: the dark frame
 * (header and tab bar colours) in both palettes, the wordmark, and one amber action within thumb
 * reach. It sits under no stack header, so it owns every safe-area edge itself. */
export function SignInScreen() {
  const { signIn } = useAuth();
  const { shell } = useTheme();
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<ElementRef<typeof Text>>(null);

  useEffect(() => {
    if (!error) return;
    const handle = findNodeHandle(errorRef.current);
    if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
  }, [error]);

  const handleSignIn = () => {
    setError(null);
    signIn().catch(() => {
      const message = 'Sign-in could not be started. Check your connection and try again.';
      setError(message);
      AccessibilityInfo.announceForAccessibility(message);
    });
  };

  const handleForgotPassword = () => {
    setError(null);
    try {
      const url = buildForgotPasswordUrl();
      Linking.openURL(url).catch(() => {
        const message =
          'Password recovery could not be started. Check your connection and try again.';
        setError(message);
        AccessibilityInfo.announceForAccessibility(message);
      });
    } catch {
      const message =
        'Password recovery could not be started. Check your connection and try again.';
      setError(message);
      AccessibilityInfo.announceForAccessibility(message);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: shell.bg }}>
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: spacing.lg,
        }}
      >
        <Text
          accessibilityRole="header"
          style={{
            color: shell.fg,
            fontSize: typography.size.display,
            fontWeight: '800',
            letterSpacing: -1,
          }}
        >
          Boxalarm
        </Text>
        <View
          accessible={false}
          style={{
            width: spacing.xl,
            height: spacing.xs,
            borderRadius: radiusScale.pill,
            backgroundColor: shell.accent,
            marginVertical: spacing.md,
          }}
        />
        <Text style={{ color: shell.fgMuted, fontSize: typeScale.heading.size }}>
          Nichols Fire Department
        </Text>
      </View>
      <View
        style={{
          width: '100%',
          maxWidth: 480,
          alignSelf: 'center',
          gap: spacing.sm,
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.xl,
        }}
      >
        <Button label="Sign in" accessibilityLabel="Sign in" fullWidth onPress={handleSignIn} />
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Forgot password"
          onPress={handleForgotPassword}
          style={{
            minHeight: targetSize.field,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: spacing.lg,
            borderRadius: radiusScale.lg,
            borderWidth: 1,
            borderColor: shell.border,
            backgroundColor: shell.bgRaised,
          }}
        >
          <Text style={{ color: shell.fg, fontSize: typeScale.label.size, fontWeight: '700' }}>
            Forgot password
          </Text>
        </TouchableOpacity>
        {error && (
          <Text
            ref={errorRef}
            accessible
            style={{
              // The frame is dark in both palettes, so the error takes the dark palette's red.
              color: statusPalette.cab.danger,
              fontSize: typeScale.body.size,
              marginTop: spacing.sm,
              textAlign: 'center',
            }}
          >
            {error}
          </Text>
        )}
      </View>
    </SafeAreaView>
  );
}
