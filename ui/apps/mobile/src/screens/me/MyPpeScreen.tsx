import { palette, spacing, typography } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import { FlatList, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../auth/AuthContext';
import { useInventoryRepository } from '../../features/inventory/apiInventoryRepository';
import type { PpeAssignment } from '../../features/inventory/types';

export function MyPpeScreen() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const repository = useInventoryRepository();
  const { memberId } = useAuth();
  const [ppe, setPpe] = useState<PpeAssignment[]>([]);

  useEffect(() => {
    if (!memberId) return;
    let cancelled = false;
    repository.getMyPpe(memberId).then((result) => {
      if (!cancelled) setPpe(result);
    });
    return () => {
      cancelled = true;
    };
  }, [repository, memberId]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <FlatList
        data={ppe}
        keyExtractor={(item) => item.ppeItemId}
        contentContainerStyle={{ padding: spacing.lg }}
        ListEmptyComponent={
          <Text style={{ color: tokens.foreground, fontSize: typography.size.base }}>
            No PPE issued to you.
          </Text>
        }
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
              {item.itemType} · size {item.size}
            </Text>
            <Text
              style={{
                color: item.status === 'EXPIRED' ? tokens.error : tokens.foreground,
                opacity: item.status === 'EXPIRED' ? 1 : 0.7,
                fontSize: typography.size.sm,
                fontWeight: item.status === 'EXPIRED' ? '700' : '400',
                marginTop: 2,
              }}
            >
              {item.status === 'EXPIRED' ? 'EXPIRED' : item.status} · expires {item.nfpaExpiryDate}
            </Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}
