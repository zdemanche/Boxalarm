import { spacing, typeScale } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { Screen, useTheme } from '../../components/ui';
import { useAuth } from '../../auth/AuthContext';
import { useInventoryRepository } from '../../features/inventory/apiInventoryRepository';
import type { EquipmentAsset } from '../../features/inventory/types';

export function MyEquipmentScreen() {
  const theme = useTheme();
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
    <Screen scroll={false}>
      <FlatList
        data={equipment}
        keyExtractor={(item) => item.assetId}
        ListEmptyComponent={
          <Text style={{ color: theme.fg, fontSize: typeScale.body.size }}>
            No equipment assigned to you.
          </Text>
        }
        renderItem={({ item }) => (
          <View
            style={{
              paddingVertical: spacing.md,
              borderBottomWidth: 1,
              borderBottomColor: theme.borderDecorative,
            }}
          >
            <Text style={{ color: theme.fg, fontSize: typeScale.body.size, fontWeight: '600' }}>
              {item.serialNumber}
            </Text>
            <Text style={{ color: theme.fgMuted, fontSize: typeScale.caption.size, marginTop: 2 }}>
              {item.location} · {item.lifecycleStatus}
            </Text>
          </View>
        )}
      />
    </Screen>
  );
}
