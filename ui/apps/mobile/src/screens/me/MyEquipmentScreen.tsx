import { typeScale, type StatusRole } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { Card, Screen, StatusChip, useTheme } from '../../components/ui';
import { useAuth } from '../../auth/AuthContext';
import { useInventoryRepository } from '../../features/inventory/apiInventoryRepository';
import type { EquipmentAsset, LifecycleStatus } from '../../features/inventory/types';
import { InfoRow, Rows } from './MeRows';

const LIFECYCLE_CHIP: Record<LifecycleStatus, { status: StatusRole; label: string }> = {
  IN_SERVICE: { status: 'ok', label: 'In service' },
  ACQUIRED: { status: 'info', label: 'Acquired' },
  RETIRED: { status: 'neutral', label: 'Retired' },
};

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
    <Screen>
      <Card>
        {equipment.length === 0 ? (
          <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
            No equipment assigned to you.
          </Text>
        ) : (
          <Rows>
            {equipment.map((item) => {
              // A status this build doesn't know still shows, as its raw word.
              const chip: { status: StatusRole; label: string } = LIFECYCLE_CHIP[
                item.lifecycleStatus
              ] ?? {
                status: 'neutral',
                label: item.lifecycleStatus,
              };
              return (
                <InfoRow
                  key={item.assetId}
                  title={item.serialNumber}
                  detail={item.location}
                  trailing={<StatusChip status={chip.status} label={chip.label} />}
                />
              );
            })}
          </Rows>
        )}
      </Card>
    </Screen>
  );
}
