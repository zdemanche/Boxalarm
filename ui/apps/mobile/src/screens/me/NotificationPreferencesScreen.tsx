import { spacing, targetSize, typeScale } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import Config from 'react-native-config';
import { Switch, Text, View } from 'react-native';
import { useOptionalAuth } from '../../auth/AuthContext';
import { Button, Card, Screen, useTheme } from '../../components/ui';
import { preferencesFor } from '../../features/notifications/categories';
import { getNotificationPreferences, putNotificationPreference } from '../../features/training/api';
import type { NotificationPreference } from '../../features/training/types';
import { ROW_TITLE_SIZE, Rows } from './MeRows';

// Stored channels are MUTES (notification-service repository.ts) - true means that channel is
// muted for the category - so each switch shows the inverse. No stored row: nothing is muted.
const UNMUTED: NotificationPreference['channels'] = { push: false, email: false };

export function NotificationPreferencesScreen() {
  const theme = useTheme();
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const [preferences, setPreferences] = useState<NotificationPreference[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!auth?.isAuthenticated || !apiBaseUrl) return;
    setLoadError(null);
    getNotificationPreferences(auth, apiBaseUrl)
      .then((result) => {
        if (cancelled) return;
        setPreferences(result);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError(
            'Notification preferences could not be loaded. Check your connection and try again.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [auth, apiBaseUrl, loadAttempt]);

  const channelsFor = (category: string) =>
    preferences.find((p) => p.category === category)?.channels ?? UNMUTED;

  const togglePush = async (category: string, enabled: boolean) => {
    if (!auth || !apiBaseUrl || !loaded) return;
    const previous = channelsFor(category);
    const next = { ...previous, push: !enabled };
    const withChannels = (channels: NotificationPreference['channels']) =>
      setPreferences((prev) => [
        ...prev.filter((p) => p.category !== category),
        { category, channels },
      ]);
    setSaveError(null);
    withChannels(next);
    try {
      await putNotificationPreference(auth, apiBaseUrl, category, next);
    } catch {
      // Revert the optimistic toggle: the member must not believe a reminder was muted or
      // unmuted when nothing was saved (PR #321 review M11).
      withChannels(previous);
      setSaveError('Your change was not saved. Check your connection and try again.');
    }
  };

  const alertText = { color: theme.status.danger, fontSize: typeScale.body.size };
  const note = { color: theme.fgMuted, fontSize: typeScale.body.size };

  return (
    <Screen>
      {saveError || loadError ? (
        <Card>
          {saveError ? (
            <Text accessibilityRole="alert" style={alertText}>
              {saveError}
            </Text>
          ) : null}
          {loadError ? (
            <Text accessibilityRole="alert" style={alertText}>
              {loadError}
            </Text>
          ) : null}
          {loadError ? (
            <Button label="Try again" onPress={() => setLoadAttempt((attempt) => attempt + 1)} />
          ) : null}
        </Card>
      ) : null}
      <Card title="Push reminders">
        <Text style={note}>
          Muting push still delivers the reminder to your inbox. Dispatch alerts cannot be muted
          here.
        </Text>
        {auth?.roles.includes('TRAINING') ? (
          <Text style={note}>
            As a training officer you also get the department-wide certification-expiry digest; it
            cannot be muted. The switch below covers only your own certifications.
          </Text>
        ) : null}
        <Rows>
          {preferencesFor(auth?.roles ?? []).map(({ category, label }) => (
            <View
              key={category}
              style={{
                minHeight: targetSize.field,
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: spacing.md,
                paddingVertical: spacing.sm,
              }}
            >
              <Text
                style={{ flex: 1, color: theme.fg, fontSize: ROW_TITLE_SIZE, fontWeight: '600' }}
              >
                {label}
              </Text>
              <Switch
                accessibilityLabel={`${label} push notifications`}
                value={!channelsFor(category).push}
                disabled={!loaded}
                onValueChange={(value) => void togglePush(category, value)}
                trackColor={{ false: theme.border, true: theme.indicator }}
                ios_backgroundColor={theme.border}
              />
            </View>
          ))}
        </Rows>
      </Card>
    </Screen>
  );
}
