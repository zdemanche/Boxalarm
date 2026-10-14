import { FormEvent, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, PageHeader, TextInput } from '../../components/ui';
import { canAccessPath } from '../../routing/routeTable';
import type { AttendanceActivityType } from '../personnel/types';
import { humanize } from '../../lib/labels';
import { updateLosapRules } from './api';
import styles from './LosapSettingsPage.module.css';

const ACTIVITY_TYPES: AttendanceActivityType[] = [
  'CALL',
  'DRILL',
  'MEETING',
  'WORK_DETAIL',
  'STANDBY',
];

export function LosapSettingsPage() {
  const auth = useAuth();
  const [points, setPoints] = useState<Record<AttendanceActivityType, string>>({
    CALL: '',
    DRILL: '',
    MEETING: '',
    WORK_DETAIL: '',
    STANDBY: '',
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      updateLosapRules(
        auth,
        Object.fromEntries(
          ACTIVITY_TYPES.filter((type) => points[type].trim() !== '').map((type) => [
            type,
            Number(points[type]),
          ]),
        ),
      ),
  });

  return (
    <main id="main-content">
      <PageHeader
        title="LOSAP point rules"
        description="Points a member earns for each kind of activity toward their yearly LOSAP total."
        // A chief can edit LOSAP rules but not open /settings (ADMIN only); a linked crumb
        // would dead-end them on Forbidden.
        breadcrumbs={[
          {
            label: 'Settings',
            to: canAccessPath('/settings', auth.roles) ? '/settings' : undefined,
          },
          { label: 'LOSAP' },
        ]}
      />
      <Card title="Points per activity">
        <p className={styles.intro}>
          Saving publishes a new rule version. An activity left blank is left out of it.
        </p>
        <form
          aria-label="LOSAP point rules"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            saveMutation.mutate();
          }}
        >
          <div className={styles.grid}>
            {ACTIVITY_TYPES.map((type) => (
              <TextInput
                key={type}
                label={`${humanize(type)} points`}
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                value={points[type]}
                onChange={(e) => setPoints((prev) => ({ ...prev, [type]: e.target.value }))}
              />
            ))}
          </div>
          <div className={styles.actions}>
            {saveMutation.error ? (
              <p role="alert" aria-live="assertive" className={styles.error}>
                {saveMutation.error.message}
              </p>
            ) : null}
            {saveMutation.data ? (
              <p role="status">Saved as rule version {saveMutation.data.ruleVersionId}.</p>
            ) : null}
            <Button type="submit" loading={saveMutation.isPending}>
              Save rules
            </Button>
          </div>
        </form>
      </Card>
    </main>
  );
}
