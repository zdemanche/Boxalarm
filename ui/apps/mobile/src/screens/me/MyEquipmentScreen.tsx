import { palette, spacing, typography } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import { FlatList, Text, useColorScheme, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../auth/AuthContext';
import { useInventoryRepository } from '../../features/inventory/apiInventoryRepository';
import type { EquipmentAsset } from '../../features/inventory/types';

export function MyEquipmentScreen() {
  const scheme = useColorScheme();
  const tokens = scheme === 'dark' ? palette.cab : palette.day;
  const repository = useInventoryRepository();
  const { memberId } = useAuth();
  const [equipment, setEquipment] = useState<EquipmentAsset[]>([]);

  useEffect(() => {
    if (!memberId) return;
    let cancelled = false;
    repository.getMyEquipment(memberId).then((result) => {
      if (!cancelled) setEquipment(result);
    });
    return () => {
      cancelled = true;
    };
  }, [repository, memberId]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: tokens.background }}>
      <FlatList
        data={equipment}
        keyExtractor={(item) => item.assetId}
        contentContainerStyle={{ padding: spacing.lg }}
        ListEmptyComponent={
          <Text style={{ color: tokens.foreground, fontSize: typography.size.base }}>
            No equipment assigned to you.
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
              {item.serialNumber}
            </Text>
            <Text
              style={{
                color: tokens.foreground,
                opacity: 0.7,
                fontSize: typography.size.sm,
                marginTop: 2,
              }}
            >
              {item.location} · {item.lifecycleStatus}
            </Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}
