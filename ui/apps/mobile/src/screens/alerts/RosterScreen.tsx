import { palette, spacing, typography } from '@boxalarm/design-tokens';
import { useRoute } from '@react-navigation/native';
import { useEffect, useState } from 'react';
import { FlatList, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ackStatusColor, ackStatusLabel } from '../../features/alerts/ackStatus';
import { mockAlertsRepository } from '../../features/alerts/mockAlertsRepository';
import type { RosterEntry } from '../../features/alerts/types';
import { useConnectivity } from '../../sync/ConnectivityContext';

// F1.7: live roster is one row per member, reflecting each member's current answer. It requires
// connectivity by nature (real-time data) - architecture.md is explicit this is one of the two
// screens that must show a clear "offline, will resume" state rather than pretending to work.
export function RosterScreen() {
  const route = useRoute();
  const { dispatchId } = route.params as { dispatchId: string };
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const { isOnline } = useConnectivity();
  const [roster, setRoster] = useState<RosterEntry[]>([]);

  useEffect(() => {
    if (!isOnline) return;
    let cancelled = false;
    mockAlertsRepository.getRoster(dispatchId).then((result) => {
      if (!cancelled) setRoster(result);
    });
    return () => {
      cancelled = true;
    };
  }, [dispatchId, isOnline]);

  if (!isOnline) {
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
        <Text style={{ color: tokens.foreground, fontSize: typography.size.base }}>
          Offline — roster will resume when connected.
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <FlatList
        data={roster}
        keyExtractor={(item) => item.memberId}
        contentContainerStyle={{ padding: spacing.lg }}
        renderItem={({ item }) => (
          <View
            style={{
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
              {item.name}
            </Text>
            <Text
              style={{
                color: ackStatusColor(item.ackStatus, tokens),
                fontSize: typography.size.sm,
                marginTop: 2,
              }}
            >
              {ackStatusLabel(item.ackStatus)}
            </Text>
            <Text
              style={{
                color: tokens.foreground,
                opacity: 0.7,
                fontSize: typography.size.sm,
                marginTop: 2,
              }}
            >
              {item.quals.join(', ')}
            </Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}
