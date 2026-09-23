import { palette, spacing, touchTarget, typography } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import Config from 'react-native-config';
import { FlatList, Text, TouchableOpacity, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useOptionalAuth } from '../../auth/AuthContext';
import { getTrainingEvents, signUpForEvent } from '../../features/training/api';
import type { TrainingEvent } from '../../features/training/types';

function formatEventTime(startAt: number): string {
  return new Date(startAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function TrainingEventsScreen() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const auth = useOptionalAuth();
  const apiBaseUrl = Config.API_BASE_URL;
  const [events, setEvents] = useState<TrainingEvent[]>([]);

  const load = () => {
    if (!auth?.isAuthenticated || !apiBaseUrl) return;
    getTrainingEvents(auth, apiBaseUrl).then(setEvents);
  };

  useEffect(load, [auth, apiBaseUrl]);

  const onSignUp = async (eventId: string) => {
    if (!auth || !apiBaseUrl) return;
    await signUpForEvent(auth, apiBaseUrl, eventId);
    setEvents((prev) => prev.map((e) => (e.eventId === eventId ? { ...e, signedUp: true } : e)));
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <FlatList
        data={events}
        keyExtractor={(item) => item.eventId}
        contentContainerStyle={{ padding: spacing.lg }}
        ListEmptyComponent={
          <Text style={{ color: tokens.foreground, opacity: 0.7 }}>
            No training events scheduled.
          </Text>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            accessibilityRole="button"
            disabled={item.signedUp}
            onPress={() => void onSignUp(item.eventId)}
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
                fontWeight: '600',
              }}
            >
              {item.title}
            </Text>
            <Text style={{ color: tokens.foreground, opacity: 0.7, fontSize: typography.size.sm }}>
              {formatEventTime(item.startAt)} · {item.category}
            </Text>
            <Text
              style={{
                color: item.signedUp ? tokens.success : tokens.accent,
                fontSize: typography.size.sm,
                fontWeight: '600',
                marginTop: 2,
              }}
            >
              {item.signedUp ? 'Signed up' : 'Sign up'}
            </Text>
          </TouchableOpacity>
        )}
      />
    </SafeAreaView>
  );
}
