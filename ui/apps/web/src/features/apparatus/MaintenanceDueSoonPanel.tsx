import { useQueries } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Card, StatusChip } from '../../components/ui';
import { daysUntil, dueLabel, formatCalendarDate, toCalendarDate } from '../../lib/dates';
import { getMaintenance } from './api';
import type { Apparatus } from './types';
import styles from './Apparatus.module.css';

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
  // Most overdue first: a unit past its service date is the one an officer has to act on.
  const dueSoon = apparatus
    .map((unit, index) => ({ unit, nextScheduled: results[index]?.data?.nextScheduled ?? null }))
    .filter(
      (entry): entry is { unit: Apparatus; nextScheduled: number } =>
        entry.nextScheduled !== null && entry.nextScheduled - now <= REMINDER_WINDOW_SECONDS,
    )
    .sort((a, b) => a.nextScheduled - b.nextScheduled);

  return (
    <Card title="Maintenance due soon">
      {dueSoon.length === 0 ? (
        <p className={styles.message}>No maintenance due within 30 days.</p>
      ) : (
        <ul className={styles.list}>
          {dueSoon.map(({ unit, nextScheduled }) => {
            const dueDate = toCalendarDate(nextScheduled * 1000);
            const days = daysUntil(dueDate);
            return (
              <li key={unit.apparatusId} className={styles.row}>
                <span className={styles.rowBody}>
                  <Link
                    to={`/apparatus/${encodeURIComponent(unit.unitId)}`}
                    className={[styles.rowTitle, styles.mono].join(' ')}
                  >
                    {unit.unitId}
                  </Link>
                  <span className={styles.rowMeta}>Service {formatCalendarDate(dueDate)}</span>
                </span>
                <StatusChip status={days < 0 ? 'danger' : 'warning'}>{dueLabel(days)}</StatusChip>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
