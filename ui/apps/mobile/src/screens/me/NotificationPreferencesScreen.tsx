import { palette, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import Config from 'react-native-config';
import { ScrollView, Switch, Text, View, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useOptionalAuth } from '../../auth/AuthContext';
import { getNotificationPreferences, putNotificationPreference } from '../../features/training/api';
import type { NotificationPreference } from '../../features/training/types';

const CERT_EXPIRY_CATEGORY = 'CERT_EXPIRY';

export function NotificationPreferencesScreen() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const [preferences, setPreferences] = useState<NotificationPreference[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!auth?.isAuthenticated || !apiBaseUrl) return;
    getNotificationPreferences(auth, apiBaseUrl).then((result) => {
      if (!cancelled) setPreferences(result);
    });
    return () => {
      cancelled = true;
    };
  }, [auth, apiBaseUrl]);

  const certExpiry = preferences.find((p) => p.category === CERT_EXPIRY_CATEGORY) ?? {
    category: CERT_EXPIRY_CATEGORY,
    channels: { push: true, email: true },
  };

  const togglePush = async (value: boolean) => {
    if (!auth || !apiBaseUrl) return;
    const next = { ...certExpiry.channels, push: value };
    setPreferences((prev) => [
      ...prev.filter((p) => p.category !== CERT_EXPIRY_CATEGORY),
      { category: CERT_EXPIRY_CATEGORY, channels: next },
    ]);
    await putNotificationPreference(auth, apiBaseUrl, CERT_EXPIRY_CATEGORY, next);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <ScrollView contentContainerStyle={{ padding: spacing.lg }}>
        <View
          style={{
            minHeight: touchTarget.baseline.ios,
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Text style={{ color: tokens.foreground, fontSize: typography.size.base }}>
            Certification expiry
          </Text>
          <Switch
            accessibilityLabel="Certification expiry push notifications"
            value={certExpiry.channels.push}
            onValueChange={(value) => void togglePush(value)}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
