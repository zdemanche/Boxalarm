import { palette, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import Config from 'react-native-config';
import { FlatList, Text, TouchableOpacity, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useOptionalAuth } from '../../auth/AuthContext';
import { getNotifications, markNotificationRead } from '../../features/training/api';
import type { NotificationItem } from '../../features/training/types';

export function InboxScreen() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const canFetch = Boolean(auth?.isAuthenticated && apiBaseUrl);

  useEffect(() => {
    let cancelled = false;
    if (!canFetch || !auth) return;
    setLoadError(null);
    getNotifications(auth, apiBaseUrl!)
      .then((result) => {
        if (!cancelled) setItems(result);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError('Notifications could not be loaded. Check your connection and try again.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [canFetch, auth, apiBaseUrl]);

  const onOpen = async (item: NotificationItem) => {
    if (!auth || !apiBaseUrl || item.readAt) return;
    await markNotificationRead(auth, apiBaseUrl, item.notificationId);
    setItems((prev) =>
      prev.map((n) =>
        n.notificationId === item.notificationId ? { ...n, readAt: Date.now() } : n,
      ),
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      {loadError ? (
        <Text
          accessibilityRole="alert"
          style={{
            color: tokens.error,
            fontSize: typography.size.sm,
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.md,
          }}
        >
          {loadError}
        </Text>
      ) : null}
      <FlatList
        data={items}
        keyExtractor={(item) => item.notificationId}
        contentContainerStyle={{ padding: spacing.lg }}
        ListEmptyComponent={
          <Text style={{ color: tokens.foreground, opacity: 0.7 }}>No notifications.</Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            accessibilityRole="button"
            onPress={() => void onOpen(item)}
            style={{
              minHeight: touchTarget.baseline.ios,
              justifyContent: 'center',
              paddingVertical: spacing.md,
              borderBottomWidth: 1,
              borderBottomColor: tokens.foreground + '22',
            }}
          >
            <Text
              style={{
                color: tokens.foreground,
                fontSize: typography.size.base,
                fontWeight: item.readAt ? '400' : '700',
              }}
            >
              {item.summary}
            </Text>
            <Text style={{ color: tokens.foreground, opacity: 0.7, fontSize: typography.size.sm }}>
              {item.category} · {item.readAt ? 'Read' : 'Unread'}
            </Text>
          </TouchableOpacity>
        )}
      />
    </SafeAreaView>
  );
}
