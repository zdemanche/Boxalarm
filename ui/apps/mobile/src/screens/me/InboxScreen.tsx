import { spacing, targetSize, typeScale } from '@boxalarm/design-tokens';
import { useNavigation } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import Config from 'react-native-config';
import { Text, TouchableOpacity, View } from 'react-native';
import { useOptionalAuth } from '../../auth/AuthContext';
import { Card, Screen, useTheme } from '../../components/ui';
import { categoryLabel, itemText } from '../../features/notifications/categories';
import { getNotifications, markNotificationRead } from '../../features/training/api';
import type { NotificationItem } from '../../features/training/types';
import { ROW_TITLE_SIZE, Rows } from './MeRows';

/** Items shown per row before "+N more"; the web inbox lists them all. */
const ITEMS_SHOWN = 3;

/** A PPE reminder about the viewer's own gear links to My PPE, the one reminder page on mobile. */
function isOwnPpe(item: NotificationItem, memberId: string | null | undefined): boolean {
  return (
    item.category === 'ppe-expiry' &&
    Boolean(memberId) &&
    (item.items ?? []).some((i) => i.link?.kind === 'member' && i.link.id === memberId)
  );
}

export function InboxScreen() {
  const theme = useTheme();
  const auth = useOptionalAuth();
  const navigation = useNavigation();
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

  const small = { color: theme.fg, fontSize: typeScale.body.size };

  return (
    <Screen>
      {loadError ? (
        <Card>
          <Text
            accessibilityRole="alert"
            style={{ color: theme.status.danger, fontSize: typeScale.body.size }}
          >
            {loadError}
          </Text>
        </Card>
      ) : null}
      <Card>
        {items.length === 0 ? (
          <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
            No notifications.
          </Text>
        ) : (
          <Rows>
            {items.map((item) => {
              const title = categoryLabel(item.category);
              const lines = (item.items ?? []).map(itemText);
              const shown = lines.slice(0, ITEMS_SHOWN);
              return (
                <View key={item.notificationId} style={{ paddingVertical: spacing.xs }}>
                  <TouchableOpacity
                    accessibilityRole="button"
                    // An explicit label replaces the children's text for screen readers, so it must
                    // carry the due items themselves, not just the category and count.
                    accessibilityLabel={[
                      `${item.readAt ? '' : 'Unread: '}${title}, ${item.summary}`,
                      ...shown,
                      ...(lines.length > shown.length
                        ? [`and ${lines.length - shown.length} more`]
                        : []),
                    ].join('. ')}
                    accessibilityHint={item.readAt ? undefined : 'Marks this notification read'}
                    onPress={() => void onOpen(item)}
                    style={{
                      minHeight: targetSize.field,
                      justifyContent: 'center',
                      paddingVertical: spacing.sm,
                      gap: 2,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                      {item.readAt ? null : (
                        // The unread mark (docs/design.md §2 amendment: selection marks), beside
                        // the word "Unread" - never the mark alone.
                        <View
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 5,
                            backgroundColor: theme.indicator,
                          }}
                        />
                      )}
                      <Text
                        style={{
                          flex: 1,
                          color: theme.fg,
                          fontSize: ROW_TITLE_SIZE,
                          fontWeight: item.readAt ? '500' : '700',
                        }}
                      >
                        {title}
                        {item.readAt ? '' : ' · Unread'}
                      </Text>
                    </View>
                    <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
                      {item.summary}
                    </Text>
                    {shown.map((line, index) => (
                      <Text key={`${item.notificationId}-${index}`} style={small}>
                        {line}
                      </Text>
                    ))}
                    {lines.length > shown.length ? (
                      <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
                        +{lines.length - shown.length} more
                      </Text>
                    ) : null}
                  </TouchableOpacity>
                  {isOwnPpe(item, auth?.memberId) ? (
                    <TouchableOpacity
                      accessibilityRole="link"
                      onPress={() => navigation.navigate('MyPpe' as never)}
                      style={{ minHeight: targetSize.field, justifyContent: 'center' }}
                    >
                      <Text
                        style={{
                          color: theme.accent,
                          fontSize: ROW_TITLE_SIZE,
                          fontWeight: '600',
                          textDecorationLine: 'underline',
                        }}
                      >
                        View my PPE
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              );
            })}
          </Rows>
        )}
      </Card>
    </Screen>
  );
}
