import { spacing, targetSize, typeScale } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import Config from 'react-native-config';
import { Text, TouchableOpacity, View } from 'react-native';
import { useOptionalAuth } from '../../auth/AuthContext';
import { Card, Screen, StatusChip, useTheme } from '../../components/ui';
import { getTrainingEvents, signUpForEvent } from '../../features/training/api';
import type { TrainingEvent } from '../../features/training/types';

/** Field rows: primary text 17/600 (docs/design.md §1 field body). */
const ROW_TITLE_SIZE = 17;

function formatEventTime(startAt: number): string {
  return new Date(startAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function TrainingEventsScreen() {
  const theme = useTheme();
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const [events, setEvents] = useState<TrainingEvent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!auth?.isAuthenticated || !apiBaseUrl) return;
    setLoadError(null);
    getTrainingEvents(auth, apiBaseUrl)
      .then((result) => {
        if (!cancelled) setEvents(result);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError('Training events could not be loaded. Check your connection and try again.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [auth, apiBaseUrl]);

  const onSignUp = async (eventId: string) => {
    if (!auth || !apiBaseUrl) return;
    await signUpForEvent(auth, apiBaseUrl, eventId);
    setEvents((prev) => prev.map((e) => (e.eventId === eventId ? { ...e, signedUp: true } : e)));
  };

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
        {events.length === 0 ? (
          <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
            No training events scheduled.
          </Text>
        ) : (
          <View>
            {events.map((item, index) => (
              <TouchableOpacity
                key={item.eventId}
                accessibilityRole="button"
                disabled={item.signedUp}
                onPress={() => void onSignUp(item.eventId)}
                style={{
                  minHeight: targetSize.field,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.md,
                  paddingVertical: spacing.sm + spacing.xs,
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderTopColor: theme.borderDecorative,
                }}
              >
                <View style={{ flex: 1, gap: spacing.xs }}>
                  <Text style={{ color: theme.fg, fontSize: ROW_TITLE_SIZE, fontWeight: '600' }}>
                    {item.title}
                  </Text>
                  <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
                    {formatEventTime(item.startAt)} · {item.category}
                  </Text>
                </View>
                {item.signedUp ? (
                  <StatusChip status="ok" label="Signed up" />
                ) : (
                  <Text
                    style={{
                      color: theme.accent,
                      fontSize: typeScale.body.size,
                      fontWeight: '700',
                    }}
                  >
                    Sign up
                  </Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}
      </Card>
    </Screen>
  );
}
