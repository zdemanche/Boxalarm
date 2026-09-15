import {
  elevation,
  palette,
  radius,
  spacing,
  touchTarget,
  typography,
} from '@boxalarm/design-tokens';
import { Component, useEffect, useRef, useState, type ElementRef, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  SafeAreaView,
  StatusBar,
  Text,
  TouchableOpacity,
  View,
  useColorScheme,
} from 'react-native';
import { AuthProvider, useAuth, type Role } from './auth/AuthContext';

const ROLE_PRIORITY: readonly Role[] = [
  'CHIEF',
  'ADMIN',
  'OFFICER',
  'TRAINING',
  'APPARATUS',
  'MEMBER',
];

const ROLE_LABEL: Record<Role, string> = {
  CHIEF: 'Chief dashboard',
  ADMIN: 'Admin dashboard',
  OFFICER: 'Officer dashboard',
  TRAINING: 'Training dashboard',
  APPARATUS: 'Apparatus dashboard',
  MEMBER: 'Member dashboard',
};

function primaryRole(roles: Role[]): Role {
  return ROLE_PRIORITY.find((role) => roles.includes(role)) ?? 'MEMBER';
}

class ConfigErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <View
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg }}
        >
          <Text accessibilityRole="header" style={{ fontSize: 20, marginBottom: spacing.md }}>
            Boxalarm can&apos;t start
          </Text>
          <Text>
            Sign-in configuration is missing or invalid. Contact your department administrator.
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

function SignInScreen() {
  const { signIn } = useAuth();
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
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
        style={{
          color: tokens.foreground,
          fontSize: typography.size.display,
          fontWeight: '700',
          marginBottom: spacing.xs,
        }}
      >
        Boxalarm
      </Text>
      <Text
        style={{
          color: tokens.foreground,
          opacity: 0.7,
          fontSize: typography.size.base,
          marginBottom: spacing.xl,
        }}
      >
        Nichols Fire Department
      </Text>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Sign in"
        onPress={handleSignIn}
        style={{
          minWidth: 240,
          minHeight: touchTarget.baseline.ios,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: spacing.xl,
          paddingVertical: spacing.md,
          backgroundColor: tokens.accent,
          borderRadius: radius.default,
          shadowColor: '#000000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: elevation.level1.shadowOpacity,
          shadowRadius: elevation.level1.shadowRadius,
          elevation: elevation.level1.androidElevation,
        }}
      >
        <Text style={{ color: tokens.background, fontSize: typography.size.lg, fontWeight: '600' }}>
          Sign in
        </Text>
      </TouchableOpacity>
      {error && (
        <Text
          ref={errorRef}
          accessible
          style={{ color: tokens.error, fontSize: typography.size.sm, marginTop: spacing.md }}
        >
          {error}
        </Text>
      )}
    </SafeAreaView>
  );
}

function LandingScreen() {
  const { roles } = useAuth();
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const role = primaryRole(roles);

  return (
    <SafeAreaView
      style={{
        flex: 1,
        backgroundColor: tokens.background,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        accessibilityRole="header"
        style={{ color: tokens.foreground, fontSize: typography.size.xl, fontWeight: '700' }}
      >
        {ROLE_LABEL[role]}
      </Text>
    </SafeAreaView>
  );
}

function Root() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) return <View style={{ flex: 1 }} />;
  return isAuthenticated ? <LandingScreen /> : <SignInScreen />;
}

export function App() {
  return (
    <ConfigErrorBoundary>
      <AuthProvider>
        <StatusBar barStyle="default" />
        <Root />
      </AuthProvider>
    </ConfigErrorBoundary>
  );
}
