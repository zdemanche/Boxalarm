import { typeScale, type StatusRole } from '@boxalarm/design-tokens';
import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { Card, Screen, StatusChip, useTheme } from '../../components/ui';
import { useAuth } from '../../auth/AuthContext';
import { useInventoryRepository } from '../../features/inventory/apiInventoryRepository';
import type { PpeAssignment, PpeStatus } from '../../features/inventory/types';
import { InfoRow, Rows } from './MeRows';

// Expired gear is an alarm (docs/design.md §2.3, Expired); it must stand out without officer help.
const PPE_CHIP: Record<PpeStatus, { status: StatusRole; label: string }> = {
  ISSUED: { status: 'ok', label: 'Issued' },
  EXPIRED: { status: 'danger', label: 'Expired' },
  RETIRED: { status: 'neutral', label: 'Retired' },
};

export function MyPpeScreen() {
  const theme = useTheme();
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
    <Screen>
      <Card>
        {ppe.length === 0 ? (
          <Text style={{ color: theme.fgMuted, fontSize: typeScale.body.size }}>
            No PPE issued to you.
          </Text>
        ) : (
          <Rows>
            {ppe.map((item) => {
              const chip: { status: StatusRole; label: string } = PPE_CHIP[item.status] ?? {
                status: 'neutral',
                label: item.status,
              };
              return (
                <InfoRow
                  key={item.ppeItemId}
                  title={`${item.itemType} · size ${item.size}`}
                  detail={`expires ${item.nfpaExpiryDate}`}
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
