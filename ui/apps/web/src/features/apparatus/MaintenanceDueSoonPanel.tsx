import { useQueries } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { Card, StatusChip } from '../../components/ui';
import { getMaintenance } from './api';
import type { Apparatus } from './types';

// Stated default (no ticket or architecture text sets a reminder window) - see the plan's Risks.
const REMINDER_WINDOW_SECONDS = 30 * 86400;

// #124 AC3: /apparatus due-soon panel. Fans getMaintenance out across the already-loaded
// apparatus roster (bounded, 5 units at Nichols FD) - client-side UI fan-out over a small,
// already-fetched list, not the backend n-plus-1/scan() criterion's target. A unit whose call
// fails is silently omitted rather than failing the whole panel.
export function MaintenanceDueSoonPanel({ apparatus }: { apparatus: Apparatus[] }) {
  const auth = useAuth();
  const results = useQueries({
    queries: apparatus.map((unit) => ({
      queryKey: ['apparatus', unit.apparatusId, 'maintenance'],
      queryFn: () => getMaintenance(auth, unit.apparatusId),
    })),
  });

  const now = Math.floor(Date.now() / 1000);
  const dueSoon = apparatus
    .map((unit, index) => ({ unit, nextScheduled: results[index]?.data?.nextScheduled ?? null }))
    .filter(
      (entry): entry is { unit: Apparatus; nextScheduled: number } =>
        entry.nextScheduled !== null && entry.nextScheduled - now <= REMINDER_WINDOW_SECONDS,
    );

  return (
    <Card title="Maintenance due soon" style={{ marginTop: 'var(--bx-space-lg)' }}>
      {dueSoon.length === 0 ? (
        <p>No maintenance due within 30 days.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {dueSoon.map(({ unit, nextScheduled }) => (
            <li key={unit.apparatusId} style={{ padding: 'var(--bx-space-xs) 0' }}>
              <StatusChip status="warning">
                {unit.unitId}: due {new Date(nextScheduled * 1000).toLocaleDateString()}
              </StatusChip>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
