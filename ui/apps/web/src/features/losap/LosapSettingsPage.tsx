import { FormEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, PageHeader, Skeleton, TextInput } from '../../components/ui';
import { ApiError } from '../../lib/apiClient';
import type { ConfigResponse } from '../platform/types';
import { canAccessPath } from '../../routing/routeTable';
import type { AttendanceActivityType } from '../personnel/types';
import { humanize } from '../../lib/labels';
import { getLosapRules, updateLosapRules } from './api';
import type { LosapPointRules } from './types';
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
  const queryClient = useQueryClient();
  const queryKey = ['platform', 'config', 'LOSAP_POINT_RULES'];
  const rulesQuery = useQuery({
    queryKey,
    queryFn: async (): Promise<ConfigResponse | null> => {
      try {
        return await getLosapRules(auth);
      } catch (error) {
        if (error instanceof ApiError && error.problem.status === 404) return null;
        throw error;
      }
    },
  });
  const [points, setPoints] = useState<Record<AttendanceActivityType, string>>({
    CALL: '',
    DRILL: '',
    MEETING: '',
    WORK_DETAIL: '',
    STANDBY: '',
  });

  useEffect(() => {
    const current = rulesQuery.data?.value.pointsByActivityType as LosapPointRules | undefined;
    if (!current) return;
    setPoints(
      Object.fromEntries(
        ACTIVITY_TYPES.map((type) => [
          type,
          current[type] === undefined ? '' : String(current[type]),
        ]),
      ) as Record<AttendanceActivityType, string>,
    );
  }, [rulesQuery.data]);

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
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
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
          Saving publishes a new rule version. An activity left blank earns 0 points.
        </p>
        {rulesQuery.isLoading ? <Skeleton lines={3} /> : null}
        {rulesQuery.error ? (
          <p role="alert" className={styles.error}>
            The current rules could not be loaded, so they can&rsquo;t be edited safely. Reload to
            try again.
          </p>
        ) : null}
        <form
          aria-label="LOSAP point rules"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (rulesQuery.isSuccess) saveMutation.mutate();
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
            <Button type="submit" loading={saveMutation.isPending || rulesQuery.isPending}>
              Save rules
            </Button>
          </div>
        </form>
      </Card>
    </main>
  );
}
